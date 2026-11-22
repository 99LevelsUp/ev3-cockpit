//! The discovery list: one entry per brick, however many channels reach it.
//!
//! Discovery reports channels — `usb:001653…` and `bt:00:16:53:…` are two sightings of one brick
//! — and this layer groups them by the brick's hardware digits, drives each channel's state from
//! presence and session events, and picks the most trustworthy name. It is the one read model of
//! the list; the views and the clients read it.
//!
//! It does not order the list: what belongs at the top is a question about the person reading
//! it, not about discovery. So it keeps the evidence a view sorts by (when each channel was last
//! seen, its signal, when a presence check last heard it): a brick in the hand rises as it comes
//! closer.
//!
//! A channel discovery has given up on stays in its brick as `lost`, so a brick whose cable was
//! pulled shows a grey USB channel rather than none. A brick whose every channel has expired is
//! dropped only if nothing ties it to this user — never connected and not remembered — so the
//! strangers' bricks a competition room is full of do not pile up.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use ev3_transports::{
    BrickKey, DiscoveryItem, NameSource, PresenceState, SignalInfo, Transport, TransportError,
};
use tokio::sync::broadcast;

use crate::discovery::{DiscoveryListener, DiscoveryScheduler, PresenceChange, now_ms};
use crate::guard::brick_id_of;
use crate::session::ConnectionState;

// ── One channel's state ─────────────────────────────────────────────

/// How one channel to a brick stands, as the list shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChannelState {
    /// Never seen.
    Absent,
    Available,
    Connected,
    /// Seen before and not now, or its session lost the link.
    Lost,
}

/// What can happen to a channel. Facts, not commands: the machine decides what they mean.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelEvent {
    /// Discovery reports the brick on this transport, or a presence check answered.
    Seen,
    /// Discovery stopped reporting it, or a presence check went unanswered.
    Gone,
    /// A session over this channel is connected.
    LinkUp,
    /// That session lost its link and is reconnecting.
    LinkDown,
    /// That session ended: signed out, or a join that failed.
    Closed,
}

/// An event that is not valid in the channel's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidTransition {
    pub state: ChannelState,
    pub event: ChannelEvent,
}

impl fmt::Display for InvalidTransition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Invalid channel transition: {:?} on {:?}",
            self.state, self.event
        )
    }
}

impl std::error::Error for InvalidTransition {}

/// The valid transitions; `None` where an event is invalid.
///
/// Two rules worth naming. A connected channel stays connected while discovery misses it: the
/// live session is stronger evidence than a scan (USB discovery skips a device its own transport
/// holds claimed). And a lost channel stays lost when its session closes: closing says nothing
/// about whether the brick came back.
fn transition(state: ChannelState, event: ChannelEvent) -> Option<ChannelState> {
    use ChannelEvent as E;
    use ChannelState as S;
    match (state, event) {
        (S::Absent, E::Seen) => Some(S::Available),
        (S::Absent, _) => None,
        (S::Available, E::Seen | E::Closed) => Some(S::Available),
        (S::Available, E::Gone) => Some(S::Lost),
        (S::Available, E::LinkUp) => Some(S::Connected),
        (S::Available, E::LinkDown) => None,
        (S::Connected, E::Seen | E::Gone | E::LinkUp) => Some(S::Connected),
        (S::Connected, E::LinkDown) => Some(S::Lost),
        (S::Connected, E::Closed) => Some(S::Available),
        (S::Lost, E::Seen) => Some(S::Available),
        (S::Lost, E::Gone | E::LinkDown | E::Closed) => Some(S::Lost),
        (S::Lost, E::LinkUp) => Some(S::Connected),
    }
}

/// One channel's state machine; every transport loses and regains a channel the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelMachine {
    state: ChannelState,
}

impl Default for ChannelMachine {
    fn default() -> Self {
        Self {
            state: ChannelState::Absent,
        }
    }
}

impl ChannelMachine {
    pub fn state(&self) -> ChannelState {
        self.state
    }

    pub fn accepts(&self, event: ChannelEvent) -> bool {
        transition(self.state, event).is_some()
    }

