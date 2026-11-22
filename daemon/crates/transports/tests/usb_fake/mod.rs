//! A fake USB bus behind the backend traits: devices that record what was done to them and
//! answer with what a test queued, the way the TypeScript tests' module loader did.

#![allow(dead_code)] // each test binary uses its own part of this module

use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use ev3_protocol::encode_ev3_packet;
use ev3_protocol::packet::command;
use ev3_transports::usb::{
    EndpointDirection, EndpointInfo, HidBackend, HidDeviceInfo, HidHandle, LibusbOpenOptions,
    NodeAccess, Platform, TransferKind, UsbBackend, UsbDevice, UsbError, UsbHandle, UsbLocation,
};

pub const FRAME: usize = 1024;

/// Longest a held call waits for its answer. Bounded, so a test that fails before answering
/// still ends instead of leaving a blocking thread its runtime waits for.
const HELD_AT_MOST: Duration = Duration::from_secs(10);

/// A reply in the brick's framing: length prefix, message counter, type, then a body.
pub fn reply_packet(counter: u16, body: &[u8]) -> Vec<u8> {
    let mut payload = counter.to_le_bytes().to_vec();
    payload.push(0x03);
    payload.extend_from_slice(body);
    let mut framed = u16::try_from(payload.len()).unwrap().to_le_bytes().to_vec();
    framed.extend_from_slice(&payload);
    framed
}

/// What the wire hands back: the packet, then padding to the full frame.
pub fn padded(counter: u16, body: &[u8]) -> Vec<u8> {
    let mut frame = vec![0u8; FRAME];
    let packet = reply_packet(counter, body);
    frame[..packet.len()].copy_from_slice(&packet);
    frame
}

/// A frame that declares more than it carries: what a freshly plugged brick left on Linux.
pub fn unreadable() -> Vec<u8> {
    let mut frame = vec![0u8; FRAME];
    frame[..2].copy_from_slice(&4000u16.to_le_bytes());
    frame[600] = 0x7e;
    frame
}

/// A direct command numbered `counter` whose whole packet is `total` bytes.
pub fn command_of(counter: u16, total: usize) -> Vec<u8> {
    let packet = encode_ev3_packet(
        u32::from(counter),
        command::DIRECT_COMMAND_REPLY,
        &vec![0u8; total - 5],
    )
    .unwrap();
    assert_eq!(packet.len(), total);
    packet
}

pub fn interrupt_pair(in_size: u16, out_size: u16) -> Vec<EndpointInfo> {
    vec![
        EndpointInfo {
            address: 0x81,
            direction: EndpointDirection::In,
            transfer: TransferKind::Interrupt,
            max_packet_size: in_size,
        },
        EndpointInfo {
            address: 0x01,
            direction: EndpointDirection::Out,
            transfer: TransferKind::Interrupt,
            max_packet_size: out_size,
        },
    ]
}

/// Open options for a link test.
pub fn open_options(platform: Platform, serial: Option<&str>) -> LibusbOpenOptions {
    LibusbOpenOptions {
        serial: serial.map(str::to_owned),
        in_use: Vec::new(),
        platform,
        udev_rule_path: None,
        send_timeout: Duration::from_secs(1),
    }
}

/// What one fake device is and does.
#[derive(Clone)]
pub struct Spec {
    pub serial: Option<String>,
    pub product: Option<String>,
    pub vendor_id: u16,
    pub product_id: u16,
    pub endpoints: Vec<EndpointInfo>,
    pub replies: Vec<Vec<u8>>,
    pub send_error: Option<UsbError>,
    pub claim_error: Option<UsbError>,
    pub open_error: Option<UsbError>,
    /// What a write reports written; the data's length when unset.
    pub write_reports: Option<usize>,
    pub bus: u8,
    /// Defaults to 10 plus the device's index.
    pub address: Option<u8>,
    /// How many reads, from the first, never return on their own: a read still inside libusb
    /// until the test answers it.
    pub hold_reads: usize,
    /// A kernel driver holds the interface, as Linux's `usbhid` holds an EV3's: the claim fails
    /// with `LIBUSB_ERROR_BUSY` until it is detached.
    pub kernel_driver_active: bool,
    /// The device offers libusb's auto-detach.
    pub auto_detach: bool,
    /// Clear-halts wait until the test answers them.
    pub hold_clear_halt: bool,
    pub clear_halt_error: Option<UsbError>,
    /// The claim waits until the test answers it.
    pub hold_claim: bool,
}

