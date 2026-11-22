//! The Bluetooth provider on Windows: discovery from Windows' device cache, sessions over Winsock
//! RFCOMM, presence over uncached SDP, pairing over WinRT and forget through `bthprops`, all in
//! the daemon itself.
//!
//! Every operation that pages the radio (an open, a pairing, a presence check, an inquiry) takes
//! its turn in one [`BtConnectionQueue`]. Discovery reads the cache only and never queues.
//!
//! One attempt per connect. A connect that touched the air and failed ends the attempt: Windows
//! carries one RFCOMM channel, a failed connection leaves it settling for tens of seconds, and an
//! immediate second try is the impatient retry the queue's recovery exists to prevent. The caller
//! connects again later, and the queue spaces it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tokio::sync::{OnceCell, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

use crate::brick_key::{BrickKey, Transport};
use crate::bt::presence::{
    PresenceFailure, PresenceMonitor, PresenceSource, PresenceTimings, ScannedBrick,
};
use crate::bt::queue::{BtConnectionQueue, QueueTimings, ReconnectGap, SlotKind, StartupGrace};
use crate::bt::{describe_address, format_mac, is_lego_mac, normalise_mac, parse_mac};
use crate::bt_windows::discovery::{self, DeviceRecord, PlatformError};
use crate::bt_windows::forget::{self, unpair_result, windows_residue};
use crate::bt_windows::pairing::{
    self, PAIRING_CANCELLED, PAIRING_INQUIRY_WINDOW, PAIRING_TIMEOUT, PairingCancel,
};
use crate::bt_windows::sdp::{self, PRESENCE_CHECK_TIMEOUT, SdpAnswer};
use crate::bt_windows::winsock::{
    CONNECT_TIMEOUT, ConnectFailure, RfcommConnector, RfcommLink, SEND_TIMEOUT, WinsockConnector,
};
use crate::error::TransportError;
use crate::pending::Exchanger;
use crate::provider::{
    DiscoveryItem, DiscoveryScanResult, ForgetResidue, NameSource, PairingOutcome, PresenceState,
    SendOptions, SessionHandle, SignalInfo, TransportCapabilities, TransportProvider,
};

/// How long a pairing thread gets to stop after it was told to, before its slot is given back.
const PAIRING_STOP_GRACE: Duration = Duration::from_secs(5);

/// The Windows calls the provider makes, each one blocking. The provider runs every one on a
/// thread of its own, never on the runtime's threads. The seam the provider is tested through.
pub trait BluetoothPlatform: Send + Sync + 'static {
    /// Windows' device cache. No air time.
    fn list_devices(&self) -> Result<Vec<DeviceRecord>, PlatformError>;
    /// `BluetoothRemoveDevice`; Windows' own code.
    fn remove_device(&self, address: u64) -> u32;
    /// One uncached SDP query for the serial-port service. May block for seconds and cannot be
    /// cancelled.
    fn serial_port_records(&self, address: u64) -> SdpAnswer;
    /// One inquiry window: paired devices from the records, then a live watcher for `window`.
    fn inquire(&self, window: Duration) -> Result<Vec<ScannedBrick>, PlatformError>;
    /// The whole pairing ceremony, on the calling thread; stops early once `cancel` is set.
    fn pair(&self, address: u64, window: Duration, cancel: &PairingCancel) -> PairingOutcome;
    /// This computer's Bluetooth radio name.
    fn radio_name(&self) -> Option<String>;
}

/// The real Windows calls.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemBluetooth;

impl BluetoothPlatform for SystemBluetooth {
    fn list_devices(&self) -> Result<Vec<DeviceRecord>, PlatformError> {
        discovery::list_devices()
    }

    fn remove_device(&self, address: u64) -> u32 {
        forget::remove_device(address)
    }

    fn serial_port_records(&self, address: u64) -> SdpAnswer {
        sdp::serial_port_records(address)
    }

