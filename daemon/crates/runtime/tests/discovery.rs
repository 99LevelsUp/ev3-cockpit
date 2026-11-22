//! Discovery: scans, presence from scan to scan, and the fences that keep a scan older than the
//! cockpit's own change from speaking for a key.
//!
//! Time is tokio's paused clock.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use async_trait::async_trait;
use ev3_runtime::{DiscoveryConfig, DiscoveryListener, DiscoveryScheduler, PresenceChange};
use ev3_transports::{
    BrickKey, DiscoveryItem, DiscoveryScanResult, PresenceState, SendOptions, SessionHandle,
    Transport, TransportCapabilities, TransportError, TransportProvider,
};
use tokio::sync::Semaphore;
use tokio::time::{Instant, sleep};

fn key(transport: Transport, id: &str) -> BrickKey {
    BrickKey::new(transport, id).unwrap()
}

fn item(id: &str, transport: Transport) -> DiscoveryItem {
    DiscoveryItem {
        brick_key: key(transport, id),
        display_name: format!("Brick {id}"),
        name_source: None,
        transport,
        presence_state: PresenceState::Available,
        remembered: false,
        connected: false,
        favorite: false,
        paired: None,
        heard: None,
        heard_at: None,
        signal_info: None,
        bt_visible: None,
        last_seen_at: 0,
    }
}

/// A brick an inquiry heard: listed, not paired.
fn sighting() -> DiscoveryItem {
    DiscoveryItem {
        paired: Some(false),
        ..item("00:16:53:00:00:0A", Transport::Bt)
    }
}

/// A provider whose list a test changes between scans; held, each scan waits for the test to let
/// it finish and then answers the list as it is at that moment.
struct Scans {
    transport: Transport,
    items: Mutex<Vec<DiscoveryItem>>,
    fail: Mutex<bool>,
    held: Mutex<bool>,
    pending: AtomicUsize,
    release: Semaphore,
    calls: AtomicUsize,
}

impl Scans {
    fn new(transport: Transport, items: Vec<DiscoveryItem>) -> Arc<Self> {
        Arc::new(Self {
            transport,
            items: Mutex::new(items),
            fail: Mutex::new(false),
            held: Mutex::new(false),
            pending: AtomicUsize::new(0),
            release: Semaphore::new(0),
            calls: AtomicUsize::new(0),
        })
    }

    fn held(transport: Transport, items: Vec<DiscoveryItem>) -> Arc<Self> {
        let scans = Self::new(transport, items);
        *scans.held.lock().unwrap() = true;
        scans
    }

    fn set(&self, items: Vec<DiscoveryItem>) {
        *self.items.lock().unwrap() = items;
    }

    fn pending(&self) -> usize {
        self.pending.load(Ordering::SeqCst)
    }

    fn release_all(&self) {
        self.release.add_permits(self.pending());
    }

    fn provider(self: &Arc<Self>) -> Arc<dyn TransportProvider> {
        self.clone()
    }
}

#[async_trait]
impl TransportProvider for Scans {
    fn transport(&self) -> Transport {
        self.transport
    }

    fn priority(&self) -> i32 {
        0
    }

    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities::default()
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let held = *self.held.lock().unwrap();
        if held {
            self.pending.fetch_add(1, Ordering::SeqCst);
            self.release.acquire().await.unwrap().forget();
            self.pending.fetch_sub(1, Ordering::SeqCst);
        }
        if *self.fail.lock().unwrap() {
            return Err(TransportError::transport_failed(
                "TCP discovery is disabled for this provider",
            ));
        }
        Ok(DiscoveryScanResult {
            transport: self.transport,
            items: self.items.lock().unwrap().clone(),
        })
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        Ok(SessionHandle {
            brick_key: brick_key.clone(),
            transport: self.transport,
        })
    }

    async fn disconnect(&self, _brick_key: &BrickKey) -> Result<(), TransportError> {
        Ok(())
    }

    async fn send_packet(
        &self,
        _brick_key: &BrickKey,
        _packet: &[u8],
        _options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        Ok(Vec::new())
    }
}

/// Hears the scheduler.
#[derive(Default)]
struct Heard {
    changes: Mutex<Vec<PresenceChange>>,
    failures: Mutex<Vec<Transport>>,
}

impl DiscoveryListener for Heard {
    fn presence_changed(&self, change: &PresenceChange) {
        self.changes.lock().unwrap().push(change.clone());
    }

    fn scan_failed(&self, transport: Transport, _error: &TransportError) {
        self.failures.lock().unwrap().push(transport);
    }
}

