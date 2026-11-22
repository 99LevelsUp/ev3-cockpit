//! Sessions: one brick on one channel, from connect to disconnect, with the heartbeat that
//! notices a dead link and the reconnect that brings it back.
//!
//! The session manager is the one source of truth for connection state. A session ends only when
//! someone disconnects it: a link that dies on its own (a pulled cable, a brick switched off, a
//! radio out of range) puts the session into `Reconnecting`, and it keeps trying for as long as
//! the sign-in stands.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use ev3_protocol::packet::verify_reply_counter;
use ev3_protocol::{
    BrickCommand, BrickResponse, build_command, decode_ev3_packet, encode_ev3_packet,
    parse_response,
};
use ev3_transports::{
    BrickKey, ErrorCode, SendOptions, SessionHandle, Transport, TransportError, TransportProvider,
};
use tokio::sync::broadcast;
use tokio::task::AbortHandle;
use tokio::time::Instant;

use crate::error::SessionError;
use crate::guard::Guard;
use crate::heartbeat::{Beat, MissCounter, Probe, effective_interval};
use crate::queue::{CommandQueue, DrainReason};
use crate::reconnect::{Backoff, BackoffConfig};

/// How sessions watch and restore their links.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionConfig {
    /// How often the heartbeat probes; raised to [`crate::MIN_HEARTBEAT_INTERVAL`] if lower.
    pub heartbeat_interval: Duration,
    /// Consecutive missed beats that mean the link is gone.
    pub heartbeat_miss_threshold: u32,
    pub backoff: BackoffConfig,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            heartbeat_interval: crate::heartbeat::MIN_HEARTBEAT_INTERVAL,
            heartbeat_miss_threshold: 2,
            backoff: BackoffConfig::default(),
        }
    }
}

/// Where a session's connection stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
}

/// What the heartbeat last found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeartbeatState {
    Unknown,
    Ok,
    Missed,
}

/// A session as it stands, for reading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub brick_key: BrickKey,
    pub transport: Transport,
    pub display_name: String,
    pub connection_state: ConnectionState,
    pub heartbeat_state: HeartbeatState,
    /// Why the last thing that failed failed: a connect, a reconnect attempt, a heartbeat.
    pub last_error: Option<String>,
}

/// What the session manager tells its listeners.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    StateChanged {
        brick_key: BrickKey,
        previous: ConnectionState,
        new: ConnectionState,
    },
    /// One reconnect attempt failed. A session can sit in `Reconnecting` for minutes; without
    /// this the reason lived only in `last_error`, which nobody reads, and the log said nothing.
    ReconnectFailed {
        brick_key: BrickKey,
        /// Which attempt of this reconnect cycle failed, from 1 (0 for an attempt a sighting
        /// started right after the backoff was reset).
        attempt: u32,
        error: String,
        /// When the next attempt goes; `None` when there is none and the session ends.
        next_delay: Option<Duration>,
    },
}

/// One session's state.
struct Entry {
    /// Tells this session from a later one on the same channel.
    id: u64,
    display_name: String,
    connection: ConnectionState,
    heartbeat: HeartbeatState,
    last_error: Option<String>,
    /// A disconnect is under way; the session takes no commands and starts nothing.
    closing: bool,
    /// The message counter of the current link. Each link starts again: two counters over one
    /// connection would collide and match each other's replies.
    counter: u16,
    misses: MissCounter,
    backoff: Backoff,
    queue: Arc<CommandQueue>,
    heartbeat_task: Option<AbortHandle>,
    /// The one wait before the next reconnect attempt. Covers the wait only: the attempt runs on
    /// a task of its own, so cancelling the wait never cuts an open short.
    reconnect_timer: Option<AbortHandle>,
}

impl Entry {
    fn stop_tasks(&mut self) {
        if let Some(task) = self.heartbeat_task.take() {
            task.abort();
        }
        if let Some(timer) = self.reconnect_timer.take() {
            timer.abort();
        }
    }
}

#[derive(Default)]
struct State {
    sessions: HashMap<BrickKey, Entry>,
    /// Channels signed out by hand: not to be connected again automatically.
    suppressed: HashSet<BrickKey>,
    next_id: u64,
}

