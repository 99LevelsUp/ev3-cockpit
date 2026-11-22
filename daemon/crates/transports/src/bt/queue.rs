//! The Bluetooth connection queue: every operation that pages the radio (opening a connection,
//! pairing, a presence check, an inquiry) takes its turn here, so two of them never page it at
//! once.
//!
//! It serialises *opening*, not holding. The host holds two sessions to two bricks at once, so a
//! caller releases its slot as soon as the connection is open; a session that kept the slot for
//! its whole life only stopped a second brick from connecting at all.
//!
//! Grants are spaced: an ordinary gap after a release, and a longer recovery, doubling up to a
//! ceiling, after a release that failed. Windows carries one RFCOMM channel, and a failed attempt
//! leaves it unsettled for far longer than a clean close does (about 10 s against 30 s).
//!
//! All timing runs on tokio's clock, so a paused test clock drives every pause here.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::{Instant, sleep_until};

use crate::bt::normalise_mac;
use crate::error::TransportError;

/// Gap after a release before the next grant.
pub const INTER_CONNECTION_COOLDOWN: Duration = Duration::from_secs(15);
/// Recovery after a failed release; doubles with each failure in a row, up to
/// [`ERROR_BACKOFF_MAX`].
pub const ERROR_RECOVERY_COOLDOWN: Duration = Duration::from_secs(30);
/// Ceiling of the recovery after failures in a row.
pub const ERROR_BACKOFF_MAX: Duration = Duration::from_secs(30);
/// How long a waiter waits while another operation holds the slot before it fails with a stated
/// reason. A pairing that waits for a person at the brick can hold the slot that long.
pub const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(45);
/// Gap between closing a brick's connection and connecting to it again. A connect 0-2 s after a
/// clean close failed at once with WSA 10064 every time it was tried; from 5 s on it opened.
pub const RECONNECT_GAP_AFTER_CLOSE: Duration = Duration::from_secs(5);
/// How long after a daemon starts its first connect to a brick may meet the close of the daemon it
/// replaced. That one closed its links moments before, and when is not known.
pub const STARTUP_BUSY_WINDOW: Duration = Duration::from_secs(5);

/// The queue's pauses. [`Default`] is what ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueTimings {
    pub inter_connection_cooldown: Duration,
    pub error_recovery_cooldown: Duration,
    pub error_backoff_max: Duration,
    pub acquire_timeout: Duration,
}

impl Default for QueueTimings {
    fn default() -> Self {
        Self {
            inter_connection_cooldown: INTER_CONNECTION_COOLDOWN,
            error_recovery_cooldown: ERROR_RECOVERY_COOLDOWN,
            error_backoff_max: ERROR_BACKOFF_MAX,
            acquire_timeout: ACQUIRE_TIMEOUT,
        }
    }
}

/// What a slot is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    /// An operation that opens something on the radio: a connection or a pairing. Its release
    /// starts the gap, and a failed release the recovery.
    Open,
    /// Mutual exclusion only: the release starts no gap and counts no error.
    ///
    /// For the background presence checks and inquiry. They must not run beside a connect, but
    /// the pauses were set for RFCOMM opens: armed by a background check, one round over three
    /// paired bricks would hold every user connect behind it for about a minute. A check that
    /// goes unanswered is a result, not a failure.
    HoldOnly,
}

#[derive(Debug, Default)]
struct State {
    active: bool,
    last_release: Option<Instant>,
    last_error: Option<Instant>,
    consecutive_errors: u32,
    waiters: VecDeque<u64>,
    next_waiter: u64,
    disposed: bool,
}

impl State {
    /// How long the pauses still keep the slot closed.
    fn delay(&self, timings: &QueueTimings, now: Instant) -> Duration {
        let mut wait = Duration::ZERO;
        if let Some(released) = self.last_release {
            let gap = timings.inter_connection_cooldown;
            wait = wait.max(gap.saturating_sub(now.saturating_duration_since(released)));
        }
        if let (true, Some(failed)) = (self.consecutive_errors > 0, self.last_error) {
            let doublings = self.consecutive_errors.saturating_sub(1).min(31);
            let backoff = timings
                .error_recovery_cooldown
                .saturating_mul(1u32 << doublings)
                .min(timings.error_backoff_max);
            wait = wait.max(backoff.saturating_sub(now.saturating_duration_since(failed)));
        }
        wait
    }
}

