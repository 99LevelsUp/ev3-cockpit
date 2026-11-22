//! Decides which bricks run telemetry, which rows each reads and at what cadence.
//!
//! Three modes, one per brick:
//!
//!  - **foreground**: a brick some client shows in its panel, read for every row at the
//!    transport's foreground cadence;
//!  - **subscribed**: a connected brick a client claimed rows of, read for only those rows at the
//!    interval each was granted;
//!  - **minimal**: every other connected brick. No telemetry; the heartbeat and reconnect keep
//!    running, which is what minimal means.
//!
//! **One loop per brick.** The foreground is a claim like the others, so a loop's rows and tick
//! come from one plan: the foreground changing re-plans a running loop instead of restarting it,
//! which would read every static row again and settle every port afresh. Only a change of
//! transport restarts a loop, because a loop is built for one link's cadence. Every event funnels
//! into one [`TelemetryService::refresh`], which works out what a brick should be doing from the
//! brick layer's state rather than from the event that woke it.
//!
//! **Claims outlive a lost link and end with the sign-in.** While a brick has no route its loop
//! stops and its claims wait; when it is signed out they end, and a
//! [`TelemetryEvent::ClaimsEnded`] names them so the daemon can tell their makers.
//!
//! **One telemetry frame per brick at a time, across loops.** A loop holds one frame in flight,
//! but a restarted loop is a new loop: the retired one's frame may still be on its way over the old
//! link, and if it commands a sensor mode it would switch the device behind the new loop's back.
//! Every loop of a brick takes turns on one gate, so a new loop's first frame waits until the
//! retired one's has settled; every transport times a send out, so the wait is bounded. A frame
//! that waited goes out only if its loop is still the brick's loop; otherwise it fails without
//! reaching the brick.
//!
//! **A grant is fixed when the claim is made**: the request clamped to the floor. What a row really
//! runs at, slower after a route change or under throttling, travels in the data.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use async_trait::async_trait;
use ev3_contract::TelemetryRowInfo;
use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_transports::Transport;
use tokio::sync::broadcast;
use tokio::task::AbortHandle;

use crate::bricks::{BrickEvent, BrickManager};

use super::brick_loop::{BrickTelemetry, BrickTelemetryOptions, TelemetrySender};
use super::cadence::{cadence_for, typical_round_trip_ms};
use super::claims::{ClaimCadence, ClaimRequest, Grant, RowRate, TelemetryClaims};
use super::clock::WallClock;
use super::dispatch::{Dispatcher, Listener};
use super::error::TelemetryError;
use super::ev3_rows::PROGRAM_RUNNING_ROW;
use super::registry::{RowRegistry, ev3_row_registry};
use super::row::{Lifetime, Reading, RowValue};
use super::settings::{ProgramPresetSettings, ThrottleSettings};
use super::throttle::{ThrottleState, TickThrottle};

/// What the service needs of the brick layer, beyond sending. Narrow, so a test can stand in.
pub trait TelemetryHost: TelemetrySender {
    /// The brick the editor shows, when no client has said which bricks it shows.
    fn active_brick(&self) -> Option<String>;
    /// The brick is signed in: it may be reconnecting, but its claims are not over.
    fn has_session(&self, brick_id: &str) -> bool;
    /// The brick has a route: a frame can go out now.
    fn is_connected(&self, brick_id: &str) -> bool;
    /// The transport executes composed frames, as its provider declares. Declared rather than
    /// probed: a provider that cannot serve frames would otherwise announce itself as an error on
    /// every tick for as long as the brick was read.
    fn serves_frames(&self, transport: Transport) -> bool;
}

impl TelemetryHost for BrickManager {
    fn active_brick(&self) -> Option<String> {
        BrickManager::active_brick(self)
    }

    fn has_session(&self, brick_id: &str) -> bool {
        self.is_signed_in(brick_id)
    }

    fn is_connected(&self, brick_id: &str) -> bool {
        self.route_of(brick_id).is_some()
    }

