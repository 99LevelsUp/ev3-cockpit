//! The HID fallback: the brick over hidapi, 64 bytes per packet.
//!
//! Works, but is not equivalent to libusb: transfers run about forty times slower, and `copy`
//! and `move` carry two paths and do not fit a 64-byte packet at all.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::sync::Mutex as AsyncMutex;

use super::backend::{HidBackend, HidHandle, UsbLocation};
use super::link::{CLOSED_DURING_EXCHANGE, InFlight, UsbBackendKind, UsbLink, run_blocking};
use super::{
    CLOSE_DRAIN_MAX, HID_PACKET_BYTES, HID_REPORT_ID, HID_REPORT_SIZE, PRODUCT_ID, VENDOR_ID,
};
use crate::error::TransportError;
use crate::pending::{Exchanger, LinkIo};
use crate::provider::SendOptions;

/// How long one hidapi read waits before the loop looks again whether the exchange is still
/// wanted. Bounds how long a close waits for a read nobody waits for.
const READ_POLL: Duration = Duration::from_millis(100);

/// An open HID link.
pub struct HidLink {
    shared: Arc<Shared>,
    exchanger: AsyncMutex<Exchanger>,
    send_timeout: Duration,
}

struct Shared {
    device: Mutex<Option<Box<dyn HidHandle>>>,
    /// Report payloads received and not yet taken as a packet. Cleared when a request goes out:
    /// the brick is strictly request-reply, so anything left belongs to an abandoned exchange.
    received: Mutex<Vec<u8>>,
    packet_bytes: usize,
    closed: AtomicBool,
    /// One transfer at a time, so a read nobody waits for cannot take the next reply.
    transfer: Mutex<()>,
    in_flight: InFlight,
}

impl Shared {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

impl HidLink {
    /// Opens the brick with `serial`, or the first EV3 HID device without one.
    pub async fn open(
        backend: Arc<dyn HidBackend>,
        serial: Option<String>,
        send_timeout: Duration,
    ) -> Result<Self, String> {
        let in_flight = InFlight::new();
        let device = run_blocking(&in_flight, move || {
            Ok(open_device(&*backend, serial.as_deref()))
        })
        .await
        .map_err(|error| error.message)??;
        Ok(Self {
            shared: Arc::new(Shared {
                device: Mutex::new(Some(device)),
                received: Mutex::new(Vec::new()),
                packet_bytes: HID_PACKET_BYTES,
                closed: AtomicBool::new(false),
                transfer: Mutex::new(()),
                in_flight,
            }),
            exchanger: AsyncMutex::new(Exchanger::new("USB", send_timeout)),
            send_timeout,
        })
    }
}

fn open_device(
    backend: &dyn HidBackend,
    serial: Option<&str>,
) -> Result<Box<dyn HidHandle>, String> {
    let devices = backend.devices(VENDOR_ID, PRODUCT_ID)?;
    let ids = format!("vendor=0x{VENDOR_ID:04x}, product=0x{PRODUCT_ID:04x}");
    let path = match serial {
        None => devices
            .iter()
            .find(|device| !device.path.is_empty())
            .map(|device| device.path.clone())
            .ok_or_else(|| format!("No EV3 USB HID device found ({ids})."))?,
        Some(serial) => {
            let wanted = serial.trim().to_lowercase();
            devices
                .iter()
                .find(|device| {
                    !device.path.is_empty()
                        && device
                            .serial_number
                            .as_deref()
                            .is_some_and(|got| got.trim().to_lowercase() == wanted)
                })
                .map(|device| device.path.clone())
                .ok_or_else(|| {
                    format!(
                        "No EV3 USB HID device found for serial {} ({ids}).",
                        wanted.to_uppercase()
                    )
                })?
        }
    };
    backend
        .open(&path)
        .map_err(|error| format!("Could not open the EV3's HID device {path}. ({error})"))
}

/// One report as it goes out: the report id, then the packet padded to what one write
/// delivers. Sized to what actually reaches the brick: handing the OS a 1025-byte report it
/// truncates to 65 is what hid the 64-byte limit for so long.
fn report_for(packet: &[u8], packet_bytes: usize) -> Vec<u8> {
    let mut report = vec![0u8; packet_bytes + 1];
    report[0] = HID_REPORT_ID;
    report[1..=packet.len()].copy_from_slice(packet);
    report
}

/// Drops the report id where a backend left it in front of the data.
fn strip_report_id(data: &[u8]) -> &[u8] {
    if data.len() > 1 && data[0] == HID_REPORT_ID {
        &data[1..]
    } else {
        data
    }
}

/// Takes the next whole packet off the receive buffer.
///
/// Reports are padded with zeros, so a header that cannot be one (a body under three bytes, or
/// longer than a report) is padding and is stepped over a byte at a time.
fn take_packet(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    while buffer.len() >= 2 {
        let body = usize::from(u16::from_le_bytes([buffer[0], buffer[1]]));
        let total = body + 2;
        if body < 3 || total > HID_REPORT_SIZE {
            buffer.remove(0);
            continue;
        }
        if buffer.len() < total {
            return None;
        }
        return Some(buffer.drain(..total).collect());
    }
    None
}

#[async_trait]
impl UsbLink for HidLink {
    fn backend(&self) -> UsbBackendKind {
        UsbBackendKind::Hid
    }

    /// What a HID write actually delivers, far below the frame the endpoints advertise.
    fn max_packet_bytes(&self) -> Option<usize> {
        (!self.shared.is_closed()).then_some(self.shared.packet_bytes)
    }

    fn location(&self) -> Option<UsbLocation> {
        None
    }

