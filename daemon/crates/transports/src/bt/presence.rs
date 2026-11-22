//! Bluetooth presence: which bricks are actually there, found without connecting.
//!
//! The operating system lists every paired brick whether it is switched on or not, and a brick
//! nobody has paired yet shows up nowhere until somebody runs an inquiry. Two background jobs
//! fill those gaps:
//!
//!  - an **inquiry** every so often, so a brick never seen before appears in the list by itself;
//!  - a **presence check** of each paired brick without a session (an uncached service query),
//!    so a switched-off brick turns "not heard" instead of looking available.
//!
//! The check is one-sided: an answer proves the brick is on, silence may be this host's adapter
//! missing the page. So a brick is "heard" on its first answer and "not heard" only after several
//! misses in a row. Until its first check a paired brick counts as heard: the operating system's
//! record is all there is to go on.
//!
//! Both jobs hold the connection queue while they run, so neither ever pages the radio beside a
//! connect or a pairing, but they hold it for mutual exclusion only: releasing it starts no
//! pause, and an unanswered check is not an error.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tokio::time::{Instant, MissedTickBehavior};

use crate::bt::normalise_mac;
use crate::bt::queue::{BtConnectionQueue, SlotKind};

/// How often each paired brick without a session is checked. A check of a brick that is off
/// holds the radio about 5.3 s, so a round over three switched-off bricks is ~16 s in a minute.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(60);
/// How often an inquiry looks for bricks nobody has paired yet.
pub const INQUIRY_INTERVAL: Duration = Duration::from_secs(60);
/// Length of one background inquiry window. Well below the queue's 45 s acquire timeout, so a
/// connect queued behind an inquiry is never refused for waiting it out.
pub const INQUIRY_WINDOW: Duration = Duration::from_secs(10);
/// Misses in a row before a paired brick counts as not heard. More than one because a brick
/// that is on went unanswered 2 times in 4 on one host's adapter.
pub const MISSES_BEFORE_NOT_HEARD: u32 = 3;

/// The monitor's rhythm. [`Default`] is what ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresenceTimings {
    pub check_interval: Duration,
    pub inquiry_interval: Duration,
    pub misses_before_not_heard: u32,
}

impl Default for PresenceTimings {
    fn default() -> Self {
        Self {
            check_interval: CHECK_INTERVAL,
            inquiry_interval: INQUIRY_INTERVAL,
            misses_before_not_heard: MISSES_BEFORE_NOT_HEARD,
        }
    }
}

/// One brick an inquiry heard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedBrick {
    /// Colon-separated, upper case.
    pub mac: String,
    /// What the brick calls itself.
    pub name: String,
    pub paired: bool,
    /// Signal, where the host reported one. Good enough to order a list by, not a measurement.
    pub signal: Option<i32>,
}

/// What the latest checks say about one paired brick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairedPresence {
    pub heard: bool,
    /// When it last answered, in ms since the epoch, if it ever has.
    pub heard_at: Option<i64>,
}

/// A brick the inquiry heard that is not paired with this computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnpairedSighting {
    pub mac: String,
    pub name: String,
    pub signal: Option<i32>,
    /// When it was last heard, in ms since the epoch.
    pub seen_at: i64,
}

/// Why a check or an inquiry produced no answer at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresenceFailure {
    /// This host cannot run the job at all (no radio, the wrong platform). It will not start
    /// working on the next tick, so the monitor stops and says so once.
    Unavailable(String),
    /// This round failed; the next one tries again.
    Failed(String),
}

/// What the monitor asks of the platform.
#[async_trait]
pub trait PresenceSource: Send + Sync {
    /// One presence check of a paired brick; true when it answered.
    async fn check(&self, mac: &str) -> Result<bool, PresenceFailure>;
    /// One inquiry window; every brick it heard.
    async fn inquire(&self) -> Result<Vec<ScannedBrick>, PresenceFailure>;
    /// The paired bricks to check now: those without a session.
    fn paired_without_session(&self) -> Vec<String>;
}

#[derive(Debug, Clone, Copy)]
struct PairedState {
    heard: bool,
    heard_at: Option<i64>,
    misses: u32,
}

