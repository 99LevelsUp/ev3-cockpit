//! A brick with a Bluetooth list behind fake USB and Bluetooth providers, for the forget, the clear
//! and the one-sided repair.
//!
//! The brick answers the peer-list commands from its own list and removes names the way the
//! firmware does: the first entry whose name matches, and nothing at all while its Bluetooth is
//! busy. The providers add what a link does: a Bluetooth link the removal of this computer's entry
//! cuts (`c_bt.c` 3609-3612), and a pairing the Bluetooth provider forgets and makes.
//!
//! Names are placeholders: HOSTA is this computer, the rest are other computers.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::commands::{bt_peer_layout, info_layout};
use ev3_protocol::packet::reply;
use ev3_protocol::{BrickCommand, build_command, encode_ev3_packet};
use ev3_runtime::forget::{ForgetService, RadioName, ThisComputer};
use ev3_runtime::repair::{CheckConfig, OneSidedCheck, RepairEvent};
use ev3_runtime::{
    BackoffConfig, BrickConfig, BrickLog, BrickManager, BrickOptions, ConnectionState,
    ConsentAnswer, ConsentPort, ConsentRequest, DiscoveryConfig, DiscoveryScheduler, Guard,
    PresenceAggregator, Requester, SessionConfig, SessionManager,
};
use ev3_transports::{
    BrickKey, DiscoveryItem, DiscoveryScanResult, ForgetResidue, NameSource, PairingOutcome,
    PresenceState, SendOptions, SessionHandle, Transport, TransportCapabilities, TransportError,
    TransportProvider,
};
use tokio::sync::Semaphore;

pub const AAA: &str = "00165300000A";
/// This computer's Bluetooth name.
pub const HOSTA: &str = "HOSTA";

pub fn usb_key() -> BrickKey {
    BrickKey::new(Transport::Usb, AAA).unwrap()
}

pub fn bt_key() -> BrickKey {
    BrickKey::new(Transport::Bt, "00:16:53:00:00:0A").unwrap()
}

pub fn wall_ms() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(since.as_millis()).unwrap()
}

/// What the Bluetooth provider says the system keeps, returned by its `forget`.
pub fn residue() -> Vec<ForgetResidue> {
    vec![ForgetResidue {
        location: "the system's record of 00165300000A".to_owned(),
        reason: "owned by the system".to_owned(),
    }]
}

// ── The brick ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    PeerCount,
    Peer,
    Remove,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Received {
    pub over: Transport,
    pub kind: Kind,
    /// Whether the Bluetooth link was open when the command reached the brick.
    pub bt_link_open: bool,
    /// The name a removal named.
    pub name: Option<String>,
}

pub struct BrickState {
    pub peers: Vec<String>,
    /// Entries the list marks connected, by name.
    pub connected: HashSet<String>,
    /// Entries the list marks connected, by their place in the list.
    pub connected_at: HashSet<usize>,
    /// The entry the brick holds this computer's Bluetooth link under: its removal cuts the link.
    pub link_entry: String,
    /// The firmware acks a removal it does not run: its Bluetooth is off or busy.
    pub ignores_removal: bool,
    /// Names whose removal the firmware acks and does not run.
    pub refuses: HashSet<String>,
    /// Names the firmware removes this many copies of, then acks the next removal and does not run.
    pub refuses_after: HashMap<String, u32>,
    /// After a removal, the list cannot be read back.
    pub read_back_fails: bool,
    removal_seen: bool,
    pub received: Vec<Received>,
    /// The next command of each kind waits for a permit before it is answered.
    pub holds: HashMap<Kind, Arc<Semaphore>>,
    /// The Bluetooth link is open.
    pub bt_link_open: bool,
}

pub struct Brick {
    state: Mutex<BrickState>,
}