    fn serves_frames(&self, transport: Transport) -> bool {
        self.aggregator()
            .scheduler()
            .provider(transport)
            .is_some_and(|provider| provider.capabilities().supports_telemetry_frames)
    }
}

/// How often each row of a brick is read now, by row id.
pub type Intervals = BTreeMap<String, RowRate>;

/// The mode a brick is read in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadMode {
    Foreground,
    Subscribed,
    Minimal,
    /// The brick has no session.
    None,
}

/// A brick's throttle, as the diagnostic display shows it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BrickThrottleState {
    pub throttle: ThrottleState,
    /// The plan's tick, in milliseconds.
    pub base_period_ms: f64,
    /// The tick the loop runs at: the plan's times the factor.
    pub period_ms: f64,
}

/// What the service tells its listeners.
#[derive(Debug, Clone)]
pub enum TelemetryEvent {
    /// A brick's loop read these values.
    Values {
        brick_id: String,
        values: Vec<RowValue>,
    },
    /// A brick's frame failed.
    Error {
        brick_id: String,
        error: TelemetryError,
    },
    /// Claims that ended because their brick went, not because their makers released them.
    ClaimsEnded {
        brick_id: String,
        handles: Vec<String>,
    },
    /// Which rows a brick is read for now and how often; empty when it stops being read.
    PlanChanged {
        brick_id: String,
        intervals: Intervals,
    },
    /// A brick this service read has no session any more: whatever was read of it is gone.
    SessionEnded { brick_id: String },
    /// A brick's throttle moved its tick.
    ThrottleChanged {
        brick_id: String,
        state: BrickThrottleState,
    },
}

/// A claim as its maker holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimTicket {
    pub handle: String,
    pub grant: Grant,
}

pub struct TelemetryServiceOptions {
    /// The rows a brick offers; the EV3 catalogue when `None`.
    pub registry: Option<RowRegistry>,
    /// Overrides the foreground cadence, below the transport's floor if need be. For probes; the
    /// daemon leaves it unset.
    pub tick_period_ms: Option<f64>,
    /// How a brick's tick slows down when its round trips grow; no brick is throttled when `None`.
    pub throttle: Option<ThrottleSettings>,
    /// How a running program slows its brick's loop; a running program changes nothing when
    /// `None`.
    pub program_preset: Option<ProgramPresetSettings>,
    /// Starts each loop's timer. False leaves the ticks to the caller, for tests and probes that
    /// tick by hand.
    pub start_loops: bool,
    pub clock: WallClock,
}

impl Default for TelemetryServiceOptions {
    fn default() -> Self {
        Self {
            registry: None,
            tick_period_ms: None,
            throttle: None,
            program_preset: None,
            start_loops: true,
            clock: WallClock::system(),
        }
    }
}

struct RunningLoop {
    telemetry: BrickTelemetry,
    /// The plan's tick; the loop runs at it times the throttle's factor.
    base_period_ms: f64,
    throttle: Option<TickThrottle>,
    /// Whether the brick's program row last said a program runs; a new loop does not know yet.
    program_running: bool,
    /// This loop's identity: a frame waiting at the gate goes out only while it is the brick's.
    token: u64,
    /// The transport the loop was built for; another one restarts it.
    transport: Option<Transport>,
}

#[derive(Default)]
struct State {
    loops: HashMap<String, RunningLoop>,
    /// Each brick's claims, apart from its loop so they outlive a lost link.
    claims: HashMap<String, TelemetryClaims>,
    /// The service's handles, unique across bricks: each brick's claims count their own.
    handles: HashMap<String, (String, u64)>,
    /// Each brick's frame gate, shared by every loop the brick has had.
    gates: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    /// The plan last announced per brick, so a refresh that changed nothing announces nothing.
    announced: HashMap<String, Intervals>,
    /// Bricks read since their session began: the ones whose end is worth announcing.
    read: HashSet<String>,
    next_handle: u64,
    next_token: u64,
    disposed: bool,
    throttle: Option<ThrottleSettings>,
    program_preset: Option<ProgramPresetSettings>,
    /// The bricks read in the foreground when set; otherwise the active brick is.
    foreground: Option<HashSet<String>>,
}