#[derive(Debug, Clone)]
struct Sighting {
    key: String,
    seen: Instant,
    public: UnpairedSighting,
}

#[derive(Debug, Default)]
struct Known {
    paired: HashMap<String, PairedState>,
    /// In the order first heard.
    unpaired: Vec<Sighting>,
    unavailable: Option<String>,
}

/// Background presence for one transport's bricks.
pub struct PresenceMonitor {
    queue: Arc<BtConnectionQueue>,
    timings: PresenceTimings,
    known: Mutex<Known>,
    checking: AtomicBool,
    inquiring: AtomicBool,
    stopped: AtomicBool,
    on_change: Option<Box<dyn Fn() + Send + Sync>>,
}

impl std::fmt::Debug for PresenceMonitor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PresenceMonitor")
            .field("timings", &self.timings)
            .field("stopped", &self.stopped)
            .finish_non_exhaustive()
    }
}

/// Clears a "running" flag however the round ends, the future dropped included.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

impl PresenceMonitor {
    pub fn new(queue: Arc<BtConnectionQueue>, timings: PresenceTimings) -> Self {
        Self {
            queue,
            timings,
            known: Mutex::new(Known::default()),
            checking: AtomicBool::new(false),
            inquiring: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            on_change: None,
        }
    }

    /// Called after a round that changed what is known, so discovery can be asked again.
    pub fn with_on_change(mut self, on_change: impl Fn() + Send + Sync + 'static) -> Self {
        self.on_change = Some(Box::new(on_change));
        self
    }

    fn lock(&self) -> MutexGuard<'_, Known> {
        self.known
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Stops both jobs: a round in progress ends at its next brick, and no new one starts.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Why the monitor stopped on its own, when the host cannot run it.
    pub fn unavailable_reason(&self) -> Option<String> {
        self.lock().unavailable.clone()
    }

    /// What the checks say about a paired brick, or `None` before its first check.
    pub fn presence_of(&self, mac: &str) -> Option<PairedPresence> {
        self.lock()
            .paired
            .get(&normalise_mac(mac))
            .map(|state| PairedPresence {
                heard: state.heard,
                heard_at: state.heard_at,
            })
    }

    /// The unpaired bricks recent inquiries heard, in the order first heard.
    pub fn unpaired_bricks(&self) -> Vec<UnpairedSighting> {
        self.lock()
            .unpaired
            .iter()
            .map(|sighting| sighting.public.clone())
            .collect()
    }

    /// Forgets a brick: drops its check results and its inquiry sighting. A forgotten brick is
    /// neither paired nor a known stranger any more; an inquiry that hears it afterwards lists it
    /// as a new unpaired brick.
    pub fn forget(&self, mac: &str) {
        let key = normalise_mac(mac);
        let mut known = self.lock();
        known.paired.remove(&key);
        known.unpaired.retain(|sighting| sighting.key != key);
    }

    /// Records a pairing this computer has just made: drops the brick's check results, which are
    /// older than the pairing. A check that missed the brick while its owner was confirming on it
    /// would otherwise mark the fresh channel as not heard; until the next check the brick counts
    /// as heard, as any paired brick does before its first.
    pub fn note_paired(&self, mac: &str) {
        self.lock().paired.remove(&normalise_mac(mac));
    }

    /// One round of presence checks, one brick at a time. Skipped while the previous round runs.
    ///
    /// The queue is taken per brick and released between bricks, so a user's connect waits for
    /// at most one check.
    pub async fn run_checks(&self, source: &dyn PresenceSource) {
        if self.is_stopped() || self.checking.swap(true, Ordering::SeqCst) {
            return;
        }
        let _running = Running(&self.checking);
        let targets = source.paired_without_session();
        // A brick with a session is plainly there; whatever its last checks said is stale by the
        // time its session ends, and must not mark it not heard on its way back.
        {
            let current: Vec<String> = targets.iter().map(|mac| normalise_mac(mac)).collect();
            self.lock().paired.retain(|key, _| current.contains(key));
        }
        let mut changed = false;
        for mac in targets {
            if self.is_stopped() {
                return;
            }
            let Ok(slot) = self
                .queue
                .acquire(&format!("presence:{mac}"), SlotKind::HoldOnly)
                .await
            else {
                return;
            };
            let answer = source.check(&mac).await;
            slot.release(false);
            match answer {
                Ok(answered) => changed |= self.record(&mac, answered),
                Err(failure) => {
                    self.handle_failure(failure);
                    break;
                }
            }
        }
        if changed {
            self.changed();
        }
    }