    fn inquire(&self, window: Duration) -> Result<Vec<ScannedBrick>, PlatformError> {
        discovery::inquire(window)
    }

    fn pair(&self, address: u64, window: Duration, cancel: &PairingCancel) -> PairingOutcome {
        pairing::pair_on_this_thread(address, window, cancel)
    }

    fn radio_name(&self) -> Option<String> {
        discovery::radio_name()
    }
}

/// The provider's timings. [`Default`] is what ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BtWindowsSettings {
    pub connect_timeout: Duration,
    pub send_timeout: Duration,
    pub reconnect_gap: Duration,
    /// When this daemon started, for the busy retry of a first connect right after a replacement.
    pub daemon_started: Instant,
    /// How long after daemon_started a first connect refused as busy is tried once more.
    pub startup_busy_window: Duration,
    pub presence_check_timeout: Duration,
    /// One background inquiry window.
    pub inquiry_window: Duration,
    /// One of a pairing's two inquiry windows.
    pub pairing_inquiry_window: Duration,
    pub pairing_timeout: Duration,
    pub queue: QueueTimings,
    pub presence: PresenceTimings,
}

impl Default for BtWindowsSettings {
    fn default() -> Self {
        Self {
            connect_timeout: CONNECT_TIMEOUT,
            send_timeout: SEND_TIMEOUT,
            reconnect_gap: crate::bt::queue::RECONNECT_GAP_AFTER_CLOSE,
            daemon_started: Instant::now(),
            startup_busy_window: crate::bt::queue::STARTUP_BUSY_WINDOW,
            presence_check_timeout: PRESENCE_CHECK_TIMEOUT,
            inquiry_window: crate::bt::presence::INQUIRY_WINDOW,
            pairing_inquiry_window: PAIRING_INQUIRY_WINDOW,
            pairing_timeout: PAIRING_TIMEOUT,
            queue: QueueTimings::default(),
            presence: PresenceTimings::default(),
        }
    }
}

struct Link {
    /// `None` once closed.
    open: Option<Box<dyn RfcommLink>>,
    exchanger: Exchanger,
}

/// One brick's session: its link behind a lock that an exchange holds for its whole round trip,
/// and a close signal outside that lock, so a close ends an exchange in flight at once instead
/// of waiting it out (forever, for an exchange with the timer disabled).
struct Session {
    link: tokio::sync::Mutex<Link>,
    closing: AtomicBool,
    closed: tokio::sync::Notify,
}

impl Session {
    fn new(link: Box<dyn RfcommLink>, send_timeout: Duration) -> Self {
        Self {
            link: tokio::sync::Mutex::new(Link {
                open: Some(link),
                exchanger: Exchanger::new("BT", send_timeout),
            }),
            closing: AtomicBool::new(false),
            closed: tokio::sync::Notify::new(),
        }
    }

    fn signal_close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.closed.notify_waiters();
    }

    async fn closing(&self) {
        loop {
            let notified = self.closed.notified();
            if self.closing.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }

    /// Ends whatever exchange is in flight, then closes the socket.
    async fn close(&self) {
        self.signal_close();
        let link = self.link.lock().await.open.take();
        drop(link);
    }
}

type SharedSession = Arc<Session>;
type ConnectCell = Arc<OnceCell<Result<SessionHandle, TransportError>>>;