impl Heard {
    fn on(scheduler: &DiscoveryScheduler) -> Arc<Self> {
        let heard = Arc::new(Self::default());
        let weak: Weak<dyn DiscoveryListener> =
            Arc::downgrade(&heard) as Weak<dyn DiscoveryListener>;
        scheduler.add_listener(weak);
        heard
    }

    fn changes(&self) -> Vec<(BrickKey, Option<PresenceState>, PresenceState)> {
        self.changes
            .lock()
            .unwrap()
            .iter()
            .map(|c| (c.brick_key.clone(), c.previous, c.current))
            .collect()
    }
}

fn scheduler(providers: &[&Arc<Scans>], config: DiscoveryConfig) -> Arc<DiscoveryScheduler> {
    DiscoveryScheduler::new(providers.iter().map(|p| p.provider()), config)
}

fn misses(unavailable: u32, removed: u32) -> DiscoveryConfig {
    DiscoveryConfig {
        unavailable_after_misses: unavailable,
        removed_after_misses: removed,
        ..DiscoveryConfig::default()
    }
}

fn presence(scheduler: &DiscoveryScheduler, key: &BrickKey) -> Option<PresenceState> {
    scheduler.tracked_item(key).map(|i| i.presence_state)
}

async fn wait_until(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !done() {
        assert!(Instant::now() < deadline, "the condition never held");
        sleep(Duration::from_millis(1)).await;
    }
}

/// Runs a scan on its own task, so the test can act while the provider holds it.
fn scan_in_background(scheduler: &Arc<DiscoveryScheduler>) -> tokio::task::JoinHandle<()> {
    let scheduler = scheduler.clone();
    tokio::spawn(async move { scheduler.scan_once().await })
}

// ── Scans ───────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn discovers_bricks_from_a_single_provider() {
    let mock = Scans::new(Transport::Mock, vec![item("a", Transport::Mock)]);
    let scheduler = scheduler(&[&mock], DiscoveryConfig::default());
    scheduler.scan_once().await;
    assert_eq!(scheduler.tracked().len(), 1);
    assert_eq!(
        presence(&scheduler, &key(Transport::Mock, "a")),
        Some(PresenceState::Available)
    );
}

