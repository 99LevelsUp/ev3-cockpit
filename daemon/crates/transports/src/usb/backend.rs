//! The seam between the USB links and the libraries under them: libusb (through `rusb`) and
//! hidapi. Every call here blocks; the links run them on tokio's blocking pool.
//!
//! Small on purpose: only what the links use, so a fake bus in tests stands in for the hardware.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

/// Where a device sits on the bus. Identifies it without opening it, so also a device another
/// link holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct UsbLocation {
    pub bus: u8,
    pub address: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointDirection {
    In,
    Out,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferKind {
    Control,
    Isochronous,
    Bulk,
    Interrupt,
}

/// One endpoint of an interface, as its descriptor declares it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndpointInfo {
    pub address: u8,
    pub direction: EndpointDirection,
    pub transfer: TransferKind,
    pub max_packet_size: u16,
}

/// A libusb failure. Displayed as libusb's own name for it (`LIBUSB_ERROR_ACCESS`), which is
/// what a user pastes into a search and what the log is grepped for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsbError {
    Io,
    InvalidParam,
    Access,
    NoDevice,
    NotFound,
    Busy,
    Timeout,
    Overflow,
    Pipe,
    Interrupted,
    NoMem,
    NotSupported,
    BadDescriptor,
    Other,
}

impl UsbError {
    pub fn libusb_name(self) -> &'static str {
        match self {
            Self::Io => "LIBUSB_ERROR_IO",
            Self::InvalidParam => "LIBUSB_ERROR_INVALID_PARAM",
            Self::Access => "LIBUSB_ERROR_ACCESS",
            Self::NoDevice => "LIBUSB_ERROR_NO_DEVICE",
            Self::NotFound => "LIBUSB_ERROR_NOT_FOUND",
            Self::Busy => "LIBUSB_ERROR_BUSY",
            Self::Timeout => "LIBUSB_ERROR_TIMEOUT",
            Self::Overflow => "LIBUSB_ERROR_OVERFLOW",
            Self::Pipe => "LIBUSB_ERROR_PIPE",
            Self::Interrupted => "LIBUSB_ERROR_INTERRUPTED",
            Self::NoMem => "LIBUSB_ERROR_NO_MEM",
            Self::NotSupported => "LIBUSB_ERROR_NOT_SUPPORTED",
            Self::BadDescriptor => "LIBUSB_ERROR_BAD_DESCRIPTOR",
            Self::Other => "LIBUSB_ERROR_OTHER",
        }
    }
}

impl fmt::Display for UsbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.libusb_name())
    }
}

impl std::error::Error for UsbError {}

/// libusb's view of the bus.
pub trait UsbBackend: Send + Sync {
    /// Every device on the bus now. Lists without opening any of them.
    fn devices(&self) -> Result<Vec<Arc<dyn UsbDevice>>, UsbError>;
}

/// A device on the bus, not yet opened.
pub trait UsbDevice: Send + Sync {
    fn vendor_id(&self) -> u16;
    fn product_id(&self) -> u16;
    fn location(&self) -> UsbLocation;
    /// The endpoints of `interface` in its first alternate setting, from the active
    /// configuration's descriptor.
    fn interface_endpoints(&self, interface: u8) -> Result<Vec<EndpointInfo>, UsbError>;
    /// Opens the device. Dropping the last clone of the handle closes it.
    fn open(&self) -> Result<Arc<dyn UsbHandle>, UsbError>;
}

/// An open device. Dropping it closes the device.
pub trait UsbHandle: Send + Sync {
    /// The serial number string, read off the hardware.
    fn serial_number(&self) -> Option<String>;
    /// The product string, read off the hardware: the brick's name when the cable went in.
    fn product(&self) -> Option<String>;
    /// libusb's auto-detach: the claim detaches the kernel driver and the release gives it
    /// back. Not on every platform.
    fn set_auto_detach_kernel_driver(&self, enable: bool) -> Result<(), UsbError>;
    fn kernel_driver_active(&self, interface: u8) -> Result<bool, UsbError>;
    fn detach_kernel_driver(&self, interface: u8) -> Result<(), UsbError>;
    fn attach_kernel_driver(&self, interface: u8) -> Result<(), UsbError>;
    fn claim_interface(&self, interface: u8) -> Result<(), UsbError>;
    fn release_interface(&self, interface: u8) -> Result<(), UsbError>;
    /// Resets an endpoint's halt and data toggle on both ends.
    fn clear_halt(&self, endpoint: u8) -> Result<(), UsbError>;
    /// An interrupt write; returns the bytes libusb reports written. `Duration::ZERO` waits
    /// without limit.
    fn write_interrupt(
        &self,
        endpoint: u8,
        data: &[u8],
        timeout: Duration,
    ) -> Result<usize, UsbError>;
    /// An interrupt read into `buf`; returns the bytes libusb reports read, which on Windows
    /// counts the report id too. `Duration::ZERO` waits without limit.
    fn read_interrupt(
        &self,
        endpoint: u8,
        buf: &mut [u8],
        timeout: Duration,
    ) -> Result<usize, UsbError>;
}

/// One HID device as hidapi lists it. Needs no handle, so also a device another link holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HidDeviceInfo {
    pub path: String,
    pub serial_number: Option<String>,
    /// From the operating system's descriptor cache, which on Windows can be stale.
    pub product: Option<String>,
}

/// Whether this user may open a HID node, asked of the node itself (Linux `hidraw`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeAccess {
    Denied,
    Granted,
    Unknown,
}

/// hidapi's view of the bus.
pub trait HidBackend: Send + Sync {
    /// HID devices with this vendor and product id.
    fn devices(&self, vendor_id: u16, product_id: u16) -> Result<Vec<HidDeviceInfo>, String>;
    fn open(&self, path: &str) -> Result<Box<dyn HidHandle>, String>;
    /// Whether this user may read and write the node at `path`. hidapi's open failure carries
    /// no errno, so the node is asked directly.
    fn node_access(&self, path: &str) -> NodeAccess;
}

/// An open HID device. Dropping it closes the device.
pub trait HidHandle: Send {
    /// Writes one report, report id first. Returns the bytes written; 0 means the backend did
    /// not say.
    fn write(&mut self, report: &[u8]) -> Result<usize, String>;
    /// Reads one report, waiting at most `timeout_ms` (-1 without limit). 0 bytes means
    /// nothing arrived in time.
    fn read_timeout(&mut self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, String>;
}