    /// One inquiry window. Skipped while the previous one runs.
    pub async fn run_inquiry(&self, source: &dyn PresenceSource) {
        if self.is_stopped() || self.inquiring.swap(true, Ordering::SeqCst) {
            return;
        }
        let _running = Running(&self.inquiring);
        let Ok(slot) = self
            .queue
            .acquire("presence:inquiry", SlotKind::HoldOnly)
            .await
        else {
            return;
        };
        let heard = source.inquire().await;
        slot.release(false);
        let heard = match heard {
            Ok(heard) => heard,
            Err(failure) => {
                self.handle_failure(failure);
                return;
            }
        };
        let now = Instant::now();
        let now_ms = now_epoch_ms();
        let mut changed = false;
        {
            let mut known = self.lock();
            for brick in heard {
                // A paired brick is listed from the operating system's records and checked on
                // its own.
                if brick.paired {
                    continue;
                }
                let key = normalise_mac(&brick.mac);
                let public = UnpairedSighting {
                    mac: brick.mac,
                    name: brick.name,
                    signal: brick.signal,
                    seen_at: now_ms,
                };
                match known
                    .unpaired
                    .iter_mut()
                    .find(|sighting| sighting.key == key)
                {
                    Some(sighting) => {
                        sighting.seen = now;
                        sighting.public = public;
                    }
                    None => {
                        changed = true;
                        known.unpaired.push(Sighting {
                            key,
                            seen: now,
                            public,
                        });
                    }
                }
            }
            // A brick missed by two windows running has left; one miss can be the radio.
            let horizon = self.timings.inquiry_interval.saturating_mul(2);
            let before = known.unpaired.len();
            known
                .unpaired
                .retain(|sighting| now.saturating_duration_since(sighting.seen) <= horizon);
            changed |= known.unpaired.len() != before;
        }
        if changed {
            self.changed();
        }
    }

    /// Runs both jobs until [`PresenceMonitor::stop`]: an inquiry and a round of checks straight
    /// away, then each on its own interval.
    pub async fn run(self: Arc<Self>, source: Arc<dyn PresenceSource>) {
        self.run_inquiry(source.as_ref()).await;
        self.run_checks(source.as_ref()).await;
        let mut inquiries = tokio::time::interval_at(
            Instant::now() + self.timings.inquiry_interval,
            self.timings.inquiry_interval,
        );
        let mut checks = tokio::time::interval_at(
            Instant::now() + self.timings.check_interval,
            self.timings.check_interval,
        );
        inquiries.set_missed_tick_behavior(MissedTickBehavior::Delay);
        checks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        while !self.is_stopped() {
            tokio::select! {
                _ = inquiries.tick() => self.run_inquiry(source.as_ref()).await,
                _ = checks.tick() => self.run_checks(source.as_ref()).await,
            }
        }
    }

    /// Applies one check's answer. True when the brick's heard state changed, or it answered.
    fn record(&self, mac: &str, answered: bool) -> bool {
        let key = normalise_mac(mac);
        let mut known = self.lock();
        let before = known.paired.get(&key).map(|state| state.heard);
        let mut state = known.paired.get(&key).copied().unwrap_or(PairedState {
            heard: true,
            heard_at: None,
            misses: 0,
        });
        if answered {
            state.heard = true;
            state.heard_at = Some(now_epoch_ms());
            state.misses = 0;
        } else {
            state.misses = state.misses.saturating_add(1);
            if state.misses >= self.timings.misses_before_not_heard {
                state.heard = false;
            }
        }
        known.paired.insert(key, state);
        answered || before != Some(state.heard)
    }

    fn handle_failure(&self, failure: PresenceFailure) {
        if let PresenceFailure::Unavailable(reason) = failure {
            self.stop();
            self.lock().unavailable.get_or_insert(reason);
        }
    }

    fn changed(&self) {
        if let Some(on_change) = &self.on_change {
            on_change();
        }
    }
}
