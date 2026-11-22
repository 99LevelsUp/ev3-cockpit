//! The presence check: an uncached Winsock SDP query for the brick's serial-port service.
//!
//! The operating system lists a paired brick whether it is switched on or not; an uncached query
//! (`LUP_FLUSHCACHE`) has to reach the brick itself. Through Winsock a brick paired only on the
//! Windows side just fails the query; WinRT's uncached service query answered the same brick's
//! missing key with a new pairing dialog, 2 times in 3. Winsock heard a brick that was on 3 times
//! in 4 (WinRT 1 in 4) and a brick that was off never.
//!
//! `WSALookupServiceBegin` blocks until the brick answers or the page times out (about 5.2 s for
//! a brick that is off) and cannot be cancelled, so it runs on a thread of its own that the
//! caller abandons at its deadline.

use std::time::Duration;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Networking::WinSock::{LUP_FLUSHCACHE, LUP_RETURN_ALL, WSAGetLastError};
use windows_sys::core::{GUID, PWSTR};

use crate::bt::format_mac;
use crate::bt_windows::winsock::ensure_winsock;

/// How long one check may take before it counts as not heard. A brick that is off takes about
/// 5.3 s to give up.
pub const PRESENCE_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// `NS_BTH`: the Bluetooth namespace.
const NS_BTH: u32 = 16;
/// The Serial Port Profile's service class, `00001101-0000-1000-8000-00805F9B34FB`.
const SERIAL_PORT: GUID = GUID::from_u128(0x0000_1101_0000_1000_8000_0080_5f9b_34fb);
/// Result buffer per record, in bytes.
const BUFFER_BYTES: usize = 4096;

/// What one query found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdpAnswer {
    /// Serial-port records the brick returned.
    pub records: u32,
    /// The Winsock error that ended the query without a record.
    pub error: Option<String>,
}

impl SdpAnswer {
    /// A record proves the brick is on. Silence means off, or missed.
    pub fn answered(&self) -> bool {
        self.records > 0
    }
}

/// `WSAQUERYSETW`, declared here because the crate's own declaration sits behind a feature this
/// crate does not enable. Layout per `winsock2.h`, natural alignment; checked by a size test.
#[repr(C)]
struct WsaQuerySetW {
    dw_size: u32,
    lpsz_service_instance_name: PWSTR,
    lp_service_class_id: *mut GUID,
    lp_version: *mut core::ffi::c_void,
    lpsz_comment: PWSTR,
    dw_name_space: u32,
    lp_ns_provider_id: *mut GUID,
    lpsz_context: PWSTR,
    dw_number_of_protocols: u32,
    lpafp_protocols: *mut core::ffi::c_void,
    lpsz_query_string: PWSTR,
    dw_number_of_cs_addrs: u32,
    lpcsa_buffer: *mut core::ffi::c_void,
    dw_output_flags: u32,
    lp_blob: *mut core::ffi::c_void,
}

#[link(name = "ws2_32")]
unsafe extern "system" {
    fn WSALookupServiceBeginW(
        restrictions: *const WsaQuerySetW,
        flags: u32,
        lookup: *mut HANDLE,
    ) -> i32;
    fn WSALookupServiceNextW(
        lookup: HANDLE,
        flags: u32,
        length: *mut u32,
        results: *mut WsaQuerySetW,
    ) -> i32;
    fn WSALookupServiceEnd(lookup: HANDLE) -> i32;
}

/// Asks the brick at `address`, bypassing Windows' cache, for its serial-port records. Blocks
/// until the brick answers or the page times out.
pub fn serial_port_records(address: u64) -> SdpAnswer {
    if let Err(reason) = ensure_winsock() {
        return SdpAnswer {
            records: 0,
            error: Some(reason),
        };
    }
    let mut service = SERIAL_PORT;
    let mut context: Vec<u16> = format!("({})", format_mac(address))
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let restrictions = WsaQuerySetW {
        dw_size: u32::try_from(std::mem::size_of::<WsaQuerySetW>()).unwrap_or(0),
        lpsz_service_instance_name: std::ptr::null_mut(),
        lp_service_class_id: &raw mut service,
        lp_version: std::ptr::null_mut(),
        lpsz_comment: std::ptr::null_mut(),
        dw_name_space: NS_BTH,
        lp_ns_provider_id: std::ptr::null_mut(),
        lpsz_context: context.as_mut_ptr(),
        dw_number_of_protocols: 0,
        lpafp_protocols: std::ptr::null_mut(),
        lpsz_query_string: std::ptr::null_mut(),
        dw_number_of_cs_addrs: 0,
        lpcsa_buffer: std::ptr::null_mut(),
        dw_output_flags: 0,
        lp_blob: std::ptr::null_mut(),
    };
    let mut lookup: HANDLE = std::ptr::null_mut();
    // SAFETY: `restrictions` and everything it points at (`service`, `context`) outlive the
    // call; `lookup` is writable.
    if unsafe { WSALookupServiceBeginW(&raw const restrictions, LUP_FLUSHCACHE, &raw mut lookup) }
        != 0
    {
        // SAFETY: reads this thread's last Winsock error, straight after the failed call.
        let code = unsafe { WSAGetLastError() };
        return SdpAnswer {
            records: 0,
            error: Some(format!("WSA {code}")),
        };
    }
    // u64 cells keep the buffer aligned for the structure Winsock writes at its start.
    let mut buffer = vec![0u64; BUFFER_BYTES / 8];
    let mut records = 0u32;
    let error = loop {
        let mut length = u32::try_from(BUFFER_BYTES).unwrap_or(0);
        // SAFETY: `lookup` came from a successful begin and is ended below; `buffer` holds
        // `length` writable bytes.
        let status = unsafe {
            WSALookupServiceNextW(
                lookup,
                LUP_RETURN_ALL,
                &raw mut length,
                buffer.as_mut_ptr().cast::<WsaQuerySetW>(),
            )
        };
        if status != 0 {
            // SAFETY: as above.
            let code = unsafe { WSAGetLastError() };
            break (records == 0).then(|| format!("WSA {code}"));
        }
        records += 1;
    };
    // SAFETY: `lookup` came from a successful begin and is ended once.
    unsafe { WSALookupServiceEnd(lookup) };
    SdpAnswer { records, error }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_query_structure_has_the_size_winsock_expects() {
        // sizeof(WSAQUERYSETW) on 64-bit Windows.
        assert_eq!(std::mem::size_of::<WsaQuerySetW>(), 120);
    }

    #[test]
    fn a_record_is_an_answer_and_silence_is_not() {
        assert!(
            SdpAnswer {
                records: 1,
                error: None
            }
            .answered()
        );
        assert!(
            !SdpAnswer {
                records: 0,
                error: Some("WSA 10108".into())
            }
            .answered()
        );
    }
}
