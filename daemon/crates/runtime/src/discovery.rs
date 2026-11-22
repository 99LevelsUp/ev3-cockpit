//! Discovery: every transport polled on its own timer, and each channel's presence followed from
//! scan to scan.
//!
//! A channel is one brick on one transport (`usb:…`, `bt:…`). The scheduler only records what
//! the providers report, including the signal evidence the views sort by; grouping channels into
//! bricks is the presence aggregator's, and ordering the list is the views'.
//!
//! Presence moves `available` → `unavailable` after a number of scans in a row that miss the
//! channel, and on to `removed`, when the channel stops being tracked, after a number more. Only a
//! scan that answered counts a miss: a transport skipped because its last scan still runs, or
//! whose scan failed, told nothing about its bricks.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ev3_transports::{
    BrickKey, DiscoveryItem, DiscoveryScanResult, NameSource, PresenceState, Transport,
    TransportError, TransportProvider,
};
use futures_util::future::join_all;
use tokio::task::AbortHandle;

use crate::guard::brick_id_of;

/// The wall clock in milliseconds since the epoch, the unit discovery items carry.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// How often discovery looks, and how many misses move a channel on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryConfig {
    /// The scan interval of a transport with no override.
    pub default_interval: Duration,
    pub interval_overrides: HashMap<Transport, Duration>,
    /// Missed scans in a row before `available` → `unavailable`.
    pub unavailable_after_misses: u32,
    /// Missed scans in a row, after those, before `unavailable` → `removed`.
    pub removed_after_misses: u32,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            default_interval: Duration::from_millis(3000),
            interval_overrides: HashMap::new(),
            unavailable_after_misses: 2,
            removed_after_misses: 5,
        }
    }
}

/// A channel's presence changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceChange {
    pub brick_key: BrickKey,
    /// `None` for a channel not tracked before: a first discovery, which is not the same as one
    /// that was removed.
    pub previous: Option<PresenceState>,
    pub current: PresenceState,
    pub item: DiscoveryItem,
}

/// Hears what discovery finds, synchronously and in order, once the scheduler has let go of its
/// own state: a listener may call back into the scheduler.
pub trait DiscoveryListener: Send + Sync {
    fn presence_changed(&self, _change: &PresenceChange) {}

    /// A scan finished; `tracked` is every channel tracked now.
    fn scan_completed(&self, _tracked: &[DiscoveryItem]) {}

    /// A provider's scan failed. A failing provider would otherwise go dark with nothing said,
    /// while the channels it tracked sat there unchecked.
    fn scan_failed(&self, _transport: Transport, _error: &TransportError) {}
}

/// Why a key's scans are not believed: the cockpit changed it itself after they began.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Change {
    Forgotten,
    Paired,
}

#[derive(Debug, Clone, Copy)]
struct Fence {
    /// Scans numbered up to this began before the change.
    at: u64,
    change: Change,
}

struct Tracked {
    item: DiscoveryItem,
    /// Scans in a row that did not list the channel.
    misses: u32,
}

#[derive(Default)]
struct State {
    tracked: BTreeMap<BrickKey, Tracked>,
    /// Transports with a scan running. A slow scan (a Bluetooth inquiry runs for many seconds)
    /// would otherwise stack scans that each count misses, enough to walk a brick sitting right
    /// there to `unavailable`.
    in_flight: HashSet<Transport>,
    /// Counts scans as they start; each scan applies its results knowing which one it was.
    scans_started: u64,
    /// Keys the cockpit forgot or paired, with the number of the last scan started by then. Such
    /// a scan read the operating system's list before the change, so it does not speak for the
    /// key: for a forgotten key what it lists is dropped, and for a paired one it neither
    /// overwrites the pairing nor counts a miss. The first later scan clears the fence.
    fences: HashMap<BrickKey, Fence>,
    /// Transports whose provider has answered a scan; a failed scan does not count.
    answered: HashSet<Transport>,
    timers: Vec<AbortHandle>,
    disposed: bool,
}

/// What one scan found, told to the listeners once the lock is let go.
enum Notice {
    Presence(PresenceChange),
    Failed(Transport, TransportError),
}

/// Polls the providers and tracks each channel's presence.
pub struct DiscoveryScheduler {
    providers: Vec<Arc<dyn TransportProvider>>,
    config: DiscoveryConfig,
    state: Mutex<State>,
    listeners: Mutex<Vec<Weak<dyn DiscoveryListener>>>,
}

/// Clears a scan's transports from the in-flight set however the scan ends, a dropped one too.
struct InFlight<'a> {
    scheduler: &'a DiscoveryScheduler,
    transports: Vec<Transport>,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut state = self.scheduler.lock();
        for transport in &self.transports {
            state.in_flight.remove(transport);
        }
    }
}

