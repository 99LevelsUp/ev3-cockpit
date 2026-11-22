//! Running, stopping and watching the program on one brick.
//!
//! Programs run in the user slot, as the brick's own file browser runs them, so the brick's
//! clean-up of motors and sound applies when they end.
//!
//! The firmware refuses a start into a running slot without saying so (`lms2012.c` 3002–3030), and
//! a loaded image whose start was refused stays allocated. So a start asks first and refuses with
//! [`ProgramError::Running`] unless the caller asked to replace the running program, and afterwards
//! confirms the start by asking again. Emergency stop is the brick's own power-off sequence, never
//! `PROGRAM_STOP(0)`, which stops the brick's UI and ends its VM.
//!
//! One [`ProgramService`] per brick, shared by every client: a stop from anyone cancels every start
//! asked before it whose command has not gone out, so no program starts after a stop was asked.
//! Starts take turns, so two callers cannot both pass the check and race their starts, the second
//! refused in silence. Stops never wait for a start's turn.
//!
//! The brick does not say when a program ends, so its state is followed, and only while someone
//! listens: through the telemetry row `program.user.running` ([`ProgramRows`]), which rides in the
//! frame a read brick sends anyway, instead of a poll of this service's own. Following ends with
//! the brick's session, as every telemetry claim does.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use ev3_contract::{ErrorCode, StartOutcome};
use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_transports::BrickKey;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::bricks::{BrickError, BrickManager, CommandOptions};
use crate::fs::{FsError, WriteReporter, kind_of, may_have_run};
use crate::ports::{ActivityPort, Requester, WriteScope};
use crate::telemetry::ev3_rows::PROGRAM_RUNNING_ROW;
use crate::telemetry::{
    ClaimRequest, ReadModelChange, ReadValue, Reading, TelemetryError, TelemetryEvent,
    TelemetryReadModel, TelemetryService,
};
use crate::transfer::CancelFlag;

/// How long a start may take to show the program running before it counts as not seen: a start
/// shows within a second on every transport.
pub const DEFAULT_CONFIRM_TIMEOUT: Duration = Duration::from_millis(1500);
/// The gap between the confirmation's questions.
pub const DEFAULT_CONFIRM_STEP: Duration = Duration::from_millis(100);

// ── Errors ──────────────────────────────────────────────────────────

/// A program operation that did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgramError {
    /// A program runs in the user slot; the firmware would refuse a start in silence.
    /// `deploying`: refused before any file was put on the brick.
    Running { deploying: bool },
    /// The brick loaded nothing: there is no program at the path.
    NotFound { path: String },
    /// A stop or an emergency stop, from anyone, came first: nothing was started.
    Stopped {
        /// Who stopped the brick, as they named themselves.
        stopped_by: Option<String>,
        /// The stop ended a deployment, possibly before all of its files were put on the brick.
        deploying: bool,
    },
    /// The caller cancelled its own request before the start went out. Nothing was stopped.
    Cancelled,
    /// The request cannot be carried out as given; nothing was sent.
    Invalid(String),
    /// A command failed: refused before it left, lost with the link, or answered with an error.
    Command(BrickError),
    /// A file of a deployment could not be checked or put on the brick.
    Files(FsError),
    /// The brick answered with a reply of another kind.
    Protocol(String),
    /// The program's state cannot be followed.
    Subscription(String),
    /// Telemetry refused the claim that follows the program's state.
    Telemetry(TelemetryError),
}

impl ProgramError {
    /// The contract code of a refusal this module makes; `None` for a brick or file failure,
    /// whose code comes from the error it carries.
    pub fn code(&self) -> Option<ErrorCode> {
        match self {
            Self::Running { .. } => Some(ErrorCode::ProgramRunning),
            Self::NotFound { .. } => Some(ErrorCode::ProgramNotFound),
            Self::Stopped { .. } | Self::Cancelled => Some(ErrorCode::Cancelled),
            Self::Invalid(_) => Some(ErrorCode::InvalidRequest),
            Self::Protocol(_) => Some(ErrorCode::ProtocolFailed),
            Self::Subscription(_) => Some(ErrorCode::SubscriptionFailed),
            Self::Telemetry(error) => Some(error.code()),
            Self::Command(_) | Self::Files(_) => None,
        }
    }