impl Brick {
    fn new(peers: Vec<String>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(BrickState {
                peers,
                connected: HashSet::new(),
                connected_at: HashSet::new(),
                link_entry: HOSTA.to_owned(),
                ignores_removal: false,
                refuses: HashSet::new(),
                refuses_after: HashMap::new(),
                read_back_fails: false,
                removal_seen: false,
                received: Vec::new(),
                holds: HashMap::new(),
                bt_link_open: false,
            }),
        })
    }

    pub fn state(&self) -> MutexGuard<'_, BrickState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn peers(&self) -> Vec<String> {
        self.state().peers.clone()
    }

    /// Holds the next read of the list until the returned gate gets a permit.
    pub fn hold_next_count(&self) -> Arc<Semaphore> {
        self.hold_next(Kind::PeerCount)
    }

    /// Holds the next command of `kind`, at the brick, until the returned gate gets a permit.
    pub fn hold_next(&self, kind: Kind) -> Arc<Semaphore> {
        let gate = Arc::new(Semaphore::new(0));
        self.state().holds.insert(kind, gate.clone());
        gate
    }

    async fn answer(&self, over: Transport, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        let counter = u32::from(u16::from_le_bytes([request[2], request[3]]));
        let body = &request[4..];
        let (kind, index, name) = decode(body);
        let hold = {
            let mut state = self.state();
            let bt_link_open = state.bt_link_open;
            state.received.push(Received {
                over,
                kind,
                bt_link_open,
                name: name.clone(),
            });
            state.holds.remove(&kind)
        };
        if let Some(hold) = hold {
            hold.acquire().await.unwrap().forget();
        }
        let mut state = self.state();
        let payload = match kind {
            Kind::PeerCount => {
                if state.removal_seen && state.read_back_fails {
                    return Err(TransportError::timeout("no reply to the read-back"));
                }
                vec![u8::try_from(state.peers.len()).unwrap()]
            }
            Kind::Peer => {
                let index = index.unwrap();
                let name = state.peers.get(index).cloned().unwrap_or_default();
                let connected =
                    state.connected.contains(&name) || state.connected_at.contains(&index);
                let mut globals = vec![0u8; bt_peer_layout::TOTAL_BYTES];
                let bytes = name.as_bytes();
                let len = bytes.len().min(bt_peer_layout::NAME_BYTES - 1);
                globals[..len].copy_from_slice(&bytes[..len]);
                globals[bt_peer_layout::OFF_PAIRED] = 1;
                globals[bt_peer_layout::OFF_CONNECTED] = u8::from(connected);
                globals[bt_peer_layout::OFF_TYPE] = 3;
                globals
            }
            Kind::Remove => {
                let name = name.unwrap();
                state.removal_seen = true;
                let mut runs = !state.ignores_removal && !state.refuses.contains(&name);
                if runs && let Some(allowed) = state.refuses_after.get_mut(&name) {
                    if *allowed == 0 {
                        runs = false;
                    } else {
                        *allowed -= 1;
                    }
                }
                if runs {
                    if let Some(at) = state.peers.iter().position(|p| *p == name) {
                        state.peers.remove(at);
                    }
                    // The brick closes the removed peer's link before it answers anything.
                    if name == state.link_entry && state.bt_link_open {
                        state.bt_link_open = false;
                        if over == Transport::Bt {
                            return Err(TransportError::timeout("BT reply timed out"));
                        }
                    }
                }
                Vec::new()
            }
            Kind::Other => {
                if body[0] == build_command(&BrickCommand::Info).unwrap().packet_type
                    && body[1..] == build_command(&BrickCommand::Info).unwrap().payload[..]
                {
                    let mut globals = vec![0u8; info_layout::TOTAL_INFO_BYTES];
                    globals[..3].copy_from_slice(b"AAA");
                    globals
                } else {
                    let globals = usize::from(u16::from_le_bytes([body[1], body[2]]) & 0x03ff);
                    vec![0u8; globals]
                }
            }
        };
        drop(state);
        Ok(encode_ev3_packet(counter, reply::DIRECT_REPLY, &payload).unwrap())
    }
}

fn is(body: &[u8], command: &BrickCommand) -> bool {
    let encoded = build_command(command).unwrap();
    body[0] == encoded.packet_type && body[1..] == encoded.payload[..]
}

/// Which command a request is, with a peer's index or a removal's name.
fn decode(body: &[u8]) -> (Kind, Option<usize>, Option<String>) {
    if is(body, &BrickCommand::BluetoothPeerCount) {
        return (Kind::PeerCount, None, None);
    }
    for index in 0..32u8 {
        if is(body, &BrickCommand::BluetoothPeer { index }) {
            return (Kind::Peer, Some(usize::from(index)), None);
        }
    }
    let probe = build_command(&BrickCommand::RemoveBluetoothPeer {
        name: "X".to_owned(),
    })
    .unwrap();
    // The name is the string after the removal's own bytes, up to its terminator.
    let prefix = &probe.payload[..probe.payload.len() - 2];
    if body[0] == probe.packet_type && body[1..].starts_with(prefix) && body.last() == Some(&0) {
        let name = &body[1 + prefix.len()..body.len() - 1];
        return (
            Kind::Remove,
            None,
            Some(String::from_utf8(name.to_vec()).unwrap()),
        );
    }
    (Kind::Other, None, None)
}

