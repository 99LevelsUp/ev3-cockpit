//! Bricks across channels: one brick, signed in once, over every channel that reaches it.
//!
//! The session manager below keeps one session per channel (`usb:…`, `bt:…`) and knows nothing
//! of bricks. This layer signs bricks in and out, joins every channel a signed-in brick is
//! reachable on, and sends each command over the best channel connected at that moment, by the
//! priority each transport declares: USB, then Bluetooth, then TCP. A pulled cable moves traffic
//! to Bluetooth on the first failed command; the cable back in moves it back.
//!
//! What the layers above build on: [`BrickManager::send`] for one command, [`BrickManager::pin`]
//! for a multi-step operation that must stay on one channel (a file transfer, a program upload),
//! the route and sign-in events for telemetry, and two hooks for forgetting a brick and checking
//! its pairing: [`BrickManager::hold_links`] and [`BluetoothGate`].

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use ev3_protocol::packet::verify_reply_counter;
use ev3_protocol::{
    BrickCommand, BrickResponse, build_command, decode_ev3_packet, encode_ev3_packet,
    parse_response,
};
use ev3_transports::{BrickKey, SendOptions, Transport, TransportProvider};
use futures_util::future::join_all;
use tokio::sync::{Notify, broadcast, mpsc};
use tokio::task::AbortHandle;
use tokio::time::Instant;

use crate::discovery::now_ms;
use crate::error::SessionError;
use crate::guard::brick_id_of;
use crate::heartbeat::MIN_HEARTBEAT_INTERVAL;
use crate::presence::{ChannelState, PresenceAggregator, PresenceEvent};
use crate::reconnect::{Backoff, BackoffConfig};
use crate::session::{ConnectionState, SessionEvent, SessionManager, SessionSnapshot};

// ── Errors ──────────────────────────────────────────────────────────

/// A brick call that did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrickError {
    /// No channel of the brick can be joined now.
    NotAvailable { brick_id: String },
    /// The brick is not signed in.
    NotSignedIn { brick_id: String },
    /// The brick is being forgotten or its Bluetooth list cleared; nothing opens a link to it.
    Held { brick_id: String },
    /// The brick was signed out while it was connecting.
    ConnectionAbandoned { brick_id: String },
    /// No channel of the brick is connected; nothing was sent. The message says why, with what
    /// each channel last failed with.
    NoRoute { brick_id: String, message: String },
    /// The channel a multi-step operation began on was lost; start it again.
    ChannelChanged { brick_key: BrickKey },
    /// The session layer failed the command.
    Session(SessionError),
}

impl fmt::Display for BrickError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAvailable { brick_id } => {
                write!(f, "Brick {brick_id} is not available on any channel.")
            }
            Self::NotSignedIn { brick_id } => write!(f, "Brick {brick_id} is not signed in."),
            Self::Held { brick_id } => write!(
                f,
                "Brick {brick_id} is being forgotten or its Bluetooth list cleared; sign it in \
                 once that has finished."
            ),
            Self::ConnectionAbandoned { brick_id } => {
                write!(
                    f,
                    "Brick {brick_id} was disconnected while it was connecting."
                )
            }
            Self::NoRoute { message, .. } => f.write_str(message),
            Self::ChannelChanged { brick_key } => write!(
                f,
                "The channel {} this operation started on was lost; start it again.",
                describe_channel(brick_key)
            ),
            Self::Session(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for BrickError {}

impl From<SessionError> for BrickError {
    fn from(error: SessionError) -> Self {
        Self::Session(error)
    }
}

/// `USB 00165300000A`, the way a person reads a channel.
fn describe_channel(key: &BrickKey) -> String {
    format!(
        "{} {}",
        key.transport().as_str().to_ascii_uppercase(),
        key.id()
    )
}

// ── Options, hooks, events ──────────────────────────────────────────

/// How the brick layer retries and checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrickConfig {
    /// The backoff of a failed join on a transport that retries on a timer (USB, TCP).
    pub rejoin_backoff: BackoffConfig,
    /// How soon a channel taken out of routing for a slow reply, still connected, is asked again:
    /// a busy brick (joining Wi-Fi, Port View open) comes back to the route when it answers.
    pub slow_probe_retry: Duration,
}

impl Default for BrickConfig {
    fn default() -> Self {
        Self {
            rejoin_backoff: BackoffConfig::default(),
            slow_probe_retry: MIN_HEARTBEAT_INTERVAL,
        }
    }
}

/// Where the brick layer reports what a person reading the log would want to know.
pub trait BrickLog: Send + Sync {
    fn warn(&self, message: &str);
    fn info(&self, message: &str);
}

/// Holds a brick's Bluetooth joins back while its pairing is checked; installed by whoever
/// checks that the brick and this computer both still hold the pairing.
///
/// A connect over a pairing broken on the brick's side only fails, after holding the radio for
/// 15 s, which on hardware starved the repair's own pairing. So with a gate installed, a
/// Bluetooth join also waits while a first USB or TCP join of the brick is under way, because the
/// list the check reads comes over that channel; a USB or TCP join that is a retry after a failure
/// holds nothing back, or a cable that keeps failing would keep Bluetooth out for good. Without a
/// gate, Bluetooth joins never wait.
///
/// Called outside the brick layer's own lock; an implementation may call back into it.
pub trait BluetoothGate: Send + Sync {
    /// Whether the brick's Bluetooth joins wait now, for a reason the gate owns: its check is
    /// pending, or a repair runs. Tell the brick layer when it ends, with
    /// [`BrickManager::wake_bluetooth`].
    fn holds(&self, brick_id: &str) -> bool;

    /// A channel of the brick changed state: where a USB or TCP channel that connected marks the
    /// brick's check pending, and one that ended with no other left lets Bluetooth go. Told before
    /// a join that connected lets a held Bluetooth join look again, so a gate that marks the check
    /// here holds it; told again when the session's own event arrives, so it may hear one
    /// connect twice.
    fn channel_state(&self, _brick_id: &str, _brick_key: &BrickKey, _state: ConnectionState) {}

    /// The brick's channels were just joined again where they could be: where the pairing check
    /// runs and a sighting nobody has paired gets paired.
    fn reconciled(&self, _brick_id: &str) {}
}

/// The packet a file transfer uses over a transport, when the user chose one; `None` keeps the
/// link's own.
pub type TransferPacketBytes = Arc<dyn Fn(Transport) -> Option<usize> + Send + Sync>;