impl DiscoveryScheduler {
    pub fn new(
        providers: impl IntoIterator<Item = Arc<dyn TransportProvider>>,
        config: DiscoveryConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            providers: providers.into_iter().collect(),
            config,
            state: Mutex::new(State::default()),
            listeners: Mutex::new(Vec::new()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds a listener, held weakly: it stops hearing once nobody else holds it.
    pub fn add_listener(&self, listener: Weak<dyn DiscoveryListener>) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    /// The provider of a transport.
    pub fn provider(&self, transport: Transport) -> Option<Arc<dyn TransportProvider>> {
        self.providers
            .iter()
            .find(|p| p.transport() == transport)
            .cloned()
    }

    /// The priority the transport's provider declares; 0 without one.
    pub fn priority_of(&self, transport: Transport) -> i32 {
        self.provider(transport).map_or(0, |p| p.priority())
    }

    /// Starts each transport's timer. The first scan comes a full interval after this; a caller
    /// that wants one now runs [`DiscoveryScheduler::scan_once`].
    pub fn start(self: &Arc<Self>) {
        let mut state = self.lock();
        if state.disposed || !state.timers.is_empty() {
            return;
        }
        for provider in &self.providers {
            let interval = self
                .config
                .interval_overrides
                .get(&provider.transport())
                .copied()
                .unwrap_or(self.config.default_interval);
            let weak = Arc::downgrade(self);
            let provider = provider.clone();
            let timer = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(interval).await;
                    let Some(scheduler) = weak.upgrade() else {
                        return;
                    };
                    scheduler.scan(vec![provider.clone()]).await;
                }
            });
            state.timers.push(timer.abort_handle());
        }
    }

    /// Stops the timers. What is tracked stays.
    pub fn stop(&self) {
        let mut state = self.lock();
        for timer in state.timers.drain(..) {
            timer.abort();
        }
    }

    /// One scan of every provider whose last scan has finished.
    pub async fn scan_once(&self) {
        self.scan(self.providers.clone()).await;
    }

    /// Whether a scan of this transport has answered since the scheduler was made: until one
    /// has, what is tracked for it says nothing about what is there.
    pub fn has_scanned(&self, transport: Transport) -> bool {
        self.lock().answered.contains(&transport)
    }

    /// Every channel tracked now.
    pub fn tracked(&self) -> Vec<DiscoveryItem> {
        self.lock()
            .tracked
            .values()
            .map(|t| t.item.clone())
            .collect()
    }

    pub fn tracked_item(&self, brick_key: &BrickKey) -> Option<DiscoveryItem> {
        self.lock().tracked.get(brick_key).map(|t| t.item.clone())
    }

    /// Stops tracking these channels, so the list cannot rebuild a forgotten brick from a
    /// sighting that still says paired.
    ///
    /// Tells nobody: whoever forgets the brick clears the list itself. A scan running now read
    /// the operating system's list before the unpair, so what it lists for these keys is dropped
    /// when it lands; a scan that starts later lists a key again as a first discovery.
    pub fn forget(&self, brick_keys: &[BrickKey]) {
        let mut state = self.lock();
        let at = state.scans_started;
        for key in brick_keys {
            state.tracked.remove(key);
            state.fences.insert(
                key.clone(),
                Fence {
                    at,
                    change: Change::Forgotten,
                },
            );
        }
    }

    /// Records a Bluetooth pairing the cockpit has just made: the channel is tracked as available
    /// and paired at once, a sighting that expired during the pairing too.
    ///
    /// A scan running now read the list before the pairing, so it neither overwrites the pairing
    /// nor counts a miss against it; a scan that starts later is believed again, so a brick
    /// nothing lists any more still expires. Tells nobody: the caller updates the list, and an
    /// announcement would start a name probe beside the sign-in that follows.
    pub fn note_paired(&self, brick_key: &BrickKey) {
        let mut state = self.lock();
        let earlier = state.tracked.get(brick_key).map_or_else(
            || DiscoveryItem {
                brick_key: brick_key.clone(),
                display_name: brick_id_of(brick_key),
                name_source: Some(NameSource::Fallback),
                transport: Transport::Bt,
                presence_state: PresenceState::Available,
                remembered: false,
                connected: false,
                favorite: false,
                paired: None,
                heard: None,
                heard_at: None,
                signal_info: None,
                bt_visible: None,
                last_seen_at: now_ms(),
            },
            |t| t.item.clone(),
        );
        // A presence check that missed the brick while its owner was confirming on it is older
        // than the pairing; kept, it would take the channel away when the list is next rebuilt.
        let item = DiscoveryItem {
            presence_state: PresenceState::Available,
            paired: Some(true),
            remembered: true,
            heard: None,
            heard_at: None,
            ..earlier
        };
        state
            .tracked
            .insert(brick_key.clone(), Tracked { item, misses: 0 });
        let at = state.scans_started;
        state.fences.insert(
            brick_key.clone(),
            Fence {
                at,
                change: Change::Paired,
            },
        );
    }

    /// Stops the timers and drops what is tracked; a scan still in flight tells nobody.
    pub fn dispose(&self) {
        let mut state = self.lock();
        state.disposed = true;
        for timer in state.timers.drain(..) {
            timer.abort();
        }
        state.tracked.clear();
        state.fences.clear();
    }

    async fn scan(&self, providers: Vec<Arc<dyn TransportProvider>>) {
        let (providers, scan) = {
            let mut state = self.lock();
            if state.disposed {
                return;
            }
            let free: Vec<_> = providers
                .into_iter()
                .filter(|p| !state.in_flight.contains(&p.transport()))
                .collect();
            for p in &free {
                state.in_flight.insert(p.transport());
            }
            state.scans_started += 1;
            (free, state.scans_started)
        };
        let _in_flight = InFlight {
            scheduler: self,
            transports: providers.iter().map(|p| p.transport()).collect(),
        };
        let results = join_all(providers.iter().map(|p| p.discover())).await;

        let (notices, tracked) = {
            let mut state = self.lock();
            if state.disposed {
                return;
            }
            let mut notices = Vec::new();
            let mut seen = HashSet::new();
            let mut answered = HashSet::new();
            for (provider, result) in providers.iter().zip(results) {
                match result {
                    Ok(result) => {
                        answered.insert(provider.transport());
                        state.answered.insert(provider.transport());
                        apply_scan(&mut state, result, &mut seen, scan, &mut notices);
                    }
                    Err(error) => notices.push(Notice::Failed(provider.transport(), error)),
                }
            }
            self.count_misses(&mut state, &seen, &answered, scan, &mut notices);
            let tracked: Vec<_> = state.tracked.values().map(|t| t.item.clone()).collect();
            (notices, tracked)
        };

        let listeners: Vec<_> = self
            .listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        for notice in &notices {
            for listener in &listeners {
                match notice {
                    Notice::Presence(change) => listener.presence_changed(change),
                    Notice::Failed(transport, error) => listener.scan_failed(*transport, error),
                }
            }
        }
        for listener in &listeners {
            listener.scan_completed(&tracked);
        }
    }

    /// Counts a miss against each channel of an answered transport that this scan did not list.
    fn count_misses(
        &self,
        state: &mut State,
        seen: &HashSet<BrickKey>,
        answered: &HashSet<Transport>,
        scan: u64,
        notices: &mut Vec<Notice>,
    ) {
        let keys: Vec<BrickKey> = state.tracked.keys().cloned().collect();
        for key in keys {
            if seen.contains(&key) {
                continue;
            }
            // It read the list before the pairing; its silence is no evidence the brick has gone.
            if older_than_change(state, &key, scan) == Some(Change::Paired) {
                continue;
            }
            let Some(tracked) = state.tracked.get_mut(&key) else {
                continue;
            };
            if !answered.contains(&tracked.item.transport) {
                continue;
            }
            let previous = tracked.item.presence_state;
            if matches!(previous, PresenceState::Removed | PresenceState::Remembered) {
                continue;
            }
            tracked.misses += 1;
            let next = match previous {
                PresenceState::Available
                    if tracked.misses >= self.config.unavailable_after_misses =>
                {
                    PresenceState::Unavailable
                }
                PresenceState::Unavailable
                    if tracked.misses
                        >= self.config.unavailable_after_misses
                            + self.config.removed_after_misses =>
                {
                    PresenceState::Removed
                }
                _ => continue,
            };
            tracked.item.presence_state = next;
            let item = tracked.item.clone();
            if next == PresenceState::Removed {
                state.tracked.remove(&key);
            }
            notices.push(Notice::Presence(PresenceChange {
                brick_key: key,
                previous: Some(previous),
                current: next,
                item,
            }));
        }
    }
}