// ── The providers ───────────────────────────────────────────────────

pub struct LinkState {
    /// USB: the cable is in, so discovery lists the brick.
    pub cabled: bool,
    /// Bluetooth: this computer has the brick paired, so discovery lists it.
    pub paired: bool,
    /// Bluetooth: once unpaired, the system's cache still lists the brick, unpaired.
    pub cached_after_unpair: bool,
    /// Bluetooth: not heard by the presence checks; the list shows the channel lost.
    pub unheard: bool,
    /// Bluetooth: a presence check answered at this time.
    pub heard_at: Option<i64>,
    /// Switched off: a connect gets no answer.
    pub off: bool,
    /// The brick refuses a Bluetooth link from a computer its list does not hold.
    pub needs_entry: bool,
    pub connects: u32,
    /// USB: the link is open.
    pub open: bool,
    /// Commands of these kinds fail as a dead link would.
    pub fail_kinds: HashSet<Kind>,
    /// Holds the next connect until it gets a permit.
    pub connect_gate: Option<Arc<Semaphore>>,
    pub unpairs: Vec<BrickKey>,
    /// The system's reason for refusing an unpair.
    pub refuse: Option<String>,
    /// Holds the next unpair until it gets a permit.
    pub forget_gate: Option<Arc<Semaphore>>,
    /// How many of the next scans fail.
    pub scan_fails: u32,
    /// Holds the next scan, after it read what it lists, until it gets a permit.
    pub discover_gate: Option<Arc<Semaphore>>,
    pub pair_calls: u32,
    /// What the person at the brick answers a pairing.
    pub pair_accepts: bool,
    /// Holds every pairing until it gets a permit.
    pub pair_gate: Option<Arc<Semaphore>>,
    /// The name the brick stores this computer under when a pairing completes: `None` for this
    /// computer's name, `Some(None)` for no entry at all.
    pub stored_name: Option<Option<String>>,
    /// The brick's list when each pairing started.
    pub peers_at_pair: Vec<Vec<String>>,
    pub disconnects: u32,
    /// Holds the next disconnect until it gets a permit.
    pub disconnect_gate: Option<Arc<Semaphore>>,
    /// How many reads of the brick's list over USB had begun when each connect started.
    pub usb_reads_at_connect: Vec<usize>,
}

pub struct Link {
    transport: Transport,
    brick: Arc<Brick>,
    state: Mutex<LinkState>,
}

impl Link {
    fn new(transport: Transport, brick: Arc<Brick>) -> Arc<Self> {
        Arc::new(Self {
            transport,
            brick,
            state: Mutex::new(LinkState {
                cabled: true,
                paired: true,
                cached_after_unpair: false,
                unheard: false,
                heard_at: None,
                off: false,
                needs_entry: false,
                connects: 0,
                open: false,
                fail_kinds: HashSet::new(),
                connect_gate: None,
                unpairs: Vec::new(),
                refuse: None,
                forget_gate: None,
                scan_fails: 0,
                discover_gate: None,
                pair_calls: 0,
                pair_accepts: true,
                pair_gate: None,
                stored_name: None,
                peers_at_pair: Vec::new(),
                disconnects: 0,
                disconnect_gate: None,
                usb_reads_at_connect: Vec::new(),
            }),
        })
    }

    pub fn state(&self) -> MutexGuard<'_, LinkState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn link_open(&self) -> bool {
        match self.transport {
            Transport::Bt => self.brick.state().bt_link_open,
            _ => self.state().open,
        }
    }

    fn set_open(&self, open: bool) {
        match self.transport {
            Transport::Bt => self.brick.state().bt_link_open = open,
            _ => self.state().open = open,
        }
    }
}

#[async_trait]
impl TransportProvider for Link {
    fn transport(&self) -> Transport {
        self.transport
    }

    fn priority(&self) -> i32 {
        match self.transport {
            Transport::Usb => 30,
            Transport::Bt => 20,
            Transport::Tcp => 10,
            Transport::Mock => 0,
        }
    }