struct Inner {
    platform: Arc<dyn BluetoothPlatform>,
    connector: Arc<dyn RfcommConnector>,
    settings: BtWindowsSettings,
    queue: Arc<BtConnectionQueue>,
    gap: ReconnectGap,
    startup: StartupGrace,
    presence: Arc<PresenceMonitor>,
    sessions: Mutex<HashMap<BrickKey, SharedSession>>,
    connecting: Mutex<HashMap<BrickKey, ConnectCell>>,
    /// Paired bricks the last discovery listed, colon-separated.
    last_paired: Mutex<Vec<String>>,
    pairings: Mutex<HashMap<BrickKey, Arc<PairingCancel>>>,
    presence_task: Mutex<Option<JoinHandle<()>>>,
    disposed: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// A channel as a message shows it: `001653F00A0A BT`.
fn describe_channel(key: &BrickKey) -> String {
    format!("{} BT", describe_address(key.id()))
}

/// The brick's address, from its key.
fn address_of(key: &BrickKey) -> Result<u64, TransportError> {
    parse_mac(key.id()).ok_or_else(|| {
        TransportError::transport_failed(format!(
            "Cannot extract a Bluetooth address from brick key: {key}"
        ))
    })
}

/// Runs `work` on a thread of its own and hands back its answer. A thread the caller stops
/// waiting for is abandoned, never joined: the Windows calls here cannot be cancelled.
fn on_own_thread<T: Send + 'static>(
    name: &str,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<oneshot::Receiver<T>, TransportError> {
    let (answer, receiver) = oneshot::channel();
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let _ = answer.send(work());
        })
        .map_err(|error| {
            TransportError::transport_failed(format!("Could not start the {name} thread: {error}"))
        })?;
    Ok(receiver)
}

fn disposed_error() -> TransportError {
    TransportError::transport_failed("The Bluetooth provider has been disposed.")
}

impl Inner {
    fn is_disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn paired_without_session(&self) -> Vec<String> {
        let in_session: Vec<String> = lock(&self.sessions)
            .keys()
            .map(|key| normalise_mac(key.id()))
            .collect();
        lock(&self.last_paired)
            .iter()
            .filter(|mac| !in_session.contains(&normalise_mac(mac)))
            .cloned()
            .collect()
    }

    /// One presence check, without the queue: whoever calls it holds the slot.
    async fn sdp_check(&self, mac: &str) -> Result<bool, PresenceFailure> {
        let Some(address) = parse_mac(mac) else {
            return Ok(false);
        };
        let platform = Arc::clone(&self.platform);
        let answer = on_own_thread("bt-presence", move || platform.serial_port_records(address))
            .map_err(|error| PresenceFailure::Failed(error.message))?;
        match tokio::time::timeout(self.settings.presence_check_timeout, answer).await {
            Ok(Ok(answer)) => Ok(answer.answered()),
            // Abandoned at its deadline, or ended without an answer: not heard.
            Ok(Err(_)) | Err(_) => Ok(false),
        }
    }

    async fn inquire(&self) -> Result<Vec<ScannedBrick>, PresenceFailure> {
        let platform = Arc::clone(&self.platform);
        let window = self.settings.inquiry_window;
        let answer = on_own_thread("bt-inquiry", move || platform.inquire(window))
            .map_err(|error| PresenceFailure::Failed(error.message))?;
        // The window plus room for the paired list; beyond that the thread is abandoned.
        let deadline = window + Duration::from_secs(20);
        match tokio::time::timeout(deadline, answer).await {
            Ok(Ok(Ok(heard))) => Ok(heard.into_iter().filter(|b| is_lego_mac(&b.mac)).collect()),
            Ok(Ok(Err(PlatformError::Unavailable(reason)))) => {
                Err(PresenceFailure::Unavailable(reason))
            }
            Ok(Ok(Err(PlatformError::Failed(reason)))) => Err(PresenceFailure::Failed(reason)),
            Ok(Err(_)) => Err(PresenceFailure::Failed(
                "The inquiry ended without an answer.".into(),
            )),
            Err(_) => Err(PresenceFailure::Failed(format!(
                "The inquiry did not finish within {} s.",
                deadline.as_secs()
            ))),
        }
    }

