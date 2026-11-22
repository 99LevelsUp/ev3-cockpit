//! The libusb link: the brick's interrupt endpoints at their full frame.
//!
//! One measured quirk shapes it: a transfer must be exactly `wMaxPacketSize`. A 16-byte write
//! fails with `LIBUSB_ERROR_IO`; the same packet padded to 1024 succeeds. Reads come back
//! full-length too, so a reply is found by its own length prefix rather than by the size of the
//! transfer that carried it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::extract_length_prefixed_packet;
use tokio::sync::Mutex as AsyncMutex;

use super::backend::{
    EndpointDirection, EndpointInfo, TransferKind, UsbBackend, UsbDevice, UsbError, UsbHandle,
    UsbLocation,
};
use super::link::{CLOSED_DURING_EXCHANGE, InFlight, UsbBackendKind, UsbLink, run_blocking};
use super::{
    CLEAR_HALT_MAX, CLOSE_DRAIN_MAX, COMMAND_INTERFACE, PRODUCT_ID, Platform, VENDOR_ID,
    linux_udev_advice,
};
use crate::error::TransportError;
use crate::pending::{Exchanger, LinkIo, MAX_STALE_REPLIES};
use crate::provider::SendOptions;

/// What a libusb open needs to know.
#[derive(Debug, Clone)]
pub struct LibusbOpenOptions {
    /// The brick's serial, any case. `None` takes the first EV3 nobody holds.
    pub serial: Option<String>,
    /// Devices another link holds. Never opened, not even to read a serial: libusb hands out
    /// one handle per device, and opening and closing a brick another session has claimed drops
    /// the handle that session uses. Every later transfer on it then fails with "Device is not
    /// open" (verified on hardware: connecting a second brick killed the first).
    pub in_use: Vec<UsbLocation>,
    pub platform: Platform,
    /// Where this install keeps the udev rule a Linux permission message points at.
    pub udev_rule_path: Option<String>,
    /// The budget an exchange gets when its caller names none.
    pub send_timeout: Duration,
}

/// Why a libusb link did not open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibusbOpenError {
    pub message: String,
    /// Set when this user may not open the device (Linux, without the udev rule): the code
    /// libusb refused with. The message then carries the advice already.
    pub permission: Option<UsbError>,
}

impl LibusbOpenError {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            permission: None,
        }
    }

    fn permission(code: UsbError, rule_path: Option<&str>) -> Self {
        Self {
            message: format!(
                "This user may not open the EV3's USB device ({code}). {}",
                linux_udev_advice(rule_path)
            ),
            permission: Some(code),
        }
    }
}

impl From<LibusbOpenError> for TransportError {
    fn from(error: LibusbOpenError) -> Self {
        TransportError::transport_failed(error.message)
    }
}

/// An open libusb link with its interface claimed.
pub struct LibusbLink {
    shared: Arc<Shared>,
    exchanger: AsyncMutex<Exchanger>,
    send_timeout: Duration,
}

/// What a blocking call needs. Each call holds a clone, so the interface is released and the
/// device closed only after the last call has returned, even when nobody waits for it any more.
struct Shared {
    handle: Arc<dyn UsbHandle>,
    location: UsbLocation,
    ep_in: u8,
    ep_out: u8,
    frame: usize,
    slack: usize,
    platform: Platform,
    /// This link detached the kernel driver by hand and gives it back after the release.
    detached_by_hand: bool,
    closed: AtomicBool,
    /// Whether the interface was given back. A lock rather than a flag, so a second close waits
    /// for the release the first one is making.
    released: Mutex<bool>,
    /// One transfer at a time. A transfer whose caller gave up runs on until libusb's own
    /// timeout; the next exchange waits for it rather than racing it for the reply.
    transfer: Mutex<()>,
    in_flight: InFlight,
}