    fn capabilities(&self) -> TransportCapabilities {
        let bt = self.transport == Transport::Bt;
        TransportCapabilities {
            supports_forget: bt,
            rejoin_on_evidence_only: bt,
            supports_pairing: bt,
            ..TransportCapabilities::default()
        }
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        let (items, gate) = {
            let mut state = self.state();
            if state.scan_fails > 0 {
                state.scan_fails -= 1;
                return Err(TransportError::transport_failed("Bluetooth inquiry failed"));
            }
            let now = wall_ms();
            let items = match self.transport {
                Transport::Bt => {
                    let cached = !state.paired && state.cached_after_unpair;
                    if state.paired || cached {
                        let (heard, heard_at) = if state.unheard {
                            (Some(false), None)
                        } else if let Some(at) = state.heard_at {
                            (Some(true), Some(at))
                        } else {
                            (None, None)
                        };
                        vec![DiscoveryItem {
                            brick_key: bt_key(),
                            display_name: "AAA".to_owned(),
                            name_source: Some(NameSource::BtCache),
                            transport: Transport::Bt,
                            presence_state: PresenceState::Available,
                            remembered: state.paired,
                            connected: false,
                            favorite: false,
                            paired: Some(state.paired),
                            heard,
                            heard_at,
                            signal_info: None,
                            bt_visible: None,
                            last_seen_at: now,
                        }]
                    } else {
                        Vec::new()
                    }
                }
                _ if state.cabled => vec![DiscoveryItem {
                    brick_key: usb_key(),
                    display_name: "AAA".to_owned(),
                    name_source: Some(NameSource::UsbDescriptor),
                    transport: Transport::Usb,
                    presence_state: PresenceState::Available,
                    remembered: false,
                    connected: false,
                    favorite: false,
                    paired: None,
                    heard: None,
                    heard_at: None,
                    signal_info: None,
                    bt_visible: None,
                    last_seen_at: now,
                }],
                _ => Vec::new(),
            };
            (items, state.discover_gate.take())
        };
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        Ok(DiscoveryScanResult {
            transport: self.transport,
            items,
        })
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        let usb_reads = self
            .brick
            .state()
            .received
            .iter()
            .filter(|r| r.over == Transport::Usb && r.kind == Kind::PeerCount)
            .count();
        let gate = {
            let mut state = self.state();
            state.connects += 1;
            state.usb_reads_at_connect.push(usb_reads);
            state.connect_gate.take()
        };
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        {
            let state = self.state();
            if state.off || (self.transport == Transport::Usb && !state.cabled) {
                return Err(TransportError::transport_failed(format!(
                    "{} connect failed: no answer",
                    self.transport.as_str().to_ascii_uppercase()
                )));
            }
            if state.needs_entry && !self.brick.peers().iter().any(|p| p == HOSTA) {
                return Err(TransportError::transport_failed(
                    "BT connect failed: the brick does not know this computer",
                ));
            }
        }
        self.set_open(true);
        Ok(SessionHandle {
            brick_key: brick_key.clone(),
            transport: self.transport,
        })
    }

    async fn disconnect(&self, _brick_key: &BrickKey) -> Result<(), TransportError> {
        let gate = {
            let mut state = self.state();
            state.disconnects += 1;
            state.disconnect_gate.take()
        };
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        self.set_open(false);
        Ok(())
    }

    async fn send_packet(
        &self,
        _brick_key: &BrickKey,
        packet: &[u8],
        _options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        let (kind, _, _) = decode(&packet[4..]);
        let failing = self.state().fail_kinds.contains(&kind);
        if !self.link_open() || failing {
            return Err(TransportError::transport_failed(match self.transport {
                Transport::Bt => "BT link closed",
                _ => "USB send failed: LIBUSB_ERROR_IO",
            }));
        }
        self.brick.answer(self.transport, packet).await
    }

    async fn forget(&self, brick_key: &BrickKey) -> Result<Vec<ForgetResidue>, TransportError> {
        let gate = {
            let mut state = self.state();
            state.unpairs.push(brick_key.clone());
            state.forget_gate.take()
        };
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        self.set_open(false);
        let mut state = self.state();
        if let Some(refuse) = &state.refuse {
            return Err(TransportError::transport_failed(format!(
                "Could not forget 00165300000A: {refuse}"
            )));
        }
        state.paired = false;
        Ok(residue())
    }

