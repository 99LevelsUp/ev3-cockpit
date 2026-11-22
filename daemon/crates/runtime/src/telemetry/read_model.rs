//! What the telemetry loops read, kept for whoever asks.
//!
//! Per brick, the last value of every row with the time it was sampled, the interval the row runs
//! at now and whether the value is still fresh. A subscription's snapshot and its changes read it;
//! neither talks to a loop.
//!
//! **Stale.** A value is stale when its row stops being read (the link went, nobody wants the
//! row) or when it is `stale_factor` of its own intervals old while the row is still read (the
//! brick is stalling). Once stale it stays stale until a new sample. A stale value stays, marked,
//! for `stale_timeout_ms` from when it went stale, then goes. When the brick's sign-in ends its
//! values go at once, and replies still on their way are not taken until the brick is read again.
//! A static row, read once, stays fresh for the whole session: it is what serves a claim made after
//! the read.
//!
//! **Changes carry the rows that changed** (value, mode, unit, stale flag or effective interval)
//! and the rows dropped. Nothing is lost in an outage: there are no samples to lose, the values
//! turning stale is a change, and the first sample after the outage is one even when its value is
//! the same, because the stale flag flips back.
//!
//! **One order for every input.** A sample, a plan, a session's end, a settings change and the
//! timer all go through one path: first time is brought up to now under the state as it was (what
//! went stale is told, then what expired goes), and only then is the input applied. Changes are not
//! picked by hand: they are the difference between what readers were last told and what holds now,
//! so a change cannot go untold.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use ev3_contract::{TelemetryRate, TelemetryValue, TelemetryValueValue};
use tokio::sync::Notify;
use tokio::task::AbortHandle;

use crate::chain::ChainDepth;

use super::claims::RowRate;
use super::clock::WallClock;
use super::dispatch::{Dispatcher, Listener};
use super::error::TelemetryError;
use super::ev3_rows::CHAIN_DEPTH_ROW;
use super::row::{Reading, RowValue};
use super::service::{Intervals, TelemetryEvent, TelemetryService};
use super::settings::StaleSettings;

/// One row's last value as a reader sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadValue {
    pub row_id: String,
    pub value: Reading,
    pub unit: Option<String>,
    pub mode: Option<u8>,
    /// When the reply carrying the value arrived, in milliseconds since the Unix epoch.
    pub sampled_at: u64,
    /// How often the row is read now; `None` while it is not read.
    pub effective: Option<RowRate>,
    pub stale: bool,
}

impl ReadValue {
    /// The value as the contract carries it. A NaN reading, which JSON cannot carry, goes as null.
    pub fn to_contract(&self) -> TelemetryValue {
        let value = match &self.value {
            Reading::Number(n) if n.is_finite() => TelemetryValueValue::Number(*n),
            Reading::Number(_) | Reading::Missing => TelemetryValueValue::Null,
            Reading::Text(text) => TelemetryValueValue::String(text.clone()),
            Reading::Flag(flag) => TelemetryValueValue::Boolean(*flag),
        };
        TelemetryValue {
            row_id: self.row_id.clone(),
            value,
            unit: self.unit.clone(),
            mode: self.mode.map(u64::from),
            sampled_at: self.sampled_at,
            effective_rate: self.effective.map(|rate| match rate {
                RowRate::Every(ms) => TelemetryRate::Interval(ms.round() as u64),
                RowRate::Once => TelemetryRate::Once,
            }),
            stale: self.stale,
        }
    }
}

/// Hears a brick's chain depth: its id, and the depth or None for unknown.
pub type ChainListener = Arc<dyn Fn(&str, Option<ChainDepth>) + Send + Sync>;

/// What changed for one brick: rows that are new or different, and rows dropped.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadModelChange {
    pub brick_id: String,
    pub rows: Vec<ReadValue>,
    pub removed: Vec<String>,
}

/// The chain depth in `values`, with whether that reading is stale; `None` until it was read.
pub fn chain_depth_of(values: &[ReadValue]) -> Option<ChainDepth> {
    values
        .iter()
        .find(|value| value.row_id == CHAIN_DEPTH_ROW)
        .and_then(|value| {
            value.value.as_number().map(|depth| ChainDepth {
                depth: depth as u8,
                stale: value.stale,
            })
        })
}