    async fn connect_once(&self, key: &BrickKey) -> Result<SessionHandle, TransportError> {
        let address = address_of(key)?;
        let mac = format_mac(address);
        let retry_at = self.startup.first_connect(&mac);
        match self.open_attempt(key, address, &mac).await {
            Err(OpenFailure::Refused(failure)) if retry_at.is_some() && failure.is_busy() => {
                // The daemon this one replaced may have closed its link a moment ago: wait out
                // the rest of the window, then try once more.
                if let Some(at) = retry_at {
                    sleep_until(at).await;
                }
                match self.open_attempt(key, address, &mac).await {
                    Err(OpenFailure::Refused(failure)) => Err(failure.into_error(&mac)),
                    Err(OpenFailure::Error(error)) => Err(error),
                    Ok(handle) => Ok(handle),
                }
            }
            Err(OpenFailure::Refused(failure)) => Err(failure.into_error(&mac)),
            Err(OpenFailure::Error(error)) => Err(error),
            Ok(handle) => Ok(handle),
        }
    }

    /// One attempt: the brick's gap after a close, the queue, the connect.
    async fn open_attempt(
        &self,
        key: &BrickKey,
        address: u64,
        mac: &str,
    ) -> Result<SessionHandle, OpenFailure> {
        // The brick needs a moment after a close before it accepts a new link. Waited before the
        // queue, so no other brick is held up by it.
        self.gap.wait(mac).await;
        if self.is_disposed() {
            return Err(disposed_error().into());
        }
        let slot = self.queue.acquire(mac, SlotKind::Open).await?;
        if self.is_disposed() {
            slot.release(false);
            return Err(disposed_error().into());
        }
        match self
            .connector
            .open(address, self.settings.connect_timeout)
            .await
        {
            Ok(link) => {
                if self.is_disposed() {
                    drop(link);
                    slot.release(false);
                    return Err(disposed_error().into());
                }
                lock(&self.sessions).insert(
                    key.clone(),
                    Arc::new(Session::new(link, self.settings.send_timeout)),
                );
                // The slot serialises opening, not holding: released once the link is open.
                slot.release(false);
                Ok(SessionHandle {
                    brick_key: key.clone(),
                    transport: Transport::Bt,
                })
            }
            Err(failure) => {
                // Failed, so the next attempt waits out the longer recovery.
                slot.release(true);
                Err(OpenFailure::Refused(failure))
            }
        }
    }

    /// Closes the brick's session, if it has one, and notes when.
    async fn close_session(&self, key: &BrickKey) {
        let session = lock(&self.sessions).remove(key);
        if let Some(session) = session {
            session.close().await;
            self.gap.note_closed(key.id());
        }
    }
}

/// How one open attempt failed.
enum OpenFailure {
    /// The connector's answer, not yet turned into an error.
    Refused(ConnectFailure),
    Error(TransportError),
}

impl From<TransportError> for OpenFailure {
    fn from(error: TransportError) -> Self {
        Self::Error(error)
    }
}

struct ProviderPresence {
    inner: Weak<Inner>,
}

#[async_trait]
impl PresenceSource for ProviderPresence {
    async fn check(&self, mac: &str) -> Result<bool, PresenceFailure> {
        match self.inner.upgrade() {
            Some(inner) => inner.sdp_check(mac).await,
            None => Ok(false),
        }
    }

    async fn inquire(&self) -> Result<Vec<ScannedBrick>, PresenceFailure> {
        match self.inner.upgrade() {
            Some(inner) => inner.inquire().await,
            None => Ok(Vec::new()),
        }
    }

    fn paired_without_session(&self) -> Vec<String> {
        self.inner
            .upgrade()
            .map(|inner| inner.paired_without_session())
            .unwrap_or_default()
    }
}

/// Cancels a pairing when the future running it goes away, and forgets its cancel handle.
struct PairingRegistration<'a> {
    inner: &'a Inner,
    key: BrickKey,
    cancel: Arc<PairingCancel>,
}

impl Drop for PairingRegistration<'_> {
    fn drop(&mut self) {
        self.cancel.cancel();
        let mut pairings = lock(&self.inner.pairings);
        if pairings
            .get(&self.key)
            .is_some_and(|current| Arc::ptr_eq(current, &self.cancel))
        {
            pairings.remove(&self.key);
        }
    }
}