    /// Who stopped the brick, when a stop ended the operation.
    pub fn stopped_by(&self) -> Option<&str> {
        match self {
            Self::Stopped { stopped_by, .. } => stopped_by.as_deref(),
            _ => None,
        }
    }
}

impl fmt::Display for ProgramError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Running { deploying: false } => f.write_str(
                "A program is running on the brick. Stop it first, or ask to replace it.",
            ),
            Self::Running { deploying: true } => f.write_str(
                "A program is running on the brick: stop it first. Nothing was put on the brick.",
            ),
            Self::NotFound { path } => write!(f, "No program at {path} on the brick."),
            Self::Stopped {
                stopped_by,
                deploying: false,
            } => match stopped_by {
                Some(who) => write!(
                    f,
                    "{who} stopped the brick first: the program was not started."
                ),
                None => f.write_str("The brick was stopped first: the program was not started."),
            },
            Self::Stopped {
                stopped_by,
                deploying: true,
            } => write!(
                f,
                "{} stopped the brick: nothing more was put on it and the program was not \
                 started.",
                stopped_by.as_deref().unwrap_or("Someone")
            ),
            Self::Cancelled => f.write_str("Cancelled: the program was not started."),
            Self::Invalid(message) | Self::Protocol(message) | Self::Subscription(message) => {
                f.write_str(message)
            }
            Self::Command(error) => error.fmt(f),
            Self::Files(error) => error.fmt(f),
            Self::Telemetry(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ProgramError {}

impl From<BrickError> for ProgramError {
    fn from(error: BrickError) -> Self {
        Self::Command(error)
    }
}

// ── Reaching the brick ──────────────────────────────────────────────

/// How the program service reaches its brick.
#[async_trait]
pub trait ProgramLink: Send + Sync {
    /// Sends one command. With `route_deadline`, a brick that has no route now is waited for until
    /// then before the command goes out; without, the command fails at once.
    async fn send(
        &self,
        command: &BrickCommand,
        route_deadline: Option<Instant>,
    ) -> Result<BrickResponse, BrickError>;

    /// Waits until the brick has a route, or `deadline` passes.
    async fn wait_for_route(&self, deadline: Instant) -> Result<(), BrickError>;

    /// The channel commands go over now, for the write reports; `None` with no route.
    fn channel(&self) -> Option<BrickKey>;
}

/// One brick of a brick layer, over its best channel at each command.
pub struct BrickProgramLink {
    bricks: BrickManager,
    brick_id: String,
}

impl BrickProgramLink {
    pub fn new(bricks: BrickManager, brick_id: impl Into<String>) -> Self {
        Self {
            bricks,
            brick_id: brick_id.into(),
        }
    }
}

#[async_trait]
impl ProgramLink for BrickProgramLink {
    async fn send(
        &self,
        command: &BrickCommand,
        route_deadline: Option<Instant>,
    ) -> Result<BrickResponse, BrickError> {
        let options = CommandOptions {
            timeout: None,
            deadline: route_deadline,
        };
        self.bricks.send(&self.brick_id, command, options).await
    }

    async fn wait_for_route(&self, deadline: Instant) -> Result<(), BrickError> {
        self.bricks
            .wait_for_route(&self.brick_id, Some(deadline))
            .await
            .map(|_| ())
    }

    fn channel(&self) -> Option<BrickKey> {
        self.bricks.route_of(&self.brick_id)
    }
}

// ── Following the state ─────────────────────────────────────────────

/// Hears a program state with when it was sampled, in milliseconds since the Unix epoch.
pub type StateSink = Arc<dyn Fn(bool, u64) + Send + Sync>;
/// Hears that the brick's session ended a follow.
pub type EndSink = Arc<dyn Fn() + Send + Sync>;

/// A follow in progress; it ends when dropped.
pub struct Following {
    end: Option<Box<dyn FnOnce() + Send>>,
}

impl Following {
    pub fn new(end: impl FnOnce() + Send + 'static) -> Self {
        Self {
            end: Some(Box::new(end)),
        }
    }
}

impl Drop for Following {
    fn drop(&mut self) {
        if let Some(end) = self.end.take() {
            end();
        }
    }
}

/// How a brick's program state is followed for the service's listeners.
pub trait ProgramFollow: Send + Sync {
    /// Starts following: `on_state` hears each state with when it was sampled, `on_ended` that the
    /// brick's session ended the follow. Fails when the brick cannot be followed.
    fn follow(&self, on_state: StateSink, on_ended: EndSink) -> Result<Following, ProgramError>;
}

// ── The service ─────────────────────────────────────────────────────

/// How a [`ProgramService`] confirms a start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgramOptions {
    pub confirm_timeout: Duration,
    pub confirm_step: Duration,
}

