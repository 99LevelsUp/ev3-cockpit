//! The Bluetooth provider on Linux: discovery from BlueZ's objects, sessions over kernel RFCOMM
//! sockets, presence over an L2CAP probe and BlueZ discovery windows, pairing with an agent of
//! the cockpit's own, and forget through `RemoveDevice`.
//!
//! Every operation that pages the radio (an open, a pairing, a presence check, an inquiry) takes
//! its turn in one [`BtConnectionQueue`]. Discovery reads the cache only and never queues.
//!
//! One attempt per connect. A connect that touched the air and failed ends the attempt; the
//! caller connects again later, and the queue and the per-brick gap after a close space it. A
//! brick answers `EBUSY` and then `ECONNREFUSED` for about 2.5 s after its channel was closed;
//! the gap is longer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tokio::sync::OnceCell;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

use crate::brick_key::{BrickKey, Transport};
use crate::bt::presence::{
    PresenceFailure, PresenceMonitor, PresenceSource, PresenceTimings, ScannedBrick,
};
use crate::bt::queue::{BtConnectionQueue, QueueTimings, ReconnectGap, SlotKind, StartupGrace};
use crate::bt::{describe_address, format_mac, is_lego_mac, normalise_mac, parse_mac};
use crate::error::TransportError;
use crate::pending::Exchanger;
use crate::provider::{
    DiscoveryItem, DiscoveryScanResult, ForgetResidue, NameSource, PairingOutcome, PresenceState,
    SendOptions, SessionHandle, SignalInfo, TransportCapabilities, TransportProvider,
};

use super::access::{AccessQuestion, Activity, Consent, current_user_name};
use super::agent::{PAIR_TIMEOUT, PAIRING_CANCELLED, PairingContext, SEARCH_TIME, pair_brick};
use super::bluez::{
    BluezConnector, BluezObjects, CancelFlag, DiscoveryGate, ERROR_DOES_NOT_EXIST, device_name,
    run_detached,
};
use super::presence::{
    INQUIRY_WINDOW, L2capProber, PRESENCE_CHECK_TIMEOUT, PresenceProber, inquiry_window,
};
use super::radio_watch::{RadioSysfs, RadioWatch, RadioWatchTimings, SystemSysfs};
use super::rfcomm::{
    CONNECT_TIMEOUT, ConnectFailure, RfcommConnector, RfcommLink, SEND_TIMEOUT, SocketConnector,
};
use super::session::{BluezSession, RECONNECT_FIRST};
use super::system_bus::SystemBusConnector;

/// The provider's timings. [`Default`] is what ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BtLinuxSettings {
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
    /// How long a pairing searches for a brick BlueZ does not hold.
    pub search_time: Duration,
    /// How long `Pair` may take.
    pub pair_timeout: Duration,
    pub queue: QueueTimings,
    pub presence: PresenceTimings,
    pub radio: RadioWatchTimings,
}

impl Default for BtLinuxSettings {
    fn default() -> Self {
        Self {
            connect_timeout: CONNECT_TIMEOUT,
            send_timeout: SEND_TIMEOUT,
            reconnect_gap: crate::bt::queue::RECONNECT_GAP_AFTER_CLOSE,
            daemon_started: Instant::now(),
            startup_busy_window: crate::bt::queue::STARTUP_BUSY_WINDOW,
            presence_check_timeout: PRESENCE_CHECK_TIMEOUT,
            inquiry_window: INQUIRY_WINDOW,
            search_time: SEARCH_TIME,
            pair_timeout: PAIR_TIMEOUT,
            queue: QueueTimings::default(),
            presence: PresenceTimings::default(),
            radio: RadioWatchTimings::default(),
        }
    }
}

/// What the provider is built from: the seams it is tested through.
pub struct BtLinuxParts {
    pub session: Arc<BluezSession>,
    pub connector: Arc<dyn RfcommConnector>,
    pub prober: Arc<dyn PresenceProber>,
    pub sysfs: Arc<dyn RadioSysfs>,
    pub queue: Arc<BtConnectionQueue>,
    pub activity: Arc<dyn Activity>,
    /// The shipped udev rule's absolute path, for the advice when a radio may not be restarted.
    pub rule_path: Option<String>,
}