#[tokio::test(start_paused = true)]
async fn discovers_bricks_from_several_providers() {
    let mock = Scans::new(Transport::Mock, vec![item("a", Transport::Mock)]);
    let usb = Scans::new(Transport::Usb, vec![item("b", Transport::Usb)]);
    let scheduler = scheduler(&[&mock, &usb], DiscoveryConfig::default());
    scheduler.scan_once().await;
    assert_eq!(scheduler.tracked().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn tracks_a_brick_seen_in_consecutive_scans_once() {
    let mock = Scans::new(Transport::Mock, vec![item("a", Transport::Mock)]);
    let scheduler = scheduler(&[&mock], DiscoveryConfig::default());
    scheduler.scan_once().await;
    scheduler.scan_once().await;
    assert_eq!(scheduler.tracked().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn has_scanned_only_once_a_scan_of_the_transport_answered() {
    let tcp = Scans::new(Transport::Tcp, vec![]);
    let scheduler = scheduler(&[&tcp], DiscoveryConfig::default());
    assert!(!scheduler.has_scanned(Transport::Tcp));
    *tcp.fail.lock().unwrap() = true;
    scheduler.scan_once().await;
    assert!(
        !scheduler.has_scanned(Transport::Tcp),
        "a failed scan answered nothing"
    );
    *tcp.fail.lock().unwrap() = false;
    scheduler.scan_once().await;
    assert!(scheduler.has_scanned(Transport::Tcp));
}

// ── Presence from scan to scan ──────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn reports_a_first_discovery_as_available_with_no_state_before() {
    let mock = Scans::new(Transport::Mock, vec![item("a", Transport::Mock)]);
    let scheduler = scheduler(&[&mock], DiscoveryConfig::default());
    let heard = Heard::on(&scheduler);
    scheduler.scan_once().await;
    assert_eq!(
        heard.changes(),
        vec![(key(Transport::Mock, "a"), None, PresenceState::Available)]
    );
}

#[tokio::test(start_paused = true)]
async fn turns_an_available_channel_unavailable_after_the_missed_scans() {
    let mock = Scans::new(Transport::Mock, vec![item("a", Transport::Mock)]);
    let scheduler = scheduler(&[&mock], misses(2, 3));
    let heard = Heard::on(&scheduler);
    scheduler.scan_once().await;
    mock.set(vec![]);
    scheduler.scan_once().await;
    assert_eq!(heard.changes().len(), 1, "one miss of two moves nothing");
    scheduler.scan_once().await;
    assert_eq!(
        heard.changes()[1],
        (
            key(Transport::Mock, "a"),
            Some(PresenceState::Available),
            PresenceState::Unavailable
        )
    );
}

#[tokio::test(start_paused = true)]
async fn removes_an_unavailable_channel_after_the_further_misses() {
    let mock = Scans::new(Transport::Mock, vec![item("a", Transport::Mock)]);
    let scheduler = scheduler(&[&mock], misses(1, 2));
    let heard = Heard::on(&scheduler);
    scheduler.scan_once().await;
    mock.set(vec![]);
    for _ in 0..3 {
        scheduler.scan_once().await;
    }
    assert!(
        heard
            .changes()
            .iter()
            .any(|c| c.2 == PresenceState::Removed)
    );
    assert!(
        scheduler.tracked().is_empty(),
        "a removed channel is no longer tracked"
    );
}

#[tokio::test(start_paused = true)]
async fn brings_an_unavailable_channel_back_when_it_is_seen_again() {
    let mock = Scans::new(Transport::Mock, vec![item("a", Transport::Mock)]);
    let scheduler = scheduler(&[&mock], misses(1, 5));
    let heard = Heard::on(&scheduler);
    scheduler.scan_once().await;
    mock.set(vec![]);
    scheduler.scan_once().await;
    mock.set(vec![item("a", Transport::Mock)]);
    scheduler.scan_once().await;
    assert!(heard.changes().contains(&(
        key(Transport::Mock, "a"),
        Some(PresenceState::Unavailable),
        PresenceState::Available
    )));
}

#[tokio::test(start_paused = true)]
async fn says_nothing_while_a_channel_stays_available() {
    let mock = Scans::new(Transport::Mock, vec![item("a", Transport::Mock)]);
    let scheduler = scheduler(&[&mock], DiscoveryConfig::default());
    scheduler.scan_once().await;
    let heard = Heard::on(&scheduler);
    scheduler.scan_once().await;
    scheduler.scan_once().await;
    assert!(heard.changes().is_empty());
}

// ── A scan that told nothing ────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn reports_a_failed_scan_and_goes_on() {
    let mock = Scans::new(Transport::Mock, vec![]);
    *mock.fail.lock().unwrap() = true;
    let scheduler = scheduler(&[&mock], DiscoveryConfig::default());
    let heard = Heard::on(&scheduler);
    scheduler.scan_once().await;
    assert!(scheduler.tracked().is_empty());
    // A silently skipped provider is indistinguishable from a transport with no bricks, while
    // its tracked bricks keep accruing misses toward removal.
    assert_eq!(*heard.failures.lock().unwrap(), vec![Transport::Mock]);
}

#[tokio::test(start_paused = true)]
async fn counts_no_miss_for_a_transport_whose_scan_is_still_running() {
    let slow = key(Transport::Mock, "slow-brick");
    let mock = Scans::new(Transport::Mock, vec![item("slow-brick", Transport::Mock)]);
    // One missed scan is enough to leave available, so the check is sharp.
    let scheduler = scheduler(&[&mock], misses(1, 5));
    scheduler.scan_once().await;
    assert_eq!(presence(&scheduler, &slow), Some(PresenceState::Available));

    *mock.held.lock().unwrap() = true;
    let in_flight = scan_in_background(&scheduler);
    wait_until(|| mock.pending() == 1).await;
    // This scan finds the transport busy and scans nothing at all.
    scheduler.scan_once().await;
    assert_eq!(
        presence(&scheduler, &slow),
        Some(PresenceState::Available),
        "a transport nobody scanned must not cost its bricks a miss"
    );
    assert_eq!(
        mock.calls.load(Ordering::SeqCst),
        2,
        "a second scan was stacked on the first"
    );
    mock.release_all();
    in_flight.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn counts_no_miss_for_a_transport_whose_scan_failed() {
    let aaa = key(Transport::Tcp, "aaa");
    let tcp = Scans::new(Transport::Tcp, vec![item("aaa", Transport::Tcp)]);
    // One miss demotes and two more remove, so three failed scans would evict the brick if a
    // failed scan counted as one.
    let scheduler = scheduler(&[&tcp], misses(1, 2));
    scheduler.scan_once().await;
    *tcp.fail.lock().unwrap() = true;
    for _ in 0..3 {
        scheduler.scan_once().await;
    }
    assert_eq!(
        presence(&scheduler, &aaa),
        Some(PresenceState::Available),
        "a transport that could not answer must not report its bricks absent"
    );
}

// ── Forgetting ──────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn forgets_a_key_silently_and_reports_it_as_new_when_listed_again() {
    let bt = item("00:16:53:00:00:0A", Transport::Bt);
    let usb = item("00165300000A", Transport::Usb);
    let bts = Scans::new(Transport::Bt, vec![bt.clone()]);
    let usbs = Scans::new(Transport::Usb, vec![usb.clone()]);
    let scheduler = scheduler(&[&bts, &usbs], DiscoveryConfig::default());
    scheduler.scan_once().await;

    let heard = Heard::on(&scheduler);
    scheduler.forget(std::slice::from_ref(&bt.brick_key));
    assert!(
        heard.changes().is_empty(),
        "whoever forgets the brick clears the list itself"
    );
    assert!(scheduler.tracked_item(&bt.brick_key).is_none());
    assert!(
        scheduler.tracked_item(&usb.brick_key).is_some(),
        "only the given keys go"
    );

    scheduler.scan_once().await;
    assert_eq!(
        heard.changes(),
        vec![(bt.brick_key.clone(), None, PresenceState::Available)]
    );
}

#[tokio::test(start_paused = true)]
async fn drops_what_a_scan_older_than_the_forget_lists_for_the_forgotten_key() {
    let forgotten = item("00:16:53:00:00:0A", Transport::Bt);
    let other = item("00:16:53:00:00:0B", Transport::Bt);
    let bt = Scans::held(Transport::Bt, vec![forgotten.clone(), other.clone()]);
    let scheduler = scheduler(&[&bt], DiscoveryConfig::default());
    let heard = Heard::on(&scheduler);

    let scan = scan_in_background(&scheduler);
    wait_until(|| bt.pending() == 1).await;
    scheduler.forget(std::slice::from_ref(&forgotten.brick_key));
    bt.release_all();
    scan.await.unwrap();

    assert!(
        scheduler.tracked_item(&forgotten.brick_key).is_none(),
        "it read the list before the forget; it cannot bring the key back"
    );
    assert!(
        scheduler.tracked_item(&other.brick_key).is_some(),
        "only the forgotten key is fenced"
    );
    let keys: Vec<BrickKey> = heard.changes().into_iter().map(|c| c.0).collect();
    assert_eq!(keys, vec![other.brick_key]);
}

#[tokio::test(start_paused = true)]
async fn drops_it_from_a_timer_scan_begun_before_the_forget() {
    let forgotten = item("00:16:53:00:00:0A", Transport::Bt);
    let bt = Scans::held(Transport::Bt, vec![forgotten.clone()]);
    let scheduler = scheduler(
        &[&bt],
        DiscoveryConfig {
            default_interval: Duration::from_millis(5),
            ..DiscoveryConfig::default()
        },
    );
    scheduler.start();
    wait_until(|| bt.pending() == 1).await;
    scheduler.stop();
    scheduler.forget(std::slice::from_ref(&forgotten.brick_key));
    bt.release_all();
    sleep(Duration::from_millis(30)).await;
    assert!(scheduler.tracked_item(&forgotten.brick_key).is_none());
}

#[tokio::test(start_paused = true)]
async fn tracks_the_key_again_from_a_scan_begun_after_the_forget() {
    let forgotten = item("00:16:53:00:00:0A", Transport::Bt);
    let bt = Scans::held(Transport::Bt, vec![forgotten.clone()]);
    let scheduler = scheduler(&[&bt], DiscoveryConfig::default());

    let stale = scan_in_background(&scheduler);
    wait_until(|| bt.pending() == 1).await;
    scheduler.forget(std::slice::from_ref(&forgotten.brick_key));
    bt.release_all();
    stale.await.unwrap();

    let fresh = scan_in_background(&scheduler);
    wait_until(|| bt.pending() == 1).await;
    bt.release_all();
    fresh.await.unwrap();
    assert!(
        scheduler.tracked_item(&forgotten.brick_key).is_some(),
        "a scan that read the list after the forget says what is there now"
    );
}

// ── A pairing the cockpit made ──────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn tracks_a_brick_paired_here_as_available_and_paired_at_once_and_says_nothing() {
    let brick = sighting();
    let bt = Scans::new(Transport::Bt, vec![brick.clone()]);
    let scheduler = scheduler(&[&bt], DiscoveryConfig::default());
    scheduler.scan_once().await;
    let heard = Heard::on(&scheduler);

    scheduler.note_paired(&brick.brick_key);

    let tracked = scheduler.tracked_item(&brick.brick_key).unwrap();
    assert_eq!(tracked.paired, Some(true));
    assert_eq!(tracked.presence_state, PresenceState::Available);
    assert!(
        heard.changes().is_empty(),
        "the caller updates the list; an announcement would start a name probe"
    );
}

#[tokio::test(start_paused = true)]
async fn tracks_a_brick_whose_sighting_expired_during_the_pairing() {
    let scheduler = DiscoveryScheduler::new([], DiscoveryConfig::default());
    let brick = key(Transport::Bt, "00:16:53:00:00:0A");
    scheduler.note_paired(&brick);
    let tracked = scheduler.tracked_item(&brick).unwrap();
    assert_eq!(tracked.transport, Transport::Bt);
    assert_eq!(tracked.paired, Some(true));
    assert_eq!(tracked.presence_state, PresenceState::Available);
}

#[tokio::test(start_paused = true)]
async fn counts_no_miss_from_a_scan_begun_before_the_pairing_that_does_not_list_the_brick() {
    let brick = sighting();
    let bt = Scans::new(Transport::Bt, vec![brick.clone()]);
    let scheduler = scheduler(&[&bt], misses(1, 5));
    scheduler.scan_once().await;

    // The inquiry's sighting aged out before this scan read the list.
    bt.set(vec![]);
    *bt.held.lock().unwrap() = true;
    let stale = scan_in_background(&scheduler);
    wait_until(|| bt.pending() == 1).await;
    scheduler.note_paired(&brick.brick_key);
    bt.release_all();
    stale.await.unwrap();

    assert_eq!(
        presence(&scheduler, &brick.brick_key),
        Some(PresenceState::Available),
        "an older reading took the freshly paired brick away"
    );
}

#[tokio::test(start_paused = true)]
async fn keeps_the_pairing_when_a_scan_begun_before_it_lists_the_brick_unpaired() {
    let brick = sighting();
    let bt = Scans::held(Transport::Bt, vec![brick.clone()]);
    let scheduler = scheduler(&[&bt], DiscoveryConfig::default());

    let stale = scan_in_background(&scheduler);
    wait_until(|| bt.pending() == 1).await;
    scheduler.note_paired(&brick.brick_key);
    bt.release_all();
    stale.await.unwrap();

    assert_eq!(
        scheduler.tracked_item(&brick.brick_key).unwrap().paired,
        Some(true),
        "an older reading undid the pairing"
    );
}

#[tokio::test(start_paused = true)]
async fn lets_a_scan_begun_after_the_pairing_count_misses_so_a_gone_brick_expires() {
    let brick = sighting();
    let bt = Scans::new(Transport::Bt, vec![]);
    let scheduler = scheduler(&[&bt], misses(1, 1));
    scheduler.note_paired(&brick.brick_key);
    for _ in 0..2 {
        scheduler.scan_once().await;
    }
    assert!(
        scheduler.tracked_item(&brick.brick_key).is_none(),
        "a pairing nothing lists any more is tracked for ever"
    );
}

// ── Timers ──────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn scans_each_transport_on_its_own_timer_a_full_interval_after_start() {
    let usb = Scans::new(Transport::Usb, vec![item("00165300000A", Transport::Usb)]);
    let bt = Scans::new(Transport::Bt, vec![]);
    let scheduler = scheduler(
        &[&usb, &bt],
        DiscoveryConfig {
            default_interval: Duration::from_millis(3000),
            interval_overrides: [(Transport::Bt, Duration::from_millis(10_000))].into(),
            ..DiscoveryConfig::default()
        },
    );
    scheduler.start();
    sleep(Duration::from_millis(2900)).await;
    assert_eq!(
        usb.calls.load(Ordering::SeqCst),
        0,
        "a scan came before the first interval"
    );
    sleep(Duration::from_millis(200)).await;
    assert_eq!(usb.calls.load(Ordering::SeqCst), 1);
    assert_eq!(scheduler.tracked().len(), 1);
    sleep(Duration::from_millis(7000)).await;
    assert_eq!(usb.calls.load(Ordering::SeqCst), 3);
    assert_eq!(bt.calls.load(Ordering::SeqCst), 1);
    scheduler.stop();
    sleep(Duration::from_millis(10_000)).await;
    assert_eq!(
        usb.calls.load(Ordering::SeqCst),
        3,
        "a stopped timer scanned again"
    );
}