impl State {
    fn entry(&self, key: &BrickKey, id: u64) -> Option<&Entry> {
        self.sessions.get(key).filter(|e| e.id == id)
    }

    fn entry_mut(&mut self, key: &BrickKey, id: u64) -> Option<&mut Entry> {
        self.sessions.get_mut(key).filter(|e| e.id == id)
    }
}

struct Inner {
    providers: HashMap<Transport, Arc<dyn TransportProvider>>,
    guard: Arc<Guard>,
    config: SessionConfig,
    state: Mutex<State>,
    /// One link opening per channel at a time; see [`Inner::open_link`].
    openings: Mutex<HashMap<BrickKey, Arc<tokio::sync::Mutex<()>>>>,
    events: broadcast::Sender<SessionEvent>,
}

/// The sessions of every channel. Cheap to clone; clones share the sessions.
#[derive(Clone)]
pub struct SessionManager {
    inner: Arc<Inner>,
}

impl SessionManager {
    pub fn new(
        providers: impl IntoIterator<Item = Arc<dyn TransportProvider>>,
        guard: Arc<Guard>,
        config: SessionConfig,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                providers: providers.into_iter().map(|p| (p.transport(), p)).collect(),
                guard,
                config,
                state: Mutex::new(State::default()),
                openings: Mutex::new(HashMap::new()),
                events,
            }),
        }
    }

    /// The guard the sessions share.
    pub fn guard(&self) -> &Arc<Guard> {
        &self.inner.guard
    }

    /// Session events from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.inner.events.subscribe()
    }

    /// Connects one channel to a brick. The transport is the key's.
    ///
    /// Fails with `ConnectionAbandoned` when a disconnect ran while it connected: a caller that
    /// saw it return would take the brick as connected.
    pub async fn connect(
        &self,
        brick_key: &BrickKey,
        display_name: Option<&str>,
    ) -> Result<(), SessionError> {
        self.inner.connect(brick_key, display_name).await
    }

    /// Ends a session. An explicit disconnect (the user's) also keeps the channel from being
    /// connected again automatically.
    pub async fn disconnect(&self, brick_key: &BrickKey, explicit: bool) {
        self.inner.disconnect(brick_key, explicit, None).await;
    }

    /// Sends a command over a connected session, in its turn.
    ///
    /// Refused at once while the session reconnects: its link is lost, and a command held for
    /// the new link would arrive late (a motor command most of all).
    pub async fn send(
        &self,
        brick_key: &BrickKey,
        command: &BrickCommand,
        timeout: Option<Duration>,
    ) -> Result<BrickResponse, SessionError> {
        self.inner.submit(brick_key, command, timeout).await
    }

    /// Checks one channel now, outside the heartbeat's schedule, and answers whether it
    /// answered.
    ///
    /// For a caller that has just seen a command fail and needs to know at once whether the
    /// link is gone; waiting for the heartbeat would take two missed beats. A failure here
    /// reconnects straight away, because the failed command was the first miss. Two exceptions:
    /// a reply that arrives but does not parse proves the link; and on USB a reply that only
    /// came late is a busy brick (joining Wi-Fi, Port View open), so it counts as one missed
    /// beat and the heartbeat's threshold decides. USB reports a pulled cable at once, never as
    /// a timeout. Bluetooth and TCP keep the fast reconnect.
    pub async fn probe_now(&self, brick_key: &BrickKey) -> bool {
        self.inner.probe_now(brick_key).await
    }

    /// Tells a reconnecting session that its brick has been seen again, and tries at once.
    ///
    /// Backoff is a guess about when to look; a sighting is evidence there is something to look
    /// at. Without this a brick that boots in about 40 s took 121 s to be picked up, because the
    /// backoff had stretched to 30 s steps and waited them out. This only ever makes an attempt
    /// sooner. Does nothing unless the session is reconnecting.
    pub fn notify_brick_available(&self, brick_key: &BrickKey) {
        self.inner.notify_brick_available(brick_key);
    }

    pub fn session(&self, brick_key: &BrickKey) -> Option<SessionSnapshot> {
        let state = self.inner.lock();
        state
            .sessions
            .get(brick_key)
            .map(|entry| snapshot(brick_key, entry))
    }

    pub fn sessions(&self) -> Vec<SessionSnapshot> {
        let state = self.inner.lock();
        state
            .sessions
            .iter()
            .map(|(key, entry)| snapshot(key, entry))
            .collect()
    }

    /// The largest packet the live link carries, asked of the provider rather than derived from
    /// the transport: one USB brick carries 1024 bytes over libusb and 64 over HID. `None` for no
    /// session or the firmware's own buffer.
    pub fn max_packet_bytes(&self, brick_key: &BrickKey) -> Option<usize> {
        if !self.inner.lock().sessions.contains_key(brick_key) {
            return None;
        }
        self.inner
            .provider(brick_key.transport())
            .ok()?
            .max_packet_bytes(brick_key)
    }

    /// Whether the channel was signed out by hand and is not to be connected automatically.
    pub fn is_suppressed(&self, brick_key: &BrickKey) -> bool {
        self.inner.lock().suppressed.contains(brick_key)
    }

    pub fn clear_suppressions(&self) {
        self.inner.lock().suppressed.clear();
    }

    /// Stops every session's heartbeat and reconnect and refuses what waits in their queues.
    /// Leaves the providers to their own `dispose`.
    pub fn shutdown(&self) {
        let mut state = self.inner.lock();
        for entry in state.sessions.values_mut() {
            entry.stop_tasks();
            entry.queue.drain(DrainReason::Disconnected);
        }
        state.sessions.clear();
        state.suppressed.clear();
    }
}