    async fn pair(&self, _brick_key: &BrickKey) -> Result<PairingOutcome, TransportError> {
        let gate = {
            let mut state = self.state();
            state.pair_calls += 1;
            state.peers_at_pair.push(self.brick.peers());
            state.pair_gate.clone()
        };
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        let mut state = self.state();
        if !state.pair_accepts {
            return Ok(PairingOutcome {
                ok: false,
                reason: Some("The brick did not confirm.".to_owned()),
                status: None,
            });
        }
        state.paired = true;
        match state.stored_name.clone() {
            Some(None) => {}
            Some(Some(name)) => self.brick.state().peers.push(name),
            None => self.brick.state().peers.push(HOSTA.to_owned()),
        }
        Ok(PairingOutcome {
            ok: true,
            reason: None,
            status: Some("Paired".to_owned()),
        })
    }
}

// ── The ports ───────────────────────────────────────────────────────

pub struct Radio(pub Mutex<Option<String>>);

#[async_trait]
impl RadioName for Radio {
    async fn radio_name(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
}

/// A person who answers every question the same way, and remembers each.
pub struct Person {
    pub answer: Mutex<ConsentAnswer>,
    pub asked: Mutex<Vec<ConsentRequest>>,
    /// When set, every answer waits for a permit: the person is thinking.
    pub thinking: Mutex<Option<Arc<Semaphore>>>,
}

#[async_trait]
impl ConsentPort for Person {
    async fn ask(&self, request: ConsentRequest) -> ConsentAnswer {
        self.asked.lock().unwrap().push(request);
        let thinking = self.thinking.lock().unwrap().clone();
        if let Some(thinking) = thinking {
            thinking.acquire().await.unwrap().forget();
        }
        *self.answer.lock().unwrap()
    }
}

#[derive(Default)]
pub struct Lines(pub Mutex<Vec<String>>);

impl BrickLog for Lines {
    fn warn(&self, message: &str) {
        self.0.lock().unwrap().push(format!("warn {message}"));
    }

    fn info(&self, message: &str) {
        self.0.lock().unwrap().push(format!("info {message}"));
    }
}

impl Lines {
    pub fn warnings(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.starts_with("warn "))
            .cloned()
            .collect()
    }
}

pub fn requester() -> Requester {
    Requester {
        name: "EV3 Cockpit (VS Code)".to_owned(),
        kind: ev3_runtime::ClientKind::Vscode,
        connection: None,
    }
}

// ── The world ───────────────────────────────────────────────────────

pub struct Options {
    pub peers: Vec<String>,
    pub radio: Option<String>,
    pub cabled: bool,
    pub paired: bool,
    /// Whether the one-sided check runs.
    pub check: bool,
    /// The brick layer's first rejoin delay.
    pub rejoin_base: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            peers: vec!["Office PC".to_owned(), HOSTA.to_owned()],
            radio: Some(HOSTA.to_owned()),
            cabled: true,
            paired: true,
            check: false,
            rejoin_base: Duration::from_millis(20),
        }
    }
}

pub struct World {
    pub brick: Arc<Brick>,
    pub usb: Arc<Link>,
    pub bt: Arc<Link>,
    pub scheduler: Arc<DiscoveryScheduler>,
    pub list: Arc<PresenceAggregator>,
    pub sessions: SessionManager,
    pub bricks: BrickManager,
    pub service: ForgetService,
    pub check: Option<OneSidedCheck>,
    pub person: Arc<Person>,
    pub radio: Arc<Radio>,
    pub log: Arc<Lines>,
    pub repairs: Arc<Mutex<Vec<RepairEvent>>>,
}

pub fn strings(names: &[&str]) -> Vec<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