impl Default for ProgramOptions {
    fn default() -> Self {
        Self {
            confirm_timeout: DEFAULT_CONFIRM_TIMEOUT,
            confirm_step: DEFAULT_CONFIRM_STEP,
        }
    }
}

/// A point in a brick's stops: a start given it does not go out when any stop came after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopMark(u64);

/// Whether a stop came after a mark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopsSince {
    pub stopped: bool,
    /// Who asked the last stop, when one came.
    pub stopped_by: Option<String>,
}

/// How one start runs.
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    /// Stop a running program first, rather than refuse.
    pub replace: bool,
    /// The start does not go out when any stop came after this mark. `None`: the mark is taken
    /// when the start is asked.
    pub since: Option<StopMark>,
    /// The operation's deadline: the status questions, and the wait before the start goes out,
    /// wait out a lost route until then. The start's own send never waits.
    pub deadline: Option<Instant>,
    /// The caller's own cancel: checked right before the start goes out. Stops nothing.
    pub cancel: Option<CancelFlag>,
}

#[derive(Default)]
struct Stops {
    count: u64,
    last: Option<String>,
}

struct Listener {
    sender: mpsc::UnboundedSender<bool>,
    ended: Arc<AtomicBool>,
}

#[derive(Default)]
struct FollowState {
    /// The last state seen; `None` before the first answer.
    known: Option<bool>,
    /// When the last state taken was sampled: an older one is not taken.
    known_at: u64,
    listeners: HashMap<u64, Listener>,
    next_listener: u64,
    /// The follow running for the listeners, while there are any.
    following: Option<Following>,
    /// The follow whose callbacks count; a newer one, or none, leaves older callbacks unheard.
    generation: u64,
    /// A follow being made: its callbacks count already, so the state it tells at once is heard.
    starting: Option<u64>,
    disposed: bool,
}