    /// Applies an event and answers whether the state changed; an invalid one changes nothing.
    pub fn apply(&mut self, event: ChannelEvent) -> Result<bool, InvalidTransition> {
        let next = transition(self.state, event).ok_or(InvalidTransition {
            state: self.state,
            event,
        })?;
        let changed = next != self.state;
        self.state = next;
        Ok(changed)
    }
}

/// One brick on one transport, as the list tracks it.
#[derive(Debug, Clone)]
pub struct BrickChannel {
    pub brick_key: BrickKey,
    pub transport: Transport,
    /// The provider's priority for this transport.
    pub priority: i32,
    machine: ChannelMachine,
    signal_info: Option<SignalInfo>,
    last_seen_at: i64,
    heard_at: Option<i64>,
    ever_connected: bool,
    expired: bool,
}

impl BrickChannel {
    pub fn new(brick_key: BrickKey, transport: Transport, priority: i32) -> Self {
        Self {
            brick_key,
            transport,
            priority,
            machine: ChannelMachine::default(),
            signal_info: None,
            last_seen_at: 0,
            heard_at: None,
            ever_connected: false,
            expired: false,
        }
    }

    pub fn state(&self) -> ChannelState {
        self.machine.state()
    }

    /// Whether a session over this channel has ever been connected.
    pub fn ever_connected(&self) -> bool {
        self.ever_connected
    }

    /// When the brick last answered a presence check over this channel, if it ever has.
    pub fn heard_at(&self) -> Option<i64> {
        self.heard_at
    }

    /// Whether discovery has given the channel up for good and nothing has seen it since.
    pub fn expired(&self) -> bool {
        self.expired
    }

    pub fn accepts(&self, event: ChannelEvent) -> bool {
        self.machine.accepts(event)
    }

    /// Applies an event; answers whether the state changed.
    pub fn apply(&mut self, event: ChannelEvent) -> Result<bool, InvalidTransition> {
        let changed = self.machine.apply(event)?;
        if event == ChannelEvent::LinkUp {
            self.ever_connected = true;
        }
        if matches!(event, ChannelEvent::Seen | ChannelEvent::LinkUp) {
            self.expired = false;
        }
        Ok(changed)
    }

    /// Applies an event the state accepts; anything else is ignored. Answers whether it changed.
    fn apply_if_accepted(&mut self, event: ChannelEvent) -> bool {
        self.accepts(event) && self.apply(event).unwrap_or(false)
    }

    /// Records that discovery has given the channel up for good.
    pub fn mark_expired(&mut self) {
        self.expired = true;
    }

    /// Records what discovery last saw on this channel.
    pub fn observe(
        &mut self,
        last_seen_at: i64,
        signal_info: Option<SignalInfo>,
        heard_at: Option<i64>,
    ) {
        self.last_seen_at = last_seen_at;
        self.signal_info = signal_info;
        if heard_at.is_some() {
            self.heard_at = heard_at;
        }
    }

    pub fn snapshot(&self) -> ChannelSnapshot {
        ChannelSnapshot {
            brick_key: self.brick_key.clone(),
            transport: self.transport,
            priority: self.priority,
            state: self.state(),
            signal_info: self.signal_info.clone(),
            last_seen_at: self.last_seen_at,
            heard_at: self.heard_at,
        }
    }
}

/// One channel of a list entry, with the evidence a view sorts by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelSnapshot {
    pub brick_key: BrickKey,
    pub transport: Transport,
    pub priority: i32,
    pub state: ChannelState,
    pub signal_info: Option<SignalInfo>,
    /// When discovery last saw it, in ms since the epoch.
    pub last_seen_at: i64,
    /// When a presence check last heard it, in ms since the epoch.
    pub heard_at: Option<i64>,
}

/// The name a list entry shows, and how far it can be trusted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrickName {
    pub value: String,
    pub source: NameSource,
    /// The brick itself gave it (its info reply or its beacon), so it follows a rename.
    pub confirmed: bool,
}

/// One brick in the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrickEntry {
    pub brick_id: String,
    pub name: BrickName,
    /// Every channel ever seen, the highest priority first: USB, Bluetooth, TCP.
    pub channels: Vec<ChannelSnapshot>,
    /// Paired with this computer over Bluetooth.
    pub paired: bool,
    pub remembered: bool,
    pub favorite: bool,
    /// The latest `last_seen_at` of its channels.
    pub last_seen_at: i64,
}