impl Default for Spec {
    fn default() -> Self {
        Self {
            serial: None,
            product: None,
            vendor_id: 0x0694,
            product_id: 0x0005,
            endpoints: interrupt_pair(1024, 1024),
            replies: Vec::new(),
            send_error: None,
            claim_error: None,
            open_error: None,
            write_reports: None,
            bus: 2,
            address: None,
            hold_reads: 0,
            kernel_driver_active: false,
            auto_detach: true,
            hold_clear_halt: false,
            hold_claim: false,
            clear_halt_error: None,
        }
    }
}

impl Spec {
    pub fn serial(serial: &str) -> Self {
        Self {
            serial: Some(serial.into()),
            ..Self::default()
        }
    }
}

/// An answer to a held read.
pub type ReadAnswer = Result<Vec<u8>, UsbError>;

#[derive(Default)]
pub struct Recorded {
    /// What happened, in order: `claim`, `release`, `close`, `read-callback`, `clearHalt:in`, ...
    pub events: Vec<String>,
    pub sent: Vec<Vec<u8>>,
    pub read_lengths: Vec<usize>,
    pub opened: Vec<String>,
    pub closed: Vec<String>,
    pub claimed: usize,
    pub released: usize,
    pub held_reads: Vec<mpsc::Sender<ReadAnswer>>,
    pub held_clear_halts: Vec<mpsc::Sender<()>>,
    pub held_claims: Vec<mpsc::Sender<()>>,
}

#[derive(Clone, Default)]
pub struct Log(Arc<Mutex<Recorded>>);