struct Inner {
    link: Arc<dyn ProgramLink>,
    options: ProgramOptions,
    follow: Option<Arc<dyn ProgramFollow>>,
    activity: Option<Arc<dyn ActivityPort>>,
    /// The starts' turn: one start at a time, a failed one not blocking the next.
    turn: tokio::sync::Mutex<()>,
    /// Held by a start across its last check for a stop and its own send, and by a stop while it
    /// counts itself: a stop counted after that check reaches the brick after the start, and so
    /// ends the program, never before it.
    gate: tokio::sync::Mutex<()>,
    stops: Mutex<Stops>,
    state: Mutex<FollowState>,
    /// Serialises making and replacing the follow; never held by a follow's callbacks.
    follow_start: Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Runs, stops and follows the program on one brick. Cheap to clone; clones share the brick's
/// stops, turn and listeners.
#[derive(Clone)]
pub struct ProgramService {
    inner: Arc<Inner>,
}

impl ProgramService {
    /// `follow` is how the state is followed for listeners (the program row in the daemon);
    /// without it a listener is refused. Starts are reported as writes through `activity`.
    pub fn new(
        link: Arc<dyn ProgramLink>,
        options: ProgramOptions,
        follow: Option<Arc<dyn ProgramFollow>>,
        activity: Option<Arc<dyn ActivityPort>>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                link,
                options,
                follow,
                activity,
                turn: tokio::sync::Mutex::new(()),
                gate: tokio::sync::Mutex::new(()),
                stops: Mutex::new(Stops::default()),
                state: Mutex::new(FollowState::default()),
                follow_start: Mutex::new(()),
            }),
        }
    }

    /// Loads an `.rbf` into the user slot, starts it and says how the start ended.
    ///
    /// `Started` once the brick shows it running; `NotSeenRunning` when it never did within the
    /// confirmation window: a short program may have ended already, or the brick refused the start
    /// in silence, and the slot cannot tell the two apart. `Uncertain` when the start's reply was
    /// lost: the brick may have run it, so it is never sent again. A stop that came after the mark
    /// fails it with [`ProgramError::Stopped`], naming who stopped the brick, and nothing starts.
    ///
    /// The mark is taken here, when the start is asked, not when the returned future first runs.
    /// Dropping the future cancels the start; one whose command went out is not called back.
    pub fn start<'a>(
        &'a self,
        path: &'a str,
        requester: &'a Requester,
        options: StartOptions,
    ) -> impl Future<Output = Result<StartOutcome, ProgramError>> + Send + 'a {
        let since = options.since.unwrap_or_else(|| self.stop_mark());
        async move {
            let _turn = self.inner.turn.lock().await;
            self.start_now(path, requester, &options, since).await
        }
    }

    async fn start_now(
        &self,
        path: &str,
        requester: &Requester,
        options: &StartOptions,
        since: StopMark,
    ) -> Result<StartOutcome, ProgramError> {
        let check = || self.check_cancelled(since, options.cancel.as_ref(), false);
        check()?;
        if self.running_until(options.deadline).await? {
            if !options.replace {
                return Err(ProgramError::Running { deploying: false });
            }
            self.stop_now(options.deadline).await?;
        }
        // A lost route is waited out before the last check, never inside the start's own send: a
        // stop pressed while the route was down must not be followed by the start once it is back.
        if let Some(deadline) = options.deadline {
            self.inner.link.wait_for_route(deadline).await?;
        }
        let command = BrickCommand::ProgramRun {
            path: path.to_owned(),
        };
        let _scope;
        let reply = {
            let _gate = self.inner.gate.lock().await;
            check()?;
            // Reported once the start is sure to go out: a start a stop cancelled wrote nothing.
            _scope = self.write_scope(requester, || format!("Starting {path}"));
            match self.inner.link.send(&command, None).await {
                Ok(reply) => reply,
                Err(error) if may_have_run(&error) => return Ok(StartOutcome::Uncertain),
                Err(error) => return Err(error.into()),
            }
        };
        let BrickResponse::ProgramRun { image_bytes } = reply else {
            return Err(unexpected(&command, &reply));
        };
        if image_bytes <= 0 {
            return Err(ProgramError::NotFound {
                path: path.to_owned(),
            });
        }
        let deadline = Instant::now() + self.inner.options.confirm_timeout;
        loop {
            if self.running_until(options.deadline).await? {
                return Ok(StartOutcome::Started);
            }
            if Instant::now() >= deadline {
                return Ok(StartOutcome::NotSeenRunning);
            }
            tokio::time::sleep(self.inner.options.confirm_step).await;
        }
    }

    /// A stop that came after `since` fails the operation; then the caller's own cancel does.
    pub(crate) fn check_cancelled(
        &self,
        since: StopMark,
        cancel: Option<&CancelFlag>,
        deploying: bool,
    ) -> Result<(), ProgramError> {
        let stops = lock(&self.inner.stops);
        if stops.count != since.0 {
            return Err(ProgramError::Stopped {
                stopped_by: stops.last.clone(),
                deploying,
            });
        }
        drop(stops);
        if cancel.is_some_and(CancelFlag::is_cancelled) {
            return Err(ProgramError::Cancelled);
        }
        Ok(())
    }

    fn write_scope(
        &self,
        requester: &Requester,
        what: impl FnOnce() -> String,
    ) -> Option<WriteScope> {
        let port = self.inner.activity.clone()?;
        let channel = self.inner.link.channel()?;
        let writes = WriteReporter {
            port,
            requester: requester.clone(),
        };
        Some(writes.begin(channel, what()))
    }

    /// The point in this brick's stops now: work of several steps that ends in a start takes it
    /// at its first step, so a stop during any step cancels the start.
    pub fn stop_mark(&self) -> StopMark {
        StopMark(lock(&self.inner.stops).count)
    }

    /// Whether a stop came after `mark`, and who asked the last one.
    pub fn stopped_since(&self, mark: StopMark) -> StopsSince {
        let stops = lock(&self.inner.stops);
        let stopped = stops.count != mark.0;
        StopsSince {
            stopped,
            stopped_by: if stopped { stops.last.clone() } else { None },
        }
    }

    /// Who asked the last stop or emergency stop, as they named themselves.
    pub fn last_stopper(&self) -> Option<String> {
        lock(&self.inner.stops).last.clone()
    }

    /// Stops the program in the user slot, at once: not behind a start that is still confirming,
    /// so a stop pressed while another client's start waits reaches the brick then. A start asked
    /// before it and not yet sent does not go out; one already sent is ahead of this stop on the
    /// brick's link, so this stop ends it.
    pub async fn stop(&self, by: &Requester) -> Result<(), ProgramError> {
        self.note_stop(by).await;
        self.stop_now(None).await
    }

    /// The brick's own power-off sequence: the user and debug slots, then every motor. At once, as
    /// a stop is.
    pub async fn emergency_stop(&self, by: &Requester) -> Result<(), ProgramError> {
        self.note_stop(by).await;
        self.inner
            .link
            .send(&BrickCommand::ProgramEmergencyStop, None)
            .await?;
        self.is_running().await?;
        Ok(())
    }

    async fn note_stop(&self, by: &Requester) {
        let _gate = self.inner.gate.lock().await;
        let mut stops = lock(&self.inner.stops);
        stops.count += 1;
        stops.last = Some(by.name.clone());
    }

    async fn stop_now(&self, route_deadline: Option<Instant>) -> Result<(), ProgramError> {
        self.inner
            .link
            .send(&BrickCommand::ProgramStop, route_deadline)
            .await?;
        self.running_until(route_deadline).await?;
        Ok(())
    }

    /// Whether a program runs in the user slot; the listeners hear when that changed.
    pub async fn is_running(&self) -> Result<bool, ProgramError> {
        self.running_until(None).await
    }

    async fn running_until(&self, route_deadline: Option<Instant>) -> Result<bool, ProgramError> {
        let command = BrickCommand::ProgramStatus;
        let reply = self.inner.link.send(&command, route_deadline).await?;
        let BrickResponse::ProgramStatus { running, .. } = reply else {
            return Err(unexpected(&command, &reply));
        };
        self.inner.note(running, now_ms());
        Ok(running)
    }

    /// Hears when a program starts or ends; the state is followed while anyone listens. Fails when
    /// it cannot be followed (no telemetry, or the brick cannot be read) and keeps no listener then.
    ///
    /// Each change is queued for the subscriber, never told inside a telemetry dispatch, and one
    /// subscriber that stops reading costs the others nothing.
    pub fn subscribe(&self) -> Result<ProgramSubscription, ProgramError> {
        let Some(follow) = self.inner.follow.clone() else {
            return Err(ProgramError::Subscription(
                "Following a program needs the cockpit's telemetry, which is not available.".into(),
            ));
        };
        let _making = lock(&self.inner.follow_start);
        let generation = {
            let mut state = lock(&self.inner.state);
            if state.disposed {
                return Err(ProgramError::Subscription(
                    "This brick's program service has been disposed.".into(),
                ));
            }
            if state.following.is_some() {
                None
            } else {
                let generation = state.generation + 1;
                state.starting = Some(generation);
                Some(generation)
            }
        };
        if let Some(generation) = generation {
            let made = self.make_follow(&follow, generation);
            let mut state = lock(&self.inner.state);
            state.starting = None;
            let following = made?;
            state.generation = generation;
            state.following = Some(following);
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        let ended = Arc::new(AtomicBool::new(false));
        let mut state = lock(&self.inner.state);
        let id = state.next_listener;
        state.next_listener += 1;
        state.listeners.insert(
            id,
            Listener {
                sender,
                ended: ended.clone(),
            },
        );
        Ok(ProgramSubscription {
            inner: Arc::downgrade(&self.inner),
            id,
            receiver,
            ended,
        })
    }

    /// Follows again, as when the user changed how often a program is read: the new follow starts
    /// before the old one goes, so nothing falls between; the listeners stay. A brick that cannot
    /// be followed now keeps the old follow.
    pub fn follow_again(&self) {
        let Some(follow) = self.inner.follow.clone() else {
            return;
        };
        let _making = lock(&self.inner.follow_start);
        let generation = {
            let mut state = lock(&self.inner.state);
            if state.following.is_none() || state.disposed {
                return;
            }
            let generation = state.generation + 1;
            state.starting = Some(generation);
            generation
        };
        let made = self.make_follow(&follow, generation);
        let old = {
            let mut state = lock(&self.inner.state);
            state.starting = None;
            match made {
                Ok(following) => {
                    state.generation = generation;
                    state.following.replace(following)
                }
                Err(_) => None,
            }
        };
        drop(old);
    }

    /// Ends every listener and the follow; nothing can listen afterwards.
    pub fn dispose(&self) {
        let following = {
            let mut state = lock(&self.inner.state);
            state.disposed = true;
            state.generation += 1;
            for (_, listener) in state.listeners.drain() {
                listener.ended.store(true, Ordering::SeqCst);
            }
            state.following.take()
        };
        drop(following);
    }

    fn make_follow(
        &self,
        follow: &Arc<dyn ProgramFollow>,
        generation: u64,
    ) -> Result<Following, ProgramError> {
        let weak = Arc::downgrade(&self.inner);
        let on_state: StateSink = Arc::new(move |running, at| {
            if let Some(inner) = weak.upgrade()
                && inner.counts(generation)
            {
                inner.note(running, at);
            }
        });
        let weak = Arc::downgrade(&self.inner);
        let on_ended: EndSink = Arc::new(move || {
            if let Some(inner) = weak.upgrade() {
                inner.session_ended(generation);
            }
        });
        follow.follow(on_state, on_ended)
    }
}