struct Inner {
    host: Arc<dyn TelemetryHost>,
    registry: RowRegistry,
    tick_override: Option<f64>,
    start_loops: bool,
    clock: WallClock,
    state: Mutex<State>,
    events: Dispatcher<TelemetryEvent>,
}

/// The telemetry of every brick. Cheap to clone; clones share it.
#[derive(Clone)]
pub struct TelemetryService {
    inner: Arc<Inner>,
}

impl TelemetryService {
    /// The service over `host`. Reads the active brick at once if it is connected; call
    /// [`follow_bricks`] (or [`TelemetryService::refresh`] on every brick event) so it follows the
    /// brick layer from then on.
    pub fn new(
        host: Arc<dyn TelemetryHost>,
        options: TelemetryServiceOptions,
    ) -> Result<Self, TelemetryError> {
        if let Some(preset) = &options.program_preset {
            preset.check()?;
        }
        if let Some(throttle) = &options.throttle {
            throttle.check()?;
        }
        let service = Self {
            inner: Arc::new(Inner {
                host,
                registry: options.registry.unwrap_or_else(ev3_row_registry),
                tick_override: options.tick_period_ms,
                start_loops: options.start_loops,
                clock: options.clock,
                state: Mutex::new(State {
                    throttle: options.throttle,
                    program_preset: options.program_preset,
                    next_handle: 1,
                    ..State::default()
                }),
                events: Dispatcher::default(),
            }),
        };
        if let Some(active) = service.inner.host.active_brick() {
            service.refresh(&active);
        }
        Ok(service)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner.lock()
    }

    /// Hears every event from now on. A listener may call back into the service.
    pub fn listen(&self, listener: Listener<TelemetryEvent>) {
        self.inner.events.listen(listener);
    }

    /// Brings one brick's telemetry in line with the brick layer: ends its claims if its sign-in
    /// went, runs a loop if it is connected and someone wants it read, and gives that loop the rows
    /// and tick the claims plan. Safe to call for any brick, any number of times.
    pub fn refresh(&self, brick_id: &str) {
        {
            let mut state = self.lock();
            self.inner.refresh(&mut state, brick_id);
        }
        self.inner.events.drain();
    }

    /// Read these bricks in the foreground instead of the active brick: each client has its own,
    /// and every one a client shows is read for its panel. `None` goes back to the active brick.
    pub fn set_foreground_bricks(&self, bricks: Option<HashSet<String>>) {
        {
            let mut state = self.lock();
            let mut touched: HashSet<String> = state.foreground.clone().unwrap_or_default();
            touched.extend(bricks.iter().flatten().cloned());
            touched.extend(self.inner.host.active_brick());
            state.foreground = bricks;
            for brick in touched {
                self.inner.refresh(&mut state, &brick);
            }
        }
        self.inner.events.drain();
    }

    /// The mode a brick is read in now.
    pub fn mode_of(&self, brick_id: &str) -> ReadMode {
        let state = self.lock();
        if state.loops.contains_key(brick_id) {
            if self.inner.is_foreground(&state, brick_id) {
                ReadMode::Foreground
            } else {
                ReadMode::Subscribed
            }
        } else if self.inner.host.has_session(brick_id) {
            ReadMode::Minimal
        } else {
            ReadMode::None
        }
    }

    /// The rows a brick offers, as plain data: what a client can claim.
    pub fn rows(&self) -> Vec<TelemetryRowInfo> {
        self.inner.registry.list()
    }

    pub fn registry(&self) -> &RowRegistry {
        &self.inner.registry
    }

    /// What each brick is read for now, as last announced: for a reader attached after the loops
    /// started.
    pub fn current_plans(&self) -> HashMap<String, Intervals> {
        self.lock().announced.clone()
    }

