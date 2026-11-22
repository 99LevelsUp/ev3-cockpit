//! One delivery order for every telemetry subscription.
//!
//! A listener reacting to one update could otherwise make some subscription hear a newer update
//! before an older one, or lose one, and across subscriptions no single subscription can see the
//! order. The order belongs to the stream of events, so one owner keeps it here:
//!
//! - A change in the read model is queued for the subscriptions that exist **when it happens**. A
//!   subscription made later has it in its snapshot, and does not hear it again.
//! - Updates go out only from the delivery's own task, never from inside the read model's or the
//!   service's dispatch, so whatever a listener causes (another change, the end of a brick, a new
//!   subscription) joins the end of the queue, behind everything that happened before it.
//! - A subscription's snapshot is queued when it opens, so it comes before anything after.
//! - One turn tells only what was queued when it began; anything queued meanwhile waits for the
//!   next turn, so a listener whose every update causes another cannot starve the runtime.

use std::collections::{BTreeSet, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use ev3_contract::{TelemetryUpdate, TelemetryUpdateKind, TelemetryValue};
use tokio::sync::Notify;
use tokio::task::AbortHandle;

use super::read_model::{ReadModelChange, TelemetryReadModel};
use super::service::{TelemetryEvent, TelemetryService};

/// One subscription as the delivery sees it.
pub struct DeliveryTarget {
    pub subscription_id: String,
    pub brick_id: String,
    /// The claim behind it, so a claim that ended with its brick ends exactly this subscription.
    pub handle: String,
    pub rows: BTreeSet<String>,
    /// Told every update in order. A panic is the listener's own and stops nothing else.
    pub listener: Arc<dyn Fn(TelemetryUpdate) + Send + Sync>,
    /// Named in the warning when the listener panics.
    pub owner: String,
    /// Called once, when `ended` is being told.
    pub on_ended: Arc<dyn Fn() + Send + Sync>,
}

/// Where a warning goes when a listener panics.
pub type Warn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Hears what happens.
    Live,
    /// Its claim ended with the brick: `ended` is queued and nothing more joins it.
    Ending,
    /// Closed, or told `ended`: hears nothing.
    Done,
}

struct Recipient {
    target: DeliveryTarget,
    phase: Mutex<Phase>,
}

impl Recipient {
    fn phase(&self) -> MutexGuard<'_, Phase> {
        self.phase.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Default)]
struct State {
    /// In the order they were opened, so one event reaches them in a stable order.
    recipients: Vec<Arc<Recipient>>,
    queue: VecDeque<(Arc<Recipient>, TelemetryUpdate)>,
    disposed: bool,
}

struct Inner {
    state: Mutex<State>,
    wake: Arc<Notify>,
    warn: Warn,
    task: Mutex<Option<AbortHandle>>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn enqueue(&self, state: &mut State, to: &Arc<Recipient>, update: TelemetryUpdate) {
        state.queue.push_back((to.clone(), update));
        self.wake.notify_one();
    }

    fn changed(&self, change: &ReadModelChange) {
        let mut state = self.lock();
        let recipients = state.recipients.clone();
        for recipient in recipients {
            let target = &recipient.target;
            if change.brick_id != target.brick_id {
                continue;
            }
            let values: Vec<TelemetryValue> = change
                .rows
                .iter()
                .filter(|row| target.rows.contains(&row.row_id))
                .map(|row| row.to_contract())
                .collect();
            let removed: Vec<String> = change
                .removed
                .iter()
                .filter(|id| target.rows.contains(*id))
                .cloned()
                .collect();
            if !values.is_empty() || !removed.is_empty() {
                let update = update(target, TelemetryUpdateKind::Change, values, removed);
                self.enqueue(&mut state, &recipient, update);
            }
        }
    }

    fn claims_ended(&self, brick_id: &str, handles: &[String]) {
        let mut state = self.lock();
        let ending: Vec<Arc<Recipient>> = state
            .recipients
            .iter()
            .filter(|r| r.target.brick_id == brick_id && handles.contains(&r.target.handle))
            .cloned()
            .collect();
        for recipient in ending {
            // From here the claim is gone: nothing more joins this subscription, and closing it
            // releases nothing.
            *recipient.phase() = Phase::Ending;
            state.recipients.retain(|r| !Arc::ptr_eq(r, &recipient));
            let update = update(
                &recipient.target,
                TelemetryUpdateKind::Ended,
                Vec::new(),
                Vec::new(),
            );
            self.enqueue(&mut state, &recipient, update);
        }
    }

    /// Tells what was queued when the turn began.
    fn turn(&self) -> bool {
        let batch: Vec<(Arc<Recipient>, TelemetryUpdate)> = self.lock().queue.drain(..).collect();
        for (to, update) in batch {
            {
                let mut phase = to.phase();
                if *phase == Phase::Done {
                    continue;
                }
                if update.kind == TelemetryUpdateKind::Ended {
                    *phase = Phase::Done;
                }
            }
            if update.kind == TelemetryUpdateKind::Ended {
                (to.target.on_ended)();
            }
            let listener = to.target.listener.clone();
            if catch_unwind(AssertUnwindSafe(|| listener(update))).is_err() {
                (self.warn)(&format!(
                    "Telemetry listener of {} panicked.",
                    to.target.owner
                ));
            }
        }
        !self.lock().queue.is_empty()
    }
}

