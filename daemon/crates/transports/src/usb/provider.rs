//! The USB provider: discovery over both enumerations, a connection that prefers libusb and
//! falls back to HID out loud, and short probe links for one question outside a session.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard, OwnedMutexGuard, watch};
use tokio::task::JoinSet;

use super::backend::{HidBackend, HidDeviceInfo, NodeAccess, UsbBackend, UsbLocation};
use super::discovery::{ScanView, list_lego_devices, remember_names, scan_items};
use super::hid::HidLink;
use super::libusb::{LibusbLink, LibusbOpenError, LibusbOpenOptions};
use super::link::{UsbBackendKind, UsbLink};
use super::rusb_backend::RusbBackend;
use super::{HID_PACKET_BYTES, PRODUCT_ID, Platform, SEND_TIMEOUT, VENDOR_ID, linux_udev_advice};
use crate::brick_key::{BrickKey, Transport};
use crate::error::TransportError;
use crate::provider::{
    DiscoveryScanResult, ProbeLink, SendOptions, SessionHandle, TransportCapabilities,
    TransportProvider,
};

/// Somewhere to report which backend a connection ended up on, and why.
pub trait UsbLog: Send + Sync {
    fn info(&self, message: &str);
    fn warn(&self, message: &str);
}

/// How the provider is built.
#[derive(Clone)]
pub struct UsbProviderOptions {
    pub platform: Platform,
    /// Where this install keeps the udev rule a Linux permission message points at (absolute).
    pub udev_rule_path: Option<String>,
    pub log: Option<Arc<dyn UsbLog>>,
    /// The budget an exchange gets when its caller names none.
    pub send_timeout: Duration,
}

impl Default for UsbProviderOptions {
    fn default() -> Self {
        Self {
            platform: Platform::current(),
            udev_rule_path: None,
            log: None,
            send_timeout: SEND_TIMEOUT,
        }
    }
}

type ConnectOutcome = Option<Result<SessionHandle, TransportError>>;

#[derive(Default)]
struct State {
    sessions: HashMap<BrickKey, Arc<dyn UsbLink>>,
    /// Probe links open now. Their devices count as in use until they close.
    probes: HashMap<u64, Arc<LibusbLink>>,
    next_probe: u64,
    /// Devices whose link is closing: still in use until the close has waited for libusb to
    /// hand back transfers in flight.
    closing: Vec<UsbLocation>,
    /// Names read off the hardware, by lower-cased serial.
    names: HashMap<String, String>,
    /// Connects in flight, so a second connect to the same brick gets the same answer.
    connecting: HashMap<BrickKey, watch::Receiver<ConnectOutcome>>,
}

struct Inner {
    usb: Arc<dyn UsbBackend>,
    hid: Option<Arc<dyn HidBackend>>,
    options: UsbProviderOptions,
    state: Mutex<State>,
    /// Per brick, the queue its connects and probes wait in.
    brick_locks: Mutex<HashMap<BrickKey, Arc<AsyncMutex<()>>>>,
    /// Every opening of a device waits here, whichever brick it is for. Finding a brick by
    /// serial opens every EV3 on the bus in turn, and so does discovery; two of those at once,
    /// or one beside a link still opening, closed a device another link had just claimed with a
    /// transfer in flight (traced 30.10.2026). Whatever is opened under this lock is registered
    /// as in use before the lock is released.
    bus: AsyncMutex<()>,
    discovering: AtomicBool,
    disposed: watch::Sender<bool>,
}

/// The USB provider.
///
/// Discovery lists over hidapi, which needs no handle on the device, and reads names over
/// libusb. A connection prefers libusb, which reaches the brick's full 1024-byte frame, and
/// falls back to HID, with a warning, when libusb cannot claim the interface.
pub struct UsbTransportProvider {
    inner: Arc<Inner>,
}

impl UsbTransportProvider {
    /// The provider over the real bus: libusb, and hidapi where this build has it.
    pub fn new(options: UsbProviderOptions) -> Self {
        Self::with_backends(Arc::new(RusbBackend::new()), default_hid(), options)
    }