/// What the brick layer is built with besides the sessions and the list.
#[derive(Clone, Default)]
pub struct BrickOptions {
    pub config: BrickConfig,
    pub log: Option<Arc<dyn BrickLog>>,
    pub bluetooth_gate: Option<Arc<dyn BluetoothGate>>,
    /// Asked at each pinned operation's start, for TCP and Bluetooth only: USB's packet is its
    /// link's report size, which no firmware changes. Transfers only; telemetry frames stay at
    /// the link's size, which the stock firmware's direct commands need.
    pub transfer_packet_bytes: Option<TransferPacketBytes>,
}

/// What the brick layer tells its listeners.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrickEvent {
    /// The channel a brick's traffic goes over changed, to none too.
    RouteChanged {
        brick_id: String,
        previous: Option<BrickKey>,
        current: Option<BrickKey>,
    },
    ActiveBrickChanged {
        previous: Option<String>,
        current: Option<String>,
    },
    /// A brick's sign-in ended. Its own event because a route event cannot carry it: a brick
    /// that lost its link has no route left to lose, so signing it out changes no route.
    SignInEnded { brick_id: String },
}

/// Per-command options of [`BrickManager::send`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CommandOptions {
    /// The exchange's own budget; `None` takes the transport's.
    pub timeout: Option<Duration>,
    /// With no route now, how long the command may wait for one: it was not sent, so nothing is
    /// lost by waiting. `None` fails at once.
    pub deadline: Option<Instant>,
}

// ── State ───────────────────────────────────────────────────────────

/// One sign-in of one brick.
struct SignIn {
    /// Tells this sign-in from a later one of the same brick.
    id: u64,
    /// Joins in flight.
    pending: HashSet<BrickKey>,
    /// Failed joins that wait for the brick to be seen again, with when they failed (ms since
    /// the epoch, the unit presence answers carry).
    awaiting_evidence: HashMap<BrickKey, i64>,
    /// Failed joins waiting out a backoff.
    retry_timers: HashMap<BrickKey, AbortHandle>,
    backoff: HashMap<BrickKey, Backoff>,
}

impl SignIn {
    fn stop_timers(&mut self) {
        for (_, timer) in self.retry_timers.drain() {
            timer.abort();
        }
    }
}

#[derive(Default)]
struct State {
    signed_in: HashMap<String, SignIn>,
    next_sign_in: u64,
    /// Channels taken out of routing by a link failure, until they answer again.
    dropped: HashSet<BrickKey>,
    routes: HashMap<String, BrickKey>,
    active: Option<String>,
    /// The reason each channel's join last failed with, said once until it joins or the reason
    /// changes.
    join_failures: HashMap<BrickKey, String>,
    /// Channels being asked their name without a session, so one sighting asks once.
    probing: HashSet<BrickKey>,
    /// Channels whose name probe has failed and been reported, so it is reported once.
    probe_failures_reported: HashSet<BrickKey>,
    /// Holds on bricks' links, counted: one that ends first does not lift another's.
    holds: HashMap<String, u32>,
    disposed: bool,
}

struct Inner {
    sessions: SessionManager,
    aggregator: Arc<PresenceAggregator>,
    options: BrickOptions,
    state: Mutex<State>,
    events: broadcast::Sender<BrickEvent>,
    /// Wakes Bluetooth joins held by the gate; they look again, and spurious wakes cost nothing.
    bluetooth_wake: Notify,
    event_loop: Mutex<Option<AbortHandle>>,
}

/// The cockpit's bricks. Cheap to clone; clones share the bricks.
#[derive(Clone)]
pub struct BrickManager {
    inner: Arc<Inner>,
}

/// A hold on a brick's links: while one stands nothing opens, reopens or probes a link to the
/// brick, and a failed command on it moves no traffic. For whoever forgets a brick or clears its
/// Bluetooth list, which close the brick's links on purpose. Released when dropped.
pub struct LinkHold {
    inner: Weak<Inner>,
    brick_id: String,
}

impl Drop for LinkHold {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut state = inner.lock();
            if let Some(count) = state.holds.get_mut(&self.brick_id) {
                *count -= 1;
                if *count == 0 {
                    state.holds.remove(&self.brick_id);
                }
            }
        }
    }
}

/// One brick's current channel, held for a multi-step operation.
///
/// Every step goes over that channel even if traffic moves meanwhile, so a transfer that started
/// over Bluetooth finishes there when a cable is plugged in; a step fails with
/// [`BrickError::ChannelChanged`] once that channel is lost. A link fault on a step fails over for
/// everyone else as an ordinary send would.
pub struct PinnedLink {
    inner: Arc<Inner>,
    brick_key: BrickKey,
    max_packet_bytes: Option<usize>,
}

impl PinnedLink {
    pub fn brick_key(&self) -> &BrickKey {
        &self.brick_key
    }

    /// The packet the operation uses: the user's choice over TCP or Bluetooth, else the link's;
    /// `None` for the firmware's own buffer.
    pub fn max_packet_bytes(&self) -> Option<usize> {
        self.max_packet_bytes
    }

    pub async fn send(
        &self,
        command: &BrickCommand,
        timeout: Option<Duration>,
    ) -> Result<BrickResponse, BrickError> {
        let key = &self.brick_key;
        let connected = self
            .inner
            .sessions
            .session(key)
            .is_some_and(|s| s.connection_state == ConnectionState::Connected);
        if !connected || self.inner.lock().dropped.contains(key) {
            return Err(BrickError::ChannelChanged {
                brick_key: key.clone(),
            });
        }
        match self.inner.sessions.send(key, command, timeout).await {
            Ok(response) => Ok(response),
            Err(error) => {
                if error.is_link_fault() {
                    self.inner.drop_from_routing(key, &error);
                }
                Err(error.into())
            }
        }
    }
}

impl BrickManager {
    /// The brick layer over `sessions` and the list; it listens to both from now on. Call it
    /// inside a tokio runtime.
    pub fn new(
        sessions: SessionManager,
        aggregator: Arc<PresenceAggregator>,
        options: BrickOptions,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        let inner = Arc::new(Inner {
            sessions,
            aggregator,
            options,
            state: Mutex::new(State::default()),
            events,
            bluetooth_wake: Notify::new(),
            event_loop: Mutex::new(None),
        });
        let handle = start_event_loop(&inner);
        *inner
            .event_loop
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(handle);
        Self { inner }
    }

