//! The real bus through `rusb` and its vendored libusb.

use std::sync::Arc;
use std::time::Duration;

use rusb::{Context, UsbContext};

use super::backend::{
    EndpointDirection, EndpointInfo, TransferKind, UsbBackend, UsbDevice, UsbError, UsbHandle,
    UsbLocation,
};

impl From<rusb::Error> for UsbError {
    fn from(error: rusb::Error) -> Self {
        match error {
            rusb::Error::Io => Self::Io,
            rusb::Error::InvalidParam => Self::InvalidParam,
            rusb::Error::Access => Self::Access,
            rusb::Error::NoDevice => Self::NoDevice,
            rusb::Error::NotFound => Self::NotFound,
            rusb::Error::Busy => Self::Busy,
            rusb::Error::Timeout => Self::Timeout,
            rusb::Error::Overflow => Self::Overflow,
            rusb::Error::Pipe => Self::Pipe,
            rusb::Error::Interrupted => Self::Interrupted,
            rusb::Error::NoMem => Self::NoMem,
            rusb::Error::NotSupported => Self::NotSupported,
            rusb::Error::BadDescriptor => Self::BadDescriptor,
            rusb::Error::Other => Self::Other,
        }
    }
}

/// libusb with its own context, so nothing else in the process shares its state.
pub struct RusbBackend {
    context: Result<Context, UsbError>,
}

impl RusbBackend {
    /// A libusb context that failed to start answers every listing with its error.
    pub fn new() -> Self {
        Self {
            context: Context::new().map_err(UsbError::from),
        }
    }
}

impl Default for RusbBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl UsbBackend for RusbBackend {
    fn devices(&self) -> Result<Vec<Arc<dyn UsbDevice>>, UsbError> {
        let context = self.context.as_ref().map_err(|error| *error)?;
        let mut devices: Vec<Arc<dyn UsbDevice>> = Vec::new();
        for device in context.devices()?.iter() {
            let Ok(descriptor) = device.device_descriptor() else {
                continue;
            };
            devices.push(Arc::new(RusbDevice { device, descriptor }));
        }
        Ok(devices)
    }
}

struct RusbDevice {
    device: rusb::Device<Context>,
    descriptor: rusb::DeviceDescriptor,
}

impl UsbDevice for RusbDevice {
    fn vendor_id(&self) -> u16 {
        self.descriptor.vendor_id()
    }

    fn product_id(&self) -> u16 {
        self.descriptor.product_id()
    }

    fn location(&self) -> UsbLocation {
        UsbLocation {
            bus: self.device.bus_number(),
            address: self.device.address(),
        }
    }

    fn interface_endpoints(&self, interface: u8) -> Result<Vec<EndpointInfo>, UsbError> {
        let config = self.device.active_config_descriptor()?;
        let Some(setting) = config
            .interfaces()
            .find(|candidate| candidate.number() == interface)
            .and_then(|found| found.descriptors().next())
        else {
            return Ok(Vec::new());
        };
        Ok(setting
            .endpoint_descriptors()
            .map(|endpoint| EndpointInfo {
                address: endpoint.address(),
                direction: match endpoint.direction() {
                    rusb::Direction::In => EndpointDirection::In,
                    rusb::Direction::Out => EndpointDirection::Out,
                },
                transfer: match endpoint.transfer_type() {
                    rusb::TransferType::Control => TransferKind::Control,
                    rusb::TransferType::Isochronous => TransferKind::Isochronous,
                    rusb::TransferType::Bulk => TransferKind::Bulk,
                    rusb::TransferType::Interrupt => TransferKind::Interrupt,
                },
                max_packet_size: endpoint.max_packet_size(),
            })
            .collect())
    }

    fn open(&self) -> Result<Arc<dyn UsbHandle>, UsbError> {
        Ok(Arc::new(RusbHandle {
            handle: self.device.open()?,
            serial_index: self.descriptor.serial_number_string_index(),
            product_index: self.descriptor.product_string_index(),
        }))
    }
}

struct RusbHandle {
    handle: rusb::DeviceHandle<Context>,
    serial_index: Option<u8>,
    product_index: Option<u8>,
}

impl RusbHandle {
    fn string(&self, index: Option<u8>) -> Option<String> {
        self.handle.read_string_descriptor_ascii(index?).ok()
    }
}

impl UsbHandle for RusbHandle {
    fn serial_number(&self) -> Option<String> {
        self.string(self.serial_index)
    }

    fn product(&self) -> Option<String> {
        self.string(self.product_index)
    }

    fn set_auto_detach_kernel_driver(&self, enable: bool) -> Result<(), UsbError> {
        Ok(self.handle.set_auto_detach_kernel_driver(enable)?)
    }

    fn kernel_driver_active(&self, interface: u8) -> Result<bool, UsbError> {
        Ok(self.handle.kernel_driver_active(interface)?)
    }

    fn detach_kernel_driver(&self, interface: u8) -> Result<(), UsbError> {
        Ok(self.handle.detach_kernel_driver(interface)?)
    }

    fn attach_kernel_driver(&self, interface: u8) -> Result<(), UsbError> {
        Ok(self.handle.attach_kernel_driver(interface)?)
    }

    fn claim_interface(&self, interface: u8) -> Result<(), UsbError> {
        Ok(self.handle.claim_interface(interface)?)
    }

    fn release_interface(&self, interface: u8) -> Result<(), UsbError> {
        Ok(self.handle.release_interface(interface)?)
    }

    fn clear_halt(&self, endpoint: u8) -> Result<(), UsbError> {
        Ok(self.handle.clear_halt(endpoint)?)
    }

    fn write_interrupt(
        &self,
        endpoint: u8,
        data: &[u8],
        timeout: Duration,
    ) -> Result<usize, UsbError> {
        Ok(self.handle.write_interrupt(endpoint, data, timeout)?)
    }

    fn read_interrupt(
        &self,
        endpoint: u8,
        buf: &mut [u8],
        timeout: Duration,
    ) -> Result<usize, UsbError> {
        Ok(self.handle.read_interrupt(endpoint, buf, timeout)?)
    }
}