impl BrickEntry {
    /// The channel over a transport, if the brick has one.
    pub fn channel(&self, transport: Transport) -> Option<&ChannelSnapshot> {
        self.channels.iter().find(|c| c.transport == transport)
    }
}

// ── Name trust ──────────────────────────────────────────────────────

/// Sources that follow a rename; between these the newest wins.
fn is_confirmed_source(source: NameSource) -> bool {
    matches!(source, NameSource::Brick | NameSource::Beacon)
}

/// Sources that go stale, most trustworthy first; used only while no confirmed name exists.
const UNCONFIRMED_ORDER: [NameSource; 3] = [
    NameSource::UsbDescriptor,
    NameSource::BtCache,
    NameSource::Fallback,
];

#[derive(Debug, Clone)]
struct NameRecord {
    value: String,
    at: i64,
}

struct BrickRecord {
    brick_id: String,
    channels: BTreeMap<Transport, BrickChannel>,
    names: Vec<(NameSource, NameRecord)>,
    paired: bool,
    remembered: bool,
    favorite: bool,
}

impl BrickRecord {
    fn new(brick_id: String) -> Self {
        Self {
            brick_id,
            channels: BTreeMap::new(),
            names: Vec::new(),
            paired: false,
            remembered: false,
            favorite: false,
        }
    }

    /// Stores a name from one source; answers whether it changed.
    ///
    /// An unchanged name keeps the time it was first given. Otherwise a beacon repeating a name
    /// every scan would always be the newest, and would overrule a rename the cockpit just read
    /// back from the brick for the seconds until the beacon catches up.
    fn set_name(&mut self, source: NameSource, name: &str, at: i64) -> bool {
        let value = name.trim();
        if value.is_empty() {
            return false;
        }
        match self.names.iter_mut().find(|(s, _)| *s == source) {
            Some((_, record)) if record.value == value => false,
            Some((_, record)) => {
                *record = NameRecord {
                    value: value.to_owned(),
                    at,
                };
                true
            }
            None => {
                self.names.push((
                    source,
                    NameRecord {
                        value: value.to_owned(),
                        at,
                    },
                ));
                true
            }
        }
    }

    fn note_name(&mut self, item: &DiscoveryItem, at: i64) -> bool {
        self.set_name(
            item.name_source.unwrap_or(NameSource::Fallback),
            &item.display_name,
            at,
        )
    }

    /// The newest name the brick itself gave, if any; otherwise the most trustworthy stale one.
    fn resolve_name(&self) -> BrickName {
        let mut best: Option<&(NameSource, NameRecord)> = None;
        for entry in &self.names {
            if is_confirmed_source(entry.0) && best.is_none_or(|b| entry.1.at >= b.1.at) {
                best = Some(entry);
            }
        }
        if let Some((source, record)) = best {
            return BrickName {
                value: record.value.clone(),
                source: *source,
                confirmed: true,
            };
        }
        for source in UNCONFIRMED_ORDER {
            if let Some((_, record)) = self.names.iter().find(|(s, _)| *s == source) {
                return BrickName {
                    value: record.value.clone(),
                    source,
                    confirmed: false,
                };
            }
        }
        BrickName {
            value: self.brick_id.clone(),
            source: NameSource::Fallback,
            confirmed: false,
        }
    }

    fn entry(&self) -> BrickEntry {
        let mut channels: Vec<ChannelSnapshot> = self
            .channels
            .values()
            .filter(|c| c.state() != ChannelState::Absent)
            .map(BrickChannel::snapshot)
            .collect();
        channels.sort_by_key(|c| std::cmp::Reverse(c.priority));
        let last_seen_at = channels
            .iter()
            .map(|c| c.last_seen_at)
            .max()
            .unwrap_or(0)
            .max(0);
        BrickEntry {
            brick_id: self.brick_id.clone(),
            name: self.resolve_name(),
            channels,
            paired: self.paired,
            remembered: self.remembered,
            favorite: self.favorite,
            last_seen_at,
        }
    }