impl Shared {
    /// Releases the interface and gives the kernel driver back, once. A device unplugged
    /// mid-session fails both; neither failure may keep the other from happening.
    fn release_once(&self) {
        let mut released = self.released.lock().unwrap_or_else(PoisonError::into_inner);
        if *released {
            return;
        }
        *released = true;
        let _ = self.handle.release_interface(COMMAND_INTERFACE);
        if self.detached_by_hand {
            // A brick already unplugged has no driver to take back.
            let _ = self.handle.attach_kernel_driver(COMMAND_INTERFACE);
        }
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    async fn write(
        self: &Arc<Self>,
        packet: &[u8],
        budget: Duration,
    ) -> Result<(), TransportError> {
        // Padded to the full frame: libusb refuses a short interrupt transfer outright, and the
        // brick reads the packet length from the packet itself.
        let mut frame = vec![0u8; self.frame];
        frame[..packet.len()].copy_from_slice(packet);
        let shared = self.clone();
        run_blocking(&self.in_flight, move || {
            let _one = shared
                .transfer
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if shared.is_closed() {
                return Err(TransportError::transport_failed(CLOSED_DURING_EXCHANGE));
            }
            match shared.handle.write_interrupt(shared.ep_out, &frame, budget) {
                // On Windows libusb's HID backend counts the report id too: 1025 written for a
                // 1024-byte frame (measured 21.11.2026).
                Ok(written) if written >= shared.frame => Ok(()),
                Ok(written) => Err(TransportError::transport_failed(format!(
                    "USB send delivered {written} of {} bytes.",
                    shared.frame
                ))),
                Err(error) => Err(TransportError::transport_failed(format!(
                    "USB send failed: {error}"
                ))),
            }
        })
        .await
    }

    /// Reads until one readable reply arrives and returns the packet it declares, without the
    /// padding behind it.
    async fn read(
        self: &Arc<Self>,
        budget: Duration,
        tolerate_unreadable: bool,
    ) -> Result<Vec<u8>, TransportError> {
        for _ in 0..=MAX_STALE_REPLIES {
            let shared = self.clone();
            let data = run_blocking(&self.in_flight, move || {
                let _one = shared
                    .transfer
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                if shared.is_closed() {
                    return Err(TransportError::transport_failed(CLOSED_DURING_EXCHANGE));
                }
                let mut buffer = vec![0u8; shared.frame + shared.slack];
                let result = shared
                    .handle
                    .read_interrupt(shared.ep_in, &mut buffer, budget);
                if shared.is_closed() {
                    return Err(TransportError::transport_failed(CLOSED_DURING_EXCHANGE));
                }
                match result {
                    Ok(0) => Err(TransportError::transport_failed(
                        "USB receive returned no data.",
                    )),
                    Ok(read) => {
                        buffer.truncate(read.min(buffer.len()));
                        Ok(buffer)
                    }
                    Err(error) => Err(TransportError::transport_failed(format!(
                        "USB receive failed: {error}"
                    ))),
                }
            })
            .await?;
            match extract_length_prefixed_packet(&data) {
                Some((packet, _padding)) => return Ok(packet.to_vec()),
                // On Linux a freshly plugged brick has one packet of garbage waiting on its IN
                // endpoint, declaring a length the transfer cannot hold (measured 13.11.2026,
                // two re-plugs). While a known counter is awaited it is stepped over like a
                // stale reply.
                None if tolerate_unreadable => {}
                None => {
                    return Err(TransportError::transport_failed(format!(
                        "USB reply of {} bytes is shorter than the packet it declares.",
                        data.len()
                    )));
                }
            }
        }
        Err(TransportError::transport_failed(format!(
            "USB reply stream stayed out of step after {MAX_STALE_REPLIES} stale replies."
        )))
    }

    /// Clears one endpoint, best effort, and waits for it at most [`CLEAR_HALT_MAX`]. The
    /// request stays counted until libusb answers, so a close waits for it rather than release
    /// the interface under it.
    async fn clear_halt(self: &Arc<Self>, endpoint: u8) {
        let shared = self.clone();
        let counted = self.in_flight.start();
        let call = tokio::task::spawn_blocking(move || {
            let _counted = counted;
            let _ = shared.handle.clear_halt(endpoint);
        });
        let _ = tokio::time::timeout(CLEAR_HALT_MAX, call).await;
    }
}

impl Drop for Shared {
    /// A link nobody closed (an open whose caller went away) still gives the device back.
    fn drop(&mut self) {
        self.release_once();
    }
}

/// What the claim step hands to the open.
struct Claimed {
    handle: Arc<dyn UsbHandle>,
    location: UsbLocation,
    ep_in: u8,
    ep_out: u8,
    frame: usize,
    detached_by_hand: bool,
}

impl LibusbLink {
    /// Finds the brick, opens it and claims its command interface.
    pub async fn open(
        backend: Arc<dyn UsbBackend>,
        options: LibusbOpenOptions,
    ) -> Result<Self, LibusbOpenError> {
        let in_flight = InFlight::new();
        let platform = options.platform;
        let send_timeout = options.send_timeout;
        // The owner that gives the device back is made inside the blocking call, so a caller
        // that stops waiting while the claim runs still gets the interface released and the
        // kernel driver reattached once the claim lands.
        let owner_in_flight = in_flight.clone();
        let shared = run_blocking(&in_flight, move || {
            Ok(find_and_claim(&*backend, &options).map(|claimed| {
                Arc::new(Shared {
                    handle: claimed.handle,
                    location: claimed.location,
                    ep_in: claimed.ep_in,
                    ep_out: claimed.ep_out,
                    frame: claimed.frame,
                    slack: platform.read_slack(),
                    platform,
                    detached_by_hand: claimed.detached_by_hand,
                    closed: AtomicBool::new(false),
                    released: Mutex::new(false),
                    transfer: Mutex::new(()),
                    in_flight: owner_in_flight,
                })
            }))
        })
        .await
        .map_err(|error| LibusbOpenError::plain(error.message))??;
        if platform == Platform::Linux {
            // Taking the interface from `usbhid` leaves the endpoints' data toggle out of step
            // with the brick's, and the first reply after every detach was dropped as a
            // duplicate: the first exchange of each connect timed out (measured 13.11.2026, all
            // three bricks). A clear-halt resets the toggle on both ends.
            shared.clear_halt(shared.ep_in).await;
            shared.clear_halt(shared.ep_out).await;
        }
        Ok(Self {
            shared,
            exchanger: AsyncMutex::new(Exchanger::new("USB", send_timeout)),
            send_timeout,
        })
    }
}

#[async_trait]
impl UsbLink for LibusbLink {
    fn backend(&self) -> UsbBackendKind {
        UsbBackendKind::Libusb
    }