impl Inner {
    fn counts(&self, generation: u64) -> bool {
        let state = lock(&self.state);
        (state.following.is_some() && state.generation == generation)
            || state.starting == Some(generation)
    }

    /// Takes a state sampled `at`, unless a newer one was taken already: a cached reading cannot
    /// undo a confirmed start. The first answer is where things stand, not a change.
    fn note(&self, running: bool, at: u64) {
        let mut state = lock(&self.state);
        if at < state.known_at {
            return;
        }
        state.known_at = at;
        let first = state.known.is_none();
        if state.known == Some(running) {
            return;
        }
        state.known = Some(running);
        if first {
            return;
        }
        for listener in state.listeners.values() {
            // A subscriber that went is removed by its own drop; the others still hear.
            let _ = listener.sender.send(running);
        }
    }

    /// The brick's session ended the follow. Its listeners end with it, as telemetry subscriptions
    /// do: one that subscribes after a reconnect starts a new follow, and a listener of the ended
    /// session is not revived by it.
    fn session_ended(&self, generation: u64) {
        let following = {
            let mut state = lock(&self.state);
            if state.generation != generation || state.following.is_none() {
                return;
            }
            state.generation += 1;
            for (_, listener) in state.listeners.drain() {
                listener.ended.store(true, Ordering::SeqCst);
            }
            state.following.take()
        };
        drop(following);
    }