    /// A brick's throttle; `None` when it is not read or not throttled.
    pub fn throttle_of(&self, brick_id: &str) -> Option<BrickThrottleState> {
        let state = self.lock();
        state
            .loops
            .get(brick_id)
            .filter(|running| running.throttle.is_some())
            .map(state_of)
    }

    /// The running loop of a brick, for tests and hardware probes.
    pub fn loop_for(&self, brick_id: &str) -> Option<BrickTelemetry> {
        self.lock()
            .loops
            .get(brick_id)
            .map(|running| running.telemetry.clone())
    }

    /// A new program preset applies at once to every brick, a program running or not. Refuses a
    /// setting out of range, changing nothing.
    pub fn configure_program_preset(
        &self,
        settings: ProgramPresetSettings,
    ) -> Result<(), TelemetryError> {
        settings.check()?;
        {
            let mut state = self.lock();
            state.program_preset = Some(settings);
            let bricks: Vec<String> = state.loops.keys().cloned().collect();
            for brick in bricks {
                self.inner.apply_period(&mut state, &brick);
            }
        }
        self.inner.events.drain();
        Ok(())
    }

    /// New throttle settings apply at once to every brick. Refuses settings out of range, changing
    /// nothing.
    pub fn configure_throttle(&self, settings: ThrottleSettings) -> Result<(), TelemetryError> {
        settings.check()?;
        {
            let mut state = self.lock();
            let bricks: Vec<String> = state.loops.keys().cloned().collect();
            for brick in bricks {
                let Some(running) = state.loops.get_mut(&brick) else {
                    continue;
                };
                let changed = match &mut running.throttle {
                    None => {
                        running.throttle = Some(TickThrottle::new(
                            settings,
                            typical_round_trip_ms(running.transport),
                        )?);
                        false
                    }
                    Some(throttle) => throttle.configure(settings)?,
                };
                if changed {
                    self.inner.apply_throttle(&mut state, &brick);
                }
            }
            state.throttle = Some(settings);
        }
        self.inner.events.drain();
        Ok(())
    }

    /// Claims rows of a brick, or refuses and claims nothing.
    ///
    /// Refused for a brick with no session, and for one whose link cannot carry telemetry frames:
    /// such a claim would never be read and nobody would hear why. A brick reconnecting has no link
    /// to judge yet; its claim is taken and read when the link is back.
    pub fn claim(
        &self,
        brick_id: &str,
        request: &ClaimRequest,
        owner: &str,
    ) -> Result<ClaimTicket, TelemetryError> {
        let ticket = {
            let mut state = self.lock();
            if state.disposed {
                return Err(TelemetryError::SubscriptionFailed(
                    "Telemetry has been shut down.".into(),
                ));
            }
            let host = &self.inner.host;
            if !host.has_session(brick_id) {
                return Err(TelemetryError::NotConnected(format!(
                    "Brick {brick_id} is not connected; telemetry can be claimed of a connected \
                     brick only."
                )));
            }
            let transport = host.transport_of(brick_id);
            if let Some(transport) = transport
                && !host.serves_frames(transport)
            {
                return Err(TelemetryError::SubscriptionFailed(format!(
                    "Brick {brick_id} is connected over a link that does not carry telemetry."
                )));
            }
            // The grant is fixed now, so against the floor of the link the brick is on now: the
            // claims keep the cadence of their last plan, which a brick nobody read since may have
            // left behind.
            let cadence = self.inner.cadence_of(transport);
            let claims = self.inner.claims_for(&mut state, brick_id);
            if transport.is_some() {
                claims.set_cadence(cadence);
            }
            let inner_handle = claims.claim(request, owner)?;
            let grant = claims.grant_of(inner_handle).cloned().unwrap_or_default();
            let handle = format!("telemetry-{}", state.next_handle);
            state.next_handle += 1;
            state
                .handles
                .insert(handle.clone(), (brick_id.to_owned(), inner_handle));
            self.inner.refresh(&mut state, brick_id);
            ClaimTicket { handle, grant }
        };
        self.inner.events.drain();
        Ok(ticket)
    }