fn update(
    target: &DeliveryTarget,
    kind: TelemetryUpdateKind,
    values: Vec<TelemetryValue>,
    removed: Vec<String>,
) -> TelemetryUpdate {
    TelemetryUpdate {
        subscription_id: target.subscription_id.clone(),
        brick_id: target.brick_id.clone(),
        kind,
        values,
        removed,
    }
}

/// A subscription's place in the delivery.
pub struct DeliveryHandle {
    recipient: Arc<Recipient>,
    inner: Arc<Inner>,
}

impl DeliveryHandle {
    /// Stops telling it anything, including what is already queued. Returns whether its claim is
    /// still held (false once the claim ended with its brick, or when already closed), so the
    /// caller releases a claim at most once and never one already gone.
    pub fn close(&self) -> bool {
        let held = {
            let mut phase = self.recipient.phase();
            let held = *phase == Phase::Live;
            *phase = Phase::Done;
            held
        };
        self.inner
            .lock()
            .recipients
            .retain(|r| !Arc::ptr_eq(r, &self.recipient));
        held
    }
}

/// Every telemetry subscription's updates, in one order. Cheap to clone; clones share it.
#[derive(Clone)]
pub struct TelemetryDelivery {
    inner: Arc<Inner>,
}

impl TelemetryDelivery {
    /// A delivery with nothing to listen to yet; [`TelemetryDelivery::follow`] gives it its
    /// sources. Starts its own task, so call it inside a tokio runtime.
    pub fn new(warn: Warn) -> Self {
        let inner = Arc::new(Inner {
            state: Mutex::new(State::default()),
            wake: Arc::new(Notify::new()),
            warn,
            task: Mutex::new(None),
        });
        let weak = Arc::downgrade(&inner);
        let wake = inner.wake.clone();
        let task = tokio::spawn(async move {
            loop {
                wake.notified().await;
                loop {
                    let Some(inner) = weak.upgrade() else { return };
                    let more = inner.turn();
                    drop(inner);
                    if !more {
                        break;
                    }
                    // What a turn's listeners queued waits for the next turn of the runtime.
                    tokio::task::yield_now().await;
                }
            }
        });
        *inner.task.lock().unwrap_or_else(PoisonError::into_inner) = Some(task.abort_handle());
        Self { inner }
    }

    /// Listens to the read model's changes and to the claims that ended with their brick.
    pub fn follow(&self, read_model: &TelemetryReadModel, service: &TelemetryService) {
        let weak = Arc::downgrade(&self.inner);
        read_model.listen(Arc::new(move |change: &ReadModelChange| {
            if let Some(inner) = weak.upgrade() {
                inner.changed(change);
            }
        }));
        let weak = Arc::downgrade(&self.inner);
        service.listen(Arc::new(move |event: &TelemetryEvent| {
            if let (Some(inner), TelemetryEvent::ClaimsEnded { brick_id, handles }) =
                (weak.upgrade(), event)
            {
                inner.claims_ended(brick_id, handles);
            }
        }));
    }

    /// Takes one read-model change; for a source other than [`TelemetryDelivery::follow`]'s.
    pub fn change(&self, change: &ReadModelChange) {
        self.inner.changed(change);
    }

    /// Takes claims that ended with their brick; for a source other than
    /// [`TelemetryDelivery::follow`]'s.
    pub fn claims_ended(&self, brick_id: &str, handles: &[String]) {
        self.inner.claims_ended(brick_id, handles);
    }

    /// Starts telling `target`: the snapshot first, then every change after it.
    ///
    /// The snapshot is taken here, while no change can join the queue, so it holds everything up
    /// to now and the queue everything after. A change racing it on another thread may be told
    /// twice, once in the snapshot and once as a change; it is never lost.
    pub fn open(
        &self,
        target: DeliveryTarget,
        snapshot: impl FnOnce() -> Vec<TelemetryValue>,
    ) -> DeliveryHandle {
        let mut state = self.inner.lock();
        let recipient = Arc::new(Recipient {
            target,
            phase: Mutex::new(if state.disposed {
                Phase::Done
            } else {
                Phase::Live
            }),
        });
        if !state.disposed {
            let values = snapshot();
            state.recipients.push(recipient.clone());
            let update = update(
                &recipient.target,
                TelemetryUpdateKind::Snapshot,
                values,
                Vec::new(),
            );
            self.inner.enqueue(&mut state, &recipient, update);
        }
        drop(state);
        DeliveryHandle {
            recipient,
            inner: self.inner.clone(),
        }
    }

    /// Stops telling anything, queued or not.
    pub fn dispose(&self) {
        {
            let mut state = self.inner.lock();
            state.disposed = true;
            for recipient in state.recipients.drain(..) {
                *recipient.phase() = Phase::Done;
            }
            state.queue.clear();
        }
        if let Some(task) = self
            .inner
            .task
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }
}