#[derive(Debug, Clone)]
struct Entry {
    value: Reading,
    unit: Option<String>,
    mode: Option<u8>,
    sampled_at: u64,
    /// How often the row is read now; `None` while it is not read.
    interval: Option<RowRate>,
    /// When the value went stale; `None` while fresh. Sticky until a new sample.
    stale_since: Option<f64>,
}

/// What a brick's plans said of a row this session, kept apart from its value: a value may be gone
/// while a reply for it is still on its way.
#[derive(Debug, Clone, Default)]
struct RowPlan {
    /// Planned as read once: its value stays fresh for the session, whenever its reply comes.
    once: bool,
    /// When it stopped being read; `None` while it is read.
    stopped_at: Option<f64>,
    /// Its value was dropped: no reply for it while it is not read brings it back.
    dropped: bool,
}

#[derive(Default)]
struct State {
    settings: Option<StaleSettings>,
    bricks: HashMap<String, BTreeMap<String, Entry>>,
    /// What each brick is read for now, as the service last said.
    plans: HashMap<String, Intervals>,
    /// What readers were last told, per brick: changes are the difference from it.
    told: HashMap<String, BTreeMap<String, ReadValue>>,
    /// Per brick, what its plans said of each row this session; cleared when the session ends.
    planned: HashMap<String, HashMap<String, RowPlan>>,
    /// Bricks whose session ended and that are not read again yet: their late replies are not taken.
    ended: HashSet<String>,
    disposed: bool,
}

struct Inner {
    clock: WallClock,
    state: Mutex<State>,
    events: Dispatcher<ReadModelChange>,
    /// Woken whenever the next deadline may have moved.
    rescheduled: Notify,
    timer: Mutex<Option<AbortHandle>>,
}

/// The telemetry read model. Cheap to clone; clones share it.
#[derive(Clone)]
pub struct TelemetryReadModel {
    inner: Arc<Inner>,
}

