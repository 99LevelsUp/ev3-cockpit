//! One base tick per brick, with integer dividers.
//!
//! A row's cadence is a whole number of ticks: divider 1 is every tick, 5 every fifth. That gives
//! three properties a list of per-row due times firing on the wall clock did not have:
//!
//!  - **At most one frame in flight.** A tick that arrives while the previous frame is still out
//!    is skipped, not queued. Without it a stalled brick lets frames pile up behind the serial
//!    queue until the heartbeat misses its window and trips a reconnect on a brick that is merely
//!    busy. Not a corner case: a brick drawing its own port screen stalls the channel several
//!    times a second, and Bluetooth sustains 10.7 commands a second.
//!  - **The tick is the only clock.** Phase comes from the tick counter, so no row drifts and none
//!    can be pulled forward.
//!  - **A skipped tick is a later sample, never a gap.** The next tick includes every row whose
//!    divider comes up, so a stall costs latency and nothing else.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use ev3_transports::usb::HID_PACKET_BYTES;
use tokio::task::AbortHandle;
use tokio::time::{Instant, MissedTickBehavior};

use super::assembler::{
    AssembledFrame, FrameLimits, assemble_frame, build_telemetry_frame, check_no_mode_conflict,
    parse_frame,
};
use super::clock::WallClock;
use super::error::TelemetryError;
use super::port_state::{PortState, is_readable_type, port_state_of};
use super::row::{Lifetime, Reading, RowValue, TelemetryRow, check_lifetime, comes_up_on_tick};

/// How long a port's readings are withheld after its mode was switched, at most: the firmware's
/// `MAX_DEVICE_BUSY_TIME` (`lms2012.h` 313), the longest a device may stay busy after a mode
/// change.
pub const SETTLE_LIMIT: Duration = Duration::from_millis(1200);

/// Where a scheduler's frames go.
#[async_trait]
pub trait FrameLink: Send + Sync {
    /// Sends one composed frame and returns the reply payload.
    async fn send_frame(&self, payload: Vec<u8>) -> Result<Vec<u8>, TelemetryError>;

    /// The packet budget of the link now. Asked per frame, not once: a session outlives its link,
    /// and a USB brick that comes back on the 64-byte HID fallback keeps the scheduler built for
    /// libusb. Fixed limits would then compose 1024-byte frames for a 64-byte link, and the failure
    /// is silent truncation rather than an error.
    fn frame_limits(&self) -> FrameLimits;
}

/// Hears every row value a frame produced.
pub type ValuesListener = Arc<dyn Fn(&[RowValue]) + Send + Sync>;
/// Hears a frame that failed, so its owner can decide about the link.
pub type ErrorListener = Arc<dyn Fn(&TelemetryError) + Send + Sync>;