fn snapshot(key: &BrickKey, entry: &Entry) -> SessionSnapshot {
    SessionSnapshot {
        brick_key: key.clone(),
        transport: key.transport(),
        display_name: entry.display_name.clone(),
        connection_state: entry.connection,
        heartbeat_state: entry.heartbeat,
        last_error: entry.last_error.clone(),
    }
}

/// On USB, a reply that came too late rather than a link that failed: the exchange's own budget,
/// or libusb's transfer timeout.
fn is_slow_usb_reply(transport: Transport, error: &SessionError) -> bool {
    if transport != Transport::Usb {
        return false;
    }
    match error {
        SessionError::Transport(error) => {
            error.code == ErrorCode::Timeout || error.message.contains("LIBUSB_ERROR_TIMEOUT")
        }
        _ => false,
    }
}

/// One exchange over the link and its reply, checked and parsed.
async fn exchange(
    provider: &dyn TransportProvider,
    key: &BrickKey,
    command: &BrickCommand,
    packet: &[u8],
    counter: u16,
    timeout: Option<Duration>,
) -> Result<BrickResponse, SessionError> {
    let options = SendOptions {
        timeout,
        expected_message_counter: Some(counter),
    };
    let reply = provider.send_packet(key, packet, &options).await?;
    // A counter mismatch is framing, not a lost link: a protocol error, so the heartbeat does not
    // reconnect a brick that is answering.
    verify_reply_counter(
        &reply,
        counter,
        &key.transport().as_str().to_ascii_uppercase(),
    )?;
    let decoded = decode_ev3_packet(&reply)?;
    Ok(parse_response(command, &decoded)?)
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn provider(&self, transport: Transport) -> Result<Arc<dyn TransportProvider>, SessionError> {
        self.providers
            .get(&transport)
            .cloned()
            .ok_or(SessionError::NoProvider { transport })
    }

    fn emit(&self, event: SessionEvent) {
        // No listener is not an error.
        let _ = self.events.send(event);
    }

    fn emit_state(&self, key: &BrickKey, previous: ConnectionState, new: ConnectionState) {
        self.emit(SessionEvent::StateChanged {
            brick_key: key.clone(),
            previous,
            new,
        });
    }

    async fn submit(
        self: &Arc<Self>,
        key: &BrickKey,
        command: &BrickCommand,
        timeout: Option<Duration>,
    ) -> Result<BrickResponse, SessionError> {
        // Built before it queues: a command that cannot be encoded is refused without taking a
        // turn, and without counting against the link.
        let encoded = build_command(command)?;
        let (queue, epoch, id) = {
            let state = self.lock();
            let entry = state
                .sessions
                .get(key)
                .filter(|e| !e.closing)
                .ok_or_else(|| SessionError::NotConnected {
                    brick_key: key.clone(),
                })?;
            match entry.connection {
                ConnectionState::Connected => {}
                ConnectionState::Reconnecting => {
                    return Err(SessionError::LinkLost {
                        brick_key: key.clone(),
                    });
                }
                ConnectionState::Connecting | ConnectionState::Disconnected => {
                    return Err(SessionError::NotConnected {
                        brick_key: key.clone(),
                    });
                }
            }
            (entry.queue.clone(), entry.queue.epoch(), entry.id)
        };
        let provider = self.provider(key.transport())?;
        let execute = async {
            let counter = {
                let mut state = self.lock();
                let entry = state
                    .entry_mut(key, id)
                    .ok_or_else(|| SessionError::Disconnected {
                        brick_key: key.clone(),
                    })?;
                entry.counter = entry.counter.wrapping_add(1);
                entry.counter
            };
            let packet =
                encode_ev3_packet(u32::from(counter), encoded.packet_type, &encoded.payload)?;
            let started = Instant::now();
            let result = exchange(provider.as_ref(), key, command, &packet, counter, timeout).await;
            match &result {
                // A reply that arrived, readable or not, proves the link: only a link failure
                // counts toward degrading the channel. Counted as failures, unreadable heartbeat
                // replies on a firmware with another layout would degrade a working channel.
                Ok(_) | Err(SessionError::Protocol(_)) => {
                    self.guard.record_success(key, Some(started.elapsed()));
                }
                Err(_) => self.guard.record_failure(key),
            }
            result
        };
        // A full rate window holds the command in the queue, where a drain still reaches it.
        queue.submit(epoch, self.guard.acquire(key), execute).await
    }

    async fn connect(
        self: &Arc<Self>,
        key: &BrickKey,
        display_name: Option<&str>,
    ) -> Result<(), SessionError> {
        let id = {
            let mut state = self.lock();
            if state.sessions.contains_key(key) {
                return Err(SessionError::AlreadyConnected {
                    brick_key: key.clone(),
                });
            }
            self.provider(key.transport())?;
            // Connecting by hand clears the sign-out's suppression.
            state.suppressed.remove(key);
            state.next_id += 1;
            let id = state.next_id;
            state.sessions.insert(
                key.clone(),
                Entry {
                    id,
                    display_name: display_name.map_or_else(|| key.to_string(), str::to_owned),
                    connection: ConnectionState::Connecting,
                    heartbeat: HeartbeatState::Unknown,
                    last_error: None,
                    closing: false,
                    counter: 0,
                    misses: MissCounter::new(self.config.heartbeat_miss_threshold),
                    backoff: Backoff::new(self.config.backoff),
                    queue: Arc::new(CommandQueue::new(key.clone())),
                    heartbeat_task: None,
                    reconnect_timer: None,
                },
            );
            id
        };
        let provider = self.provider(key.transport())?;
        let wanted = |state: &State| state.entry(key, id).is_some_and(|e| !e.closing);
        match self
            .open_link(key, &provider, id, wanted, provider.connect(key))
            .await
        {
            Ok(true) => Ok(()),
            Ok(false) => Err(SessionError::ConnectionAbandoned {
                brick_key: key.clone(),
            }),
            Err(error) => {
                // A disconnect that ran meanwhile ended the session itself, and the key may
                // belong to a newer connect by now.
                let removed = {
                    let mut state = self.lock();
                    let ours = state.entry(key, id).is_some_and(|e| !e.closing);
                    if ours {
                        state.sessions.remove(key);
                    }
                    ours
                };
                if removed {
                    self.emit_state(
                        key,
                        ConnectionState::Connecting,
                        ConnectionState::Disconnected,
                    );
                }
                Err(error)
            }
        }
    }

    /// Ends the session on `key`; with `only`, only if it is still that session.
    async fn disconnect(self: &Arc<Self>, key: &BrickKey, explicit: bool, only: Option<u64>) {
        let (id, previous) = {
            let mut state = self.lock();
            let Some(entry) = state.sessions.get_mut(key) else {
                return;
            };
            if entry.closing || only.is_some_and(|id| id != entry.id) {
                return;
            }
            entry.closing = true;
            entry.stop_tasks();
            entry.queue.drain(DrainReason::Disconnected);
            let taken = (entry.id, entry.connection);
            if explicit {
                state.suppressed.insert(key.clone());
            }
            taken
        };
        // The channel's failures are history the next connect should not inherit. Only this
        // channel: another channel to the same brick keeps its own count.
        self.guard.reset_health(key);
        if let Ok(provider) = self.provider(key.transport()) {
            // Best effort: the link may already be gone.
            let _ = provider.disconnect(key).await;
        }
        {
            let mut state = self.lock();
            if state.entry(key, id).is_some() {
                state.sessions.remove(key);
            }
        }
        if previous != ConnectionState::Disconnected {
            self.emit_state(key, previous, ConnectionState::Disconnected);
        }
    }

    /// Opens a channel's link, one opening per channel at a time.
    ///
    /// Providers key their links by brick key alone, so two openings that overlap on one channel
    /// close or overwrite each other's: a reconnect still waiting when the user signed the brick
    /// out and in again opened its link beside the new connect's, and one was left open with
    /// nobody to close it. Each opening waits for the one before it and then checks it is still
    /// wanted; one no longer wanted once its link is open closes it before the next starts.
    ///
    /// The link goes into the session under the same lock that checks it is wanted, before the
    /// next opening may look: a second reconnect that woke between the two once took the session
    /// for still reconnecting and closed the link the first had just opened.
    ///
    /// Returns whether the link was opened and installed.
    async fn open_link(
        self: &Arc<Self>,
        key: &BrickKey,
        provider: &Arc<dyn TransportProvider>,
        id: u64,
        wanted: impl Fn(&State) -> bool,
        open: impl Future<Output = Result<SessionHandle, TransportError>>,
    ) -> Result<bool, SessionError> {
        let opening = self
            .openings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key.clone())
            .or_default()
            .clone();
        let _turn = opening.lock().await;
        if !wanted(&self.lock()) {
            return Ok(false);
        }
        open.await?;
        let installed = {
            let mut state = self.lock();
            let wanted_now = wanted(&state);
            if wanted_now {
                self.install(&mut state, key, id);
            }
            wanted_now
        };
        if !installed {
            // Best effort: a link nobody wants is closed before the next opening starts.
            let _ = provider.disconnect(key).await;
        }
        Ok(installed)
    }

    /// Puts a freshly opened link into the session.
    fn install(self: &Arc<Self>, state: &mut State, key: &BrickKey, id: u64) {
        let Some(entry) = state.entry_mut(key, id) else {
            return;
        };
        let previous = entry.connection;
        entry.counter = 0;
        entry.connection = ConnectionState::Connected;
        entry.heartbeat = HeartbeatState::Ok;
        entry.last_error = None;
        entry.backoff.reset();
        entry.misses.reset();
        // The failures that degraded the channel belonged to the link that died. Without this a
        // cable that comes back after three failed sends stays refused for good.
        self.guard.reset_health(key);
        if let Some(task) = entry.heartbeat_task.take() {
            task.abort();
        }
        entry.heartbeat_task = Some(self.start_heartbeat(key, id));
        self.emit_state(key, previous, ConnectionState::Connected);
    }

    fn start_heartbeat(self: &Arc<Self>, key: &BrickKey, id: u64) -> AbortHandle {
        let weak: Weak<Inner> = Arc::downgrade(self);
        let key = key.clone();
        let interval = effective_interval(self.config.heartbeat_interval);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let result = inner.submit(&key, &BrickCommand::Battery, None).await;
                if !inner.heartbeat_beat(&key, id, result.err()) {
                    return;
                }
            }
        })
        .abort_handle()
    }

    /// Counts one heartbeat probe; answers whether the loop goes on.
    fn heartbeat_beat(
        self: &Arc<Self>,
        key: &BrickKey,
        id: u64,
        error: Option<SessionError>,
    ) -> bool {
        let failure = {
            let mut state = self.lock();
            let Some(entry) = state.entry_mut(key, id) else {
                return false;
            };
            if entry.closing || entry.connection != ConnectionState::Connected {
                return false;
            }
            let probe = match &error {
                None => Probe::Answered,
                Some(e) if e.reply_arrived() => Probe::Unreadable,
                Some(_) => Probe::Missed,
            };
            match entry.misses.record(probe) {
                Beat::Ok => {
                    entry.heartbeat = HeartbeatState::Ok;
                    return true;
                }
                Beat::Anomaly => {
                    // The reply arrived, so the link is alive; the reason is kept for whoever
                    // looks, and the session stays connected.
                    entry.last_error = error.as_ref().map(ToString::to_string);
                    entry.heartbeat = HeartbeatState::Ok;
                    return true;
                }
                Beat::Missed => {
                    entry.heartbeat = HeartbeatState::Missed;
                    return true;
                }
                Beat::Failed => error.unwrap_or(SessionError::NotConnected {
                    brick_key: key.clone(),
                }),
            }
        };
        self.link_failed(key, id, &failure);
        false
    }

    async fn probe_now(self: &Arc<Self>, key: &BrickKey) -> bool {
        let id = {
            let state = self.lock();
            match state.sessions.get(key) {
                Some(e) if !e.closing && e.connection == ConnectionState::Connected => e.id,
                _ => return false,
            }
        };
        match self.submit(key, &BrickCommand::Battery, None).await {
            Ok(_) => {
                if let Some(entry) = self.lock().entry_mut(key, id) {
                    entry.heartbeat = HeartbeatState::Ok;
                    entry.misses.reset();
                }
                true
            }
            Err(error) if error.reply_arrived() => true,
            Err(error) if is_slow_usb_reply(key.transport(), &error) => {
                let failed = {
                    let mut state = self.lock();
                    match state.entry_mut(key, id) {
                        Some(entry) if entry.connection == ConnectionState::Connected => {
                            entry.heartbeat = HeartbeatState::Missed;
                            entry.misses.record(Probe::Missed) == Beat::Failed
                        }
                        _ => false,
                    }
                };
                if failed {
                    self.link_failed(key, id, &error);
                }
                false
            }
            Err(error) => {
                self.link_failed(key, id, &error);
                false
            }
        }
    }

    /// The link of a connected session is gone: reconnect it.
    fn link_failed(self: &Arc<Self>, key: &BrickKey, id: u64, error: &SessionError) {
        {
            let mut state = self.lock();
            let Some(entry) = state.entry_mut(key, id) else {
                return;
            };
            if entry.closing || entry.connection != ConnectionState::Connected {
                return;
            }
            entry.last_error = Some(error.to_string());
            entry.connection = ConnectionState::Reconnecting;
            entry.heartbeat = HeartbeatState::Missed;
            // What waited behind the failure is refused now rather than sent on the dead link one
            // by one, each on its own timeout; nor held for the new link. A command already on
            // the wire fails by itself.
            entry.queue.drain(DrainReason::LinkLost);
            if let Some(task) = entry.heartbeat_task.take() {
                task.abort();
            }
        }
        self.emit_state(
            key,
            ConnectionState::Connected,
            ConnectionState::Reconnecting,
        );
        self.schedule_reconnect(key, id);
    }

    /// Schedules the next attempt and returns its delay; `None` when there is none.
    fn schedule_reconnect(self: &Arc<Self>, key: &BrickKey, id: u64) -> Option<Duration> {
        {
            let mut state = self.lock();
            let entry = state.entry_mut(key, id)?;
            if let Some(delay) = entry.backoff.next_delay() {
                // Two attempts can fail one after the other (the backoff's and one a sighting
                // started) and each asks for the next; the session keeps one timer, not one per
                // failure.
                if let Some(timer) = entry.reconnect_timer.take() {
                    timer.abort();
                }
                entry.reconnect_timer = Some(self.start_timer(key, id, delay));
                return Some(delay);
            }
        }
        // The attempts are used up: the session ends.
        let inner = self.clone();
        let key = key.clone();
        tokio::spawn(async move { inner.disconnect(&key, false, Some(id)).await });
        None
    }

    fn start_timer(self: &Arc<Self>, key: &BrickKey, id: u64, delay: Duration) -> AbortHandle {
        let weak: Weak<Inner> = Arc::downgrade(self);
        let key = key.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            // On a task of its own: cancelling this timer must never cut an open short and leave
            // its link with nobody.
            tokio::spawn(async move { inner.attempt_reconnect(&key, id).await });
        })
        .abort_handle()
    }

    fn notify_brick_available(self: &Arc<Self>, key: &BrickKey) {
        let id = {
            let mut state = self.lock();
            let Some(entry) = state.sessions.get_mut(key) else {
                return;
            };
            if entry.closing || entry.connection != ConnectionState::Reconnecting {
                return;
            }
            if let Some(timer) = entry.reconnect_timer.take() {
                timer.abort();
            }
            // The wait was all that stood between the last failure and this attempt, and the
            // sighting has just retired the reason for it.
            entry.backoff.reset();
            entry.id
        };
        let inner = self.clone();
        let key = key.clone();
        tokio::spawn(async move { inner.attempt_reconnect(&key, id).await });
    }

    async fn attempt_reconnect(self: &Arc<Self>, key: &BrickKey, id: u64) {
        let still_reconnecting = |state: &State| {
            state
                .entry(key, id)
                .is_some_and(|e| !e.closing && e.connection == ConnectionState::Reconnecting)
        };
        if !still_reconnecting(&self.lock()) {
            return;
        }
        let Ok(provider) = self.provider(key.transport()) else {
            self.disconnect(key, false, Some(id)).await;
            return;
        };
        let open = async {
            if provider.capabilities().supports_recover {
                // A provider that recovers owns the release of its old link itself.
                provider.recover(key).await
            } else {
                // Release whatever the provider still thinks it holds before asking for a new
                // link. A provider drops its own record of a link only in `disconnect`, so after
                // a link dies on its own the record survives and `connect` answers "already
                // connected": every attempt, at once, forever. Measured on a brick: a USB session
                // never recovered from a power cycle, a pulled cable or a brick out of range.
                let _ = provider.disconnect(key).await;
                provider.connect(key).await
            }
        };
        let Err(error) = self
            .open_link(key, &provider, id, still_reconnecting, open)
            .await
        else {
            return;
        };
        // Recorded and told: a reconnect that failed with no trace looked like a brick that had
        // not come back, rather than like the defect it was.
        let reason = error.to_string();
        let attempt = {
            let mut state = self.lock();
            let Some(entry) = state.entry_mut(key, id) else {
                return;
            };
            entry.last_error = Some(reason.clone());
            entry.backoff.attempts()
        };
        let next_delay = self.schedule_reconnect(key, id);
        self.emit(SessionEvent::ReconnectFailed {
            brick_key: key.clone(),
            attempt,
            error: reason,
            next_delay,
        });
    }
}