    /// Records a sighting of one channel: its evidence, whether the brick is paired, its name.
    fn observe(&mut self, transport: Transport, item: &DiscoveryItem) {
        if let Some(channel) = self.channels.get_mut(&transport) {
            channel.observe(item.last_seen_at, item.signal_info.clone(), item.heard_at);
        }
        // The operating system's Bluetooth list says whether the brick is paired now: a brick
        // unpaired in the system's settings, outside the cockpit, was otherwise still joined as
        // paired for the rest of the session — a connect where a pairing was needed, which raised
        // the brick's dialog and the system's own pairing prompt and failed. Discovery fences a
        // scan older than a pairing the cockpit made, so a stale listing cannot take a fresh
        // pairing back. Other sources (USB, persistence) only ever add it.
        if item.transport == Transport::Bt && item.paired.is_some() {
            self.paired = item.paired == Some(true);
        } else {
            self.paired |= item.paired == Some(true);
        }
        self.note_name(item, item.last_seen_at);
    }
}

// ── Events ──────────────────────────────────────────────────────────

/// What the list tells its listeners.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresenceEvent {
    /// The list changed; read it with [`PresenceAggregator::list`].
    ListChanged,
    /// A channel's presence changed, as discovery reported it.
    PresenceChanged(PresenceChange),
    /// The Bluetooth presence checks stopped hearing a channel, which the list then shows lost,
    /// or heard it again. Not for a flag a scan merely repeats.
    HeardChanged { brick_key: BrickKey, heard: bool },
    /// A provider's scan failed.
    ScanFailed {
        transport: Transport,
        error: TransportError,
    },
}

// ── The aggregator ──────────────────────────────────────────────────

/// Turns per-channel discovery into the list of bricks.
pub struct PresenceAggregator {
    scheduler: Arc<DiscoveryScheduler>,
    bricks: Mutex<BTreeMap<String, BrickRecord>>,
    events: broadcast::Sender<PresenceEvent>,
}

/// How a session state reads as a channel event; `Connecting` says nothing yet.
fn session_event(state: ConnectionState) -> Option<ChannelEvent> {
    match state {
        ConnectionState::Connected => Some(ChannelEvent::LinkUp),
        ConnectionState::Reconnecting => Some(ChannelEvent::LinkDown),
        ConnectionState::Disconnected => Some(ChannelEvent::Closed),
        ConnectionState::Connecting => None,
    }
}

impl PresenceAggregator {
    /// The list over `scheduler`, which it listens to from now on.
    pub fn new(scheduler: Arc<DiscoveryScheduler>) -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        let aggregator = Arc::new(Self {
            scheduler: scheduler.clone(),
            bricks: Mutex::new(BTreeMap::new()),
            events,
        });
        let weak: Weak<dyn DiscoveryListener> =
            Arc::downgrade(&aggregator) as Weak<dyn DiscoveryListener>;
        scheduler.add_listener(weak);
        aggregator
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, BrickRecord>> {
        self.bricks.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn scheduler(&self) -> &Arc<DiscoveryScheduler> {
        &self.scheduler
    }

    /// Events from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<PresenceEvent> {
        self.events.subscribe()
    }

    fn emit(&self, event: PresenceEvent) {
        // No listener is not an error.
        let _ = self.events.send(event);
    }

    /// The bricks known now, in no particular order: sorting belongs to the views.
    pub fn list(&self) -> Vec<BrickEntry> {
        self.lock().values().map(BrickRecord::entry).collect()
    }

    pub fn brick(&self, brick_id: &str) -> Option<BrickEntry> {
        self.lock().get(brick_id).map(BrickRecord::entry)
    }

    /// Merges remembered bricks from persistence into the list. Their channels start absent.
    pub fn merge_remembered(&self, remembered: &[DiscoveryItem]) {
        {
            let mut bricks = self.lock();
            for item in remembered {
                let record = record_for(&mut bricks, brick_id_of(&item.brick_key));
                record.remembered = true;
                record.paired |= item.paired == Some(true);
                record.note_name(item, 0);
            }
        }
        self.emit(PresenceEvent::ListChanged);
    }

    /// Records the name the brick itself just gave, from an info reply: the most trustworthy
    /// source there is, alongside the TCP beacon; between the two the newer name wins.
    pub fn confirm_name(&self, brick_id: &str, name: &str) {
        let changed = self
            .lock()
            .get_mut(brick_id)
            .is_some_and(|record| record.set_name(NameSource::Brick, name, now_ms()));
        if changed {
            self.emit(PresenceEvent::ListChanged);
        }
    }