/// The serialised queue. One slot; grants spaced by the pauses above.
#[derive(Debug)]
pub struct BtConnectionQueue {
    timings: QueueTimings,
    state: Mutex<State>,
    changed: Notify,
}

impl Default for BtConnectionQueue {
    fn default() -> Self {
        Self::new(QueueTimings::default())
    }
}

impl BtConnectionQueue {
    pub fn new(timings: QueueTimings) -> Self {
        Self {
            timings,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        }
    }

    pub fn timings(&self) -> QueueTimings {
        self.timings
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Waits for the slot.
    ///
    /// Fails with a stated reason when another operation keeps the slot for longer than the
    /// acquire timeout, rather than queueing indefinitely. The pause after a release never fails
    /// the wait: while the slot is free and only a pause keeps it closed, the wait goes on, and
    /// the grant follows when the pause ends. A slot held 23 s and released with an error is
    /// followed by a 30 s pause, and the waiter is granted after it.
    ///
    /// Dropping the returned future leaves the queue as if it had never been called.
    pub async fn acquire(
        self: &Arc<Self>,
        brick_id: &str,
        kind: SlotKind,
    ) -> Result<Slot, TransportError> {
        let id = {
            let mut state = self.lock();
            if state.disposed {
                return Err(disposed());
            }
            let id = state.next_waiter;
            state.next_waiter += 1;
            state.waiters.push_back(id);
            id
        };
        let mut waiting = Waiting {
            queue: self,
            id,
            armed: true,
        };
        let mut deadline = Instant::now() + self.timings.acquire_timeout;
        loop {
            // Created before the state is read, so a release between the read and the wait is
            // not missed: `notify_waiters` reaches every `Notified` that exists.
            let notified = self.changed.notified();
            let now = Instant::now();
            let wake = {
                let mut state = self.lock();
                if state.disposed {
                    return Err(disposed());
                }
                let mut wake = None;
                if state.waiters.front() == Some(&id) && !state.active {
                    let delay = state.delay(&self.timings, now);
                    if delay.is_zero() {
                        state.waiters.pop_front();
                        state.active = true;
                        waiting.armed = false;
                        return Ok(Slot {
                            queue: Arc::clone(self),
                            kind,
                            released: false,
                        });
                    }
                    wake = Some(now + delay);
                }
                if now >= deadline {
                    if !state.active {
                        // The slot is free; only a pause keeps it closed, and the grant follows
                        // when it ends. Failing here would blame a busy radio that is idle.
                        deadline =
                            now + state.delay(&self.timings, now) + self.timings.acquire_timeout;
                        continue;
                    }
                    return Err(TransportError::transport_failed(format!(
                        "BT connection queue timed out after {} ms waiting for a slot for {brick_id} \
                         (1/1 in use). Bluetooth is busy opening another connection or pairing a \
                         brick; try again once that has finished.",
                        self.timings.acquire_timeout.as_millis()
                    )));
                }
                wake
            };
            let until = wake.map_or(deadline, |at| at.min(deadline));
            tokio::select! {
                () = notified => {}
                () = sleep_until(until) => {}
            }
        }
    }

    /// Runs `task` within a slot, released when it ends: as failed when it returns an error.
    pub async fn enqueue<T, F>(
        self: &Arc<Self>,
        brick_id: &str,
        task: F,
    ) -> Result<T, TransportError>
    where
        F: Future<Output = Result<T, TransportError>>,
    {
        let slot = self.acquire(brick_id, SlotKind::Open).await?;
        let result = task.await;
        slot.release(result.is_err());
        result
    }

    /// Waiters not yet granted.
    pub fn pending(&self) -> usize {
        self.lock().waiters.len()
    }

    /// Slots in use: 0 or 1.
    pub fn active(&self) -> usize {
        usize::from(self.lock().active)
    }

    /// Fails every waiter and every later acquire.
    pub fn dispose(&self) {
        let mut state = self.lock();
        state.disposed = true;
        state.waiters.clear();
        drop(state);
        self.changed.notify_waiters();
    }

    fn release_slot(&self, kind: SlotKind, failed: bool) {
        let mut state = self.lock();
        state.active = false;
        if kind == SlotKind::Open {
            let now = Instant::now();
            state.last_release = Some(now);
            if failed {
                state.consecutive_errors = state.consecutive_errors.saturating_add(1);
                state.last_error = Some(now);
            } else {
                state.consecutive_errors = 0;
            }
        }
        drop(state);
        self.changed.notify_waiters();
    }

    fn withdraw(&self, id: u64) {
        let mut state = self.lock();
        state.waiters.retain(|waiter| *waiter != id);
        drop(state);
        self.changed.notify_waiters();
    }
}

fn disposed() -> TransportError {
    TransportError::transport_failed("BT connection queue disposed.")
}

/// Takes a waiter out of the line when its acquire is dropped or fails.
struct Waiting<'a> {
    queue: &'a BtConnectionQueue,
    id: u64,
    armed: bool,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.queue.withdraw(self.id);
        }
    }
}