    /// Releases one claim; releasing it again, or after its brick went, does nothing.
    pub fn release(&self, handle: &str) {
        {
            let mut state = self.lock();
            let Some((brick, inner_handle)) = state.handles.remove(handle) else {
                return;
            };
            if let Some(claims) = state.claims.get_mut(&brick) {
                claims.release(inner_handle);
            }
            self.inner.refresh(&mut state, &brick);
        }
        self.inner.events.drain();
    }

    /// What each row of a claim was granted; `None` once the claim has ended.
    pub fn grant_of(&self, handle: &str) -> Option<Grant> {
        let state = self.lock();
        let (brick, inner_handle) = state.handles.get(handle)?;
        state.claims.get(brick)?.grant_of(*inner_handle).cloned()
    }

    /// Stops every loop and ends every claim without a word; nothing more is told.
    pub fn dispose(&self) {
        {
            let mut state = self.lock();
            state.disposed = true;
            let bricks: Vec<String> = state.loops.keys().cloned().collect();
            for brick in bricks {
                self.inner.stop_for(&mut state, &brick);
            }
            state.claims.clear();
            state.handles.clear();
        }
        self.inner.events.clear();
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_foreground(&self, state: &State, brick_id: &str) -> bool {
        match &state.foreground {
            Some(bricks) => bricks.contains(brick_id),
            None => self.host.active_brick().as_deref() == Some(brick_id),
        }
    }

    /// The transport's cadence, with the foreground override probes use.
    fn cadence_of(&self, transport: Option<Transport>) -> ClaimCadence {
        let cadence = ClaimCadence::from(cadence_for(transport));
        match self.tick_override {
            None => cadence,
            Some(ms) => ClaimCadence {
                foreground_ms: ms,
                floor_ms: ms.min(cadence.floor_ms),
            },
        }
    }

    fn claims_for<'a>(&self, state: &'a mut State, brick_id: &str) -> &'a mut TelemetryClaims {
        let cadence = self.cadence_of(self.host.transport_of(brick_id));
        state
            .claims
            .entry(brick_id.to_owned())
            .or_insert_with(|| TelemetryClaims::new(self.registry.clone(), cadence))
    }

    fn refresh(self: &Arc<Self>, state: &mut State, brick_id: &str) {
        if state.disposed {
            return;
        }
        let has_session = self.host.has_session(brick_id);
        if !has_session {
            self.end_claims(state, brick_id);
        }
        let foreground = self.is_foreground(state, brick_id);
        let transport = self.host.transport_of(brick_id);
        let wanted = self.host.is_connected(brick_id)
            && transport.is_some_and(|t| self.host.serves_frames(t))
            && (foreground
                || state
                    .claims
                    .get(brick_id)
                    .is_some_and(TelemetryClaims::has_claims));
        if !wanted {
            self.stop_for(state, brick_id);
            if !has_session && state.read.remove(brick_id) {
                self.events.push(TelemetryEvent::SessionEnded {
                    brick_id: brick_id.to_owned(),
                });
            }
            return;
        }

        let cadence = self.cadence_of(transport);
        let claims = self.claims_for(state, brick_id);
        claims.set_cadence(cadence);
        claims.set_foreground(foreground);
        let plan = claims.plan();

        if let Some(running) = state.loops.get_mut(brick_id)
            && running.transport == transport
        {
            // A plan's rows were checked by the registry; a refusal here is a bug in the plan.
            let _ = running.telemetry.set_rows(plan.rows);
            running.base_period_ms = plan.period_ms;
            // The brick's slowdown, and a running program's floor, carry over to the new tick.
            self.apply_period(state, brick_id);
            return;
        }
        self.stop_for(state, brick_id);
        state.next_token += 1;
        let token = state.next_token;
        let telemetry =
            match self.build_loop(brick_id, token, plan.rows, plan.period_ms, cadence.floor_ms) {
                Ok(telemetry) => telemetry,
                Err(error) => {
                    self.events.push(TelemetryEvent::Error {
                        brick_id: brick_id.to_owned(),
                        error,
                    });
                    return;
                }
            };
        // A new loop is a new link: it starts unthrottled and learns this one's round trips.
        let throttle = state.throttle.and_then(|settings| {
            TickThrottle::new(settings, typical_round_trip_ms(transport)).ok()
        });
        state.loops.insert(
            brick_id.to_owned(),
            RunningLoop {
                telemetry: telemetry.clone(),
                base_period_ms: plan.period_ms,
                throttle,
                program_running: false,
                token,
                transport,
            },
        );
        state.read.insert(brick_id.to_owned());
        if self.start_loops {
            telemetry.start();
        }
        self.announce(state, brick_id, intervals_of(&telemetry));
    }

    fn build_loop(
        self: &Arc<Self>,
        brick_id: &str,
        token: u64,
        rows: Vec<super::row::TelemetryRow>,
        period_ms: f64,
        floor_ms: f64,
    ) -> Result<BrickTelemetry, TelemetryError> {
        let weak = Arc::downgrade(self);
        let sender = Arc::new(LoopSender {
            service: weak.clone(),
            brick_id: brick_id.to_owned(),
            token,
        });
        let (on_values, on_error, on_round_trip) = {
            let (w1, w2, w3) = (weak.clone(), weak.clone(), weak);
            let (b1, b2, b3) = (
                brick_id.to_owned(),
                brick_id.to_owned(),
                brick_id.to_owned(),
            );
            (
                move |values: &[RowValue]| {
                    if let Some(inner) = w1.upgrade() {
                        inner.loop_values(&b1, token, values);
                    }
                },
                move |error: &TelemetryError| {
                    if let Some(inner) = w2.upgrade() {
                        inner.loop_error(&b2, token, error);
                    }
                },
                move |ms: f64| {
                    if let Some(inner) = w3.upgrade() {
                        inner.loop_round_trip(&b3, token, ms);
                    }
                },
            )
        };
        BrickTelemetry::new(BrickTelemetryOptions {
            sender,
            brick_id: brick_id.to_owned(),
            rows: Some(rows),
            tick_period_ms: Some(period_ms),
            // The plan's floor, override included: retiming clamps to the floor the plan used.
            floor_ms: Some(floor_ms),
            on_values: Some(Arc::new(on_values)),
            on_error: Some(Arc::new(on_error)),
            on_round_trip: Some(Arc::new(on_round_trip)),
            clock: self.clock,
        })
    }

    fn is_current(&self, state: &State, brick_id: &str, token: u64) -> bool {
        state
            .loops
            .get(brick_id)
            .is_some_and(|running| running.token == token)
    }

    fn gate(&self, brick_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.lock()
            .gates
            .entry(brick_id.to_owned())
            .or_default()
            .clone()
    }

    fn loop_values(&self, brick_id: &str, token: u64, values: &[RowValue]) {
        {
            let mut state = self.lock();
            if !self.is_current(&state, brick_id, token) {
                return;
            }
            self.note_program(&mut state, brick_id, values);
            self.events.push(TelemetryEvent::Values {
                brick_id: brick_id.to_owned(),
                values: values.to_vec(),
            });
        }
        self.events.drain();
    }

    /// A retired loop's refused frame is not a failure anyone needs to hear about.
    fn loop_error(&self, brick_id: &str, token: u64, error: &TelemetryError) {
        {
            let state = self.lock();
            if !self.is_current(&state, brick_id, token) {
                return;
            }
            self.events.push(TelemetryEvent::Error {
                brick_id: brick_id.to_owned(),
                error: error.clone(),
            });
        }
        self.events.drain();
    }

    /// One frame's round trip, to its brick's throttle; a retired loop's is not this link's
    /// evidence.
    fn loop_round_trip(&self, brick_id: &str, token: u64, ms: f64) {
        {
            let mut state = self.lock();
            if !self.is_current(&state, brick_id, token) {
                return;
            }
            let changed = state
                .loops
                .get_mut(brick_id)
                .and_then(|running| running.throttle.as_mut())
                .is_some_and(|throttle| throttle.observe(ms));
            if changed {
                self.apply_throttle(&mut state, brick_id);
            }
        }
        self.events.drain();
    }

    /// Ends every claim on a brick whose sign-in went, and says which ended.
    fn end_claims(&self, state: &mut State, brick_id: &str) {
        let Some(mut claims) = state.claims.remove(brick_id) else {
            return;
        };
        let ended: HashSet<u64> = claims.end_all().into_iter().collect();
        let mut handles: Vec<String> = state
            .handles
            .iter()
            .filter(|(_, (brick, inner))| brick == brick_id && ended.contains(inner))
            .map(|(handle, _)| handle.clone())
            .collect();
        handles.sort_by_key(|handle| {
            handle
                .rsplit('-')
                .next()
                .and_then(|n| n.parse::<u64>().ok())
                .unwrap_or(0)
        });
        for handle in &handles {
            state.handles.remove(handle);
        }
        if !handles.is_empty() {
            self.events.push(TelemetryEvent::ClaimsEnded {
                brick_id: brick_id.to_owned(),
                handles,
            });
        }
    }

    fn stop_for(&self, state: &mut State, brick_id: &str) {
        let Some(running) = state.loops.remove(brick_id) else {
            return;
        };
        running.telemetry.dispose();
        self.announce(state, brick_id, Intervals::new());
    }

    /// Moves a loop's tick to the plan's times the factor, and says so: in the plan and to the
    /// display.
    fn apply_throttle(&self, state: &mut State, brick_id: &str) {
        self.apply_period(state, brick_id);
        if let Some(running) = state.loops.get(brick_id) {
            self.events.push(TelemetryEvent::ThrottleChanged {
                brick_id: brick_id.to_owned(),
                state: state_of(running),
            });
        }
    }

    /// The one place a loop's tick is worked out: the plan's, times the throttle's factor, and
    /// while a program runs no faster than the preset's floor. The plan's readers hear the
    /// intervals.
    fn apply_period(&self, state: &mut State, brick_id: &str) {
        let floor = state
            .program_preset
            .map_or(0.0, |preset| preset.program_running_tick_ms);
        let Some(running) = state.loops.get(brick_id) else {
            return;
        };
        let factor = running.throttle.as_ref().map_or(1.0, TickThrottle::factor);
        let mut period = running.base_period_ms * factor;
        if running.program_running && floor > 0.0 {
            period = period.max(floor);
        }
        let telemetry = running.telemetry.clone();
        if telemetry.tick_period_ms() != period {
            // A positive tick always: the plan's tick is, and so is any factor of it.
            let _ = telemetry.set_period(period);
        }
        self.announce(state, brick_id, intervals_of(&telemetry));
    }

    /// Learns from a frame whether a program runs, and retimes the loop when that changed.
    fn note_program(&self, state: &mut State, brick_id: &str, values: &[RowValue]) {
        let Some(Reading::Flag(running_now)) = values
            .iter()
            .find(|value| value.row_id == PROGRAM_RUNNING_ROW)
            .map(|value| &value.value)
        else {
            return;
        };
        let Some(running) = state.loops.get_mut(brick_id) else {
            return;
        };
        if running.program_running == *running_now {
            return;
        }
        running.program_running = *running_now;
        self.apply_period(state, brick_id);
    }

    /// Tells the readers what a brick is read for now, if that differs from what they were told.
    fn announce(&self, state: &mut State, brick_id: &str, intervals: Intervals) {
        let before = state.announced.get(brick_id).cloned().unwrap_or_default();
        if before == intervals {
            return;
        }
        if intervals.is_empty() {
            state.announced.remove(brick_id);
        } else {
            state
                .announced
                .insert(brick_id.to_owned(), intervals.clone());
        }
        self.events.push(TelemetryEvent::PlanChanged {
            brick_id: brick_id.to_owned(),
            intervals,
        });
    }
}

