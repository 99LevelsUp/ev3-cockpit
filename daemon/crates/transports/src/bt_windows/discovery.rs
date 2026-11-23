//! What Windows knows about Bluetooth devices: its device cache through `bthprops`, which costs
//! no air time, and an inquiry through WinRT, which finds bricks nobody has paired yet.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::bt::format_mac;
use crate::bt::presence::ScannedBrick;

/// One device as Windows' cache knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRecord {
    /// The 48-bit address in the low bytes.
    pub address: u64,
    /// Friendly name as Windows last learned it, trimmed. Usually empty: Windows fills it only
    /// while it is connected to the device, so a remembered brick comes back without one.
    pub name: String,
    pub connected: bool,
    /// Paired with this computer.
    pub remembered: bool,
    pub authenticated: bool,
    pub class_of_device: u32,
}

/// Why a platform call produced nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformError {
    /// This host cannot run the call at all; it will not start working later.
    Unavailable(String),
    /// This call failed.
    Failed(String),
}

impl PlatformError {
    pub fn message(&self) -> &str {
        match self {
            Self::Unavailable(message) | Self::Failed(message) => message,
        }
    }
}

/// Reads a UTF-16 name buffer up to its terminator. Windows leaves the rest untouched.
pub fn read_utf16_name(units: &[u16]) -> String {
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

/// Enumerates the Bluetooth devices Windows' cache knows about: remembered, authenticated,
/// connected and seen-but-unpaired. Never an inquiry: an inquiry occupies the radio for seconds,
/// exactly the interference an open RFCOMM channel cannot absorb.
///
/// No first device is an answer, not a fault: a host with a radio and nothing paired, or with no
/// radio at all, reaches here.
pub fn list_devices() -> Result<Vec<DeviceRecord>, PlatformError> {
    use windows_sys::Win32::Devices::Bluetooth::{
        BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS, BluetoothFindDeviceClose,
        BluetoothFindFirstDevice, BluetoothFindNextDevice,
    };

    let params = BLUETOOTH_DEVICE_SEARCH_PARAMS {
        dwSize: u32::try_from(std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>()).unwrap_or(0),
        fReturnAuthenticated: 1,
        fReturnRemembered: 1,
        fReturnUnknown: 1,
        fReturnConnected: 1,
        fIssueInquiry: 0,
        cTimeoutMultiplier: 0,
        hRadio: std::ptr::null_mut(),
    };
    let fresh = || BLUETOOTH_DEVICE_INFO {
        // The version field: a wrong value is not refused but interpreted, and the enumeration
        // walks memory at the wrong stride.
        dwSize: u32::try_from(std::mem::size_of::<BLUETOOTH_DEVICE_INFO>()).unwrap_or(0),
        ..BLUETOOTH_DEVICE_INFO::default()
    };
    let read = |info: &BLUETOOTH_DEVICE_INFO| DeviceRecord {
        // SAFETY: the union's two members cover the same bytes; the 64-bit one is always valid.
        address: unsafe { info.Address.Anonymous.ullLong } & 0xffff_ffff_ffff,
        name: read_utf16_name(&info.szName).trim().to_owned(),
        connected: info.fConnected != 0,
        remembered: info.fRemembered != 0,
        authenticated: info.fAuthenticated != 0,
        class_of_device: info.ulClassofDevice,
    };

    let mut first = fresh();
    // SAFETY: `params` and `first` are live, sized as their `dwSize` says.
    let find = unsafe { BluetoothFindFirstDevice(&raw const params, &raw mut first) };
    if find.is_null() {
        return Ok(Vec::new());
    }
    let mut devices = vec![read(&first)];
    loop {
        let mut next = fresh();
        // SAFETY: `find` is the live handle from above; `next` is sized as its `dwSize` says.
        if unsafe { BluetoothFindNextDevice(find, &raw mut next) } == 0 {
            break;
        }
        devices.push(read(&next));
    }
    // SAFETY: `find` is live and closed once.
    unsafe { BluetoothFindDeviceClose(find) };
    Ok(devices)
}

/// This computer's Bluetooth name: the first local radio's own name, read from its record, so
/// it costs no air time.
///
/// Not trimmed or folded: a brick stores each peer under the name the peer's radio reported and
/// removes an entry only on an exact, case-sensitive match. `None` when there is no radio or the
/// call fails, and for an empty name, which the brick would treat as a wildcard. Never a stand-in
/// such as the host name: a wrong name misses this computer's entry and reads as though there was
/// none.
pub fn radio_name() -> Option<String> {
    use windows_sys::Win32::Devices::Bluetooth::{
        BLUETOOTH_FIND_RADIO_PARAMS, BLUETOOTH_RADIO_INFO, BluetoothFindFirstRadio,
        BluetoothFindRadioClose, BluetoothGetRadioInfo,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

    let params = BLUETOOTH_FIND_RADIO_PARAMS {
        dwSize: u32::try_from(std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>()).unwrap_or(0),
    };
    let mut radio: HANDLE = std::ptr::null_mut();
    // SAFETY: `params` is live and sized; `radio` is writable.
    let find = unsafe { BluetoothFindFirstRadio(&raw const params, &raw mut radio) };
    if find.is_null() {
        return None;
    }
    let mut info = BLUETOOTH_RADIO_INFO {
        dwSize: u32::try_from(std::mem::size_of::<BLUETOOTH_RADIO_INFO>()).unwrap_or(0),
        ..BLUETOOTH_RADIO_INFO::default()
    };
    let name = if radio.is_null() {
        None
    } else {
        // SAFETY: `radio` is the live handle the find wrote; `info` is sized.
        let status = unsafe { BluetoothGetRadioInfo(radio, &raw mut info) };
        // SAFETY: `radio` is live and closed once.
        unsafe { CloseHandle(radio) };
        (status == 0).then(|| read_utf16_name(&info.szName))
    };
    // SAFETY: `find` is live and closed once.
    unsafe { BluetoothFindRadioClose(find) };
    name.filter(|name| !name.is_empty())
}

/// Pulls the peer address out of a WinRT association endpoint id, which ends in it after the
/// last dash, colon-separated: `Bluetooth#Bluetooth<radio>-<peer>`. Colon-separated and upper
/// case, the spelling the rest of the cockpit uses.
pub fn address_from_id(id: &str) -> Option<String> {
    let tail = &id[id.rfind('-')? + 1..];
    let hex: String = tail.chars().filter(|c| *c != ':').collect();
    if hex.len() != 12 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let address = u64::from_str_radix(&hex, 16).ok()?;
    Some(format_mac(address))
}

/// Whether an endpoint id names the device with these twelve hex digits, compared without
/// separators, so either spelling matches.
pub fn id_matches_address(id: &str, address: u64) -> bool {
    let id: String = id
        .chars()
        .filter(|c| *c != ':' && *c != '-')
        .collect::<String>()
        .to_ascii_lowercase();
    id.ends_with(&format!("{address:012x}"))
}

/// Keeps COM's multithreaded apartment alive for the rest of the process, once.
///
/// The WinRT bindings cache class factories in statics for the process. Each WinRT call here
/// runs on a thread of its own that ends after it; without a usage that outlives those threads,
/// COM went away with the first one, and the next inquiry, on a new thread, crashed the process
/// with an access violation inside a cached factory. Threads that never initialise COM run in
/// this apartment implicitly.
pub(crate) fn keep_com_alive() -> Result<(), String> {
    use std::sync::OnceLock;
    static KEPT: OnceLock<Result<(), String>> = OnceLock::new();
    KEPT.get_or_init(|| {
        // SAFETY: takes one usage of the process's multithreaded apartment and never releases
        // it; the cookie is dropped deliberately.
        unsafe { windows::Win32::System::Com::CoIncrementMTAUsage() }
            .map(|_cookie| ())
            .map_err(|error| format!("COM could not start: {}", error.message()))
    })
    .clone()
}

const SIGNAL_STRENGTH: &str = "System.Devices.Aep.SignalStrength";

/// The signal strength in a WinRT property map, where Windows put one. A macro rather than a
/// function: the map's type lives in a crate this one does not name.
macro_rules! signal_of {
    ($properties:expr) => {{
        use windows::core::Interface;
        let key = windows::core::HSTRING::from(SIGNAL_STRENGTH);
        $properties.ok().and_then(|properties| {
            if !properties.HasKey(&key).ok()? {
                return None;
            }
            properties
                .Lookup(&key)
                .ok()?
                .cast::<windows::Foundation::IReference<i32>>()
                .ok()?
                .Value()
                .ok()
        })
    }};
}

/// One inquiry window: the paired devices from Windows' records first, which cost nothing, then
/// a live watcher on unpaired devices for `window`.
///
/// Two queries, because one cannot answer both halves: the unpaired selector is the only one
/// whose filter makes the radio scan, and by construction it excludes everything paired. A scan
/// is a live view: a device the watcher reports removed leaves the list, and a signal update
/// replaces the old value. Blocks for `window`; run it on its own thread.
pub fn inquire(window: Duration) -> Result<Vec<ScannedBrick>, PlatformError> {
    use windows::Devices::Bluetooth::BluetoothDevice;
    use windows::Devices::Enumeration::{
        DeviceInformation, DeviceInformationUpdate, DeviceWatcher,
    };
    use windows::Foundation::TypedEventHandler;

    let failed = |error: windows::core::Error| PlatformError::Failed(error.message());
    keep_com_alive().map_err(PlatformError::Unavailable)?;

    let heard: Arc<Mutex<Vec<ScannedBrick>>> = Arc::new(Mutex::new(Vec::new()));
    let report = {
        let heard = Arc::clone(&heard);
        move |info: &DeviceInformation, paired: bool| {
            let Some(mac) = info
                .Id()
                .ok()
                .and_then(|id| address_from_id(&id.to_string()))
            else {
                return;
            };
            let mut heard = heard
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if heard.iter().any(|brick| brick.mac == mac) {
                return;
            }
            heard.push(ScannedBrick {
                mac,
                name: info.Name().map(|name| name.to_string()).unwrap_or_default(),
                paired,
                signal: signal_of!(info.Properties()),
            });
        }
    };

    let paired_selector =
        BluetoothDevice::GetDeviceSelectorFromPairingState(true).map_err(failed)?;
    let paired = DeviceInformation::FindAllAsyncAqsFilter(&paired_selector)
        .map_err(failed)?
        .join()
        .map_err(failed)?;
    for index in 0..paired.Size().map_err(failed)? {
        if let Ok(info) = paired.GetAt(index) {
            report(&info, true);
        }
    }

    let unpaired_selector =
        BluetoothDevice::GetDeviceSelectorFromPairingState(false).map_err(failed)?;
    let watcher = DeviceInformation::CreateWatcherAqsFilter(&unpaired_selector).map_err(failed)?;
    {
        let report = report.clone();
        watcher
            .Added(&TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(
                move |_, info| {
                    if let Some(info) = info.as_ref() {
                        report(info, false);
                    }
                    Ok(())
                },
            ))
            .map_err(failed)?;
    }
    // All three events are subscribed: a watcher with only Added subscribed lost live inquiry
    // results after its enumeration completed.
    {
        let heard = Arc::clone(&heard);
        watcher
            .Updated(
                &TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(
                    move |_, update| {
                        let Some(update) = update.as_ref() else {
                            return Ok(());
                        };
                        let Some(mac) = update
                            .Id()
                            .ok()
                            .and_then(|id| address_from_id(&id.to_string()))
                        else {
                            return Ok(());
                        };
                        let Some(signal) = signal_of!(update.Properties()) else {
                            return Ok(());
                        };
                        let mut heard = heard
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if let Some(brick) = heard.iter_mut().find(|brick| brick.mac == mac) {
                            brick.signal = Some(signal);
                        }
                        Ok(())
                    },
                ),
            )
            .map_err(failed)?;
    }
    {
        let heard = Arc::clone(&heard);
        watcher
            .Removed(
                &TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(
                    move |_, update| {
                        if let Some(mac) = update
                            .as_ref()
                            .and_then(|update| update.Id().ok())
                            .and_then(|id| address_from_id(&id.to_string()))
                        {
                            heard
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .retain(|brick| brick.mac != mac);
                        }
                        Ok(())
                    },
                ),
            )
            .map_err(failed)?;
    }
    watcher.Start().map_err(failed)?;
    std::thread::sleep(window);
    let _ = watcher.Stop();
    let heard = heard
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    Ok(heard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_peer_address_from_an_endpoint_id() {
        assert_eq!(
            address_from_id("Bluetooth#Bluetooth00:11:22:33:44:55-00:16:53:f0:0a:0a").as_deref(),
            Some("00:16:53:F0:0A:0A")
        );
        assert_eq!(address_from_id("no address here"), None);
        assert_eq!(address_from_id("Bluetooth#x-00:16:53"), None);
    }

    #[test]
    fn matches_an_endpoint_id_by_address_however_it_is_spelled() {
        let id = "Bluetooth#Bluetooth00:11:22:33:44:55-00:16:53:f0:0a:0a";
        assert!(id_matches_address(id, 0x0016_53f0_0a0a));
        assert!(!id_matches_address(id, 0x0016_53f0_0b0b));
    }

    #[test]
    fn reads_a_name_up_to_its_terminator() {
        let mut units = [0u16; 8];
        for (slot, unit) in units.iter_mut().zip("AAA".encode_utf16()) {
            *slot = unit;
        }
        units[5] = u16::from(b'x');
        assert_eq!(read_utf16_name(&units), "AAA");
    }

    #[test]
    fn the_cache_structures_have_the_sizes_windows_expects() {
        use windows_sys::Win32::Devices::Bluetooth::{
            BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS, BLUETOOTH_RADIO_INFO,
        };
        // As the SDK headers lay them out: the search parameters end in a radio handle, a pointer
        // (8 bytes on x64 and arm64, 4 on x86); the other two hold no pointer.
        let search = if cfg!(target_pointer_width = "64") {
            40
        } else {
            32
        };
        assert_eq!(std::mem::size_of::<BLUETOOTH_DEVICE_INFO>(), 560);
        assert_eq!(
            std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>(),
            search
        );
        assert_eq!(std::mem::size_of::<BLUETOOTH_RADIO_INFO>(), 520);
    }
}