    fn unsubscribe(&self, id: u64) {
        let following = {
            let mut state = lock(&self.state);
            if state.listeners.remove(&id).is_none() || !state.listeners.is_empty() {
                return;
            }
            // The last listener gone: nobody to follow for.
            state.generation += 1;
            state.following.take()
        };
        drop(following);
    }
}

/// One listener of a brick's program state. Dropping it stops listening, and the follow with the
/// last listener.
pub struct ProgramSubscription {
    inner: Weak<Inner>,
    id: u64,
    receiver: mpsc::UnboundedReceiver<bool>,
    ended: Arc<AtomicBool>,
}

impl ProgramSubscription {
    /// The next change: `true` when a program started, `false` when it ended. `None` once the
    /// brick's session ended the follow or the service was disposed; what was queued before that
    /// is not told.
    pub async fn next(&mut self) -> Option<bool> {
        // An ending drops this listener's sender too, so a wait for a change ends with it.
        if self.ended() {
            return None;
        }
        self.receiver.recv().await
    }

    /// Whether the follow this listener was part of ended.
    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }
}

impl Drop for ProgramSubscription {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            inner.unsubscribe(self.id);
        }
    }
}

fn unexpected(command: &BrickCommand, reply: &BrickResponse) -> ProgramError {
    ProgramError::Protocol(format!(
        "Sent {} but got a {} reply.",
        command.kind(),
        kind_of(reply)
    ))
}