/// The Bluetooth provider on Windows.
pub struct WindowsBtProvider {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for WindowsBtProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WindowsBtProvider")
            .field("settings", &self.inner.settings)
            .finish_non_exhaustive()
    }
}

impl WindowsBtProvider {
    /// A provider over the given Windows calls and connector, taking turns in `queue`.
    pub fn new(
        platform: Arc<dyn BluetoothPlatform>,
        connector: Arc<dyn RfcommConnector>,
        queue: Arc<BtConnectionQueue>,
        settings: BtWindowsSettings,
    ) -> Self {
        let presence = Arc::new(PresenceMonitor::new(Arc::clone(&queue), settings.presence));
        Self {
            inner: Arc::new(Inner {
                platform,
                connector,
                settings,
                queue,
                gap: ReconnectGap::new(settings.reconnect_gap),
                startup: StartupGrace::new(settings.daemon_started, settings.startup_busy_window),
                presence,
                sessions: Mutex::new(HashMap::new()),
                connecting: Mutex::new(HashMap::new()),
                last_paired: Mutex::new(Vec::new()),
                pairings: Mutex::new(HashMap::new()),
                presence_task: Mutex::new(None),
                disposed: AtomicBool::new(false),
            }),
        }
    }

    /// The provider the daemon runs: the real Windows calls and Winsock, with the shipped
    /// timings.
    pub fn system() -> Self {
        let settings = BtWindowsSettings::default();
        Self::new(
            Arc::new(SystemBluetooth),
            Arc::new(WinsockConnector),
            Arc::new(BtConnectionQueue::new(settings.queue)),
            settings,
        )
    }

    /// Background presence: what the checks and inquiries found.
    pub fn presence(&self) -> &Arc<PresenceMonitor> {
        &self.inner.presence
    }

    /// The queue every radio operation takes its turn in.
    pub fn queue(&self) -> &Arc<BtConnectionQueue> {
        &self.inner.queue
    }

    fn presence_source(&self) -> Arc<dyn PresenceSource> {
        Arc::new(ProviderPresence {
            inner: Arc::downgrade(&self.inner),
        })
    }

    /// Starts background presence on the current tokio runtime: an inquiry and a round of
    /// checks now, then each on its interval, until [`TransportProvider::dispose`].
    pub fn start_presence(&self) {
        let mut task = lock(&self.inner.presence_task);
        if task.is_some() || self.inner.is_disposed() {
            return;
        }
        let monitor = Arc::clone(&self.inner.presence);
        *task = Some(tokio::spawn(monitor.run(self.presence_source())));
    }

    /// One round of presence checks over the paired bricks without a session.
    pub async fn run_presence_checks(&self) {
        let source = self.presence_source();
        self.inner.presence.run_checks(source.as_ref()).await;
    }

    /// One background inquiry window.
    pub async fn run_inquiry(&self) {
        let source = self.presence_source();
        self.inner.presence.run_inquiry(source.as_ref()).await;
    }

    /// The paired bricks the last discovery listed that have no session: what presence checks.
    pub fn paired_without_session(&self) -> Vec<String> {
        self.inner.paired_without_session()
    }

    /// This computer's Bluetooth radio name, for finding this computer's entry in a brick's own
    /// list of paired devices.
    pub async fn radio_name(&self) -> Option<String> {
        let platform = Arc::clone(&self.inner.platform);
        let answer = on_own_thread("bt-radio", move || platform.radio_name()).ok()?;
        answer.await.ok().flatten()
    }
}

#[async_trait]
impl TransportProvider for WindowsBtProvider {
    fn transport(&self) -> Transport {
        Transport::Bt
    }