/// A granted slot. Release it once the operation it was for has finished, saying whether it
/// failed.
///
/// Dropped without a release, an [`SlotKind::Open`] slot counts as failed: the operation was
/// abandoned part way and may have left the radio unsettled, which the longer recovery covers.
#[derive(Debug)]
pub struct Slot {
    queue: Arc<BtConnectionQueue>,
    kind: SlotKind,
    released: bool,
}

impl Slot {
    pub fn kind(&self) -> SlotKind {
        self.kind
    }

    /// Gives the slot back. `failed` starts the longer recovery; a hold-only slot ignores it.
    pub fn release(mut self, failed: bool) {
        self.released = true;
        self.queue.release_slot(self.kind, failed);
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        if !self.released {
            self.released = true;
            self.queue.release_slot(self.kind, true);
        }
    }
}

/// When each brick's connection was last closed, so the next connect to it waits out
/// [`RECONNECT_GAP_AFTER_CLOSE`]. Per brick: other bricks are not held.
///
/// Waited before taking the queue slot, so no other brick waits behind it.
#[derive(Debug)]
pub struct ReconnectGap {
    gap: Duration,
    closed_at: Mutex<HashMap<String, Instant>>,
}

impl Default for ReconnectGap {
    fn default() -> Self {
        Self::new(RECONNECT_GAP_AFTER_CLOSE)
    }
}

impl ReconnectGap {
    pub fn new(gap: Duration) -> Self {
        Self {
            gap,
            closed_at: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Instant>> {
        self.closed_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Notes that the connection to `mac` was closed now.
    pub fn note_closed(&self, mac: &str) {
        self.lock().insert(normalise_mac(mac), Instant::now());
    }

    /// Drops what is known about `mac`: a forgotten brick is not held back.
    pub fn forget(&self, mac: &str) {
        self.lock().remove(&normalise_mac(mac));
    }

    /// When a connect to `mac` may go, if it has to wait.
    pub fn ready_at(&self, mac: &str) -> Option<Instant> {
        let closed = *self.lock().get(&normalise_mac(mac))?;
        let at = closed + self.gap;
        (at > Instant::now()).then_some(at)
    }

    /// Waits until a connect to `mac` may go.
    pub async fn wait(&self, mac: &str) {
        if let Some(at) = self.ready_at(mac) {
            sleep_until(at).await;
        }
    }
}

/// A new daemon's first connect to each brick, in the first [STARTUP_BUSY_WINDOW] after it
/// started: the daemon it replaced closed its Bluetooth links moments before, at a time this one
/// does not know, so a connect refused as busy may only be early.
#[derive(Debug)]
pub struct StartupGrace {
    until: Instant,
    tried: Mutex<HashSet<String>>,
}

impl StartupGrace {
    /// A grace of window from started. A zero window never grants one.
    pub fn new(started: Instant, window: Duration) -> Self {
        Self {
            until: started + window,
            tried: Mutex::new(HashSet::new()),
        }
    }

    /// Called as a connect to mac begins. For the first one inside the window, the instant the
    /// window ends, which is when a busy refusal may be tried again; otherwise None.
    pub fn first_connect(&self, mac: &str) -> Option<Instant> {
        if Instant::now() >= self.until {
            return None;
        }
        let first = self
            .tried
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(normalise_mac(mac));
        first.then_some(self.until)
    }
}