struct Link {
    /// `None` once closed.
    open: Option<Box<dyn RfcommLink>>,
    exchanger: Exchanger,
}

/// One brick's session: its link behind a lock that an exchange holds for its whole round trip,
/// and a close signal outside that lock, so a close ends an exchange in flight at once.
struct Session {
    link: tokio::sync::Mutex<Link>,
    closing: CancelFlag,
}

impl Session {
    fn new(link: Box<dyn RfcommLink>, send_timeout: Duration) -> Self {
        Self {
            link: tokio::sync::Mutex::new(Link {
                open: Some(link),
                exchanger: Exchanger::new("BT", send_timeout),
            }),
            closing: CancelFlag::default(),
        }
    }

    /// Ends whatever exchange is in flight, then closes the socket.
    async fn close(&self) {
        self.closing.cancel();
        let link = self.link.lock().await.open.take();
        drop(link);
    }
}

type SharedSession = Arc<Session>;
type ConnectCell = Arc<OnceCell<Result<SessionHandle, TransportError>>>;

struct Inner {
    bluez: Arc<BluezSession>,
    connector: Arc<dyn RfcommConnector>,
    prober: Arc<dyn PresenceProber>,
    activity: Arc<dyn Activity>,
    settings: BtLinuxSettings,
    queue: Arc<BtConnectionQueue>,
    gap: ReconnectGap,
    startup: StartupGrace,
    presence: Arc<PresenceMonitor>,
    radio: Arc<RadioWatch>,
    gate: Arc<DiscoveryGate>,
    one_pairing: Arc<tokio::sync::Mutex<()>>,
    sessions: Mutex<HashMap<BrickKey, SharedSession>>,
    connecting: Mutex<HashMap<BrickKey, ConnectCell>>,
    /// Paired bricks the last discovery listed, colon-separated.
    last_paired: Mutex<Vec<String>>,
    pairings: Mutex<HashMap<BrickKey, Arc<CancelFlag>>>,
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

fn disposed_error() -> TransportError {
    TransportError::transport_failed("The Bluetooth provider has been disposed.")
}

/// What BlueZ keeps of a brick after `RemoveDevice`: its name cache, owned by root. Reported,
/// never removed, as Windows' residue is.
pub fn bluez_residue(objects: &BluezObjects, mac: &str) -> Vec<ForgetResidue> {
    let address = parse_mac(mac).map_or_else(|| mac.to_owned(), format_mac);
    let adapter = objects
        .adapter()
        .and_then(|adapter| adapter.address)
        .map_or_else(
            || "<adapter>".to_owned(),
            |address| address.to_ascii_uppercase(),
        );
    vec![ForgetResidue {
        location: format!("/var/lib/bluetooth/{adapter}/cache/{address}"),
        reason: "BlueZ keeps the brick's name here after unpairing; it is owned by root and the \
                 cockpit does not change it."
            .into(),
    }]
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

    /// One presence check, without the queue: whoever calls it holds the slot. A dead radio is
    /// not asked: nothing is heard, as nothing can be, which is not a failed round (that would
    /// leave every brick heard as before).
    async fn probe(&self, mac: &str) -> Result<bool, PresenceFailure> {
        if self.radio.checks_held() {
            return Ok(false);
        }
        let Some(address) = parse_mac(mac) else {
            return Ok(false);
        };
        self.prober
            .probe(address, self.settings.presence_check_timeout)
            .await
    }

    /// One inquiry window, run to its end on a task of its own, its radio verdict noted before
    /// it answers, while the caller still holds the queue.
    async fn inquire(&self) -> Result<Vec<ScannedBrick>, PresenceFailure> {
        if self.radio.inquiry_held() {
            return Ok(Vec::new());
        }
        // A pairing search's late StopDiscovery would end this window: let it go out first. The
        // adapter and the connection are read after the wait, together.
        self.gate.idle().await;
        let Some(bus) = self.bluez.bus() else {
            return Err(PresenceFailure::Failed(
                "Bluetooth is not ready: there is no connection to BlueZ.".into(),
            ));
        };
        let hold = self.gate.hold();
        let objects = Arc::clone(self.bluez.objects());
        let radio = Arc::clone(&self.radio);
        let activity = Arc::clone(&self.activity);
        let window = self.settings.inquiry_window;
        let cancel = Arc::new(CancelFlag::default());
        let work_cancel = Arc::clone(&cancel);
        let answer = run_detached(cancel, async move {
            let (heard, outcome) =
                inquiry_window(bus, objects, window, work_cancel, activity).await;
            drop(hold);
            radio.note_window(outcome).await;
            heard
        })
        .await;
        match answer {
            Some(Ok(heard)) => Ok(heard),
            Some(Err(reason)) => Err(PresenceFailure::Failed(reason)),
            None => Err(PresenceFailure::Failed(
                "The inquiry ended without an answer.".into(),
            )),
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

    /// Removes BlueZ's record of the brick, link key included. A brick BlueZ does not hold is
    /// already forgotten, which is what the caller asked for, as Windows counts
    /// `ERROR_NOT_FOUND`.
    async fn unpair(&self, address: u64) -> Result<(), String> {
        let objects = self.bluez.objects();
        let Some(adapter) = objects.adapter() else {
            return Err("This computer has no Bluetooth adapter BlueZ knows.".into());
        };
        // The cache holds every adapter's objects; only this adapter's device can be removed
        // through it.
        let held: Vec<_> = objects
            .devices()
            .into_iter()
            .filter(|device| {
                device
                    .address
                    .as_deref()
                    .and_then(parse_mac)
                    .is_some_and(|found| found == address)
            })
            .collect();
        let prefix = format!("{}/", adapter.path);
        let Some(device) = held.iter().find(|device| device.path.starts_with(&prefix)) else {
            if held.is_empty() {
                return Ok(());
            }
            return Err(format!(
                "BlueZ holds this brick under another adapter; the cockpit forgets through {} \
                 only.",
                adapter.path
            ));
        };
        let Some(bus) = self.bluez.bus() else {
            return Err("there is no connection to BlueZ".into());
        };
        match bus.remove_device(&adapter.path, &device.path).await {
            Ok(()) => Ok(()),
            Err(error) if error.is(ERROR_DOES_NOT_EXIST) => Ok(()),
            Err(error) => Err(format!("BlueZ refused to remove the pairing ({error}).")),
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
            Some(inner) => inner.probe(mac).await,
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

/// Forgets a pairing's cancel handle when the call running it goes away.
struct PairingRegistration<'a> {
    inner: &'a Inner,
    key: BrickKey,
    cancel: Arc<CancelFlag>,
}

impl Drop for PairingRegistration<'_> {
    fn drop(&mut self) {
        let mut pairings = lock(&self.inner.pairings);
        if pairings
            .get(&self.key)
            .is_some_and(|current| Arc::ptr_eq(current, &self.cancel))
        {
            pairings.remove(&self.key);
        }
    }
}

/// The Bluetooth provider on Linux.
pub struct LinuxBtProvider {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for LinuxBtProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinuxBtProvider")
            .field("settings", &self.inner.settings)
            .finish_non_exhaustive()
    }
}

impl LinuxBtProvider {
    pub fn new(parts: BtLinuxParts, settings: BtLinuxSettings) -> Self {
        let BtLinuxParts {
            session,
            connector,
            prober,
            sysfs,
            queue,
            activity,
            rule_path,
        } = parts;
        let presence = Arc::new(PresenceMonitor::new(Arc::clone(&queue), settings.presence));
        let bus_session = Arc::downgrade(&session);
        let radio = RadioWatch::new(
            Arc::clone(session.objects()),
            move || bus_session.upgrade().and_then(|session| session.bus()),
            sysfs,
            Arc::clone(&activity),
            rule_path,
            settings.radio,
        );
        Self {
            inner: Arc::new(Inner {
                bluez: session,
                connector,
                prober,
                activity,
                settings,
                queue,
                gap: ReconnectGap::new(settings.reconnect_gap),
                startup: StartupGrace::new(settings.daemon_started, settings.startup_busy_window),
                presence,
                radio,
                gate: Arc::new(DiscoveryGate::default()),
                one_pairing: Arc::new(tokio::sync::Mutex::new(())),
                sessions: Mutex::new(HashMap::new()),
                connecting: Mutex::new(HashMap::new()),
                last_paired: Mutex::new(Vec::new()),
                pairings: Mutex::new(HashMap::new()),
                presence_task: Mutex::new(None),
                disposed: AtomicBool::new(false),
            }),
        }
    }

    /// The provider the daemon runs: the system bus, kernel sockets and sysfs, with the shipped
    /// timings. `consent`, when given, is asked once when the bus policy keeps this user from
    /// BlueZ.
    pub fn system(
        activity: Arc<dyn Activity>,
        consent: Option<Arc<dyn Consent>>,
        rule_path: Option<String>,
    ) -> Self {
        let settings = BtLinuxSettings::default();
        let user = current_user_name().unwrap_or_else(|| "<your user name>".into());
        let access = consent.map(|consent| {
            Arc::new(AccessQuestion::new(
                user.clone(),
                consent,
                Arc::new(super::access::SystemRunner),
                Arc::clone(&activity),
            ))
        });
        let connector: Arc<dyn BluezConnector> = Arc::new(SystemBusConnector);
        let session = BluezSession::new(
            connector,
            Arc::clone(&activity),
            access,
            user,
            RECONNECT_FIRST,
        );
        Self::new(
            BtLinuxParts {
                session,
                connector: Arc::new(SocketConnector),
                prober: Arc::new(L2capProber),
                sysfs: Arc::new(SystemSysfs),
                queue: Arc::new(BtConnectionQueue::new(settings.queue)),
                activity,
                rule_path,
            },
            settings,
        )
    }

    /// The BlueZ connection and its objects.
    pub fn bluez(&self) -> &Arc<BluezSession> {
        &self.inner.bluez
    }

    /// Background presence: what the checks and inquiries found.
    pub fn presence(&self) -> &Arc<PresenceMonitor> {
        &self.inner.presence
    }

    /// The radio watch: whether the adapter is being restarted or left alone.
    pub fn radio(&self) -> &Arc<RadioWatch> {
        &self.inner.radio
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

    /// Opens the system bus and reads BlueZ, on a task of its own.
    pub fn start_bluez(&self) {
        if !self.inner.is_disposed() {
            self.inner.bluez.start();
        }
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
    pub fn radio_name(&self) -> Option<String> {
        self.inner.bluez.objects().radio_name()
    }
}

#[async_trait]
impl TransportProvider for LinuxBtProvider {
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
        // A failed scan is not an empty one: reported as empty, every tracked brick would be
        // counted a miss and walked toward unavailable.
        let devices = inner.bluez.objects().list_bricks().map_err(|reason| {
            TransportError::transport_failed(format!("BT discovery failed: {reason}"))
        })?;
        let now = now_epoch_ms();
        let mut listed_devices = Vec::new();
        for device in devices {
            let Some(address) = device.address.as_deref().and_then(parse_mac) else {
                continue;
            };
            listed_devices.push((format_mac(address), device));
        }
        *lock(&inner.last_paired) = listed_devices
            .iter()
            .filter(|(_, device)| device.paired)
            .map(|(mac, _)| mac.clone())
            .collect();
        let connected: Vec<String> = lock(&inner.sessions)
            .keys()
            .map(|key| normalise_mac(key.id()))
            .collect();
        let mut items = Vec::new();
        let mut listed = Vec::new();
        for (mac, device) in &listed_devices {
            let brick_key = BrickKey::new(Transport::Bt, mac)?;
            // Every paired brick stays listed; whether it answered is a flag on it, not its
            // absence.
            let presence = device
                .paired
                .then(|| inner.presence.presence_of(mac))
                .flatten();
            let name = device_name(device);
            let (display_name, name_source) = if name.is_empty() {
                // No name: the brick's id, as USB shows one and the brick's own display does.
                (describe_address(mac), NameSource::Fallback)
            } else {
                // BlueZ's record of the name catches up with a rename only at a connection.
                (name, NameSource::BtCache)
            };
            items.push(DiscoveryItem {
                connected: connected.contains(&normalise_mac(mac)),
                brick_key,
                display_name,
                name_source: Some(name_source),
                transport: Transport::Bt,
                presence_state: PresenceState::Available,
                remembered: device.paired,
                favorite: false,
                paired: Some(device.paired),
                heard: presence.map(|p| p.heard),
                heard_at: presence.and_then(|p| p.heard_at),
                signal_info: None,
                bt_visible: None,
                last_seen_at: now,
            });
            listed.push(normalise_mac(mac));
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
                // The brick hung up, or a command went out cut off: only a fresh link starts the
                // stream clean again.
                *open = None;
            }
            (result, broken)
        };
        // A close ends the exchange at once: dropping it mid-way is safe, since the link discards
        // what an abandoned exchange left behind, and a command cut off breaks the link.
        let (result, broken) = tokio::select! {
            biased;
            () = session.closing.cancelled() => (
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

    /// Disconnects, removes BlueZ's record of the brick, and drops everything this provider
    /// remembers about it. A pairing of it still running is cancelled first, so it cannot
    /// complete behind the forget.
    async fn forget(&self, brick_key: &BrickKey) -> Result<Vec<ForgetResidue>, TransportError> {
        let inner = &self.inner;
        if let Some(cancel) = lock(&inner.pairings).get(brick_key) {
            cancel.cancel();
        }
        inner.close_session(brick_key).await;
        let address = address_of(brick_key)?;
        let mac = format_mac(address);
        inner.unpair(address).await.map_err(|reason| {
            TransportError::transport_failed(format!(
                "Could not forget {}: {reason}",
                describe_address(&mac)
            ))
        })?;
        inner.gap.forget(&mac);
        let forgotten = normalise_mac(&mac);
        lock(&inner.last_paired).retain(|paired| normalise_mac(paired) != forgotten);
        inner.presence.forget(&mac);
        Ok(bluez_residue(inner.bluez.objects(), &mac))
    }

    /// Pairs the brick: answers rather than fails. Takes an opening slot in the queue, so the
    /// pairing never pages the radio beside a connect or an inquiry.
    async fn pair(&self, brick_key: &BrickKey) -> Result<PairingOutcome, TransportError> {
        let inner = &self.inner;
        if inner.is_disposed() {
            return Err(disposed_error());
        }
        let address = address_of(brick_key)?;
        let mac = format_mac(address);
        let cancel = Arc::new(CancelFlag::default());
        lock(&inner.pairings).insert(brick_key.clone(), Arc::clone(&cancel));
        let _registration = PairingRegistration {
            inner,
            key: brick_key.clone(),
            cancel: Arc::clone(&cancel),
        };
        let cancelled = || PairingOutcome {
            ok: false,
            reason: Some(PAIRING_CANCELLED.into()),
            status: Some("Cancelled".into()),
        };
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
        let Some(bus) = inner.bluez.bus() else {
            slot.release(false);
            return Ok(PairingOutcome {
                ok: false,
                reason: Some("Bluetooth is not ready: there is no connection to BlueZ.".into()),
                status: Some("NotReady".into()),
            });
        };
        let bluez = Arc::clone(&inner.bluez);
        let context = PairingContext {
            bus,
            objects: Arc::clone(inner.bluez.objects()),
            owner: Arc::new(move || bluez.owner()),
            gate: Arc::clone(&inner.gate),
            one_at_a_time: Arc::clone(&inner.one_pairing),
            search_time: inner.settings.search_time,
            pair_timeout: inner.settings.pair_timeout,
        };
        let work_cancel = Arc::clone(&cancel);
        let outcome = run_detached(
            Arc::clone(&cancel),
            pair_brick(context, address, work_cancel),
        )
        .await
        .unwrap_or_else(|| PairingOutcome {
            ok: false,
            reason: Some("The pairing ended without an answer.".into()),
            status: None,
        });
        slot.release(false);
        if outcome.ok {
            inner.presence.note_paired(&mac);
        }
        Ok(outcome)
    }

    /// Whether the paired brick answers an L2CAP connect, holding the queue for mutual exclusion
    /// only.
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
        let answered = inner.probe(&mac).await;
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
        inner.radio.dispose();
        let sessions: Vec<SharedSession> = lock(&inner.sessions).drain().map(|(_, s)| s).collect();
        for session in &sessions {
            session.closing.cancel();
        }
        for session in sessions {
            session.close().await;
        }
        inner.bluez.dispose();
    }
}