    /// Read from the endpoints rather than assumed: the smaller of the two directions.
    fn max_packet_bytes(&self) -> Option<usize> {
        (!self.shared.is_closed()).then_some(self.shared.frame)
    }

    fn location(&self) -> Option<UsbLocation> {
        Some(self.shared.location)
    }

    async fn send(&self, packet: &[u8], options: &SendOptions) -> Result<Vec<u8>, TransportError> {
        if self.shared.is_closed() {
            return Err(TransportError::transport_failed(
                "USB transport is not open.",
            ));
        }
        if packet.len() > self.shared.frame {
            return Err(TransportError::transport_failed(format!(
                "USB packet of {} bytes exceeds the {}-byte frame this endpoint carries.",
                packet.len(),
                self.shared.frame
            )));
        }
        let mut io = Io {
            shared: self.shared.clone(),
            budget: options.timeout.unwrap_or(self.send_timeout),
            tolerate_unreadable: self.shared.platform == Platform::Linux
                && options.expected_message_counter.is_some(),
        };
        let mut exchanger = self.exchanger.lock().await;
        exchanger.exchange(&mut io, packet, options).await
    }

    async fn close(&self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        // A send that gave up leaves its transfer with libusb until libusb's own timeout
        // returns it. Release before close, and never under a transfer still running.
        self.shared.in_flight.drained(CLOSE_DRAIN_MAX).await;
        let shared = self.shared.clone();
        let _ = tokio::task::spawn_blocking(move || shared.release_once()).await;
    }
}

/// One exchange's view of the link: the budget becomes libusb's own transfer timeout, so a
/// transfer whose caller gave up ends by itself.
struct Io {
    shared: Arc<Shared>,
    budget: Duration,
    tolerate_unreadable: bool,
}

#[async_trait]
impl LinkIo for Io {
    async fn write_packet(&mut self, packet: &[u8]) -> Result<(), TransportError> {
        self.shared.write(packet, self.budget).await
    }