    /// The provider over the given backends. Tests pass a fake bus.
    pub fn with_backends(
        usb: Arc<dyn UsbBackend>,
        hid: Option<Arc<dyn HidBackend>>,
        options: UsbProviderOptions,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                usb,
                hid,
                options,
                state: Mutex::new(State::default()),
                brick_locks: Mutex::new(HashMap::new()),
                bus: AsyncMutex::new(()),
                discovering: AtomicBool::new(false),
                disposed: watch::channel(false).0,
            }),
        }
    }

    /// Which wire this brick is connected over; `None` without a session.
    pub fn backend_for(&self, brick_key: &BrickKey) -> Option<UsbBackendKind> {
        self.inner
            .state()
            .sessions
            .get(brick_key)
            .map(|link| link.backend())
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn default_hid() -> Option<Arc<dyn HidBackend>> {
    Some(Arc::new(super::hidapi_backend::HidapiBackend))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn default_hid() -> Option<Arc<dyn HidBackend>> {
    None
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// A brick as messages name it: its hardware id and the channel.
fn describe(key: &BrickKey) -> String {
    match key.hardware_id() {
        Some(id) => format!("{id} USB"),
        None => key.to_string(),
    }
}

/// The serial a USB key carries, when it is one: twelve hex digits.
fn serial_of(key: &BrickKey) -> Option<String> {
    let id = key.id();
    (id.len() == 12 && id.chars().all(|c| c.is_ascii_hexdigit())).then(|| id.to_owned())
}

fn disposed_error() -> TransportError {
    TransportError::transport_failed("The USB provider has been disposed.")
}

enum OpenFailure {
    Disposed,
    Open(LibusbOpenError),
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_disposed(&self) -> bool {
        *self.disposed.borrow()
    }

    fn check_disposed(&self) -> Result<(), TransportError> {
        if self.is_disposed() {
            Err(disposed_error())
        } else {
            Ok(())
        }
    }

    async fn until_disposed(&self) {
        let mut disposed = self.disposed.subscribe();
        let _ = disposed.wait_for(|disposed| *disposed).await;
    }

    fn log_info(&self, message: &str) {
        if let Some(log) = &self.options.log {
            log.info(message);
        }
    }

    fn log_warn(&self, message: &str) {
        if let Some(log) = &self.options.log {
            log.warn(message);
        }
    }

    /// Devices a session, an open probe or a closing link holds.
    fn in_use(&self) -> Vec<UsbLocation> {
        let state = self.state();
        state
            .sessions
            .values()
            .filter_map(|link| link.location())
            .chain(state.probes.values().filter_map(|link| link.location()))
            .chain(state.closing.iter().copied())
            .collect()
    }

    /// Waits its turn among the connects and probes of one brick. A dispose ends the wait: it
    /// must not wait on a lock some probe never gives back.
    async fn lock_brick(&self, key: &BrickKey) -> Result<OwnedMutexGuard<()>, TransportError> {
        let lock = self
            .brick_locks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key.clone())
            .or_default()
            .clone();
        tokio::select! {
            guard = lock.lock_owned() => Ok(guard),
            () = self.until_disposed() => Err(disposed_error()),
        }
    }

    /// Opens a libusb link alone on the bus. Returns the bus lock with it, so the caller
    /// registers the link as in use before anything else may open a device.
    async fn open_libusb(
        &self,
        serial: Option<String>,
    ) -> Result<(Arc<LibusbLink>, AsyncMutexGuard<'_, ()>), OpenFailure> {
        let bus = tokio::select! {
            guard = self.bus.lock() => guard,
            () = self.until_disposed() => return Err(OpenFailure::Disposed),
        };
        if self.is_disposed() {
            return Err(OpenFailure::Disposed);
        }
        let options = LibusbOpenOptions {
            serial,
            in_use: self.in_use(),
            platform: self.options.platform,
            udev_rule_path: self.options.udev_rule_path.clone(),
            send_timeout: self.options.send_timeout,
        };
        let link = LibusbLink::open(self.usb.clone(), options)
            .await
            .map_err(OpenFailure::Open)?;
        if self.is_disposed() {
            // Landed as the dispose came: give the device back, adopt nothing.
            link.close().await;
            return Err(OpenFailure::Disposed);
        }
        Ok((Arc::new(link), bus))
    }

    /// Closes a link, keeping its device in use until libusb has let go of it.
    async fn close_held(&self, link: &dyn UsbLink) {
        let location = link.location();
        if let Some(at) = location {
            self.state().closing.push(at);
        }
        link.close().await;
        if let Some(at) = location {
            let mut state = self.state();
            if let Some(index) = state.closing.iter().position(|held| *held == at) {
                state.closing.remove(index);
            }
        }
    }

    async fn connect(&self, key: &BrickKey) -> Result<SessionHandle, TransportError> {
        let _brick = self.lock_brick(key).await?;
        if self.state().sessions.contains_key(key) {
            return Err(TransportError::transport_failed(format!(
                "{} is already connected.",
                describe(key)
            )));
        }
        let serial = serial_of(key);
        let handle = SessionHandle {
            brick_key: key.clone(),
            transport: Transport::Usb,
        };

        // libusb first: it is the only path that carries a whole EV3 frame.
        let libusb_failure = match self.open_libusb(serial.clone()).await {
            Ok((link, _bus)) => {
                let frame = link.max_packet_bytes().unwrap_or_default();
                self.state().sessions.insert(key.clone(), link);
                self.log_info(&format!(
                    "{} connected over libusb, {frame}-byte frames.",
                    describe(key)
                ));
                return Ok(handle);
            }
            // A libusb open the dispose ended is not a reason to try HID.
            Err(OpenFailure::Disposed) => return Err(disposed_error()),
            Err(OpenFailure::Open(failure)) => failure,
        };
        self.connect_over_hid(key, serial, libusb_failure).await?;
        Ok(handle)
    }

    /// Falls back to HID, which works but is not equivalent, and says so.
    async fn connect_over_hid(
        &self,
        key: &BrickKey,
        serial: Option<String>,
        libusb: LibusbOpenError,
    ) -> Result<(), TransportError> {
        let channel = describe(key);
        let Some(hid) = self.hid.clone() else {
            return Err(TransportError::transport_failed(format!(
                "Connect failed for {channel}. libusb: {}. HID: not available on this platform.",
                libusb.message
            )));
        };
        match HidLink::open(hid, serial.clone(), self.options.send_timeout).await {
            Ok(link) => {
                if self.is_disposed() {
                    link.close().await;
                    return Err(disposed_error());
                }
                self.state().sessions.insert(key.clone(), Arc::new(link));
                // Said only once the fallback has happened: while a cable is out every
                // reconnect fails both ways, and a warning about a fallback that never came
                // filled the log with a cost nobody was paying.
                self.log_warn(&format!(
                    "{channel}: libusb unavailable ({}). Fell back to HID, which delivers \
                     {HID_PACKET_BYTES} bytes per packet: transfers run about forty times slower \
                     and copy/move cannot be sent at all.",
                    libusb.message
                ));
                Ok(())
            }
            Err(hid_message) => {
                if self.is_disposed() {
                    return Err(disposed_error());
                }
                // Permission from either backend, by its own code: libusb's refusal, and on
                // Linux the hidraw node itself. Not when that node is open to this user and HID
                // failed for another reason: then the rule is in place and something else is
                // wrong.
                let node = if self.options.platform == Platform::Linux {
                    self.hid_node_access(serial).await
                } else {
                    NodeAccess::Unknown
                };
                let refused = libusb.permission.is_some() || node == NodeAccess::Denied;
                if refused && node != NodeAccess::Granted {
                    // libusb's refusal carries the same advice; name only its code, so the
                    // advice is said once.
                    let libusb_detail = match libusb.permission {
                        Some(code) => format!("refused ({code})"),
                        None => libusb.message.clone(),
                    };
                    return Err(TransportError::transport_failed(format!(
                        "Connect failed for {channel}: this user may not open the EV3's USB \
                         device. {} libusb: {libusb_detail}. HID: {hid_message}",
                        linux_udev_advice(self.options.udev_rule_path.as_deref())
                    )));
                }
                // Name both failures: "connect failed" against a working brick usually means
                // the libusb claim lost to something, and only that message says so.
                Err(TransportError::transport_failed(format!(
                    "Connect failed for {channel}. libusb: {}. HID: {hid_message}",
                    libusb.message
                )))
            }
        }
    }

    /// Whether this user may open the brick's hidraw node, found by its serial.
    async fn hid_node_access(&self, serial: Option<String>) -> NodeAccess {
        let (Some(hid), Some(serial)) = (self.hid.clone(), serial) else {
            return NodeAccess::Unknown;
        };
        tokio::task::spawn_blocking(move || {
            let devices = hid.devices(VENDOR_ID, PRODUCT_ID).ok()?;
            let path = devices
                .into_iter()
                .find(|device| {
                    device
                        .serial_number
                        .as_deref()
                        .is_some_and(|got| got.trim().eq_ignore_ascii_case(&serial))
                })?
                .path;
            Some(hid.node_access(&path))
        })
        .await
        .ok()
        .flatten()
        .unwrap_or(NodeAccess::Unknown)
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        let listing = {
            let _bus = tokio::select! {
                guard = self.bus.lock() => guard,
                () = self.until_disposed() => return Err(disposed_error()),
            };
            self.check_disposed()?;
            // A brick with a live link is listed by location, never reopened: discovery runs on
            // a timer and would otherwise pry at a device its own transport holds claimed.
            let skip = self.in_use();
            let usb = self.usb.clone();
            tokio::task::spawn_blocking(move || list_lego_devices(&*usb, &skip))
                .await
                .unwrap_or_default()
        };
        self.check_disposed()?;

        let hid: Vec<HidDeviceInfo> = match self.hid.clone() {
            Some(hid) => tokio::task::spawn_blocking(move || hid.devices(VENDOR_ID, PRODUCT_ID))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default(),
            None => Vec::new(),
        };

        let (names, sessions) = {
            let mut state = self.state();
            remember_names(&mut state.names, &listing);
            let sessions: Vec<(BrickKey, Option<UsbLocation>)> = state
                .sessions
                .iter()
                .map(|(key, link)| (key.clone(), link.location()))
                .collect();
            (state.names.clone(), sessions)
        };
        Ok(DiscoveryScanResult {
            transport: Transport::Usb,
            items: scan_items(&ScanView {
                platform: self.options.platform,
                usb: &listing,
                hid: &hid,
                names: &names,
                sessions: &sessions,
                now_ms: now_ms(),
            }),
        })
    }

    async fn dispose(self: &Arc<Self>) {
        self.disposed.send_replace(true);
        // Every open still on the bus finishes first and, seeing the dispose, adopts nothing.
        let _bus = self.bus.lock().await;
        let links: Vec<Arc<dyn UsbLink>> = {
            let mut guard = self.state();
            let state = &mut *guard;
            let sessions = state.sessions.drain().map(|(_, link)| link);
            let probes = state
                .probes
                .drain()
                .map(|(_, link)| link as Arc<dyn UsbLink>);
            sessions.chain(probes).collect()
        };
        // Concurrently: each close may wait for libusb to hand back a transfer.
        let mut closes = JoinSet::new();
        for link in links {
            let inner = self.clone();
            closes.spawn(async move { inner.close_held(link.as_ref()).await });
        }
        while closes.join_next().await.is_some() {}
    }
}

/// Marks a scan as running until it ends, a dropped future included: a flag left set would
/// answer every later scan with nothing.
struct Scanning<'a>(&'a AtomicBool);

impl Drop for Scanning<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Removes a connect from the in-flight table however it ends, a dropped future included.
struct ConnectingEntry<'a> {
    inner: &'a Inner,
    key: BrickKey,
}