/// Whether scan number `scan` began before the cockpit's own change to `key`, and which change.
fn older_than_change(state: &State, key: &BrickKey, scan: u64) -> Option<Change> {
    state
        .fences
        .get(key)
        .filter(|fence| scan <= fence.at)
        .map(|fence| fence.change)
}

/// Applies what scan number `scan` listed; nothing for a key the cockpit changed since it began.
fn apply_scan(
    state: &mut State,
    result: DiscoveryScanResult,
    seen: &mut HashSet<BrickKey>,
    scan: u64,
    notices: &mut Vec<Notice>,
) {
    for item in result.items {
        let key = item.brick_key.clone();
        if older_than_change(state, &key, scan).is_some() {
            continue;
        }
        state.fences.remove(&key);
        seen.insert(key.clone());
        match state.tracked.get_mut(&key) {
            None => {
                let item = DiscoveryItem {
                    presence_state: PresenceState::Available,
                    ..item
                };
                state.tracked.insert(
                    key.clone(),
                    Tracked {
                        item: item.clone(),
                        misses: 0,
                    },
                );
                notices.push(Notice::Presence(PresenceChange {
                    brick_key: key,
                    previous: None,
                    current: PresenceState::Available,
                    item,
                }));
            }
            Some(tracked) => {
                let previous = tracked.item.presence_state;
                tracked.item = DiscoveryItem {
                    presence_state: PresenceState::Available,
                    remembered: tracked.item.remembered,
                    favorite: tracked.item.favorite,
                    ..item
                };
                tracked.misses = 0;
                if previous != PresenceState::Available {
                    notices.push(Notice::Presence(PresenceChange {
                        brick_key: key,
                        previous: Some(previous),
                        current: PresenceState::Available,
                        item: tracked.item.clone(),
                    }));
                }
            }
        }
    }
}