    /// Brick events from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<BrickEvent> {
        self.inner.events.subscribe()
    }

    pub fn sessions(&self) -> &SessionManager {
        &self.inner.sessions
    }

    pub fn aggregator(&self) -> &Arc<PresenceAggregator> {
        &self.inner.aggregator
    }

    // ── Sign-in ─────────────────────────────────────────────────────

    /// Signs a brick in: joins every channel it is available on now, its paired Bluetooth channel
    /// even when the presence checks did not hear it, and every one that becomes available later
    /// while it stays signed in.
    ///
    /// Returns once the first channel connects; the rest keep joining in the background, so a
    /// cable that opens in 30 ms does not wait out a 5 s Bluetooth attempt. Makes the brick the
    /// active one. Fails when no channel is available or every join fails, and the brick is then
    /// not signed in; with `ConnectionAbandoned` when it was signed out meanwhile, whatever its
    /// channels failed with before that.
    ///
    /// Runs to its end on a task of its own: a caller that drops the future does not leave a
    /// sign-in whose every join failed standing, retrying and never made active.
    pub async fn sign_in(&self, brick_id: &str) -> Result<(), BrickError> {
        let this = self.clone();
        let brick = brick_id.to_owned();
        tokio::spawn(async move { this.run_sign_in(&brick).await })
            .await
            .unwrap_or_else(|_| {
                Err(BrickError::ConnectionAbandoned {
                    brick_id: brick_id.to_owned(),
                })
            })
    }

    /// Connects a signed-in brick again over every channel that is not connected: what the user
    /// asks for by connecting a brick that is signed in already.
    ///
    /// Joins every available channel now, whatever a failed join was waiting for, and the paired
    /// Bluetooth channel the presence checks lost too. Waits for the joins and makes the brick
    /// the active one, or fails with the first failure when no channel ends up connected. A
    /// brick not signed in is signed in. Runs to its end on a task of its own, as a sign-in does.
    pub async fn connect_again(&self, brick_id: &str) -> Result<(), BrickError> {
        let this = self.clone();
        let brick = brick_id.to_owned();
        tokio::spawn(async move { this.run_connect_again(&brick).await })
            .await
            .unwrap_or_else(|_| {
                Err(BrickError::ConnectionAbandoned {
                    brick_id: brick_id.to_owned(),
                })
            })
    }

    /// Signs a brick out: closes every channel; it does not reconnect until signed in again.
    ///
    /// Runs to its end on a task of its own: a caller that drops the future does not leave
    /// sessions open, reconnecting, with nobody signed in.
    pub async fn sign_out(&self, brick_id: &str) {
        let inner = self.inner.clone();
        let brick = brick_id.to_owned();
        let _ = tokio::spawn(async move { inner.sign_out(&brick).await }).await;
    }

    async fn run_sign_in(&self, brick_id: &str) -> Result<(), BrickError> {
        let inner = &self.inner;
        let (id, candidates) = {
            let mut state = inner.lock();
            // A forget is closing every channel of this brick; a sign-in would reopen one under it.
            if state.holds.contains_key(brick_id) {
                return Err(BrickError::Held {
                    brick_id: brick_id.to_owned(),
                });
            }
            if state.signed_in.contains_key(brick_id) {
                drop(state);
                return inner.set_active(brick_id);
            }
            // A new sign-in says its own failures again, even ones the last one already said.
            state
                .join_failures
                .retain(|key, _| brick_id_of(key) != brick_id);
            // The paired Bluetooth channel the presence checks lost is tried too: the checks miss
            // bricks that are there. A sign-in that left it out refused three times on hardware
            // with no channel tried, and one over USB joined USB alone, so the pulled cable had
            // nothing to fail over to. A brick that is really off costs one failed connect.
            let mut candidates = inner.join_candidates(brick_id);
            candidates.extend(inner.unheard_bluetooth(brick_id));
            if candidates.is_empty() {
                return Err(BrickError::NotAvailable {
                    brick_id: brick_id.to_owned(),
                });
            }
            state.next_sign_in += 1;
            let id = state.next_sign_in;
            state.signed_in.insert(
                brick_id.to_owned(),
                SignIn {
                    id,
                    pending: candidates.iter().cloned().collect(),
                    awaiting_evidence: HashMap::new(),
                    retry_timers: HashMap::new(),
                    backoff: HashMap::new(),
                },
            );
            (id, candidates)
        };

        let (results, mut outcomes) = mpsc::unbounded_channel();
        for (index, key) in candidates.iter().enumerate() {
            let inner = inner.clone();
            let results = results.clone();
            let brick_id = brick_id.to_owned();
            let key = key.clone();
            tokio::spawn(async move {
                let outcome = inner.join(&brick_id, &key, id).await;
                let _ = results.send((index, outcome));
            });
        }
        drop(results);
        let mut errors: Vec<Option<BrickError>> = vec![None; candidates.len()];
        let mut joined = false;
        while let Some((index, outcome)) = outcomes.recv().await {
            match outcome {
                Ok(()) => {
                    joined = true;
                    break;
                }
                Err(error) => errors[index] = Some(error),
            }
        }

        if !inner.is_current(brick_id, id) {
            return Err(BrickError::ConnectionAbandoned {
                brick_id: brick_id.to_owned(),
            });
        }
        if !joined {
            // A channel found after the sign-in started has joined meanwhile: the brick is
            // connected, so the sign-in stands. On hardware a cable plugged in just after the
            // sign-in joined while the only first candidate, Bluetooth, failed: the user was told
            // the brick did not answer, and the brick was signed out with its USB session open.
            if inner.has_connected_channel(brick_id) {
                return inner.set_active(brick_id);
            }
            inner.forget_sign_in(brick_id);
            return Err(errors
                .into_iter()
                .flatten()
                .next()
                .unwrap_or(BrickError::NotAvailable {
                    brick_id: brick_id.to_owned(),
                }));
        }
        inner.set_active(brick_id)
    }

    async fn run_connect_again(&self, brick_id: &str) -> Result<(), BrickError> {
        let inner = &self.inner;
        let prepared = {
            let mut state = inner.lock();
            let held = state.holds.contains_key(brick_id);
            let mut keys = inner.join_candidates(brick_id);
            keys.extend(inner.unheard_bluetooth(brick_id));
            match state.signed_in.get_mut(brick_id) {
                Some(sign_in) if !held => {
                    keys.retain(|key| !sign_in.pending.contains(key));
                    // The user asks now: what a failed join was waiting for goes, and so does its
                    // backoff, or the old retry timer would run beside the one a failure here
                    // sets.
                    for key in &keys {
                        if let Some(timer) = sign_in.retry_timers.remove(key) {
                            timer.abort();
                        }
                        sign_in.awaiting_evidence.remove(key);
                        sign_in.backoff.remove(key);
                        sign_in.pending.insert(key.clone());
                    }
                    Some((sign_in.id, keys))
                }
                _ => None,
            }
        };
        let Some((id, keys)) = prepared else {
            return self.run_sign_in(brick_id).await;
        };
        let joins: Vec<_> = keys
            .iter()
            .map(|key| {
                let inner = inner.clone();
                let brick_id = brick_id.to_owned();
                let key = key.clone();
                tokio::spawn(async move { inner.join(&brick_id, &key, id).await })
            })
            .collect();
        let outcomes: Vec<Result<(), BrickError>> = join_all(joins)
            .await
            .into_iter()
            .map(|joined| {
                joined.unwrap_or(Err(BrickError::ConnectionAbandoned {
                    brick_id: brick_id.to_owned(),
                }))
            })
            .collect();
        if !inner.is_current(brick_id, id) {
            return Err(BrickError::ConnectionAbandoned {
                brick_id: brick_id.to_owned(),
            });
        }
        if !inner.has_connected_channel(brick_id) {
            return Err(outcomes.into_iter().find_map(Result::err).unwrap_or(
                BrickError::NotAvailable {
                    brick_id: brick_id.to_owned(),
                },
            ));
        }
        inner.set_active(brick_id)
    }

    pub fn is_signed_in(&self, brick_id: &str) -> bool {
        self.inner.lock().signed_in.contains_key(brick_id)
    }

    pub fn signed_in_bricks(&self) -> Vec<String> {
        self.inner.lock().signed_in.keys().cloned().collect()
    }

    // ── Routing ─────────────────────────────────────────────────────

    /// The channel a brick's traffic goes over now; `None` when none is connected.
    pub fn route_of(&self, brick_id: &str) -> Option<BrickKey> {
        self.inner.lock().routes.get(brick_id).cloned()
    }

    /// The brick's route, waiting for one until `deadline` when it has none now: a momentary
    /// loss of the route does not fail an operation by itself.
    ///
    /// Without a deadline nothing waits. Neither does a brick that is not signed in: no channel
    /// of it is joining, so none can come back. Fails with what the brick's channels last failed
    /// with; nothing was sent.
    pub async fn wait_for_route(
        &self,
        brick_id: &str,
        deadline: Option<Instant>,
    ) -> Result<BrickKey, BrickError> {
        let inner = &self.inner;
        let mut events = inner.events.subscribe();
        if let Some(route) = self.route_of(brick_id) {
            return Ok(route);
        }
        let Some(deadline) = deadline else {
            return Err(inner.no_route(brick_id, None));
        };
        let late = "no channel came back in time";
        if Instant::now() >= deadline || !self.is_signed_in(brick_id) || inner.lock().disposed {
            return Err(inner.no_route(brick_id, Some(late)));
        }
        loop {
            if let Some(route) = self.route_of(brick_id) {
                return Ok(route);
            }
            let ended = || {
                inner.no_route(
                    brick_id,
                    Some("it was disconnected while the operation waited"),
                )
            };
            if !self.is_signed_in(brick_id) {
                return Err(ended());
            }
            tokio::select! {
                event = events.recv() => match event {
                    Ok(BrickEvent::SignInEnded { brick_id: ended_id }) if ended_id == brick_id => {
                        return Err(ended());
                    }
                    Err(broadcast::error::RecvError::Closed) => return Err(ended()),
                    _ => {}
                },
                () = tokio::time::sleep_until(deadline) => {
                    return Err(inner.no_route(brick_id, Some(late)));
                }
            }
        }
    }

    /// Sends a command to a brick over its best connected channel.
    ///
    /// A command that fails on a link fault is not resent: its caller hears the failure. When the
    /// brick has another connected channel, this one leaves routing at once, so the next command
    /// goes over that, and is probed straight away: back in routing if it answers, reconnecting
    /// if not. When it is the only one, it stays the route and is probed: leaving it would only
    /// make the next commands fail until the probe answered.
    ///
    /// A caller cancels by dropping the future; a cancelled command moves no traffic and starts
    /// no probe.
    pub async fn send(
        &self,
        brick_id: &str,
        command: &BrickCommand,
        options: CommandOptions,
    ) -> Result<BrickResponse, BrickError> {
        let route = match self.route_of(brick_id) {
            Some(route) => route,
            None => self.wait_for_route(brick_id, options.deadline).await?,
        };
        match self
            .inner
            .sessions
            .send(&route, command, options.timeout)
            .await
        {
            Ok(response) => {
                // The brick answers a rename with a bare status, and rejects a bad name in
                // silence; the only proof it took is to read the name back.
                if matches!(command, BrickCommand::SetName { .. }) {
                    self.inner.read_name_over_session(&route);
                }
                Ok(response)
            }
            Err(error) => {
                if error.is_link_fault() {
                    self.inner.drop_from_routing(&route, &error);
                }
                Err(error.into())
            }
        }
    }

    /// Holds the brick's current channel for a multi-step operation; see [`PinnedLink`].
    ///
    /// Takes the route there is now; an operation that may wait for one first awaits
    /// [`BrickManager::wait_for_route`].
    pub fn pin(&self, brick_id: &str) -> Result<PinnedLink, BrickError> {
        let key = self.route_of(brick_id).ok_or_else(|| BrickError::NoRoute {
            brick_id: brick_id.to_owned(),
            message: format!("Brick {brick_id} has no connected channel."),
        })?;
        let transport = key.transport();
        let chosen = match transport {
            Transport::Tcp | Transport::Bt => self
                .inner
                .options
                .transfer_packet_bytes
                .as_ref()
                .and_then(|chosen| chosen(transport)),
            Transport::Usb | Transport::Mock => None,
        };
        let max_packet_bytes = chosen.or_else(|| self.inner.sessions.max_packet_bytes(&key));
        Ok(PinnedLink {
            inner: self.inner.clone(),
            brick_key: key,
            max_packet_bytes,
        })
    }

    /// The largest packet the brick's current channel carries; `None` for the firmware's own.
    pub fn max_packet_bytes(&self, brick_id: &str) -> Option<usize> {
        let route = self.route_of(brick_id)?;
        self.inner.sessions.max_packet_bytes(&route)
    }

    /// The transport a brick's traffic goes over now.
    pub fn transport_of_brick(&self, brick_id: &str) -> Option<Transport> {
        self.route_of(brick_id).map(|key| key.transport())
    }

    // ── Active brick ────────────────────────────────────────────────

    pub fn active_brick(&self) -> Option<String> {
        self.inner.lock().active.clone()
    }

    /// Makes a signed-in brick the active one.
    pub fn set_active_brick(&self, brick_id: &str) -> Result<(), BrickError> {
        self.inner.set_active(brick_id)
    }

    pub fn clear_active_brick(&self) {
        self.inner.clear_active();
    }

    // ── Hooks for forgetting and the pairing check ──────────────────

    /// Holds the brick's links; see [`LinkHold`].
    pub fn hold_links(&self, brick_id: &str) -> LinkHold {
        *self
            .inner
            .lock()
            .holds
            .entry(brick_id.to_owned())
            .or_default() += 1;
        LinkHold {
            inner: Arc::downgrade(&self.inner),
            brick_id: brick_id.to_owned(),
        }
    }

    pub fn is_held(&self, brick_id: &str) -> bool {
        self.inner.lock().holds.contains_key(brick_id)
    }

    /// Lets the Bluetooth joins the gate holds look again.
    pub fn wake_bluetooth(&self) {
        self.inner.bluetooth_wake.notify_waiters();
    }

    // ── Lifecycle ───────────────────────────────────────────────────

    /// Ends every sign-in and stops listening. Leaves the sessions to their own shutdown.
    pub fn dispose(&self) {
        let bricks: Vec<String> = {
            let mut state = self.inner.lock();
            state.disposed = true;
            state.signed_in.keys().cloned().collect()
        };
        for brick_id in bricks {
            self.inner.forget_sign_in(&brick_id);
        }
        if let Some(handle) = self
            .inner
            .event_loop
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            handle.abort();
        }
    }
}