impl Drop for ConnectingEntry<'_> {
    fn drop(&mut self) {
        self.inner.state().connecting.remove(&self.key);
    }
}

/// A probe link: libusb only, holding its brick's lock until it closes, so a connect waits for
/// it rather than lose the claim to it and land, silently, on 64-byte HID.
struct UsbProbe {
    inner: Arc<Inner>,
    id: u64,
    link: Arc<LibusbLink>,
    brick: Option<OwnedMutexGuard<()>>,
}

#[async_trait]
impl ProbeLink for UsbProbe {
    async fn send_packet(
        &mut self,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        self.link.send(packet, options).await
    }

    async fn close(&mut self) {
        let Some(brick) = self.brick.take() else {
            return;
        };
        self.inner.state().probes.remove(&self.id);
        self.inner.close_held(self.link.as_ref()).await;
        drop(brick);
    }
}

impl Drop for UsbProbe {
    /// A probe dropped without a close leaves the registry at once; its link gives the device
    /// back when the last transfer on it returns.
    fn drop(&mut self) {
        if self.brick.is_some() {
            self.inner.state().probes.remove(&self.id);
        }
    }
}

#[async_trait]
impl TransportProvider for UsbTransportProvider {
    fn transport(&self) -> Transport {
        Transport::Usb
    }