impl Log {
    pub fn get(&self) -> MutexGuard<'_, Recorded> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn events(&self) -> Vec<String> {
        self.get().events.clone()
    }

    fn event(&self, event: &str) {
        self.get().events.push(event.into());
    }

    /// Answers the oldest held read.
    pub fn answer_read(&self, answer: ReadAnswer) {
        let sender = self.get().held_reads.remove(0);
        sender.send(answer).unwrap();
    }

    pub fn held_reads(&self) -> usize {
        self.get().held_reads.len()
    }

    pub fn held_clear_halts(&self) -> usize {
        self.get().held_clear_halts.len()
    }

    pub fn answer_clear_halt(&self, index: usize) {
        let sender = self.get().held_clear_halts.remove(index);
        let _ = sender.send(());
    }

    pub fn answer_claim(&self) {
        let sender = self.get().held_claims.remove(0);
        let _ = sender.send(());
    }

    /// Lets every held call go, so no blocking thread outlives the test.
    pub fn release_all(&self) {
        let mut log = self.get();
        log.held_reads.clear();
        log.held_clear_halts.clear();
        log.held_claims.clear();
    }

    /// Polls until `condition` holds, failing after two seconds.
    pub async fn wait_until(&self, what: &str, condition: impl Fn(&Recorded) -> bool) {
        let started = Instant::now();
        while !condition(&self.get()) {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "timed out waiting for {what}; events {:?}",
                self.events()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

struct DeviceState {
    replies: VecDeque<Vec<u8>>,
    kernel_held: bool,
    auto_detach_on: bool,
    /// After the kernel driver is taken off, the endpoints' data toggle no longer matches the
    /// brick's and the first reply is dropped, until a clear-halt resets both sides.
    toggle_out_of_step: bool,
    reads: usize,
}

pub struct FakeDevice {
    name: String,
    spec: Spec,
    location: UsbLocation,
    state: Arc<Mutex<DeviceState>>,
    log: Log,
}

pub struct FakeBus {
    devices: Mutex<Vec<Arc<FakeDevice>>>,
    pub log: Log,
}

impl FakeBus {
    pub fn new(specs: Vec<Spec>) -> Arc<Self> {
        let log = Log::default();
        let devices = specs
            .into_iter()
            .enumerate()
            .map(|(index, spec)| Arc::new(device(index, spec, &log)))
            .collect();
        Arc::new(Self {
            devices: Mutex::new(devices),
            log,
        })
    }

    /// Unplugs every device: the bus lists nothing from now on.
    pub fn unplug_all(&self) {
        self.devices.lock().unwrap().clear();
    }
}

fn device(index: usize, spec: Spec, log: &Log) -> FakeDevice {
    let address = spec.address.unwrap_or(10 + u8::try_from(index).unwrap());
    FakeDevice {
        name: spec
            .serial
            .clone()
            .unwrap_or_else(|| format!("device{index}")),
        location: UsbLocation {
            bus: spec.bus,
            address,
        },
        state: Arc::new(Mutex::new(DeviceState {
            replies: spec.replies.iter().cloned().collect(),
            kernel_held: spec.kernel_driver_active,
            auto_detach_on: false,
            toggle_out_of_step: false,
            reads: 0,
        })),
        spec,
        log: log.clone(),
    }
}

impl UsbBackend for FakeBus {
    fn devices(&self) -> Result<Vec<Arc<dyn UsbDevice>>, UsbError> {
        Ok(self
            .devices
            .lock()
            .unwrap()
            .iter()
            .map(|device| device.clone() as Arc<dyn UsbDevice>)
            .collect())
    }
}

impl UsbDevice for FakeDevice {
    fn vendor_id(&self) -> u16 {
        self.spec.vendor_id
    }

    fn product_id(&self) -> u16 {
        self.spec.product_id
    }

    fn location(&self) -> UsbLocation {
        self.location
    }

    fn interface_endpoints(&self, _interface: u8) -> Result<Vec<EndpointInfo>, UsbError> {
        Ok(self.spec.endpoints.clone())
    }

    fn open(&self) -> Result<Arc<dyn UsbHandle>, UsbError> {
        if let Some(error) = self.spec.open_error {
            return Err(error);
        }
        self.log.get().opened.push(self.name.clone());
        Ok(Arc::new(FakeHandle {
            name: self.name.clone(),
            spec: self.spec.clone(),
            state: self.state.clone(),
            log: self.log.clone(),
        }))
    }
}

struct FakeHandle {
    name: String,
    spec: Spec,
    state: Arc<Mutex<DeviceState>>,
    log: Log,
}

impl FakeHandle {
    fn state(&self) -> MutexGuard<'_, DeviceState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for FakeHandle {
    fn drop(&mut self) {
        let mut log = self.log.get();
        log.closed.push(self.name.clone());
        log.events.push("close".into());
    }
}

impl UsbHandle for FakeHandle {
    fn serial_number(&self) -> Option<String> {
        self.spec.serial.clone()
    }

    fn product(&self) -> Option<String> {
        self.spec.product.clone()
    }

    fn set_auto_detach_kernel_driver(&self, enable: bool) -> Result<(), UsbError> {
        if !self.spec.auto_detach {
            return Err(UsbError::NotSupported);
        }
        self.state().auto_detach_on = enable;
        self.log.event(&format!("autoDetach:{enable}"));
        Ok(())
    }

    fn kernel_driver_active(&self, _interface: u8) -> Result<bool, UsbError> {
        Ok(self.state().kernel_held)
    }

    fn detach_kernel_driver(&self, _interface: u8) -> Result<(), UsbError> {
        let mut state = self.state();
        state.kernel_held = false;
        state.toggle_out_of_step = true;
        self.log.event("detach");
        Ok(())
    }

    fn attach_kernel_driver(&self, _interface: u8) -> Result<(), UsbError> {
        self.state().kernel_held = true;
        self.log.event("attach");
        Ok(())
    }

    fn claim_interface(&self, _interface: u8) -> Result<(), UsbError> {
        if self.spec.hold_claim {
            let (sender, receiver) = mpsc::channel();
            self.log.get().held_claims.push(sender);
            let _ = receiver.recv_timeout(HELD_AT_MOST);
        }
        if let Some(error) = self.spec.claim_error {
            return Err(error);
        }
        let mut state = self.state();
        if state.kernel_held && !state.auto_detach_on {
            return Err(UsbError::Busy);
        }
        if state.kernel_held {
            state.kernel_held = false;
            state.toggle_out_of_step = true;
            self.log.event("auto-detached");
        }
        drop(state);
        let mut log = self.log.get();
        log.claimed += 1;
        log.events.push("claim".into());
        Ok(())
    }

    fn release_interface(&self, _interface: u8) -> Result<(), UsbError> {
        let mut log = self.log.get();
        log.released += 1;
        log.events.push("release".into());
        Ok(())
    }

    fn clear_halt(&self, endpoint: u8) -> Result<(), UsbError> {
        let direction = if endpoint & 0x80 != 0 { "in" } else { "out" };
        self.log.event(&format!("clearHalt:{direction}"));
        if self.spec.hold_clear_halt {
            let (sender, receiver) = mpsc::channel();
            self.log.get().held_clear_halts.push(sender);
            let _ = receiver.recv_timeout(HELD_AT_MOST);
        }
        if let Some(error) = self.spec.clear_halt_error {
            return Err(error);
        }
        self.state().toggle_out_of_step = false;
        Ok(())
    }

    fn write_interrupt(
        &self,
        _endpoint: u8,
        data: &[u8],
        _timeout: Duration,
    ) -> Result<usize, UsbError> {
        self.log.get().sent.push(data.to_vec());
        if let Some(error) = self.spec.send_error {
            return Err(error);
        }
        Ok(self.spec.write_reports.unwrap_or(data.len()))
    }

    fn read_interrupt(
        &self,
        _endpoint: u8,
        buf: &mut [u8],
        _timeout: Duration,
    ) -> Result<usize, UsbError> {
        self.log.get().read_lengths.push(buf.len());
        let held = {
            let mut state = self.state();
            if state.toggle_out_of_step {
                state.toggle_out_of_step = false;
                state.replies.pop_front();
                return Err(UsbError::Timeout);
            }
            state.reads += 1;
            state.reads <= self.spec.hold_reads
        };
        let answer = if held {
            let (sender, receiver) = mpsc::channel();
            self.log.get().held_reads.push(sender);
            let answer = receiver
                .recv_timeout(HELD_AT_MOST)
                .unwrap_or(Err(UsbError::Interrupted));
            self.log.event("read-callback");
            answer
        } else {
            self.state().replies.pop_front().ok_or(UsbError::Timeout)
        };
        let data = answer?;
        let copied = data.len().min(buf.len());
        buf[..copied].copy_from_slice(&data[..copied]);
        Ok(data.len())
    }
}

#[derive(Default)]
pub struct HidRecorded {
    pub opened: Vec<String>,
    pub written: Vec<Vec<u8>>,
    pub access_asked: Vec<String>,
}

/// A fake hidapi: the devices it lists, and reports it answers reads with.
pub struct FakeHid {
    pub devices: Mutex<Vec<HidDeviceInfo>>,
    pub open_error: Option<String>,
    pub access: NodeAccess,
    pub write_reports: Option<usize>,
    pub reports: Arc<Mutex<VecDeque<Vec<u8>>>>,
    pub log: Arc<Mutex<HidRecorded>>,
}

impl FakeHid {
    pub fn new(devices: Vec<HidDeviceInfo>) -> Self {
        Self {
            devices: Mutex::new(devices),
            open_error: None,
            access: NodeAccess::Unknown,
            write_reports: None,
            reports: Arc::default(),
            log: Arc::default(),
        }
    }

    /// One brick with this serial at `path`.
    pub fn brick(path: &str, serial: &str, product: Option<&str>) -> HidDeviceInfo {
        HidDeviceInfo {
            path: path.into(),
            serial_number: Some(serial.into()),
            product: product.map(str::to_owned),
        }
    }

    pub fn set_devices(&self, devices: Vec<HidDeviceInfo>) {
        *self.devices.lock().unwrap() = devices;
    }

    pub fn queue_report(&self, report: Vec<u8>) {
        self.reports.lock().unwrap().push_back(report);
    }
}

impl HidBackend for FakeHid {
    fn devices(&self, vendor_id: u16, product_id: u16) -> Result<Vec<HidDeviceInfo>, String> {
        assert_eq!((vendor_id, product_id), (0x0694, 0x0005));
        Ok(self.devices.lock().unwrap().clone())
    }

    fn open(&self, path: &str) -> Result<Box<dyn HidHandle>, String> {
        if let Some(error) = &self.open_error {
            return Err(error.clone());
        }
        self.log.lock().unwrap().opened.push(path.into());
        Ok(Box::new(FakeHidHandle {
            reports: self.reports.clone(),
            log: self.log.clone(),
            write_reports: self.write_reports,
        }))
    }

    fn node_access(&self, path: &str) -> NodeAccess {
        self.log.lock().unwrap().access_asked.push(path.into());
        self.access
    }
}

struct FakeHidHandle {
    reports: Arc<Mutex<VecDeque<Vec<u8>>>>,
    log: Arc<Mutex<HidRecorded>>,
    write_reports: Option<usize>,
}

impl HidHandle for FakeHidHandle {
    fn write(&mut self, report: &[u8]) -> Result<usize, String> {
        self.log.lock().unwrap().written.push(report.to_vec());
        Ok(self.write_reports.unwrap_or(report.len()))
    }

    fn read_timeout(&mut self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, String> {
        let next = self.reports.lock().unwrap().pop_front();
        let Some(report) = next else {
            let wait = u64::try_from(timeout_ms.clamp(1, 20)).unwrap();
            std::thread::sleep(Duration::from_millis(wait));
            return Ok(0);
        };
        let copied = report.len().min(buf.len());
        buf[..copied].copy_from_slice(&report[..copied]);
        Ok(copied)
    }
}