    /// Sets the fields the list owns on a brick.
    pub fn update_brick(&self, brick_id: &str, favorite: Option<bool>, remembered: Option<bool>) {
        {
            let mut bricks = self.lock();
            let Some(record) = bricks.get_mut(brick_id) else {
                return;
            };
            if let Some(favorite) = favorite {
                record.favorite = favorite;
            }
            if let Some(remembered) = remembered {
                record.remembered = remembered;
            }
        }
        self.emit(PresenceEvent::ListChanged);
    }

    /// Feeds a channel's session state into its machine.
    ///
    /// A connected session is proof the brick is there, so a channel discovery has not seen yet
    /// is marked seen first: a brick picked from a live Bluetooth scan can connect before the
    /// device cache lists it.
    pub fn update_channel_session(&self, brick_key: &BrickKey, state: ConnectionState) {
        let Some(event) = session_event(state) else {
            return;
        };
        let transport = brick_key.transport();
        let priority = self.scheduler.priority_of(transport);
        let changed = {
            let mut bricks = self.lock();
            let brick_id = brick_id_of(brick_key);
            if event == ChannelEvent::LinkUp {
                let record = record_for(&mut bricks, brick_id.clone());
                let channel = channel_for(record, brick_key, transport, priority);
                if channel.state() == ChannelState::Absent {
                    channel.apply_if_accepted(ChannelEvent::Seen);
                }
            }
            bricks
                .get_mut(&brick_id)
                .and_then(|record| record.channels.get_mut(&transport))
                .is_some_and(|channel| channel.apply_if_accepted(event))
        };
        if changed {
            self.emit(PresenceEvent::ListChanged);
        }
    }

    /// Records a Bluetooth pairing the cockpit has just made: the list says paired at once, and
    /// the channel is available, without waiting for a scan to read the pairing back.
    ///
    /// The pairing is proof the brick is there, so a sighting that expired while its owner was
    /// confirming on the brick is listed again. Discovery records the pairing too, since the list
    /// is rebuilt from what it tracks.
    pub fn mark_paired(&self, brick_key: &BrickKey) {
        if brick_key.transport() != Transport::Bt {
            return;
        }
        self.scheduler.note_paired(brick_key);
        let priority = self.scheduler.priority_of(Transport::Bt);
        {
            let mut bricks = self.lock();
            let record = record_for(&mut bricks, brick_id_of(brick_key));
            let channel = channel_for(record, brick_key, Transport::Bt, priority);
            if channel.state() != ChannelState::Available {
                channel.apply_if_accepted(ChannelEvent::Seen);
            }
            record.paired = true;
        }
        self.emit(PresenceEvent::ListChanged);
    }

    /// Forgets a brick: drops its record, so the list holds nothing about it.
    ///
    /// A scan that lists one of its channels again builds a fresh record, unpaired and not
    /// remembered unless that sighting says so, so a brick still in reach returns as a stranger.
    /// Discovery forgets the channel keys separately; until it has, the next scan rebuilds the
    /// record from what it still tracks.
    pub fn forget(&self, brick_id: &str) {
        let removed = self.lock().remove(brick_id).is_some();
        if removed {
            self.emit(PresenceEvent::ListChanged);
        }
    }

    /// Forgets one channel of a brick and keeps the brick: its other channels stay.
    ///
    /// Forgetting the Bluetooth channel clears `paired` at once; a later scan that lists the
    /// brick as paired sets it again. A record left with no channel goes too, unless remembered.
    pub fn forget_channel(&self, brick_key: &BrickKey) {
        let transport = brick_key.transport();
        {
            let mut bricks = self.lock();
            let brick_id = brick_id_of(brick_key);
            let Some(record) = bricks.get_mut(&brick_id) else {
                return;
            };
            record.channels.remove(&transport);
            if transport == Transport::Bt {
                record.paired = false;
            }
            if record.channels.is_empty() && !record.remembered {
                bricks.remove(&brick_id);
            }
        }
        self.emit(PresenceEvent::ListChanged);
    }