// ── The program row ─────────────────────────────────────────────────

/// Who claims the program row, as the telemetry names a claim's maker.
pub const PROGRAM_ROW_OWNER: &str = "cockpit:programs";

/// What following the program row needs of the telemetry.
pub trait ProgramRowTelemetry: Send + Sync {
    /// Claims rows of a brick; returns the claim's handle.
    fn claim(
        &self,
        brick_id: &str,
        request: &ClaimRequest,
        owner: &str,
    ) -> Result<String, TelemetryError>;
    fn release(&self, handle: &str);
    /// The program row's last value on the brick, if it was read.
    fn program_row(&self, brick_id: &str) -> Option<ReadValue>;
}

/// The daemon's telemetry: the service that claims and the read model that holds the values.
pub struct TelemetrySource {
    pub service: TelemetryService,
    pub read_model: TelemetryReadModel,
}

impl ProgramRowTelemetry for TelemetrySource {
    fn claim(
        &self,
        brick_id: &str,
        request: &ClaimRequest,
        owner: &str,
    ) -> Result<String, TelemetryError> {
        self.service
            .claim(brick_id, request, owner)
            .map(|ticket| ticket.handle)
    }

    fn release(&self, handle: &str) {
        self.service.release(handle);
    }

    fn program_row(&self, brick_id: &str) -> Option<ReadValue> {
        self.read_model.value_of(brick_id, PROGRAM_RUNNING_ROW)
    }
}

/// How often the program row is read, in milliseconds; asked at each follow.
pub type RowInterval = Arc<dyn Fn() -> f64 + Send + Sync>;

struct RowFollow {
    brick_id: String,
    /// `None` while the claim is being made.
    handle: Option<String>,
    /// Claims of the brick that ended while this one was being made.
    ended_early: Vec<String>,
    on_state: StateSink,
    on_ended: EndSink,
}

struct RowsInner {
    telemetry: Arc<dyn ProgramRowTelemetry>,
    follows: Mutex<HashMap<u64, RowFollow>>,
    next: Mutex<u64>,
}

/// Follows bricks' programs through their telemetry row: each follow claims
/// `program.user.running` and hears the read model. A stale or dropped value, or one that is not a
/// state, says nothing about the program and tells nothing.
///
/// The telemetry's listeners cannot be taken back, so this listens once, for every follow, and
/// routes each change to the follows of its brick.
#[derive(Clone)]
pub struct ProgramRows {
    inner: Arc<RowsInner>,
}

impl ProgramRows {
    /// Follows over `telemetry`; changes and ended claims come through
    /// [`ProgramRows::change`] and [`ProgramRows::claims_ended`].
    pub fn new(telemetry: Arc<dyn ProgramRowTelemetry>) -> Self {
        Self {
            inner: Arc::new(RowsInner {
                telemetry,
                follows: Mutex::new(HashMap::new()),
                next: Mutex::new(0),
            }),
        }
    }

    /// Follows over the daemon's telemetry, listening to its read model and its ended claims.
    pub fn over_telemetry(service: TelemetryService, read_model: TelemetryReadModel) -> Self {
        let rows = Self::new(Arc::new(TelemetrySource {
            service: service.clone(),
            read_model: read_model.clone(),
        }));
        let weak = Arc::downgrade(&rows.inner);
        read_model.listen(Arc::new(move |change: &ReadModelChange| {
            if let Some(inner) = weak.upgrade() {
                ProgramRows { inner }.change(change);
            }
        }));
        let weak = Arc::downgrade(&rows.inner);
        service.listen(Arc::new(move |event: &TelemetryEvent| {
            if let (Some(inner), TelemetryEvent::ClaimsEnded { brick_id, handles }) =
                (weak.upgrade(), event)
            {
                ProgramRows { inner }.claims_ended(brick_id, handles);
            }
        }));
        rows
    }