#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod support;

#[cfg(test)]
mod tests {
    use super::support::{FakeProvider, settle, usb_key};
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_lost_link_refuses_the_commands_queued_behind_the_failure_at_once_and_unsent() {
        let usb = FakeProvider::new(Transport::Usb);
        let manager = SessionManager::new(
            [usb.as_provider()],
            Arc::new(Guard::default()),
            SessionConfig {
                heartbeat_interval: Duration::from_secs(3600),
                backoff: BackoffConfig {
                    base: Duration::from_secs(60),
                    max: Duration::from_secs(60),
                    ..BackoffConfig::default()
                },
                ..SessionConfig::default()
            },
        );
        let key = usb_key();
        manager.connect(&key, None).await.unwrap();
        // The first command is on the wire when the cable goes; the second waits behind it.
        usb.state().hang_next = 1;
        let on_wire = {
            let (manager, key) = (manager.clone(), key.clone());
            tokio::spawn(async move { manager.send(&key, &BrickCommand::Battery, None).await })
        };
        settle().await;
        let queued = {
            let (manager, key) = (manager.clone(), key.clone());
            tokio::spawn(async move { manager.send(&key, &BrickCommand::Ports, None).await })
        };
        settle().await;

        let id = manager.inner.lock().sessions[&key].id;
        manager.inner.link_failed(
            &key,
            id,
            &SessionError::Transport(TransportError::transport_failed("cable out")),
        );
        // Refused at once, long before anything the link could still answer.
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert!(
            queued.is_finished(),
            "the queued command still waits behind the dead link"
        );
        let refused = tokio::time::timeout(Duration::from_secs(5), queued)
            .await
            .expect("the queued command still waits behind the dead link");
        assert_eq!(
            refused.unwrap(),
            Err(SessionError::LinkLost {
                brick_key: key.clone()
            })
        );
        assert_eq!(
            usb.state().requests.len(),
            1,
            "the queued command went out on the dead link"
        );
        on_wire.abort();
    }
}