pub fn world(options: Options) -> World {
    let brick = Brick::new(options.peers);
    let usb = Link::new(Transport::Usb, brick.clone());
    let bt = Link::new(Transport::Bt, brick.clone());
    usb.state().cabled = options.cabled;
    bt.state().paired = options.paired;
    let providers: [Arc<dyn TransportProvider>; 2] = [usb.clone(), bt.clone()];
    let scheduler = DiscoveryScheduler::new(
        providers.clone(),
        DiscoveryConfig {
            unavailable_after_misses: 1,
            removed_after_misses: 5,
            ..DiscoveryConfig::default()
        },
    );
    let list = PresenceAggregator::new(scheduler.clone());
    let sessions = SessionManager::new(
        providers,
        Arc::new(Guard::default()),
        SessionConfig {
            heartbeat_interval: Duration::from_secs(3600),
            backoff: BackoffConfig {
                base: Duration::from_millis(20),
                max: Duration::from_millis(40),
                ..BackoffConfig::default()
            },
            ..SessionConfig::default()
        },
    );
    let log = Arc::new(Lines::default());
    let radio = Arc::new(Radio(Mutex::new(options.radio)));
    let computer = ThisComputer::new(radio.clone(), Some(log.clone()));
    let check = options.check.then(|| {
        OneSidedCheck::new(
            computer.clone(),
            Some(log.clone()),
            CheckConfig {
                own_pairing_rereads: vec![
                    Duration::from_millis(40),
                    Duration::from_millis(80),
                    Duration::from_millis(160),
                ],
            },
        )
    });
    let bricks = BrickManager::new(
        sessions.clone(),
        list.clone(),
        BrickOptions {
            config: BrickConfig {
                rejoin_backoff: BackoffConfig {
                    base: options.rejoin_base,
                    max: options.rejoin_base * 16,
                    ..BackoffConfig::default()
                },
                slow_probe_retry: Duration::from_millis(20),
            },
            log: Some(log.clone()),
            bluetooth_gate: check.as_ref().map(OneSidedCheck::gate),
            ..BrickOptions::default()
        },
    );
    let repairs = Arc::new(Mutex::new(Vec::new()));
    if let Some(check) = &check {
        check.attach(&bricks);
        let mut events = check.subscribe();
        let seen = repairs.clone();
        tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                seen.lock().unwrap().push(event);
            }
        });
    }
    let person = Arc::new(Person {
        answer: Mutex::new(ConsentAnswer::Granted),
        asked: Mutex::new(Vec::new()),
        thinking: Mutex::new(None),
    });
    let service = ForgetService::new(bricks.clone(), person.clone(), computer, check.clone());
    World {
        brick,
        usb,
        bt,
        scheduler,
        list,
        sessions,
        bricks,
        service,
        check,
        person,
        radio,
        log,
        repairs,
    }
}

/// Lets every task that is ready run.
pub async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// Waits, on the paused clock, until `done` holds; panics after `ms` of the clock.
pub async fn wait_for(ms: u64, what: &str, done: impl Fn() -> bool) {
    for _ in 0..ms {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert!(done(), "timed out waiting for {what}");
}

impl World {
    pub async fn scan(&self) {
        self.scheduler.scan_once().await;
        settle().await;
    }

    pub fn state(&self, key: &BrickKey) -> Option<ConnectionState> {
        self.sessions.session(key).map(|s| s.connection_state)
    }

    pub fn connected(&self, key: &BrickKey) -> bool {
        self.state(key) == Some(ConnectionState::Connected)
    }

    /// Until nothing more reaches the brick: the reads its joins started have ended.
    pub async fn quiet(&self) {
        let mut seen = usize::MAX;
        loop {
            let now = self.brick.state().received.len();
            if now == seen {
                return;
            }
            seen = now;
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// Signs the brick in and waits until these channels are connected and the reads its joins
    /// started have ended; what reached the brick until then is not what a test looks at.
    pub async fn signed_in_over(&self, transports: &[Transport]) {
        self.scan().await;
        self.bricks.sign_in(AAA).await.unwrap();
        for transport in transports {
            let key = if *transport == Transport::Usb {
                usb_key()
            } else {
                bt_key()
            };
            wait_for(1000, "the channel to connect", || self.connected(&key)).await;
        }
        self.quiet().await;
        self.brick.state().received.clear();
    }

    /// The peer-list commands that reached the brick, over one transport or any.
    pub fn peer_traffic(&self, over: Option<Transport>) -> Vec<Kind> {
        self.brick
            .state()
            .received
            .iter()
            .filter(|r| over.is_none_or(|t| r.over == t) && r.kind != Kind::Other)
            .map(|r| r.kind)
            .collect()
    }

    /// The names of the removals that reached the brick, in order.
    pub fn removals(&self) -> Vec<String> {
        self.brick
            .state()
            .received
            .iter()
            .filter_map(|r| r.name.clone())
            .collect()
    }

    pub fn answer(&self, answer: ConsentAnswer) {
        *self.person.answer.lock().unwrap() = answer;
    }

    pub fn asked(&self) -> Vec<ConsentRequest> {
        self.person.asked.lock().unwrap().clone()
    }

    /// The one-sided repairs reported, in order.
    pub fn repairs(&self) -> Vec<ev3_runtime::repair::OneSidedRepair> {
        self.repairs
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                RepairEvent::Repaired(repair) => Some(repair.clone()),
                _ => None,
            })
            .collect()
    }
}