    /// The follow of one brick's program, claiming its row at `interval` ms.
    pub fn follower(
        &self,
        brick_id: impl Into<String>,
        interval: RowInterval,
    ) -> Arc<dyn ProgramFollow> {
        Arc::new(BrickRowFollow {
            rows: self.clone(),
            brick_id: brick_id.into(),
            interval,
        })
    }

    /// Takes one read-model change.
    pub fn change(&self, change: &ReadModelChange) {
        let Some(row) = change
            .rows
            .iter()
            .find(|row| row.row_id == PROGRAM_RUNNING_ROW)
        else {
            return;
        };
        let Some((running, at)) = state_of(row) else {
            return;
        };
        let sinks: Vec<StateSink> = lock(&self.inner.follows)
            .values()
            .filter(|follow| follow.brick_id == change.brick_id && follow.handle.is_some())
            .map(|follow| follow.on_state.clone())
            .collect();
        for sink in sinks {
            sink(running, at);
        }
    }

    /// Takes claims that ended with their brick.
    pub fn claims_ended(&self, brick_id: &str, handles: &[String]) {
        let mut ended: Vec<EndSink> = Vec::new();
        {
            let mut follows = lock(&self.inner.follows);
            follows.retain(|_, follow| {
                if follow.brick_id != brick_id {
                    return true;
                }
                match &follow.handle {
                    None => {
                        follow.ended_early.extend(handles.iter().cloned());
                        true
                    }
                    Some(handle) if handles.contains(handle) => {
                        ended.push(follow.on_ended.clone());
                        false
                    }
                    Some(_) => true,
                }
            });
        }
        for sink in ended {
            sink();
        }
    }
}

/// A running state with when it was sampled; `None` for a value that says nothing.
fn state_of(value: &ReadValue) -> Option<(bool, u64)> {
    match value.value {
        Reading::Flag(running) if !value.stale => Some((running, value.sampled_at)),
        _ => None,
    }
}

struct BrickRowFollow {
    rows: ProgramRows,
    brick_id: String,
    interval: RowInterval,
}

impl ProgramFollow for BrickRowFollow {
    fn follow(&self, on_state: StateSink, on_ended: EndSink) -> Result<Following, ProgramError> {
        let inner = &self.rows.inner;
        // Listening before the claim is made: a claim that ends inside the claim call itself is
        // heard too.
        let id = {
            let mut next = lock(&inner.next);
            *next += 1;
            *next
        };
        lock(&inner.follows).insert(
            id,
            RowFollow {
                brick_id: self.brick_id.clone(),
                handle: None,
                ended_early: Vec::new(),
                on_state: on_state.clone(),
                on_ended,
            },
        );
        let request = ClaimRequest {
            row_ids: vec![PROGRAM_RUNNING_ROW.to_owned()],
            interval_ms: (self.interval)(),
            modes: Default::default(),
        };
        let handle = match inner
            .telemetry
            .claim(&self.brick_id, &request, PROGRAM_ROW_OWNER)
        {
            Ok(handle) => handle,
            Err(error) => {
                lock(&inner.follows).remove(&id);
                return Err(ProgramError::Telemetry(error));
            }
        };
        {
            let mut follows = lock(&inner.follows);
            let early = follows
                .get(&id)
                .is_some_and(|follow| follow.ended_early.contains(&handle));
            if early {
                follows.remove(&id);
                return Err(ProgramError::Subscription(format!(
                    "Brick {} went while its program was being followed.",
                    self.brick_id
                )));
            }
            if let Some(follow) = follows.get_mut(&id) {
                follow.handle = Some(handle.clone());
            }
        }
        if let Some((running, at)) = inner
            .telemetry
            .program_row(&self.brick_id)
            .as_ref()
            .and_then(state_of)
        {
            on_state(running, at);
        }
        let weak = Arc::downgrade(inner);
        Ok(Following::new(move || {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            // Ended by its brick already: the claim went with it.
            if lock(&inner.follows).remove(&id).is_some() {
                inner.telemetry.release(&handle);
            }
        }))
    }
}