    /// A cable means the brick is on this desk: the strongest channel there is.
    fn priority(&self) -> i32 {
        30
    }

    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            supports_telemetry_frames: true,
            supports_probe: true,
            ..TransportCapabilities::default()
        }
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        self.inner.check_disposed()?;
        // A scan already running answers for this one too.
        if self.inner.discovering.swap(true, Ordering::SeqCst) {
            return Ok(DiscoveryScanResult {
                transport: Transport::Usb,
                items: Vec::new(),
            });
        }
        let _scanning = Scanning(&self.inner.discovering);
        self.inner.discover().await
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.inner.check_disposed()?;
        // A second connect to a brick already connecting waits for the same answer, rather than
        // open a second link whose session would overwrite the first.
        let joined = {
            let mut state = self.inner.state();
            match state.connecting.get(brick_key) {
                Some(outcome) => Err(outcome.clone()),
                None => {
                    let (sender, receiver) = watch::channel(None);
                    state.connecting.insert(brick_key.clone(), receiver);
                    Ok(sender)
                }
            }
        };
        let sender = match joined {
            Ok(sender) => sender,
            Err(mut outcome) => {
                return match outcome.wait_for(Option::is_some).await {
                    Ok(outcome) => outcome.clone().unwrap_or_else(|| Err(disposed_error())),
                    Err(_) => Err(TransportError::transport_failed(format!(
                        "The connect to {} this one waited for was abandoned.",
                        describe(brick_key)
                    ))),
                };
            }
        };
        let _entry = ConnectingEntry {
            inner: &self.inner,
            key: brick_key.clone(),
        };
        let outcome = self.inner.connect(brick_key).await;
        sender.send_replace(Some(outcome.clone()));
        outcome
    }

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError> {
        let link = self.inner.state().sessions.remove(brick_key);
        if let Some(link) = link {
            self.inner.close_held(link.as_ref()).await;
        }
        Ok(())
    }

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        self.inner.check_disposed()?;
        let link = self.inner.state().sessions.get(brick_key).cloned();
        let Some(link) = link else {
            return Err(TransportError::transport_failed(format!(
                "{} is not connected.",
                describe(brick_key)
            )));
        };
        link.send(packet, options).await
    }

    /// Read from the session, because the answer depends on which backend the connection
    /// landed on: 1024 over libusb, 64 over HID.
    fn max_packet_bytes(&self, brick_key: &BrickKey) -> Option<usize> {
        self.inner
            .state()
            .sessions
            .get(brick_key)
            .and_then(|link| link.max_packet_bytes())
    }

    /// Opens a libusb link outside any session, for one question such as the brick's name.
    ///
    /// The descriptor's name is fixed when the cable goes in, so a brick renamed since then
    /// shows its old name until somebody asks it. An open costs tens of milliseconds and
    /// nothing shared. libusb only: a HID probe could not carry the reply in one packet.
    async fn open_probe(&self, brick_key: &BrickKey) -> Result<Box<dyn ProbeLink>, TransportError> {
        let inner = &self.inner;
        inner.check_disposed()?;
        let brick = inner.lock_brick(brick_key).await?;
        if inner.state().sessions.contains_key(brick_key) {
            return Err(TransportError::transport_failed(format!(
                "{} has a session; ask it instead.",
                describe(brick_key)
            )));
        }
        let (link, bus) = match inner.open_libusb(serial_of(brick_key)).await {
            Ok(opened) => opened,
            Err(OpenFailure::Disposed) => return Err(disposed_error()),
            Err(OpenFailure::Open(failure)) => return Err(failure.into()),
        };
        let id = {
            let mut state = inner.state();
            state.next_probe += 1;
            let id = state.next_probe;
            state.probes.insert(id, link.clone());
            id
        };
        drop(bus);
        Ok(Box::new(UsbProbe {
            inner: inner.clone(),
            id,
            link,
            brick: Some(brick),
        }))
    }

    /// Closes every session and probe, and returns once each has given its device back. On
    /// Linux an open libusb link holds the brick with `usbhid` detached, and only its release
    /// gives the driver back.
    async fn dispose(&self) {
        self.inner.dispose().await;
    }
}