/// How often each row of a loop comes now: its divider times the loop's tick, `Once` for a
/// one-shot.
fn intervals_of(telemetry: &BrickTelemetry) -> Intervals {
    let tick = telemetry.tick_period_ms();
    telemetry
        .rows()
        .into_iter()
        .filter_map(|row| match row.lifetime {
            Lifetime::Repeating { divider } => {
                Some((row.id, RowRate::Every(f64::from(divider) * tick)))
            }
            Lifetime::OneShot => Some((row.id, RowRate::Once)),
            Lifetime::Off => None,
        })
        .collect()
}

fn state_of(running: &RunningLoop) -> BrickThrottleState {
    BrickThrottleState {
        throttle: running.throttle.as_ref().map_or(
            ThrottleState {
                factor: 1.0,
                limit_ms: 0.0,
                p95_ms: None,
                stalls: 0,
                window_samples: 0,
            },
            TickThrottle::state,
        ),
        base_period_ms: running.base_period_ms,
        period_ms: running.telemetry.tick_period_ms(),
    }
}

/// The brick layer as one loop sees it: its frames take turns with every other loop of the brick.
struct LoopSender {
    service: Weak<Inner>,
    brick_id: String,
    token: u64,
}

impl LoopSender {
    fn retired(&self) -> TelemetryError {
        TelemetryError::SubscriptionFailed(format!(
            "Telemetry loop for {} was retired before its frame went out.",
            self.brick_id
        ))
    }
}