pub struct SchedulerOptions {
    pub rows: Vec<TelemetryRow>,
    pub link: Arc<dyn FrameLink>,
    /// Milliseconds between ticks. Throttling moves this and nothing else.
    pub tick_period_ms: f64,
    pub on_values: Option<ValuesListener>,
    pub on_error: Option<ErrorListener>,
    pub clock: WallClock,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SchedulerStats {
    pub ticks: u64,
    pub frames_sent: u64,
    /// Ticks that found the previous frame still out and stood down.
    pub ticks_skipped: u64,
    /// Ticks where every eligible row was gated or retired, so nothing was worth sending.
    pub ticks_empty: u64,
    pub frames_failed: u64,
    /// Rows deferred by truncation and still waiting for a turn.
    pub carried_over: usize,
}

struct State {
    tick: u64,
    in_flight: bool,
    disposed: bool,
    stats: SchedulerStats,
    rows: Vec<TelemetryRow>,
    period_ms: f64,
    /// Rows truncation deferred, which come up again on the next tick.
    carried_over: Vec<TelemetryRow>,
    /// The tick each row waiting since a tick it was not sent on first came due: its lateness.
    due_since: HashMap<String, u64>,
    /// The mode last sent to each port, whatever rows are in the set now: the device stays in it
    /// until a command changes it. Forgotten when the port stops being known.
    commanded_mode: HashMap<String, u8>,
    /// Ports settling after a command switched their mode, with when the settle ends at the
    /// latest. One frame in flight and one mode per port mean a reply always reads the mode being
    /// settled.
    settling: HashMap<String, Instant>,
    /// A row set given while a tick was in flight; applied when that tick ends.
    pending_rows: Option<Vec<TelemetryRow>>,
    /// One-shot rows already read: retired rather than asked twice.
    retired: HashSet<String>,
    /// The last occupancy code seen per port. A value row is gated on it, one tick stale by
    /// construction: a port's type arrives in the same reply as its value. An unknown port is
    /// read, so a cold start does not sit silent; the firmware answers NaN for an empty port,
    /// which is a correct reading. A chain member's unknown port waits for its occupancy.
    occupancy: HashMap<String, u8>,
    /// How many bricks hang below this one, as the chain-depth row last reported.
    chain_depth: Option<u8>,
    timer: Option<AbortHandle>,
}

struct Inner {
    link: Arc<dyn FrameLink>,
    on_values: Option<ValuesListener>,
    on_error: Option<ErrorListener>,
    clock: WallClock,
    state: Mutex<State>,
}

/// Drives telemetry for one brick. Cheap to clone; clones drive the same loop.
///
/// [`TelemetryScheduler::run_tick`] can be driven by hand; [`TelemetryScheduler::start`] drives
/// it on a timer. Nothing in the scheduling depends on which.
#[derive(Clone)]
pub struct TelemetryScheduler {
    inner: Arc<Inner>,
}

/// What one tick did between its locks.
enum Sent {
    Nothing,
    Failed(TelemetryError),
    Values(Vec<RowValue>),
}

impl TelemetryScheduler {
    /// A scheduler over `options.rows`; refuses two modes of one port among them.
    pub fn new(options: SchedulerOptions) -> Result<Self, TelemetryError> {
        check_no_mode_conflict(&options.rows)?;
        check_period(options.tick_period_ms)?;
        Ok(Self {
            inner: Arc::new(Inner {
                link: options.link,
                on_values: options.on_values,
                on_error: options.on_error,
                clock: options.clock,
                state: Mutex::new(State {
                    tick: 0,
                    in_flight: false,
                    disposed: false,
                    stats: SchedulerStats::default(),
                    rows: options.rows,
                    period_ms: options.tick_period_ms,
                    carried_over: Vec::new(),
                    due_since: HashMap::new(),
                    commanded_mode: HashMap::new(),
                    settling: HashMap::new(),
                    pending_rows: None,
                    retired: HashSet::new(),
                    occupancy: HashMap::new(),
                    chain_depth: None,
                    timer: None,
                }),
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether `other` drives the same loop.
    pub fn is_same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// The rows in force: a set given while a tick was in flight counts from when it was given.
    pub fn current_rows(&self) -> Vec<TelemetryRow> {
        let state = self.lock();
        state
            .pending_rows
            .clone()
            .unwrap_or_else(|| state.rows.clone())
    }

    /// Milliseconds between ticks now.
    pub fn tick_period_ms(&self) -> f64 {
        self.lock().period_ms
    }

    pub fn stats(&self) -> SchedulerStats {
        let state = self.lock();
        SchedulerStats {
            carried_over: state.carried_over.len(),
            ..state.stats
        }
    }

    /// The occupancy code a port last reported, if any frame has carried it yet.
    pub fn occupancy_of(&self, port: &str) -> Option<u8> {
        self.lock().occupancy.get(port).copied()
    }

    /// What the port is doing, from its last reported occupancy.
    pub fn port_state(&self, port: &str) -> PortState {
        port_state_of(self.occupancy_of(port))
    }

    /// How many bricks hang below this one, as the telemetry last read it.
    pub fn chain_depth(&self) -> Option<u8> {
        self.lock().chain_depth
    }

    /// Replaces the rows while running. Keeps the tick counter (phase), the occupancy gate and the
    /// retired one-shots; a carried-over row stays only if still wanted, in its new version. A
    /// refused set leaves the old one in place. Given while a tick is in flight, the set is checked
    /// now and takes effect when that tick ends, so the tick finishes the work it began and nothing
    /// it collected outlives the new set.
    pub fn set_rows(&self, rows: Vec<TelemetryRow>) -> Result<(), TelemetryError> {
        let mut ids = HashSet::new();
        for row in &rows {
            check_lifetime(&row.id, row.lifetime)?;
            if !ids.insert(row.id.as_str()) {
                return Err(TelemetryError::InvalidRows(format!(
                    "Row '{}' is in the set twice.",
                    row.id
                )));
            }
        }
        // One mode per port at any time: alternating frames would switch the mode every frame and
        // both rows would read NaN for ever.
        check_no_mode_conflict(&rows)?;
        let mut state = self.lock();
        if state.in_flight {
            state.pending_rows = Some(rows);
        } else {
            apply_rows(&mut state, rows);
        }
        Ok(())
    }

    /// Changes the period: restarts the timer, adds no tick, keeps the count. No floor here: the
    /// scheduler does not know the transport, and the brick loop clamps to it.
    pub fn set_period(&self, ms: f64) -> Result<(), TelemetryError> {
        check_period(ms)?;
        let running = {
            let mut state = self.lock();
            state.period_ms = ms;
            state.timer.is_some()
        };
        if running {
            self.stop();
            self.start();
        }
        Ok(())
    }

    /// Runs a tick every period, from one period from now. Call it inside a tokio runtime.
    pub fn start(&self) {
        let mut state = self.lock();
        if state.timer.is_some() || state.disposed {
            return;
        }
        let period = Duration::from_secs_f64(state.period_ms / 1000.0);
        let weak = Arc::downgrade(&self.inner);
        let task = tokio::spawn(async move {
            let mut ticks = tokio::time::interval_at(Instant::now() + period, period);
            ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                ticks.tick().await;
                let Some(inner) = weak.upgrade() else { return };
                let scheduler = TelemetryScheduler { inner };
                // On a task of its own, so the next tick comes while this frame is still out and
                // stands down, counted, instead of waiting behind it.
                tokio::spawn(async move { scheduler.run_tick().await });
            }
        });
        state.timer = Some(task.abort_handle());
    }

    pub fn stop(&self) {
        if let Some(timer) = self.lock().timer.take() {
            timer.abort();
        }
    }

    /// Stops for good: no tick runs, and a frame still out delivers nothing.
    pub fn dispose(&self) {
        self.lock().disposed = true;
        self.stop();
    }

    /// Composes and sends one frame, unless a frame is already out.
    ///
    /// Advances the tick counter even when it stands down, so a slow brick slips phase rather
    /// than freezing it: a divider-5 row keeps coming up every fifth tick of wall-clock time
    /// whether or not each of those ticks got to send.
    pub async fn run_tick(&self) {
        let (tick, candidates) = {
            let mut state = self.lock();
            if state.disposed {
                return;
            }
            let tick = state.tick;
            state.tick += 1;
            state.stats.ticks = state.tick;
            if state.in_flight {
                // Queueing another frame would put a stale one in front of the heartbeat;
                // standing down costs one sample and nothing else.
                state.stats.ticks_skipped += 1;
                return;
            }
            let limits = self.inner.link.frame_limits();
            let candidates = candidates_for(&state, tick, limits);
            if candidates.is_empty() {
                state.stats.ticks_empty += 1;
                return;
            }
            // One command a tick: every command costs a running program about 2 ms of the brick's
            // VM whatever it carries, so event and static rows ride with the sampled ones.
            state.in_flight = true;
            (tick, candidates)
        };

        let mut carried = Vec::new();
        let sent = self.send_frame(&candidates, &mut carried).await;

        {
            let mut state = self.lock();
            let waiting: HashSet<String> = carried.iter().map(|row| row.id.clone()).collect();
            state.carried_over = carried;
            for row in &candidates {
                if !waiting.contains(&row.id) {
                    state.due_since.remove(&row.id);
                } else {
                    state.due_since.entry(row.id.clone()).or_insert(tick);
                }
            }
        }
        match sent {
            Sent::Nothing => {}
            Sent::Failed(error) => {
                if let Some(listener) = &self.inner.on_error {
                    listener(&error);
                }
            }
            Sent::Values(values) => {
                if let Some(listener) = &self.inner.on_values {
                    listener(&values);
                }
            }
        }
        let mut state = self.lock();
        state.in_flight = false;
        if let Some(pending) = state.pending_rows.take() {
            apply_rows(&mut state, pending);
        }
    }

    /// Composes and sends one frame; what did not fit goes into `carried`.
    async fn send_frame(&self, rows: &[TelemetryRow], carried: &mut Vec<TelemetryRow>) -> Sent {
        let (frame, payload) = {
            let mut state = self.lock();
            // Disposed meanwhile: nothing more goes out.
            if state.disposed {
                return Sent::Nothing;
            }
            // Resolved per frame, not per scheduler: see `FrameLink::frame_limits`.
            let limits = self.inner.link.frame_limits();
            let built = assemble_frame(rows, limits)
                .and_then(|frame| build_telemetry_frame(&frame).map(|payload| (frame, payload)));
            let (frame, payload) = match built {
                Ok(built) => built,
                Err(error) => {
                    state.stats.frames_failed += 1;
                    return Sent::Failed(error);
                }
            };
            carried.extend(frame.deferred.iter().cloned());
            note_modes(&mut state, &frame);
            (frame, payload)
        };

        let reply = self.inner.link.send_frame(payload).await;

        let mut state = self.lock();
        match reply {
            Err(error) => {
                // The command may never have reached the brick: the mode it carried is not known
                // to be set, so the next read of those ports settles afresh.
                forget_modes(&mut state, &frame);
                // Its rows go to the front of the next tick: a slow row would otherwise wait for
                // its next turn, a divider-100 row a hundred ticks.
                carried.extend(frame.placed.iter().map(|placed| placed.row.clone()));
                state.stats.frames_failed += 1;
                Sent::Failed(error)
            }
            Ok(payload) => {
                state.stats.frames_sent += 1;
                // Disposed while the reply was on its way: nobody is to hear from this loop again.
                if state.disposed {
                    return Sent::Nothing;
                }
                let sampled_at = self.inner.clock.now_ms();
                let values = consume(&mut state, &frame, &payload, sampled_at);
                if values.is_empty() {
                    Sent::Nothing
                } else {
                    Sent::Values(values)
                }
            }
        }
    }
}

fn check_period(ms: f64) -> Result<(), TelemetryError> {
    if ms.is_finite() && ms > 0.0 {
        Ok(())
    } else {
        Err(TelemetryError::InvalidRows(format!(
            "A tick period must be a positive number of milliseconds, not {ms}."
        )))
    }
}

fn apply_rows(state: &mut State, rows: Vec<TelemetryRow>) {
    let by_id: HashMap<&str, &TelemetryRow> = rows.iter().map(|r| (r.id.as_str(), r)).collect();
    state.carried_over = state
        .carried_over
        .iter()
        .filter_map(|row| {
            by_id
                .get(row.id.as_str())
                .filter(|next| next.lifetime != Lifetime::Off)
                .map(|next| (*next).clone())
        })
        .collect();
    state
        .due_since
        .retain(|id, _| by_id.contains_key(id.as_str()));
    state.rows = rows;
}

/// Rows for this tick, what truncation deferred and what comes up now, most urgent first.
///
/// The frame takes rows in order and defers what does not fit, so the order is the priority. A
/// row's urgency is the share of its own interval it would be late if it waited this tick out: a
/// fast row not sent now is a whole interval late, a divider-5 row a fifth. So on a tight budget
/// the fast rows keep their cadence while there is room, and a slow row still gets in, because its
/// lateness grows with every tick it waits until it is first. Ties keep the order rows were
/// gathered in, carried over first, which serves the row waiting longest. A static priority would
/// starve the same rows every tick.
fn candidates_for(state: &State, tick: u64, limits: FrameLimits) -> Vec<TelemetryRow> {
    // A one-shot comes up on every tick until it has been read, not only on tick 0: a row set
    // replaced later may add one, and it must still be read once.
    let coming_up = state
        .rows
        .iter()
        .filter(|row| row.lifetime == Lifetime::OneShot || comes_up_on_tick(row.lifetime, tick));
    let mut chosen: Vec<&TelemetryRow> = Vec::new();
    let mut taken: HashSet<&str> = HashSet::new();
    for row in state.carried_over.iter().chain(coming_up) {
        if taken.contains(row.id.as_str())
            || state.retired.contains(&row.id)
            || !is_readable(state, row, limits)
        {
            continue;
        }
        taken.insert(row.id.as_str());
        chosen.push(row);
    }
    // A one-shot has no interval of its own: it waits as patiently as the slowest row.
    let slowest = state
        .rows
        .iter()
        .map(|row| row.lifetime.divider())
        .max()
        .unwrap_or(1)
        .max(1);
    let urgency = |row: &TelemetryRow| -> f64 {
        let waited = tick - state.due_since.get(&row.id).copied().unwrap_or(tick) + 1;
        let interval = match row.lifetime {
            Lifetime::Repeating { divider } => divider,
            _ => slowest,
        };
        waited as f64 / f64::from(interval.max(1))
    };
    let mut ranked: Vec<(f64, &TelemetryRow)> =
        chosen.into_iter().map(|r| (urgency(r), r)).collect();
    // Stable: equal urgency keeps the gathering order.
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    ranked.into_iter().map(|(_, row)| row.clone()).collect()
}

/// Is this row safe to include?
///
/// The brick's own value rows are gated on their port's last reported occupancy. A row with no
/// port, or a port nothing has reported yet, is readable: the gate saves the bytes of a read with
/// nothing to learn, it does not withhold readings until permission arrives.
///
/// A daisy chain's rows are gated harder, because most bricks have no chain and must not pay for
/// one: a member's rows wait for the chain depth to report their layer, and a member's value waits
/// for its own port's occupancy. On the HID fallback the chain is not read at all: the device list
/// takes 33 of a frame's 59 bytes, and since rows go out by urgency, a slow row that keeps waiting
/// reaches the front and pushes the brick's own readings out of that frame.
fn is_readable(state: &State, row: &TelemetryRow, limits: FrameLimits) -> bool {
    let member = row.layer.is_some_and(|layer| layer > 0);
    // The depth first: on a brick with no chain it closes every member row.
    if member
        && state
            .chain_depth
            .is_none_or(|depth| row.layer.unwrap_or(0) > depth)
    {
        return false;
    }
    if (member || row.reports_chain_depth) && limits.max_packet_bytes <= HID_PACKET_BYTES {
        return false;
    }
    let Some(port) = &row.port else {
        return true;
    };
    // An occupancy row reads the type itself; gating it on the type would be circular and would
    // make a port that ever went empty unrecoverable.
    if row.reports_occupancy {
        return true;
    }
    match state.occupancy.get(port) {
        None => !member,
        Some(&code) => is_readable_type(code),
    }
}

/// Records the mode each read in the frame selects. A read in a mode other than the one last sent
/// to the port, or to a port whose mode is not known, switches the device, and its readings are
/// NaN until it settles: the settle starts now, when the command goes out, and is timed by the
/// clock, so neither a late divider nor a period change moves it.
fn note_modes(state: &mut State, frame: &AssembledFrame) {
    let now = Instant::now();
    for placed in &frame.placed {
        let row = &placed.row;
        let (Some(port), Some(mode)) = (&row.port, row.mode) else {
            continue;
        };
        if row.reports_occupancy {
            continue;
        }
        if state.commanded_mode.get(port) != Some(&mode) {
            state.settling.insert(port.clone(), now + SETTLE_LIMIT);
            state.commanded_mode.insert(port.clone(), mode);
        }
    }
}

fn forget_modes(state: &mut State, frame: &AssembledFrame) {
    for placed in &frame.placed {
        let row = &placed.row;
        if let (Some(port), Some(_), false) = (&row.port, row.mode, row.reports_occupancy) {
            state.commanded_mode.remove(port);
            state.settling.remove(port);
        }
    }
}

/// Reads a reply, updates the occupancy gate and the chain depth, and retires the one-shots whose
/// reading was delivered. Returns the values to deliver.
fn consume(
    state: &mut State,
    frame: &AssembledFrame,
    payload: &[u8],
    sampled_at: u64,
) -> Vec<RowValue> {
    let parsed = parse_frame(frame, payload, sampled_at);
    let values = settled(state, frame, parsed);
    let delivered: HashSet<&str> = values.iter().map(|v| v.row_id.as_str()).collect();
    for placed in &frame.placed {
        // A reading the settle withheld was not delivered: the one-shot is asked again.
        if placed.row.lifetime == Lifetime::OneShot && delivered.contains(placed.row.id.as_str()) {
            state.retired.insert(placed.row.id.clone());
        }
    }
    // Occupancy rows carry a type code, and the value rows read it next tick.
    for placed in &frame.placed {
        let row = &placed.row;
        let (true, Some(port), Some(&code)) =
            (row.reports_occupancy, &row.port, payload.get(placed.slot))
        else {
            continue;
        };
        state.occupancy.insert(port.clone(), code);
        // Not known any more: whatever is plugged in next starts in its own default mode.
        if port_state_of(Some(code)) != PortState::Known {
            state.commanded_mode.remove(port);
            state.settling.remove(port);
        }
    }
    let depth = frame
        .placed
        .iter()
        .find(|placed| placed.row.reports_chain_depth)
        .and_then(|placed| values.iter().find(|v| v.row_id == placed.row.id))
        .and_then(|value| value.value.as_number());
    if let Some(depth) = depth {
        set_chain_depth(state, depth as u8);
    }
    values
}

/// Takes the chain's new depth. A layer below it is gone: what its ports reported, the modes sent
/// to them and their settling are forgotten, as for a port that stops being known, so a brick
/// plugged in there later starts afresh and its values wait for its occupancy again.
fn set_chain_depth(state: &mut State, depth: u8) {
    if state.chain_depth == Some(depth) {
        return;
    }
    state.chain_depth = Some(depth);
    let gone: Vec<String> = state
        .rows
        .iter()
        .chain(state.pending_rows.iter().flatten())
        .filter(|row| row.layer.is_some_and(|layer| layer > depth))
        .filter_map(|row| row.port.clone())
        .collect();
    for port in gone {
        state.occupancy.remove(&port);
        state.commanded_mode.remove(&port);
        state.settling.remove(&port);
    }
}

/// Drops the readings of a port settling after a mode switch, until one comes back as a number or
/// the settle limit passes: a mode that reads NaN by right, or a port emptied mid-settle, must not
/// stay muted.
fn settled(state: &mut State, frame: &AssembledFrame, values: Vec<RowValue>) -> Vec<RowValue> {
    if state.settling.is_empty() {
        return values;
    }
    let now = Instant::now();
    values
        .into_iter()
        .zip(&frame.placed)
        .filter(|(value, placed)| {
            let row = &placed.row;
            let Some(port) = &row.port else { return true };
            if row.reports_occupancy {
                return true;
            }
            let Some(&until) = state.settling.get(port) else {
                return true;
            };
            let finite = matches!(value.value, Reading::Number(n) if n.is_finite());
            if finite || now >= until {
                state.settling.remove(port);
                true
            } else {
                false
            }
        })
        .map(|(value, _)| value)
        .collect()
}
