//! USB: libusb at the brick's full frame, HID as the fallback.
//!
//! The brick's interrupt endpoints advertise `wMaxPacketSize` 1024, but its HID report
//! descriptor declares `Report Count 0`, so Windows derives no report length and a HID write
//! delivers 64 bytes whatever it is handed. libusb goes straight at the endpoints and reaches the
//! firmware's real frame: about forty times faster for files, and the only path on which `copy`
//! and `move` fit at all. HID stays as the fallback for a brick libusb cannot claim.
//!
//! Every libusb and hidapi call blocks. Each one runs on tokio's blocking pool
//! (`spawn_blocking`), one transfer at a time per link, and every transfer is counted until it
//! returns so that a close can wait for it. The libraries sit behind the small traits in
//! [`backend`], which tests replace with a fake bus.

pub mod backend;
pub mod discovery;
pub mod hid;
#[cfg(any(windows, target_os = "linux"))]
pub mod hidapi_backend;
pub mod libusb;
mod link;
pub mod provider;
pub mod rusb_backend;

use std::time::Duration;

pub use backend::{
    EndpointDirection, EndpointInfo, HidBackend, HidDeviceInfo, HidHandle, NodeAccess,
    TransferKind, UsbBackend, UsbDevice, UsbError, UsbHandle, UsbLocation,
};
pub use hid::HidLink;
pub use libusb::{LibusbLink, LibusbOpenError, LibusbOpenOptions};
pub use link::{UsbBackendKind, UsbLink};
pub use provider::{UsbLog, UsbProviderOptions, UsbTransportProvider};

/// LEGO's USB vendor id.
pub const VENDOR_ID: u16 = 0x0694;
/// The EV3's USB product id.
pub const PRODUCT_ID: u16 = 0x0005;
/// The interface that carries the command channel: the HID-class one. Interface 1 is mass
/// storage with bulk endpoints.
pub const COMMAND_INTERFACE: u8 = 0;

/// Round-trip budget before a send is abandoned. Roughly a hundred times the measured round
/// trip: it detects a dead link, it is not a performance target.
pub const SEND_TIMEOUT: Duration = Duration::from_millis(1000);

/// Longest a close waits for transfers still in flight before it releases the interface.
/// Each transfer ends by its own timeout, the send budget; this only bounds one sent without
/// one.
pub const CLOSE_DRAIN_MAX: Duration = Duration::from_millis(3000);

/// Longest one clear-halt may hold up an open before the open goes on without it.
pub const CLEAR_HALT_MAX: Duration = Duration::from_millis(1000);

/// The largest EV3 packet a HID write delivers on Windows and Linux, measured: one report id
/// plus 64 payload bytes reach the brick, and replies are bounded the same way.
pub const HID_PACKET_BYTES: usize = 64;

/// The HID report the brick declares: one report id byte and 1024 payload bytes. A reply that
/// claims to be longer is padding read as a header.
pub const HID_REPORT_SIZE: usize = 1025;

/// The report id written ahead of every HID report.
pub const HID_REPORT_ID: u8 = 0;

/// The udev rule the extension ships, relative to its install folder.
pub const LINUX_UDEV_RULE_PATH: &str = "native/linux/70-lego-ev3.rules";

/// The operating system whose USB rules apply. Passed in rather than read from `cfg!`, so the
/// Linux rules run in tests on any host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// libusb reaches the brick through its HID backend: reads overrun by one byte, and no
    /// kernel driver is touched.
    Windows,
    /// The kernel's `usbhid` holds the interface until it is detached, and every EV3 node is
    /// root-only until the udev rule is installed.
    Linux,
    Other,
}

impl Platform {
    /// The platform this build runs on.
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }

    /// Bytes asked for on top of the frame in every libusb read.
    ///
    /// One on Windows: libusb's HID backend reads the report id with the data, counts it, and
    /// copies the report into the caller's buffer, so a 1024-byte read reports 1025 and writes
    /// one byte past the end. Measured 20 reads out of 20 (30.10.2026); in the Node extension
    /// host that byte hit memory that was not there and took the host down. Elsewhere libusb
    /// reads the endpoint itself, a full packet is not a short one, and a longer read would
    /// wait for more until it timed out.
    pub fn read_slack(self) -> usize {
        match self {
            Self::Windows => 1,
            Self::Linux | Self::Other => 0,
        }
    }
}

/// What a Linux user who may not open the brick does about it.
///
/// `rule_path` is where this install keeps the rule; without it the path is named relative to
/// the extension's folder. The rule grants access two ways: `uaccess` to the user at the seat,
/// which needs systemd-logind or elogind, and the group plugdev, which is all a system without
/// either has (measured on a runit system, 14.11.2026).
pub fn linux_udev_advice(rule_path: Option<&str>) -> String {
    let rule = match rule_path {
        Some(path) => path.to_owned(),
        None => format!("{LINUX_UDEV_RULE_PATH} from the extension's folder"),
    };
    format!(
        "Install the udev rule that ships with the extension: copy {rule} to /etc/udev/rules.d/, \
         run \"sudo udevadm control --reload\", then plug the brick in again. Where neither \
         systemd-logind nor elogind runs, the user must also be in the group plugdev."
    )
}