/// Listens to the sessions and the list, the session first when both have something.
fn start_event_loop(inner: &Arc<Inner>) -> AbortHandle {
    let mut sessions = inner.sessions.subscribe();
    let mut presence = inner.aggregator.subscribe();
    let weak = Arc::downgrade(inner);
    tokio::spawn(async move {
        loop {
            enum Next {
                Session(Result<SessionEvent, broadcast::error::RecvError>),
                Presence(Result<PresenceEvent, broadcast::error::RecvError>),
            }
            let next = tokio::select! {
                biased;
                event = sessions.recv() => Next::Session(event),
                event = presence.recv() => Next::Presence(event),
            };
            let Some(inner) = weak.upgrade() else {
                return;
            };
            match next {
                Next::Session(Ok(SessionEvent::StateChanged { brick_key, new, .. })) => {
                    inner.on_session_state(&brick_key, new);
                }
                Next::Session(Ok(SessionEvent::ReconnectFailed { .. })) => {}
                Next::Presence(Ok(PresenceEvent::PresenceChanged(change))) => {
                    if change.current == ev3_transports::PresenceState::Available {
                        inner.on_seen(&change.brick_key);
                    }
                }
                Next::Presence(Ok(PresenceEvent::ListChanged)) => inner.on_list_changed(),
                Next::Presence(Ok(_)) => {}
                // Missed events: what they would have said is read back from the sessions.
                Next::Session(Err(broadcast::error::RecvError::Lagged(_)))
                | Next::Presence(Err(broadcast::error::RecvError::Lagged(_))) => inner.resync(),
                Next::Session(Err(broadcast::error::RecvError::Closed))
                | Next::Presence(Err(broadcast::error::RecvError::Closed)) => return,
            }
        }
    })
    .abort_handle()
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn emit(&self, event: BrickEvent) {
        // No listener is not an error.
        let _ = self.events.send(event);
    }

    fn warn(&self, message: &str) {
        if let Some(log) = &self.options.log {
            log.warn(message);
        }
    }

    fn info(&self, message: &str) {
        if let Some(log) = &self.options.log {
            log.info(message);
        }
    }

    fn provider(&self, transport: Transport) -> Option<Arc<dyn TransportProvider>> {
        self.aggregator.scheduler().provider(transport)
    }

    fn priority_of(&self, key: &BrickKey) -> i32 {
        self.aggregator.scheduler().priority_of(key.transport())
    }

    /// `AAA over USB`, for the log.
    fn channel_label(&self, key: &BrickKey) -> String {
        let name = self
            .aggregator
            .brick(&brick_id_of(key))
            .map_or_else(|| brick_id_of(key), |entry| entry.name.value);
        format!(
            "{name} over {}",
            key.transport().as_str().to_ascii_uppercase()
        )
    }

    fn is_current(&self, brick_id: &str, id: u64) -> bool {
        self.lock()
            .signed_in
            .get(brick_id)
            .is_some_and(|sign_in| sign_in.id == id)
    }

    fn brick_sessions(&self, brick_id: &str) -> Vec<SessionSnapshot> {
        self.sessions
            .sessions()
            .into_iter()
            .filter(|s| brick_id_of(&s.brick_key) == brick_id)
            .collect()
    }

    fn has_connected_channel(&self, brick_id: &str) -> bool {
        self.brick_sessions(brick_id)
            .iter()
            .any(|s| s.connection_state == ConnectionState::Connected)
    }

    /// Channels of a brick that are available, have no session yet, and can be connected over.
    ///
    /// A Bluetooth channel of a brick nobody has paired is left out: it is a sighting — an
    /// inquiry, or the system's cache relisting the brick unpaired after a forget — not a link. It
    /// joins once it is paired.
    fn join_candidates(&self, brick_id: &str) -> Vec<BrickKey> {
        let Some(entry) = self.aggregator.brick(brick_id) else {
            return Vec::new();
        };
        entry
            .channels
            .iter()
            .filter(|c| {
                c.state == ChannelState::Available && (c.transport != Transport::Bt || entry.paired)
            })
            .map(|c| c.brick_key.clone())
            .filter(|key| self.sessions.session(key).is_none())
            .collect()
    }

    /// The brick's paired Bluetooth channel when the presence checks lost it and nothing holds it
    /// open.
    fn unheard_bluetooth(&self, brick_id: &str) -> Option<BrickKey> {
        let entry = self.aggregator.brick(brick_id)?;
        let bt = entry.channel(Transport::Bt)?;
        (entry.paired
            && bt.state == ChannelState::Lost
            && self.sessions.session(&bt.brick_key).is_none())
        .then(|| bt.brick_key.clone())
    }

    fn set_active(&self, brick_id: &str) -> Result<(), BrickError> {
        let previous = {
            let mut state = self.lock();
            if !state.signed_in.contains_key(brick_id) {
                return Err(BrickError::NotSignedIn {
                    brick_id: brick_id.to_owned(),
                });
            }
            state.active.replace(brick_id.to_owned())
        };
        if previous.as_deref() != Some(brick_id) {
            self.emit(BrickEvent::ActiveBrickChanged {
                previous,
                current: Some(brick_id.to_owned()),
            });
        }
        Ok(())
    }

    fn clear_active(&self) {
        let previous = self.lock().active.take();
        if previous.is_some() {
            self.emit(BrickEvent::ActiveBrickChanged {
                previous,
                current: None,
            });
        }
    }

    async fn sign_out(&self, brick_id: &str) {
        // Ended first, so nothing that fires while the channels close joins them again.
        self.forget_sign_in(brick_id);
        let keys: Vec<BrickKey> = self
            .brick_sessions(brick_id)
            .into_iter()
            .map(|s| s.brick_key)
            .collect();
        join_all(keys.iter().map(|key| self.sessions.disconnect(key, true))).await;
        {
            let mut state = self.lock();
            for key in &keys {
                state.dropped.remove(key);
            }
        }
        self.recompute_route(brick_id);
        let active = self.lock().active.as_deref() == Some(brick_id);
        if active {
            self.clear_active();
        }
    }

    fn forget_sign_in(&self, brick_id: &str) {
        let ended = {
            let mut state = self.lock();
            match state.signed_in.remove(brick_id) {
                Some(mut sign_in) => {
                    sign_in.stop_timers();
                    true
                }
                None => false,
            }
        };
        if ended {
            // A Bluetooth join the gate holds belongs to the sign-in that just ended: it gives up.
            self.bluetooth_wake.notify_waiters();
            self.emit(BrickEvent::SignInEnded {
                brick_id: brick_id.to_owned(),
            });
        }
    }

    // ── Joining ─────────────────────────────────────────────────────

    /// Joins every channel of a signed-in brick that can be joined now. Idempotent.
    fn reconcile(self: &Arc<Self>, brick_id: &str) {
        let joins = {
            let mut state = self.lock();
            // A brick being forgotten loses its channels on purpose; none joins again.
            if state.disposed || state.holds.contains_key(brick_id) {
                return;
            }
            let candidates = self.join_candidates(brick_id);
            let Some(sign_in) = state.signed_in.get_mut(brick_id) else {
                return;
            };
            let keys: Vec<BrickKey> = candidates
                .into_iter()
                .filter(|key| {
                    !sign_in.pending.contains(key)
                        && !sign_in.awaiting_evidence.contains_key(key)
                        && !sign_in.retry_timers.contains_key(key)
                })
                .collect();
            for key in &keys {
                sign_in.pending.insert(key.clone());
            }
            (sign_in.id, keys)
        };
        let (id, keys) = joins;
        for key in keys {
            let inner = self.clone();
            let brick_id = brick_id.to_owned();
            // Recorded by the join, and retried per transport.
            tokio::spawn(async move { inner.join(&brick_id, &key, id).await });
        }
        if let Some(gate) = &self.options.bluetooth_gate {
            gate.reconciled(brick_id);
        }
    }

    /// Joins one channel for sign-in `id`; the caller has put it among the sign-in's pending.
    async fn join(
        self: &Arc<Self>,
        brick_id: &str,
        key: &BrickKey,
        id: u64,
    ) -> Result<(), BrickError> {
        let transport = key.transport();
        let outcome = self.try_join(brick_id, key, id, transport).await;
        let mut said = None;
        {
            let mut state = self.lock();
            let current = state.signed_in.get(brick_id).is_some_and(|s| s.id == id);
            // Nothing to say or retry for a join its sign-in no longer wants.
            if let Err(error) = &outcome
                && current
                && !matches!(error, BrickError::ConnectionAbandoned { .. })
            {
                // Said, because a channel that will not join is otherwise invisible: the brick
                // works over its other channels and nothing explains why this one stays unused.
                // Once per reason: a rejoin that fails the same way every half minute is no news.
                let reason = error.to_string();
                if state.join_failures.get(key) != Some(&reason) {
                    state.join_failures.insert(key.clone(), reason.clone());
                    said = Some(reason);
                }
                self.schedule_rejoin(&mut state, brick_id, key, transport);
            }
            if let Some(sign_in) = state.signed_in.get_mut(brick_id).filter(|s| s.id == id) {
                sign_in.pending.remove(key);
            }
        }
        if let Some(reason) = said {
            self.warn(&format!(
                "Joining {} failed: {reason}",
                self.channel_label(key)
            ));
        }
        // A USB or TCP join that ends may have been what held Bluetooth back.
        if transport != Transport::Bt {
            self.bluetooth_wake.notify_waiters();
        }
        outcome
    }

    async fn try_join(
        self: &Arc<Self>,
        brick_id: &str,
        key: &BrickKey,
        id: u64,
        transport: Transport,
    ) -> Result<(), BrickError> {
        if transport == Transport::Bt && self.options.bluetooth_gate.is_some() {
            self.await_bluetooth_gate(brick_id, id).await?;
        }
        // A connect from an earlier sign-in can still be inside the provider, a Bluetooth one for
        // seconds in the connection queue; the session manager makes this one wait its turn, and
        // fails it if the brick is signed out meanwhile.
        let name = self
            .aggregator
            .brick(brick_id)
            .map(|entry| entry.name.value);
        self.sessions
            .connect(key, name.as_deref())
            .await
            .map_err(|error| match error {
                SessionError::ConnectionAbandoned { .. } => BrickError::ConnectionAbandoned {
                    brick_id: brick_id.to_owned(),
                },
                other => BrickError::Session(other),
            })?;
        let recovered = {
            let mut state = self.lock();
            if let Some(sign_in) = state.signed_in.get_mut(brick_id).filter(|s| s.id == id) {
                sign_in.backoff.remove(key);
            }
            state.join_failures.remove(key).is_some()
        };
        if recovered {
            self.info(&format!(
                "Joined {} after it had failed",
                self.channel_label(key)
            ));
        }
        self.on_session_state(key, ConnectionState::Connected);
        self.read_name_over_session(key);
        // Signed out once the connect was through: the user asked for nothing to stay open. A
        // newer sign-in keeps the channel; it is the one it would have opened.
        if !self.lock().signed_in.contains_key(brick_id) {
            self.sessions.disconnect(key, true).await;
        }
        Ok(())
    }

    /// Holds a Bluetooth join while the gate holds the brick, or a first USB or TCP join of it is
    /// under way; see [`BluetoothGate`]. Every way into a join waits at this one place.
    ///
    /// A join whose sign-in ended, whose brick is held, or whose pairing went meanwhile is
    /// abandoned and not retried: the pairing that follows makes the channel a candidate again.
    async fn await_bluetooth_gate(&self, brick_id: &str, id: u64) -> Result<(), BrickError> {
        loop {
            let notified = self.bluetooth_wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let gate_holds = self
                .options
                .bluetooth_gate
                .as_ref()
                .is_some_and(|gate| gate.holds(brick_id));
            let waits = {
                let state = self.lock();
                let sign_in = state.signed_in.get(brick_id).filter(|s| s.id == id);
                let joining_first = sign_in.is_some_and(|s| {
                    s.pending
                        .iter()
                        .any(|key| key.transport() != Transport::Bt && !s.backoff.contains_key(key))
                });
                sign_in.is_some() && !state.disposed && (gate_holds || joining_first)
            };
            if !waits {
                break;
            }
            notified.await;
        }
        let paired = self
            .aggregator
            .brick(brick_id)
            .is_some_and(|entry| entry.paired);
        let state = self.lock();
        let wanted = state.signed_in.get(brick_id).is_some_and(|s| s.id == id)
            && !state.disposed
            && !state.holds.contains_key(brick_id);
        if wanted && paired {
            Ok(())
        } else {
            Err(BrickError::ConnectionAbandoned {
                brick_id: brick_id.to_owned(),
            })
        }
    }

    /// A failed join tries again: on Bluetooth only once the brick is seen again, since every
    /// attempt pages the one radio; elsewhere on a backoff while the brick stays visible.
    fn schedule_rejoin(
        self: &Arc<Self>,
        state: &mut State,
        brick_id: &str,
        key: &BrickKey,
        transport: Transport,
    ) {
        let evidence_only = self
            .provider(transport)
            .is_some_and(|p| p.capabilities().rejoin_on_evidence_only);
        let config = self.options.config.rejoin_backoff;
        let Some(sign_in) = state.signed_in.get_mut(brick_id) else {
            return;
        };
        if evidence_only {
            sign_in.awaiting_evidence.insert(key.clone(), now_ms());
            return;
        }
        let delay = sign_in
            .backoff
            .entry(key.clone())
            .or_insert_with(|| Backoff::new(config))
            .next_delay()
            .unwrap_or(config.max);
        let id = sign_in.id;
        let weak = Arc::downgrade(self);
        let (brick, channel) = (brick_id.to_owned(), key.clone());
        let timer = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            if let Some(sign_in) = inner
                .lock()
                .signed_in
                .get_mut(&brick)
                .filter(|s| s.id == id)
            {
                sign_in.retry_timers.remove(&channel);
            }
            inner.reconcile(&brick);
        })
        .abort_handle();
        if let Some(old) = sign_in.retry_timers.insert(key.clone(), timer) {
            old.abort();
        }
    }

    // ── What the sessions and the list say ──────────────────────────

    /// A channel's session changed state: the list follows it, and the route; a channel whose
    /// session ended while its brick stays signed in joins again once it is available, whatever
    /// ended it. Idempotent: a join applies the connect at once, and the event repeats it.
    fn on_session_state(self: &Arc<Self>, key: &BrickKey, state: ConnectionState) {
        let brick_id = brick_id_of(key);
        // First: a gate that marks the brick's check pending must have done so before a join
        // that connected lets the Bluetooth join it holds look again.
        if let Some(gate) = &self.options.bluetooth_gate {
            gate.channel_state(&brick_id, key, state);
        }
        self.aggregator.update_channel_session(key, state);
        if state == ConnectionState::Connected {
            self.lock().dropped.remove(key);
        }
        self.recompute_route(&brick_id);
        if state == ConnectionState::Disconnected {
            self.reconcile(&brick_id);
        }
    }

    /// A channel has just become visible again: the evidence a reconnecting session, and a
    /// failed join, wait for. Measured before this existed: a brick that boots in about 40 s took
    /// 121 s to be picked up, because the backoff had reached 30 s steps and waited them out.
    fn on_seen(self: &Arc<Self>, key: &BrickKey) {
        let brick_id = brick_id_of(key);
        // Not for a held brick: either would open a link the forget is closing.
        let held = self.lock().holds.contains_key(&brick_id);
        if !held {
            self.sessions.notify_brick_available(key);
            self.probe_name(key);
        }
        let evidence = self
            .lock()
            .signed_in
            .get_mut(&brick_id)
            .is_some_and(|sign_in| sign_in.awaiting_evidence.remove(key).is_some());
        if evidence {
            self.reconcile(&brick_id);
        }
    }

    fn on_list_changed(self: &Arc<Self>) {
        let bricks: Vec<String> = self.lock().signed_in.keys().cloned().collect();
        for brick_id in bricks {
            self.take_answers_as_evidence(&brick_id);
            self.reconcile(&brick_id);
        }
    }

    /// Reads back what missed events would have said.
    fn resync(self: &Arc<Self>) {
        for session in self.sessions.sessions() {
            self.aggregator
                .update_channel_session(&session.brick_key, session.connection_state);
        }
        let bricks: HashSet<String> = {
            let state = self.lock();
            state
                .signed_in
                .keys()
                .chain(state.routes.keys())
                .cloned()
                .collect()
        };
        for brick_id in bricks {
            self.recompute_route(&brick_id);
            self.reconcile(&brick_id);
        }
    }

    /// A presence check answered after a join failed is the evidence that join was waiting for:
    /// the brick is there now, whatever stopped the last attempt.
    fn take_answers_as_evidence(&self, brick_id: &str) {
        let Some(entry) = self.aggregator.brick(brick_id) else {
            return;
        };
        let mut state = self.lock();
        let Some(sign_in) = state.signed_in.get_mut(brick_id) else {
            return;
        };
        for channel in &entry.channels {
            if let Some(failed_at) = sign_in.awaiting_evidence.get(&channel.brick_key)
                && channel.heard_at.unwrap_or(0) > *failed_at
            {
                sign_in.awaiting_evidence.remove(&channel.brick_key);
            }
        }
    }

    // ── Routing ─────────────────────────────────────────────────────

    /// The connected channel not out of routing with the highest priority its provider declares.
    fn recompute_route(&self, brick_id: &str) {
        // Read under the lock, so a route decided on an older reading never overwrites a newer.
        let mut state = self.lock();
        let best = self
            .brick_sessions(brick_id)
            .into_iter()
            .filter(|s| {
                s.connection_state == ConnectionState::Connected
                    && !state.dropped.contains(&s.brick_key)
            })
            .map(|s| s.brick_key)
            .max_by(|a, b| {
                self.priority_of(a)
                    .cmp(&self.priority_of(b))
                    .then_with(|| b.cmp(a))
            });
        let previous = state.routes.get(brick_id).cloned();
        if best == previous {
            return;
        }
        match &best {
            Some(key) => state.routes.insert(brick_id.to_owned(), key.clone()),
            None => state.routes.remove(brick_id),
        };
        drop(state);
        self.emit(BrickEvent::RouteChanged {
            brick_id: brick_id.to_owned(),
            previous,
            current: best,
        });
    }

    fn drop_from_routing(self: &Arc<Self>, key: &BrickKey, error: &SessionError) {
        let brick_id = brick_id_of(key);
        let label = self.channel_label(key);
        let another = {
            let mut state = self.lock();
            // A held brick loses its links on purpose, and the probe below would put a lost one
            // into reconnecting. Every failed command is said all the same.
            if state.dropped.contains(key) || state.holds.contains_key(&brick_id) {
                let why = if state.dropped.contains(key) {
                    "the channel is already being checked."
                } else {
                    "the brick is being forgotten."
                };
                drop(state);
                self.warn(&format!("A command over {label} failed: {error}; {why}"));
                return;
            }
            let another = self.brick_sessions(&brick_id).iter().any(|s| {
                &s.brick_key != key
                    && s.connection_state == ConnectionState::Connected
                    && !state.dropped.contains(&s.brick_key)
            });
            if another {
                state.dropped.insert(key.clone());
            }
            another
        };
        self.warn(&format!(
            "A command over {label} failed: {error}; {}",
            if another {
                "traffic moves to another channel while this one is checked."
            } else {
                "it stays the route, as no other channel is connected, and is checked."
            }
        ));
        if !another {
            // Dropping the only channel moves traffic nowhere: it left a gap of a few
            // milliseconds, until the check answered, in which every command failed "no connected
            // channel" (three uploads of five on one evening). The channel stays routed; the
            // check still runs at once, and the heartbeat ends a link that is really gone.
            let inner = self.clone();
            let key = key.clone();
            tokio::spawn(async move { inner.sessions.probe_now(&key).await });
            return;
        }
        self.recompute_route(&brick_id);
        self.probe_dropped(key);
    }

    /// Asks a dropped channel whether it answers, and routes it again when it does. A check that
    /// fails and leaves the session connected was a slow reply on USB, a busy brick: it is asked
    /// again until it answers, or its session leaves connected and the reconnect takes over.
    fn probe_dropped(self: &Arc<Self>, key: &BrickKey) {
        let weak = Arc::downgrade(self);
        let key = key.clone();
        tokio::spawn(async move {
            loop {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let answered = inner.sessions.probe_now(&key).await;
                {
                    let mut state = inner.lock();
                    if state.disposed || !state.dropped.contains(&key) {
                        return;
                    }
                    if answered {
                        state.dropped.remove(&key);
                        drop(state);
                        inner.recompute_route(&brick_id_of(&key));
                        return;
                    }
                }
                let connected = inner
                    .sessions
                    .session(&key)
                    .is_some_and(|s| s.connection_state == ConnectionState::Connected);
                if !connected {
                    return;
                }
                let retry = inner.options.config.slow_probe_retry;
                drop(inner);
                tokio::time::sleep(retry).await;
            }
        });
    }

    /// No route to the brick, with why: what each of its channels last failed with.
    fn no_route(&self, brick_id: &str, why: Option<&str>) -> BrickError {
        let reasons: Vec<String> = self
            .brick_sessions(brick_id)
            .into_iter()
            .filter_map(|s| {
                s.last_error.map(|error| {
                    format!(
                        "{} {:?}: {error}",
                        describe_channel(&s.brick_key),
                        s.connection_state
                    )
                })
            })
            .collect();
        let because = if reasons.is_empty() {
            String::new()
        } else {
            format!(" Last failure: {}.", reasons.join("; "))
        };
        let why = why.map(|why| format!("; {why}")).unwrap_or_default();
        BrickError::NoRoute {
            brick_id: brick_id.to_owned(),
            message: format!("Brick {brick_id} has no connected channel{why}.{because}"),
        }
    }

    // ── Names ───────────────────────────────────────────────────────

    /// Asks a channel's session for the brick's name and records it as confirmed. The name stays
    /// what discovery said when the read fails; the heartbeat deals with the link.
    fn read_name_over_session(self: &Arc<Self>, key: &BrickKey) {
        let inner = self.clone();
        let key = key.clone();
        tokio::spawn(async move {
            if let Ok(BrickResponse::Info { display_name, .. }) =
                inner.sessions.send(&key, &BrickCommand::Info, None).await
            {
                inner
                    .aggregator
                    .confirm_name(&brick_id_of(&key), &display_name);
            }
        });
    }

    /// Asks a brick that has just appeared for its name, without signing it in.
    ///
    /// Only where the transport offers a probe (USB), and only for a brick nobody is signed into:
    /// a signed-in brick's join reads the name itself, and a probe would hold the device the join
    /// is about to open.
    fn probe_name(self: &Arc<Self>, key: &BrickKey) {
        let Some(provider) = self.provider(key.transport()) else {
            return;
        };
        if !provider.capabilities().supports_probe {
            return;
        }
        let brick_id = brick_id_of(key);
        {
            let mut state = self.lock();
            if state.probing.contains(key)
                || state.signed_in.contains_key(&brick_id)
                || self.sessions.session(key).is_some()
            {
                return;
            }
            state.probing.insert(key.clone());
        }
        let inner = self.clone();
        let key = key.clone();
        tokio::spawn(async move {
            match probe_info(provider.as_ref(), &key).await {
                Ok(name) => inner.aggregator.confirm_name(&brick_id, &name),
                Err(error) => {
                    let first = inner.lock().probe_failures_reported.insert(key.clone());
                    if first {
                        inner.warn(&format!(
                            "Could not read the name of {} without connecting; showing the USB \
                             descriptor's until it connects: {error}",
                            inner.channel_label(&key)
                        ));
                    }
                }
            }
            inner.lock().probing.remove(&key);
        });
    }
}

/// The brick's name over a probe link: one info exchange, decoded the way a session decodes it,
/// so the name is cut at its terminator whatever an earlier reply left in the globals after it.
async fn probe_info(
    provider: &dyn TransportProvider,
    key: &BrickKey,
) -> Result<String, SessionError> {
    const COUNTER: u16 = 1;
    let mut link = provider.open_probe(key).await?;
    let outcome = async {
        let encoded = build_command(&BrickCommand::Info)?;
        let packet = encode_ev3_packet(u32::from(COUNTER), encoded.packet_type, &encoded.payload)?;
        let options = SendOptions {
            timeout: None,
            expected_message_counter: Some(COUNTER),
        };
        let reply = link.send_packet(&packet, &options).await?;
        verify_reply_counter(
            &reply,
            COUNTER,
            &key.transport().as_str().to_ascii_uppercase(),
        )?;
        let decoded = decode_ev3_packet(&reply)?;
        match parse_response(&BrickCommand::Info, &decoded)? {
            BrickResponse::Info { display_name, .. } => Ok(display_name),
            other => Err(SessionError::Protocol(ev3_protocol::ProtocolError::new(
                format!("Expected an info reply, got {other:?}."),
            ))),
        }
    }
    .await;
    link.close().await;
    outcome
}