impl TelemetryReadModel {
    /// A read model with no values yet; feed it with [`TelemetryReadModel::follow`] or
    /// [`TelemetryReadModel::apply`], and let [`TelemetryReadModel::start_timer`] mark values stale
    /// and drop them on time.
    pub fn new(settings: StaleSettings, clock: WallClock) -> Result<Self, TelemetryError> {
        settings.check()?;
        Ok(Self {
            inner: Arc::new(Inner {
                clock,
                state: Mutex::new(State {
                    settings: Some(settings),
                    ..State::default()
                }),
                events: Dispatcher::default(),
                rescheduled: Notify::new(),
                timer: Mutex::new(None),
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Hears every change from now on. A listener may call back into the read model.
    pub fn listen(&self, listener: Listener<ReadModelChange>) {
        self.inner.events.listen(listener);
    }

    /// Hears each brick's daisy-chain depth when it changes: a new depth, the reading going stale
    /// or fresh again, or `None` when the reading was dropped and the chain is unknown again. A
    /// change that only moved how often the depth is read tells nothing. Where `chain/changed`
    /// comes from.
    pub fn listen_chain(&self, listener: ChainListener) {
        let last: Mutex<HashMap<String, ChainDepth>> = Mutex::new(HashMap::new());
        self.listen(Arc::new(move |change: &ReadModelChange| {
            let news = if change.removed.iter().any(|id| id == CHAIN_DEPTH_ROW) {
                Some(None)
            } else {
                chain_depth_of(&change.rows).map(Some)
            };
            let Some(depth) = news else { return };
            let changed = {
                let mut last = last.lock().unwrap_or_else(PoisonError::into_inner);
                match depth {
                    None => last.remove(&change.brick_id).is_some(),
                    Some(depth) => last.insert(change.brick_id.clone(), depth) != Some(depth),
                }
            };
            if changed {
                listener(&change.brick_id, depth);
            }
        }));
    }

    /// Reads what `service` reads from now on, starting from the plans it already runs.
    pub fn follow(&self, service: &TelemetryService) {
        for (brick, intervals) in service.current_plans() {
            self.apply(&TelemetryEvent::PlanChanged {
                brick_id: brick,
                intervals,
            });
        }
        let weak = Arc::downgrade(&self.inner);
        service.listen(Arc::new(move |event: &TelemetryEvent| {
            if let Some(inner) = weak.upgrade() {
                TelemetryReadModel { inner }.apply(event);
            }
        }));
    }

    /// Takes one of the service's events: values, a plan or a session's end.
    pub fn apply(&self, event: &TelemetryEvent) {
        match event {
            TelemetryEvent::Values { brick_id, values } => {
                self.run(|state, now| take(state, now, brick_id, values))
            }
            TelemetryEvent::PlanChanged {
                brick_id,
                intervals,
            } => {
                self.run(|state, now| plan(state, now, brick_id, intervals));
            }
            TelemetryEvent::SessionEnded { brick_id } => self.run(|state, _| end(state, brick_id)),
            _ => {}
        }
    }

    /// Changes the stale settings; they apply at once. Refuses settings out of range, changing
    /// nothing.
    pub fn configure(&self, settings: StaleSettings) -> Result<(), TelemetryError> {
        settings.check()?;
        // Time up to now under the old settings, then the new ones.
        self.run(|state, _| state.settings = Some(settings));
        Ok(())
    }

    /// Brings time up to now: marks what went stale and drops what has been stale long enough.
    pub fn tick(&self) {
        self.run(|_, _| {});
    }

    /// The next moment a value turns stale or a stale one goes, in milliseconds since the epoch.
    pub fn next_deadline_ms(&self) -> Option<f64> {
        let state = self.lock();
        let settings = state.settings?;
        let mut next: Option<f64> = None;
        for entries in state.bricks.values() {
            for entry in entries.values() {
                let deadline = match (entry.stale_since, entry.interval) {
                    (Some(since), _) => since + settings.stale_timeout_ms,
                    (None, Some(RowRate::Every(ms))) => {
                        entry.sampled_at as f64 + settings.stale_factor * ms
                    }
                    _ => continue,
                };
                next = Some(next.map_or(deadline, |n| n.min(deadline)));
            }
        }
        next
    }

    /// Runs [`TelemetryReadModel::tick`] whenever the next deadline comes. Call it inside a tokio
    /// runtime.
    pub fn start_timer(&self) {
        let weak = Arc::downgrade(&self.inner);
        let task = tokio::spawn(async move {
            loop {
                let Some(inner) = weak.upgrade() else { return };
                let model = TelemetryReadModel { inner };
                let wait = model.next_deadline_ms().map(|deadline| {
                    let ms = (deadline - model.inner.clock.now_ms() as f64).max(0.0);
                    // A deadline far out is woken at a day and checked again.
                    Duration::from_millis(ms.min(86_400_000.0).ceil() as u64)
                });
                let inner = model.inner.clone();
                drop(model);
                match wait {
                    Some(wait) => {
                        tokio::select! {
                            () = tokio::time::sleep(wait) => TelemetryReadModel { inner }.tick(),
                            () = inner.rescheduled.notified() => {}
                        }
                    }
                    None => inner.rescheduled.notified().await,
                }
            }
        });
        if let Some(old) = self
            .inner
            .timer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace(task.abort_handle())
        {
            old.abort();
        }
    }

    /// The brick's values, all or the rows named; a row with no value is left out.
    pub fn snapshot(&self, brick_id: &str, rows: Option<&[String]>) -> Vec<ReadValue> {
        let state = self.lock();
        let Some(entries) = state.bricks.get(brick_id) else {
            return Vec::new();
        };
        match rows {
            None => entries.iter().map(|(id, entry)| view(id, entry)).collect(),
            Some(ids) => ids
                .iter()
                .filter_map(|id| entries.get(id).map(|entry| view(id, entry)))
                .collect(),
        }
    }

    pub fn value_of(&self, brick_id: &str, row_id: &str) -> Option<ReadValue> {
        let state = self.lock();
        state
            .bricks
            .get(brick_id)
            .and_then(|entries| entries.get(row_id))
            .map(|entry| view(row_id, entry))
    }

    /// The brick's daisy-chain depth as last read, stale or not; `None` until it was read.
    pub fn chain_depth(&self, brick_id: &str) -> Option<ChainDepth> {
        self.value_of(brick_id, CHAIN_DEPTH_ROW)
            .and_then(|value| chain_depth_of(std::slice::from_ref(&value)))
    }

    /// Stops the timer and forgets every value; nothing more is told.
    pub fn dispose(&self) {
        {
            let mut state = self.lock();
            state.disposed = true;
            state.bricks.clear();
            state.plans.clear();
            state.planned.clear();
            state.told.clear();
        }
        self.inner.events.clear();
        if let Some(timer) = self
            .inner
            .timer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            timer.abort();
        }
    }

    /// Every input goes through here: time first, under the state as it was; then the input; then
    /// time again under the new state (a shorter interval or a smaller factor may put a deadline in
    /// the past); each step tells what changed.
    fn run(&self, input: impl FnOnce(&mut State, f64)) {
        {
            let mut state = self.lock();
            if state.disposed {
                return;
            }
            let now = self.inner.clock.now_ms() as f64;
            self.settle(&mut state, now);
            input(&mut state, now);
            self.announce(&mut state);
            self.settle(&mut state, now);
        }
        self.inner.rescheduled.notify_one();
        self.inner.events.drain();
    }

    /// Brings time up to `now`: what went stale is told, then what has been stale long enough goes.
    fn settle(&self, state: &mut State, now: f64) {
        let Some(settings) = state.settings else {
            return;
        };
        for entries in state.bricks.values_mut() {
            for entry in entries.values_mut() {
                if entry.stale_since.is_some() {
                    continue;
                }
                let Some(RowRate::Every(ms)) = entry.interval else {
                    continue;
                };
                // From the deadline, however late this runs: that is when it went stale.
                let deadline = entry.sampled_at as f64 + settings.stale_factor * ms;
                if now >= deadline {
                    entry.stale_since = Some(deadline);
                }
            }
        }
        // Stale before gone, even with no time between: a reader hears both.
        self.announce(state);
        let State {
            bricks, planned, ..
        } = state;
        for (brick, entries) in bricks.iter_mut() {
            entries.retain(|id, entry| {
                let gone = entry
                    .stale_since
                    .is_some_and(|since| now >= since + settings.stale_timeout_ms);
                if gone
                    && let Some(history) = planned.get_mut(brick).and_then(|rows| rows.get_mut(id))
                {
                    // A row still read takes its next sample anyway; the next plan that reads it
                    // clears this.
                    history.dropped = true;
                }
                !gone
            });
        }
        self.announce(state);
    }

    /// Tells readers what differs from what they were last told, per brick.
    fn announce(&self, state: &mut State) {
        let mut bricks: Vec<String> = state
            .bricks
            .keys()
            .chain(state.told.keys())
            .cloned()
            .collect();
        bricks.sort();
        bricks.dedup();
        for brick in bricks {
            let now: BTreeMap<String, ReadValue> = state
                .bricks
                .get(&brick)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|(id, e)| (id.clone(), view(id, e)))
                        .collect()
                })
                .unwrap_or_default();
            let before = state.told.remove(&brick).unwrap_or_default();
            let rows: Vec<ReadValue> = now
                .values()
                .filter(|current| {
                    before
                        .get(&current.row_id)
                        .is_none_or(|was| differs(was, current))
                })
                .cloned()
                .collect();
            let removed: Vec<String> = before
                .keys()
                .filter(|id| !now.contains_key(*id))
                .cloned()
                .collect();
            if state.bricks.get(&brick).is_some_and(BTreeMap::is_empty) {
                state.bricks.remove(&brick);
            }
            if !now.is_empty() {
                state.told.insert(brick.clone(), now);
            }
            if !rows.is_empty() || !removed.is_empty() {
                self.inner.events.push(ReadModelChange {
                    brick_id: brick,
                    rows,
                    removed,
                });
            }
        }
    }
}

fn take(state: &mut State, now: f64, brick_id: &str, values: &[RowValue]) {
    // A reply still on its way when the session ended, or ended by a listener just now.
    if state.ended.contains(brick_id) {
        return;
    }
    let timeout = state.settings.map_or(0.0, |s| s.stale_timeout_ms);
    let plan = state.plans.get(brick_id).cloned();
    let history = state.planned.get(brick_id).cloned().unwrap_or_default();
    let entries = state.bricks.entry(brick_id.to_owned()).or_default();
    for value in values {
        let before = entries.get(&value.row_id);
        let planned = plan.as_ref().and_then(|p| p.get(&value.row_id)).copied();
        let row = history.get(&value.row_id);
        let mut reading = Entry {
            value: value.value.clone(),
            unit: value.unit.clone(),
            mode: value.mode,
            sampled_at: value.sampled_at,
            interval: None,
            stale_since: None,
        };
        if planned == Some(RowRate::Once)
            || before.is_some_and(|b| b.interval == Some(RowRate::Once))
            || row.is_some_and(|r| r.once)
        {
            reading.interval = Some(RowRate::Once);
        } else if planned.is_none() {
            // Not read any more: the reply of a frame sent before the re-plan. Kept, but stale
            // since it stopped being read, so its drop is not put off; once dropped, not taken.
            if row.is_some_and(|r| r.dropped) {
                continue;
            }
            let since = before
                .and_then(|b| b.stale_since)
                .or_else(|| row.and_then(|r| r.stopped_at))
                .unwrap_or(now);
            if now >= since + timeout {
                continue;
            }
            reading.stale_since = Some(since);
        } else {
            reading.interval = planned;
        }
        entries.insert(value.row_id.clone(), reading);
    }
}

fn plan(state: &mut State, now: f64, brick_id: &str, intervals: &Intervals) {
    if intervals.is_empty() {
        state.plans.remove(brick_id);
    } else {
        state.plans.insert(brick_id.to_owned(), intervals.clone());
        // Read again: a new session's loop.
        state.ended.remove(brick_id);
    }
    remember(state, now, brick_id, intervals);
    let Some(entries) = state.bricks.get_mut(brick_id) else {
        return;
    };
    for (id, entry) in entries.iter_mut() {
        if entry.interval == Some(RowRate::Once) {
            continue;
        }
        match intervals.get(id) {
            None => {
                entry.interval = None;
                entry.stale_since.get_or_insert(now);
            }
            // Stale stays stale until a sample, whatever the new interval.
            Some(rate) => entry.interval = Some(*rate),
        }
    }
}

fn end(state: &mut State, brick_id: &str) {
    state.bricks.remove(brick_id);
    state.plans.remove(brick_id);
    state.planned.remove(brick_id);
    state.ended.insert(brick_id.to_owned());
}

/// Notes what a plan says of each row: read once or not, and when a row stopped being read.
fn remember(state: &mut State, now: f64, brick_id: &str, intervals: &Intervals) {
    let history = state.planned.entry(brick_id.to_owned()).or_default();
    for (id, rate) in intervals {
        let once = *rate == RowRate::Once || history.get(id).is_some_and(|r| r.once);
        history.insert(
            id.clone(),
            RowPlan {
                once,
                ..RowPlan::default()
            },
        );
    }
    for (id, row) in history.iter_mut() {
        if !intervals.contains_key(id) && !row.once {
            row.stopped_at.get_or_insert(now);
        }
    }
}

/// Whether a reader would see a difference: a new sample of the same value is not one.
fn differs(a: &ReadValue, b: &ReadValue) -> bool {
    !a.value.same(&b.value)
        || a.unit != b.unit
        || a.mode != b.mode
        || a.stale != b.stale
        || a.effective != b.effective
}

fn view(row_id: &str, entry: &Entry) -> ReadValue {
    ReadValue {
        row_id: row_id.to_owned(),
        value: entry.value.clone(),
        unit: entry.unit.clone(),
        mode: entry.mode,
        sampled_at: entry.sampled_at,
        effective: entry.interval,
        stale: entry.stale_since.is_some(),
    }
}