    /// Below a cable, above Wi-Fi.
    fn priority(&self) -> i32 {
        20
    }

    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            supports_signal_info: false,
            supports_forget: true,
            supports_telemetry_frames: true,
            rejoin_on_evidence_only: true,
            supports_recover: true,
            supports_probe: false,
            supports_pairing: true,
            supports_presence: true,
        }
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        let inner = &self.inner;
        if inner.is_disposed() {
            return Err(disposed_error());
        }
        let platform = Arc::clone(&inner.platform);
        let answer = on_own_thread("bt-discovery", move || platform.list_devices())?;
        // A failed scan is not an empty one: reported as empty, every tracked brick would be
        // counted a miss and walked toward unavailable.
        let records = match answer.await {
            Ok(Ok(records)) => records,
            Ok(Err(error)) => {
                return Err(TransportError::transport_failed(format!(
                    "BT discovery failed: {}",
                    error.message()
                )));
            }
            Err(_) => {
                return Err(TransportError::transport_failed(
                    "BT discovery failed: the enumeration ended without an answer.",
                ));
            }
        };
        let now = now_epoch_ms();
        let devices: Vec<DeviceRecord> = records
            .into_iter()
            .filter(|device| is_lego_mac(&format_mac(device.address)))
            .collect();
        *lock(&inner.last_paired) = devices
            .iter()
            .filter(|device| device.remembered)
            .map(|device| format_mac(device.address))
            .collect();
        let connected: Vec<BrickKey> = lock(&inner.sessions).keys().cloned().collect();
        let mut items = Vec::new();
        let mut listed = Vec::new();
        for device in &devices {
            let mac = format_mac(device.address);
            let brick_key = BrickKey::new(Transport::Bt, &mac)?;
            // Every paired brick stays listed; whether it answered is a flag on it, not its
            // absence.
            let presence = device
                .remembered
                .then(|| inner.presence.presence_of(&mac))
                .flatten();
            let (display_name, name_source) = if device.name.is_empty() {
                // No name: the brick's id, as USB shows one and the brick's own display does.
                (describe_address(&mac), NameSource::Fallback)
            } else {
                // Windows' record catches up with a rename only at the next connection.
                (device.name.clone(), NameSource::BtCache)
            };
            items.push(DiscoveryItem {
                connected: connected
                    .iter()
                    .any(|key| normalise_mac(key.id()) == normalise_mac(&mac)),
                brick_key,
                display_name,
                name_source: Some(name_source),
                transport: Transport::Bt,
                presence_state: PresenceState::Available,
                remembered: device.remembered,
                favorite: false,
                paired: Some(device.remembered),
                heard: presence.map(|p| p.heard),
                heard_at: presence.and_then(|p| p.heard_at),
                signal_info: None,
                bt_visible: None,
                last_seen_at: now,
            });
            listed.push(normalise_mac(&mac));
        }
        for brick in inner.presence.unpaired_bricks() {
            if !is_lego_mac(&brick.mac) || listed.contains(&normalise_mac(&brick.mac)) {
                continue;
            }
            let brick_key = BrickKey::new(Transport::Bt, &brick.mac.to_ascii_uppercase())?;
            let (display_name, name_source) = if brick.name.is_empty() {
                (describe_address(&brick.mac), NameSource::Fallback)
            } else {
                // The name an inquiry hears is the brick's own, but nothing has confirmed it.
                (brick.name.clone(), NameSource::BtCache)
            };
            items.push(DiscoveryItem {
                brick_key,
                display_name,
                name_source: Some(name_source),
                transport: Transport::Bt,
                presence_state: PresenceState::Available,
                remembered: false,
                connected: false,
                favorite: false,
                paired: Some(false),
                heard: None,
                heard_at: None,
                signal_info: brick.signal.map(|rssi| SignalInfo {
                    rssi: Some(rssi),
                    strength: None,
                }),
                bt_visible: None,
                last_seen_at: brick.seen_at,
            });
        }
        Ok(DiscoveryScanResult {
            transport: Transport::Bt,
            items,
        })
    }

    /// One attempt. A second connect to a brick already connecting gets the same answer: two
    /// would each open a link, and the second session would orphan the first.
    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        let inner = &self.inner;
        if inner.is_disposed() {
            return Err(disposed_error());
        }
        let cell = {
            let mut connecting = lock(&inner.connecting);
            match connecting.get(brick_key) {
                Some(cell) => Arc::clone(cell),
                None => {
                    if lock(&inner.sessions).contains_key(brick_key) {
                        return Err(TransportError::transport_failed(format!(
                            "{} is already connected.",
                            describe_channel(brick_key)
                        )));
                    }
                    let cell: ConnectCell = Arc::new(OnceCell::new());
                    connecting.insert(brick_key.clone(), Arc::clone(&cell));
                    cell
                }
            }
        };
        let result = cell
            .get_or_init(|| inner.connect_once(brick_key))
            .await
            .clone();
        let mut connecting = lock(&inner.connecting);
        if connecting
            .get(brick_key)
            .is_some_and(|current| Arc::ptr_eq(current, &cell))
        {
            connecting.remove(brick_key);
        }
        result
    }

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError> {
        self.inner.close_session(brick_key).await;
        Ok(())
    }

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        let inner = &self.inner;
        if inner.is_disposed() {
            return Err(disposed_error());
        }
        let not_connected = || {
            TransportError::transport_failed(format!(
                "{} is not connected.",
                describe_channel(brick_key)
            ))
        };
        let session = lock(&inner.sessions)
            .get(brick_key)
            .cloned()
            .ok_or_else(not_connected)?;
        let exchange = async {
            let mut guard = session.link.lock().await;
            let Link { open, exchanger } = &mut *guard;
            let Some(link) = open.as_mut() else {
                return (Err(not_connected()), false);
            };
            let result = exchanger.exchange(link.as_mut(), packet, options).await;
            let broken = result.is_err() && link.is_broken();
            if broken {
                // The brick hung up, or a command went out cut off: only a fresh link starts
                // the stream clean again.
                *open = None;
            }
            (result, broken)
        };
        // A close ends the exchange at once: dropping it mid-way is safe, since the link discards
        // what an abandoned exchange left behind, and a command cut off breaks the link.
        let (result, broken) = tokio::select! {
            biased;
            () = session.closing() => (
                Err(TransportError::transport_failed("BT link closed while waiting for reply.")),
                false,
            ),
            outcome = exchange => outcome,
        };
        if broken {
            let mut sessions = lock(&inner.sessions);
            if sessions
                .get(brick_key)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                sessions.remove(brick_key);
            }
            drop(sessions);
            inner.gap.note_closed(brick_key.id());
        }
        result
    }

    async fn recover(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.inner.close_session(brick_key).await;
        self.connect(brick_key).await
    }

    /// Disconnects, removes the Windows pairing, and drops everything this provider remembers
    /// about the brick: its close time, its place among the paired bricks to check, and what
    /// presence knew of it. A pairing of it still running is cancelled first, so it cannot
    /// complete behind the forget.
    async fn forget(&self, brick_key: &BrickKey) -> Result<Vec<ForgetResidue>, TransportError> {
        let inner = &self.inner;
        if let Some(cancel) = lock(&inner.pairings).get(brick_key) {
            cancel.cancel();
        }
        inner.close_session(brick_key).await;
        let address = address_of(brick_key)?;
        let mac = format_mac(address);
        let platform = Arc::clone(&inner.platform);
        let code = on_own_thread("bt-forget", move || platform.remove_device(address))?
            .await
            .map_err(|_| TransportError::transport_failed("The unpair ended without an answer."))?;
        unpair_result(code).map_err(|reason| {
            TransportError::transport_failed(format!(
                "Could not forget {}: {reason}",
                describe_address(&mac)
            ))
        })?;
        inner.gap.forget(&mac);
        let forgotten = normalise_mac(&mac);
        lock(&inner.last_paired).retain(|paired| normalise_mac(paired) != forgotten);
        inner.presence.forget(&mac);
        Ok(windows_residue(&mac))
    }

    /// Pairs the brick: answers rather than fails. Takes an opening slot in the queue, so the
    /// pairing never pages the radio beside a connect; the first connect after it waits out the
    /// ordinary gap, which is correct, since it is the same radio.
    async fn pair(&self, brick_key: &BrickKey) -> Result<PairingOutcome, TransportError> {
        let inner = &self.inner;
        if inner.is_disposed() {
            return Err(disposed_error());
        }
        let address = address_of(brick_key)?;
        let mac = format_mac(address);
        let cancel = Arc::new(PairingCancel::default());
        lock(&inner.pairings).insert(brick_key.clone(), Arc::clone(&cancel));
        let _registration = PairingRegistration {
            inner,
            key: brick_key.clone(),
            cancel: Arc::clone(&cancel),
        };
        let cancelled = || PairingOutcome {
            ok: false,
            reason: Some(PAIRING_CANCELLED.into()),
            status: None,
        };

        // A cancel wins only while the pairing waits for its slot; once it runs, the ceremony is
        // what has to stop, and the pairing answers when it has.
        let slot = tokio::select! {
            slot = inner.queue.acquire(&mac, SlotKind::Open) => slot,
            () = cancel.cancelled() => return Ok(cancelled()),
        };
        let slot = match slot {
            Ok(slot) => slot,
            Err(error) => {
                return Ok(PairingOutcome {
                    ok: false,
                    reason: Some(error.message),
                    status: None,
                });
            }
        };
        let platform = Arc::clone(&inner.platform);
        let window = inner.settings.pairing_inquiry_window;
        let thread_cancel = Arc::clone(&cancel);
        let mut answer = match on_own_thread("bt-pairing", move || {
            platform.pair(address, window, &thread_cancel)
        }) {
            Ok(answer) => answer,
            Err(error) => {
                slot.release(false);
                return Ok(PairingOutcome {
                    ok: false,
                    reason: Some(error.message),
                    status: None,
                });
            }
        };
        let outcome = match tokio::time::timeout(inner.settings.pairing_timeout, &mut answer).await
        {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => PairingOutcome {
                ok: false,
                reason: Some("The pairing ended without an answer.".into()),
                status: None,
            },
            Err(_) => {
                cancel.cancel();
                let _ = tokio::time::timeout(PAIRING_STOP_GRACE, &mut answer).await;
                PairingOutcome {
                    ok: false,
                    reason: Some(format!(
                        "The pairing timed out after {} s and was stopped.",
                        inner.settings.pairing_timeout.as_secs()
                    )),
                    status: None,
                }
            }
        };
        slot.release(false);
        if outcome.ok {
            inner.presence.note_paired(&mac);
        }
        Ok(outcome)
    }

    /// Whether the paired brick answers an uncached service query, holding the queue for mutual
    /// exclusion only.
    async fn check_presence(&self, brick_key: &BrickKey) -> Result<bool, TransportError> {
        let inner = &self.inner;
        if inner.is_disposed() {
            return Err(disposed_error());
        }
        let mac = format_mac(address_of(brick_key)?);
        let slot = inner
            .queue
            .acquire(&format!("presence:{mac}"), SlotKind::HoldOnly)
            .await?;
        let answered = inner.sdp_check(&mac).await;
        slot.release(false);
        answered.map_err(|failure| match failure {
            PresenceFailure::Unavailable(reason) | PresenceFailure::Failed(reason) => {
                TransportError::transport_failed(reason)
            }
        })
    }

    async fn dispose(&self) {
        let inner = &self.inner;
        inner.disposed.store(true, Ordering::SeqCst);
        inner.presence.stop();
        if let Some(task) = lock(&inner.presence_task).take() {
            task.abort();
        }
        inner.queue.dispose();
        for cancel in lock(&inner.pairings).values() {
            cancel.cancel();
        }
        let sessions: Vec<SharedSession> = lock(&inner.sessions).drain().map(|(_, s)| s).collect();
        for session in &sessions {
            session.signal_close();
        }
        for session in sessions {
            session.close().await;
        }
    }
}