#[async_trait]
impl TelemetrySender for LoopSender {
    async fn send(
        &self,
        brick_id: &str,
        command: BrickCommand,
    ) -> Result<BrickResponse, TelemetryError> {
        let Some(inner) = self.service.upgrade() else {
            return Err(self.retired());
        };
        let gate = inner.gate(&self.brick_id);
        let _turn = gate.lock().await;
        // Stopping the service stops every loop, so this covers a disposed service too.
        if !inner.is_current(&inner.lock(), &self.brick_id, self.token) {
            return Err(self.retired());
        }
        let host = inner.host.clone();
        drop(inner);
        host.send(brick_id, command).await
    }

    fn max_packet_bytes(&self, brick_id: &str) -> Option<usize> {
        self.service
            .upgrade()
            .and_then(|inner| inner.host.max_packet_bytes(brick_id))
    }

    fn transport_of(&self, brick_id: &str) -> Option<Transport> {
        self.service
            .upgrade()
            .and_then(|inner| inner.host.transport_of(brick_id))
    }
}

/// Follows the brick layer's events: each one refreshes the bricks it names, and a listener that
/// fell behind refreshes every brick the service knows. Stops when the returned handle is aborted.
///
/// Every brick signed in by now is refreshed once after subscribing, so a route that changed
/// between the service's start and this call is not missed.
pub fn follow_bricks(service: &TelemetryService, bricks: &BrickManager) -> AbortHandle {
    let mut events = bricks.subscribe();
    for brick in bricks.signed_in_bricks() {
        service.refresh(&brick);
    }
    let weak = Arc::downgrade(&service.inner);
    let bricks = bricks.clone();
    tokio::spawn(async move {
        loop {
            let event = events.recv().await;
            let Some(inner) = weak.upgrade() else { return };
            let service = TelemetryService { inner };
            match event {
                Ok(
                    BrickEvent::RouteChanged { brick_id, .. }
                    | BrickEvent::SignInEnded { brick_id },
                ) => {
                    service.refresh(&brick_id);
                }
                Ok(BrickEvent::ActiveBrickChanged { previous, current }) => {
                    for brick in previous.iter().chain(current.iter()) {
                        service.refresh(brick);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let mut known: HashSet<String> =
                        bricks.signed_in_bricks().into_iter().collect();
                    {
                        let state = service.lock();
                        known.extend(state.loops.keys().cloned());
                        known.extend(state.claims.keys().cloned());
                        known.extend(state.read.iter().cloned());
                    }
                    for brick in known {
                        service.refresh(&brick);
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    })
    .abort_handle()
}