    fn handle_presence_change(&self, change: &PresenceChange) {
        let transport = change.item.transport;
        let priority = self.scheduler.priority_of(transport);
        let heard = {
            let mut bricks = self.lock();
            let brick_id = brick_id_of(&change.brick_key);
            let record = record_for(&mut bricks, brick_id.clone());
            let heard_before =
                channel_for(record, &change.brick_key, transport, priority).heard_at();
            record.observe(transport, &change.item);
            let channel = channel_for(record, &change.brick_key, transport, priority);
            let event = if change.current == PresenceState::Available {
                ChannelEvent::Seen
            } else {
                ChannelEvent::Gone
            };
            channel.apply_if_accepted(event);
            let heard = apply_heard(channel, &change.item, heard_before);
            if change.current == PresenceState::Removed {
                channel.mark_expired();
                drop_if_stranger(&mut bricks, &brick_id);
            }
            heard
        };
        if let Some(heard) = heard {
            self.emit(heard);
        }
        self.emit(PresenceEvent::PresenceChanged(change.clone()));
        self.emit(PresenceEvent::ListChanged);
    }

    fn rebuild(&self, tracked: &[DiscoveryItem]) {
        let mut heard_changes = Vec::new();
        {
            let mut bricks = self.lock();
            for item in tracked {
                let priority = self.scheduler.priority_of(item.transport);
                let record = record_for(&mut bricks, brick_id_of(&item.brick_key));
                let channel = channel_for(record, &item.brick_key, item.transport, priority);
                if item.presence_state == PresenceState::Available
                    && channel.state() == ChannelState::Absent
                {
                    channel.apply_if_accepted(ChannelEvent::Seen);
                }
                let heard_before = channel.heard_at();
                record.observe(item.transport, item);
                let channel = channel_for(record, &item.brick_key, item.transport, priority);
                heard_changes.extend(apply_heard(channel, item, heard_before));
            }
        }
        for heard in heard_changes {
            self.emit(heard);
        }
        self.emit(PresenceEvent::ListChanged);
    }
}

impl DiscoveryListener for PresenceAggregator {
    fn presence_changed(&self, change: &PresenceChange) {
        self.handle_presence_change(change);
    }

    fn scan_completed(&self, tracked: &[DiscoveryItem]) {
        self.rebuild(tracked);
    }

    fn scan_failed(&self, transport: Transport, error: &TransportError) {
        self.emit(PresenceEvent::ScanFailed {
            transport,
            error: error.clone(),
        });
    }
}

fn record_for(bricks: &mut BTreeMap<String, BrickRecord>, brick_id: String) -> &mut BrickRecord {
    bricks
        .entry(brick_id.clone())
        .or_insert_with(|| BrickRecord::new(brick_id))
}

fn channel_for<'a>(
    record: &'a mut BrickRecord,
    brick_key: &BrickKey,
    transport: Transport,
    priority: i32,
) -> &'a mut BrickChannel {
    record
        .channels
        .entry(transport)
        .or_insert_with(|| BrickChannel::new(brick_key.clone(), transport, priority))
}

/// A paired Bluetooth brick that stopped answering its presence checks is lost — shown as "not
/// heard" — while the system keeps listing it; a fresh answer makes it available again.
///
/// Only a new answer counts as evidence for the way back: a `heard` flag carried over from before
/// is not news, and a channel lost to a dropped session must not turn available on it.
fn apply_heard(
    channel: &mut BrickChannel,
    item: &DiscoveryItem,
    heard_before: Option<i64>,
) -> Option<PresenceEvent> {
    if item.heard == Some(false) && channel.state() == ChannelState::Available {
        return channel.apply_if_accepted(ChannelEvent::Gone).then(|| {
            PresenceEvent::HeardChanged {
                brick_key: item.brick_key.clone(),
                heard: false,
            }
        });
    }
    if item.heard == Some(true)
        && item.heard_at.is_some()
        && item.heard_at != heard_before
        && channel.state() == ChannelState::Lost
        && !channel.expired()
    {
        return channel.apply_if_accepted(ChannelEvent::Seen).then(|| {
            PresenceEvent::HeardChanged {
                brick_key: item.brick_key.clone(),
                heard: true,
            }
        });
    }
    None
}

fn drop_if_stranger(bricks: &mut BTreeMap<String, BrickRecord>, brick_id: &str) {
    let keep = bricks.get(brick_id).is_some_and(|record| {
        record.remembered
            || record
                .channels
                .values()
                .any(|c| c.ever_connected() || !c.expired())
    });
    if !keep {
        bricks.remove(brick_id);
    }
}