    async fn send(&self, packet: &[u8], options: &SendOptions) -> Result<Vec<u8>, TransportError> {
        if self.shared.is_closed() {
            return Err(TransportError::transport_failed(
                "USB transport is not open.",
            ));
        }
        if packet.len() > self.shared.packet_bytes {
            return Err(TransportError::transport_failed(format!(
                "USB packet of {} bytes exceeds the {} bytes a HID write delivers on this \
                 transport. Split it, or move bulk transfer to the libusb path.",
                packet.len(),
                self.shared.packet_bytes
            )));
        }
        let mut io = Io {
            shared: self.shared.clone(),
            budget: options.timeout.unwrap_or(self.send_timeout),
        };
        let mut exchanger = self.exchanger.lock().await;
        exchanger.exchange(&mut io, packet, options).await
    }

    async fn close(&self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared.in_flight.drained(CLOSE_DRAIN_MAX).await;
        let shared = self.shared.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _one = shared
                .transfer
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            shared
                .device
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
        })
        .await;
    }
}

struct Io {
    shared: Arc<Shared>,
    budget: Duration,
}

#[async_trait]
impl LinkIo for Io {
    async fn write_packet(&mut self, packet: &[u8]) -> Result<(), TransportError> {
        let report = report_for(packet, self.shared.packet_bytes);
        let shared = self.shared.clone();
        run_blocking(&self.shared.in_flight, move || {
            let _one = shared
                .transfer
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            shared
                .received
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear();
            let mut device = shared.device.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(device) = device.as_mut() else {
                return Err(TransportError::transport_failed(CLOSED_DURING_EXCHANGE));
            };
            match device.write(&report) {
                // A short write is silent corruption, not a slow path: the OS drops the tail and
                // the brick still advances its file pointer by the length the packet declares.
                // 0 is hidapi's own "not counted" (Windows, a write that completed at once).
                Ok(written) if written != 0 && written < report.len() => {
                    Err(TransportError::transport_failed(format!(
                        "USB HID write delivered {written} of {} bytes. Packets must stay within \
                         {} bytes on this transport.",
                        report.len(),
                        shared.packet_bytes
                    )))
                }
                Ok(_) => Ok(()),
                Err(error) => Err(TransportError::transport_failed(format!(
                    "USB HID write failed: {error}"
                ))),
            }
        })
        .await
    }

    async fn read_some(&mut self, into: &mut Vec<u8>) -> Result<(), TransportError> {
        let shared = self.shared.clone();
        let deadline = (!self.budget.is_zero()).then(|| Instant::now() + self.budget);
        let packet = run_blocking(&self.shared.in_flight, move || {
            let _one = shared
                .transfer
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let mut report = vec![0u8; HID_REPORT_SIZE];
            loop {
                if let Some(packet) = take_packet(
                    &mut shared
                        .received
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner),
                ) {
                    return Ok(packet);
                }
                if shared.is_closed() {
                    return Err(TransportError::transport_failed(CLOSED_DURING_EXCHANGE));
                }
                let wait = match deadline {
                    None => READ_POLL,
                    Some(deadline) => {
                        let left = deadline.saturating_duration_since(Instant::now());
                        if left.is_zero() {
                            return Err(TransportError::timeout("USB HID read timed out."));
                        }
                        left.min(READ_POLL)
                    }
                };
                let wait_ms = i32::try_from(wait.as_millis().max(1)).unwrap_or(i32::MAX);
                let mut device = shared.device.lock().unwrap_or_else(PoisonError::into_inner);
                let Some(device) = device.as_mut() else {
                    return Err(TransportError::transport_failed(CLOSED_DURING_EXCHANGE));
                };
                let read = device.read_timeout(&mut report, wait_ms).map_err(|error| {
                    TransportError::transport_failed(format!("USB HID read failed: {error}"))
                })?;
                if read > 0 {
                    let data = strip_report_id(&report[..read.min(report.len())]);
                    shared
                        .received
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .extend_from_slice(data);
                }
            }
        })
        .await?;
        into.extend_from_slice(&packet);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_is_the_id_then_the_packet_padded_to_what_one_write_delivers() {
        let report = report_for(&[0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00], 64);
        assert_eq!(report.len(), 65);
        assert_eq!(report[0], HID_REPORT_ID);
        assert_eq!(&report[1..8], &[0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
        assert!(report[8..].iter().all(|b| *b == 0));
    }

    #[test]
    fn padding_ahead_of_a_header_is_stepped_over() {
        let mut buffer = vec![
            0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00,
        ];
        assert_eq!(
            take_packet(&mut buffer),
            Some(vec![0x05, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00])
        );
        // Only padding is left, and it never makes a packet.
        assert_eq!(take_packet(&mut buffer), None);
    }

    #[test]
    fn a_header_longer_than_a_report_is_padding() {
        let mut buffer = vec![0xff, 0xff, 0x05, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00];
        assert_eq!(
            take_packet(&mut buffer),
            Some(vec![0x05, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00])
        );
    }

    #[test]
    fn a_packet_split_across_reports_waits_for_the_rest() {
        let mut buffer = vec![0x05, 0x00, 0x01];
        assert_eq!(take_packet(&mut buffer), None);
        buffer.extend_from_slice(&[0x00, 0x02, 0x00, 0x00]);
        assert_eq!(
            take_packet(&mut buffer),
            Some(vec![0x05, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00])
        );
    }

    #[test]
    fn a_leading_report_id_is_dropped() {
        assert_eq!(strip_report_id(&[0x00, 0x05, 0x00]), &[0x05, 0x00]);
        assert_eq!(strip_report_id(&[0x05, 0x00]), &[0x05, 0x00]);
        assert_eq!(strip_report_id(&[0x00]), &[0x00]);
    }
}