    async fn read_some(&mut self, into: &mut Vec<u8>) -> Result<(), TransportError> {
        let packet = self
            .shared
            .read(self.budget, self.tolerate_unreadable)
            .await?;
        into.extend_from_slice(&packet);
        Ok(())
    }
}

/// Finds the brick, opens it and claims the command interface. Runs on the blocking pool.
fn find_and_claim(
    backend: &dyn UsbBackend,
    options: &LibusbOpenOptions,
) -> Result<Claimed, LibusbOpenError> {
    let devices = backend.devices().map_err(|error| {
        LibusbOpenError::plain(format!("Could not list the USB bus. ({error})"))
    })?;
    let candidates: Vec<Arc<dyn UsbDevice>> = devices
        .into_iter()
        .filter(|device| device.vendor_id() == VENDOR_ID && device.product_id() == PRODUCT_ID)
        .collect();
    if candidates.is_empty() {
        return Err(LibusbOpenError::plain("No EV3 found on the USB bus."));
    }
    let (device, handle) = match &options.serial {
        Some(serial) => find_by_serial(&candidates, serial, options)?,
        None => open_first(&candidates, options)?,
    };
    claim(device.as_ref(), handle, options.platform)
}

/// A device and the handle it was opened with.
type Opened = (Arc<dyn UsbDevice>, Arc<dyn UsbHandle>);

/// The first EV3 nobody holds.
fn open_first(
    candidates: &[Arc<dyn UsbDevice>],
    options: &LibusbOpenOptions,
) -> Result<Opened, LibusbOpenError> {
    let device = candidates
        .iter()
        .find(|device| !options.in_use.contains(&device.location()))
        .ok_or_else(|| LibusbOpenError::plain("Every EV3 on the USB bus is in use."))?;
    match device.open() {
        Ok(handle) => Ok((device.clone(), handle)),
        Err(UsbError::Access) if options.platform == Platform::Linux => Err(
            LibusbOpenError::permission(UsbError::Access, options.udev_rule_path.as_deref()),
        ),
        Err(error) => Err(LibusbOpenError::plain(format!(
            "Could not open the EV3's USB device. ({error})"
        ))),
    }
}

/// Opens every EV3 nobody holds in turn until one reports `serial`, closing the others.
fn find_by_serial(
    candidates: &[Arc<dyn UsbDevice>],
    serial: &str,
    options: &LibusbOpenOptions,
) -> Result<Opened, LibusbOpenError> {
    let wanted = serial.trim().to_lowercase();
    let mut refused = false;
    for candidate in candidates {
        if options.in_use.contains(&candidate.location()) {
            continue;
        }
        match candidate.open() {
            Ok(handle) => {
                let found = handle
                    .serial_number()
                    .is_some_and(|got| got.trim().to_lowercase() == wanted);
                if found {
                    return Ok((candidate.clone(), handle));
                }
                // Dropping the handle closes the device: a brick we did not want must not stay
                // open, or a later connect to it fails.
            }
            // A device that refused may be exactly the brick asked for: its serial was never
            // read.
            Err(UsbError::Access) => refused = true,
            Err(_) => {}
        }
    }
    if refused && options.platform == Platform::Linux {
        return Err(LibusbOpenError::permission(
            UsbError::Access,
            options.udev_rule_path.as_deref(),
        ));
    }
    Err(LibusbOpenError::plain(format!(
        "No EV3 on the USB bus reports serial {}.",
        wanted.to_uppercase()
    )))
}

/// Frees the interface from a kernel driver (Linux only).
///
/// The kernel's `usbhid` binds an EV3's interface 0, so a bare claim fails with
/// `LIBUSB_ERROR_BUSY` and the connect lands on 64-byte HID (measured 13.11.2026, all three
/// bricks). Detaching needs no root. libusb's auto-detach is preferred: the release then gives
/// the driver back by itself.
///
/// Returns true when it detached by hand, so the release must reattach.
fn free_from_kernel_driver(handle: &dyn UsbHandle, interface: u8) -> Result<bool, UsbError> {
    if handle.set_auto_detach_kernel_driver(true).is_ok() {
        return Ok(false);
    }
    if handle.kernel_driver_active(interface).unwrap_or(false) {
        handle.detach_kernel_driver(interface)?;
        return Ok(true);
    }
    Ok(false)
}

fn claim(
    device: &dyn UsbDevice,
    handle: Arc<dyn UsbHandle>,
    platform: Platform,
) -> Result<Claimed, LibusbOpenError> {
    let interface = COMMAND_INTERFACE;
    let freed = if platform == Platform::Linux {
        free_from_kernel_driver(handle.as_ref(), interface)
    } else {
        Ok(false)
    };
    let (detached_by_hand, claimed) = match freed {
        Ok(detached) => (detached, handle.claim_interface(interface)),
        Err(error) => (false, Err(error)),
    };
    if let Err(error) = claimed {
        if detached_by_hand {
            let _ = handle.attach_kernel_driver(interface);
        }
        return Err(LibusbOpenError::plain(format!(
            "Could not claim USB interface {interface} on the brick. ({error})"
        )));
    }

    let give_back = |message: String| {
        let _ = handle.release_interface(interface);
        if detached_by_hand {
            let _ = handle.attach_kernel_driver(interface);
        }
        LibusbOpenError::plain(message)
    };
    let endpoints = device.interface_endpoints(interface).unwrap_or_default();
    // By transfer type as well as direction: interface 1 on an EV3 is mass storage with bulk
    // endpoints, and a bulk pair would hang on the first transfer.
    let pick = |direction: EndpointDirection| -> Option<EndpointInfo> {
        endpoints
            .iter()
            .copied()
            .find(|ep| ep.direction == direction && ep.transfer == TransferKind::Interrupt)
    };
    let (Some(ep_in), Some(ep_out)) = (pick(EndpointDirection::In), pick(EndpointDirection::Out))
    else {
        return Err(give_back(format!(
            "USB interface {interface} has no interrupt endpoint pair."
        )));
    };
    // Both directions advertise the same size on an EV3; take the smaller if a device ever
    // disagrees, because a transfer must match its endpoint exactly.
    let frame = usize::from(ep_in.max_packet_size.min(ep_out.max_packet_size));
    if frame == 0 {
        return Err(give_back(
            "USB interrupt endpoint advertises no packet size.".into(),
        ));
    }
    Ok(Claimed {
        location: device.location(),
        handle,
        ep_in: ep_in.address,
        ep_out: ep_out.address,
        frame,
        detached_by_hand,
    })
}
