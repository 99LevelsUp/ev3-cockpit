//! The real HID side through hidapi (Windows' own HID API, Linux hidraw).

use std::ffi::CString;

use super::backend::{HidBackend, HidDeviceInfo, HidHandle, NodeAccess};

/// hidapi. Each call takes a fresh device list, so a brick plugged in since the last call is
/// seen.
#[derive(Debug, Default)]
pub struct HidapiBackend;

impl HidBackend for HidapiBackend {
    fn devices(&self, vendor_id: u16, product_id: u16) -> Result<Vec<HidDeviceInfo>, String> {
        let api = hidapi::HidApi::new().map_err(|error| error.to_string())?;
        Ok(api
            .device_list()
            .filter(|device| device.vendor_id() == vendor_id && device.product_id() == product_id)
            .map(|device| HidDeviceInfo {
                path: device.path().to_string_lossy().into_owned(),
                serial_number: device.serial_number().map(str::to_owned),
                product: device.product_string().map(str::to_owned),
            })
            .collect())
    }

    fn open(&self, path: &str) -> Result<Box<dyn HidHandle>, String> {
        let api = hidapi::HidApi::new().map_err(|error| error.to_string())?;
        let path = CString::new(path).map_err(|error| error.to_string())?;
        let device = api.open_path(&path).map_err(|error| error.to_string())?;
        Ok(Box::new(HidapiHandle(device)))
    }

    fn node_access(&self, path: &str) -> NodeAccess {
        node_access(path)
    }
}

#[cfg(target_os = "linux")]
fn node_access(path: &str) -> NodeAccess {
    let Ok(path) = CString::new(path) else {
        return NodeAccess::Unknown;
    };
    // SAFETY: `path` is a NUL-terminated string that outlives the call, and `access` only reads
    // it.
    let result = unsafe { libc::access(path.as_ptr(), libc::R_OK | libc::W_OK) };
    if result == 0 {
        return NodeAccess::Granted;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::EACCES | libc::EPERM) => NodeAccess::Denied,
        _ => NodeAccess::Unknown,
    }
}

#[cfg(not(target_os = "linux"))]
fn node_access(_path: &str) -> NodeAccess {
    NodeAccess::Unknown
}

struct HidapiHandle(hidapi::HidDevice);

impl HidHandle for HidapiHandle {
    fn write(&mut self, report: &[u8]) -> Result<usize, String> {
        self.0.write(report).map_err(|error| error.to_string())
    }

    fn read_timeout(&mut self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, String> {
        self.0
            .read_timeout(buf, timeout_ms)
            .map_err(|error| error.to_string())
    }
}
