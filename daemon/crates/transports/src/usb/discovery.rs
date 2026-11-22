//! Which EV3s are on the cable, and what each is called.
//!
//! Two enumerations feed a scan and they disagree. libusb reads the product string off the
//! hardware; hidapi returns the operating system's descriptor cache, which on Windows called two
//! bricks of three "Xfer data to and from EV3 brick" on the machine this was found on. A brick
//! whose interface a link holds is never opened to read its name, so the name read before is
//! remembered across scans.

use std::collections::HashMap;

use super::backend::{HidDeviceInfo, UsbBackend, UsbLocation};
use super::{Platform, VENDOR_ID};
use crate::brick_key::{BrickKey, Transport};
use crate::provider::{DiscoveryItem, NameSource, PresenceState};

/// One LEGO device as libusb saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbListing {
    /// `None` for a device that was skipped or could not be opened.
    pub serial: Option<String>,
    pub product: Option<String>,
    pub location: UsbLocation,
}

/// Lists every LEGO device on the bus, reading serial and product off the hardware.
///
/// A device in `skip` is listed by its location only, never opened: discovery runs on a timer
/// while a session may hold the same brick's interface claimed, and reopening it underneath
/// would drop that session's handle. A device that cannot be opened is listed without strings.
/// Blocks; an unreadable bus lists nothing.
pub fn list_lego_devices(backend: &dyn UsbBackend, skip: &[UsbLocation]) -> Vec<UsbListing> {
    let Ok(devices) = backend.devices() else {
        return Vec::new();
    };
    devices
        .into_iter()
        .filter(|device| device.vendor_id() == VENDOR_ID)
        .map(|device| {
            let location = device.location();
            if skip.contains(&location) {
                return UsbListing {
                    serial: None,
                    product: None,
                    location,
                };
            }
            match device.open() {
                // The handle drops at the end of this arm, which closes the device.
                Ok(handle) => UsbListing {
                    serial: handle.serial_number(),
                    product: handle.product(),
                    location,
                },
                Err(_) => UsbListing {
                    serial: None,
                    product: None,
                    location,
                },
            }
        })
        .collect()
}

/// Remembers every name libusb managed to read, keyed by lower-cased serial.
///
/// Never forgotten: a serial is a brick for good, and a name that was true once is a better
/// answer than the stale cache.
pub fn remember_names(names: &mut HashMap<String, String>, listing: &[UsbListing]) {
    for device in listing {
        let (Some(serial), Some(product)) = (&device.serial, &device.product) else {
            continue;
        };
        let (serial, product) = (serial.trim(), product.trim());
        if !serial.is_empty() && !product.is_empty() {
            names.insert(serial.to_lowercase(), product.to_owned());
        }
    }
}

/// What one scan sees, gathered before the items are built.
pub struct ScanView<'a> {
    pub platform: Platform,
    pub usb: &'a [UsbListing],
    pub hid: &'a [HidDeviceInfo],
    /// Names read off the hardware, by lower-cased serial.
    pub names: &'a HashMap<String, String>,
    /// The bricks with a session, and where each one's device sits when known.
    pub sessions: &'a [(BrickKey, Option<UsbLocation>)],
    pub now_ms: i64,
}

/// Builds the scan's items.
///
/// hidapi decides which bricks are listed; the name comes from the hardware when it was ever
/// read, then the cache, then the serial. On Linux two more sources count: a brick only libusb
/// sees (an extension host that died holding it never gave `usbhid` back, so it has no hidraw
/// node, measured 13.11.2026), and a brick with a session, which the claim took from `usbhid`
/// together with its hidraw node, listed while libusb still finds it at its bus address.
pub fn scan_items(view: &ScanView<'_>) -> Vec<DiscoveryItem> {
    let connected = |key: &BrickKey| view.sessions.iter().any(|(held, _)| held == key);
    let mut items: Vec<DiscoveryItem> = Vec::new();

    for device in view.hid {
        let Some(serial) = device.serial_number.as_deref().map(str::trim) else {
            continue;
        };
        if device.path.is_empty() || serial.is_empty() {
            continue;
        }
        let Ok(key) = BrickKey::new(Transport::Usb, &serial.to_uppercase()) else {
            continue;
        };
        // The cache's product string is the last resort, not the second choice.
        let name = view
            .names
            .get(&serial.to_lowercase())
            .cloned()
            .or_else(|| non_blank(device.product.as_deref()));
        let is_connected = connected(&key);
        items.push(item(key, name, serial, is_connected, view.now_ms));
    }

    if view.platform != Platform::Linux {
        return items;
    }

    for device in view.usb {
        let Some(serial) = non_blank(device.serial.as_deref()) else {
            continue;
        };
        let Ok(key) = BrickKey::new(Transport::Usb, &serial.to_uppercase()) else {
            continue;
        };
        if items.iter().any(|listed| listed.brick_key == key) {
            continue;
        }
        let name = view
            .names
            .get(&serial.to_lowercase())
            .cloned()
            .or_else(|| non_blank(device.product.as_deref()));
        let is_connected = connected(&key);
        items.push(item(key, name, &serial, is_connected, view.now_ms));
    }

    // A pulled cable drops the brick at once rather than at the next heartbeat.
    let on_bus = |at: &Option<UsbLocation>| {
        at.is_some_and(|at| view.usb.iter().any(|device| device.location == at))
    };
    for (key, location) in view.sessions {
        if items.iter().any(|listed| listed.brick_key == *key) || !on_bus(location) {
            continue;
        }
        let serial = key.id().to_owned();
        let name = view.names.get(&serial.to_lowercase()).cloned();
        items.push(item(key.clone(), name, &serial, true, view.now_ms));
    }
    items
}

fn non_blank(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn item(
    brick_key: BrickKey,
    name: Option<String>,
    serial: &str,
    connected: bool,
    now_ms: i64,
) -> DiscoveryItem {
    // The descriptor is fixed when the cable goes in; a rename since then is not in it.
    let name_source = if name.is_some() {
        NameSource::UsbDescriptor
    } else {
        NameSource::Fallback
    };
    DiscoveryItem {
        display_name: name.unwrap_or_else(|| serial.to_uppercase()),
        brick_key,
        name_source: Some(name_source),
        transport: Transport::Usb,
        presence_state: PresenceState::Available,
        remembered: false,
        connected,
        favorite: false,
        paired: None,
        heard: None,
        heard_at: None,
        signal_info: None,
        bt_visible: None,
        last_seen_at: now_ms,
    }
}
