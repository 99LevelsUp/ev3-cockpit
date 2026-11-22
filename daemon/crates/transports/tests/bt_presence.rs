//! Background Bluetooth presence: heard on the first answer, not heard after three misses in a
//! row, rounds that never overlap and never hold a user's connect behind them, and inquiry
//! sightings that age out.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ev3_transports::bt::presence::{
    PresenceFailure, PresenceMonitor, PresenceSource, PresenceTimings, ScannedBrick,
};
use ev3_transports::bt::queue::{BtConnectionQueue, QueueTimings, SlotKind};
use tokio::sync::Notify;
use tokio::time::{Instant, sleep};

const AAA: &str = "00:16:53:F0:0A:0A";
const BBB: &str = "00:16:53:F0:0B:0B";
const STRANGER: &str = "00:16:53:00:00:99";

#[derive(Default)]
struct Source {
    answers: Mutex<HashMap<String, Vec<bool>>>,
    inquiry: Mutex<Vec<ScannedBrick>>,
    targets: Mutex<Vec<String>>,
    checked: Mutex<Vec<String>>,
    check_delay: Option<Duration>,
    hold: Option<Arc<Notify>>,
    unavailable: bool,
    off: Option<&'static str>,
}

impl Source {
    fn targets(macs: &[&str]) -> Self {
        Self {
            targets: Mutex::new(macs.iter().map(|m| (*m).to_owned()).collect()),
            ..Self::default()
        }
    }

    fn answering(self, mac: &str, answers: &[bool]) -> Self {
        self.answers
            .lock()
            .unwrap()
            .insert(mac.to_owned(), answers.to_vec());
        self
    }

    fn hearing(self, bricks: Vec<ScannedBrick>) -> Self {
        *self.inquiry.lock().unwrap() = bricks;
        self
    }
}

#[async_trait]
impl PresenceSource for Source {
    async fn check(&self, mac: &str) -> Result<bool, PresenceFailure> {
        self.checked.lock().unwrap().push(mac.to_owned());
        if self.unavailable {
            return Err(PresenceFailure::Unavailable("helper missing".into()));
        }
        if let Some(hold) = &self.hold {
            hold.notified().await;
            return Ok(true);
        }
        if let Some(delay) = self.check_delay {
            sleep(delay).await;
            return Ok(self.off != Some(mac));
        }
        let mut answers = self.answers.lock().unwrap();
        let queue = answers.entry(mac.to_owned()).or_default();
        Ok(if queue.is_empty() {
            false
        } else {
            queue.remove(0)
        })
    }

    async fn inquire(&self) -> Result<Vec<ScannedBrick>, PresenceFailure> {
        Ok(self.inquiry.lock().unwrap().clone())
    }

    fn paired_without_session(&self) -> Vec<String> {
        self.targets.lock().unwrap().clone()
    }
}

fn quick_queue() -> Arc<BtConnectionQueue> {
    Arc::new(BtConnectionQueue::new(QueueTimings {
        inter_connection_cooldown: Duration::ZERO,
        error_recovery_cooldown: Duration::ZERO,
        ..QueueTimings::default()
    }))
}

fn monitor(queue: Arc<BtConnectionQueue>, inquiry_interval: Duration) -> Arc<PresenceMonitor> {
    Arc::new(PresenceMonitor::new(
        queue,
        PresenceTimings {
            inquiry_interval,
            ..PresenceTimings::default()
        },
    ))
}

fn sighting(mac: &str, name: &str, paired: bool, signal: i32) -> ScannedBrick {
    ScannedBrick {
        mac: mac.into(),
        name: name.into(),
        paired,
        signal: Some(signal),
    }
}

#[test]
fn ships_the_measured_rhythm() {
    let timings = PresenceTimings::default();
    assert_eq!(timings.check_interval, Duration::from_secs(60));
    assert_eq!(timings.inquiry_interval, Duration::from_secs(60));
    assert_eq!(timings.misses_before_not_heard, 3);
}

#[tokio::test(start_paused = true)]
async fn counts_a_brick_heard_on_its_first_answer_and_not_heard_only_after_three_misses_in_a_row() {
    let presence = monitor(quick_queue(), Duration::from_secs(60));
    let source = Source::targets(&[AAA]).answering(AAA, &[false, false, false, true]);

    presence.run_checks(&source).await;
    presence.run_checks(&source).await;
    assert!(
        presence.presence_of(AAA).unwrap().heard,
        "two misses may be the adapter, not the brick"
    );
    presence.run_checks(&source).await;
    assert!(!presence.presence_of(AAA).unwrap().heard);

    presence.run_checks(&source).await;
    let state = presence.presence_of(AAA).unwrap();
    assert!(state.heard);
    assert!(state.heard_at.is_some());
}

#[tokio::test(start_paused = true)]
async fn knows_nothing_about_a_brick_before_its_first_check() {
    let presence = monitor(quick_queue(), Duration::from_secs(60));
    assert_eq!(presence.presence_of(AAA), None);
}

#[tokio::test(start_paused = true)]
async fn does_not_start_a_round_while_the_previous_one_is_still_running() {
    let presence = monitor(quick_queue(), Duration::from_secs(60));
    let hold = Arc::new(Notify::new());
    let source = Arc::new(Source {
        hold: Some(Arc::clone(&hold)),
        ..Source::targets(&[AAA])
    });
    let first = {
        let (presence, source) = (Arc::clone(&presence), Arc::clone(&source));
        tokio::spawn(async move { presence.run_checks(source.as_ref()).await })
    };
    sleep(Duration::from_millis(10)).await;
    presence.run_checks(source.as_ref()).await; // returns at once
    hold.notify_one();
    first.await.unwrap();
    assert_eq!(*source.checked.lock().unwrap(), [AAA]);
}

#[tokio::test(start_paused = true)]
async fn forgets_what_it_knew_about_a_brick_once_that_brick_has_a_session() {
    let presence = monitor(quick_queue(), Duration::from_secs(60));
    let source = Source::targets(&[AAA]).answering(AAA, &[false, false, false]);
    for _ in 0..3 {
        presence.run_checks(&source).await;
    }
    assert!(!presence.presence_of(AAA).unwrap().heard);

    source.targets.lock().unwrap().clear(); // the brick connected
    presence.run_checks(&source).await;
    assert_eq!(presence.presence_of(AAA), None);
}

#[tokio::test(start_paused = true)]
async fn does_not_hold_up_a_connect_queued_behind_a_full_round_with_a_switched_off_brick() {
    // The shipped pauses: 15 s after a release, 30 s after a failure.
    let queue = Arc::new(BtConnectionQueue::default());
    let presence = monitor(Arc::clone(&queue), Duration::from_secs(60));
    let source = Arc::new(Source {
        check_delay: Some(Duration::from_millis(30)),
        off: Some(BBB),
        ..Source::targets(&[AAA, BBB, "00:16:53:F0:0C:0C"])
    });
    let round = {
        let (presence, source) = (Arc::clone(&presence), Arc::clone(&source));
        tokio::spawn(async move { presence.run_checks(source.as_ref()).await })
    };
    sleep(Duration::from_millis(5)).await;
    let queued_at = Instant::now();
    let slot = queue.acquire("user connect", SlotKind::Open).await.unwrap();
    let waited = queued_at.elapsed();
    slot.release(false);
    round.await.unwrap();

    assert!(
        waited < Duration::from_millis(500),
        "the connect waited {waited:?} behind presence checks"
    );
}

#[tokio::test(start_paused = true)]
async fn stops_and_says_so_once_when_the_platform_cannot_run_it() {
    let presence = monitor(quick_queue(), Duration::from_secs(60));
    let source = Source {
        unavailable: true,
        ..Source::targets(&[AAA])
    };
    presence.run_checks(&source).await;
    presence.run_checks(&source).await;
    assert_eq!(
        presence.unavailable_reason().as_deref(),
        Some("helper missing")
    );
    assert!(presence.is_stopped());
    assert_eq!(
        source.checked.lock().unwrap().len(),
        1,
        "the second round never ran"
    );
}

#[tokio::test(start_paused = true)]
async fn keeps_the_unpaired_bricks_an_inquiry_heard_and_leaves_the_paired_ones_to_their_checks() {
    let presence = monitor(quick_queue(), Duration::from_secs(60));
    let source = Source::default().hearing(vec![
        sighting(STRANGER, "Stranger", false, -40),
        sighting(AAA, "Stranger", true, -40),
    ]);
    presence.run_inquiry(&source).await;
    let macs: Vec<String> = presence
        .unpaired_bricks()
        .into_iter()
        .map(|b| b.mac)
        .collect();
    assert_eq!(macs, [STRANGER]);
}

#[tokio::test(start_paused = true)]
async fn drops_a_brick_two_inquiry_intervals_went_by_without_hearing() {
    let presence = monitor(quick_queue(), Duration::from_millis(10));
    let source = Source::default().hearing(vec![sighting(STRANGER, "Stranger", false, -40)]);
    presence.run_inquiry(&source).await;
    source.inquiry.lock().unwrap().clear();
    sleep(Duration::from_millis(30)).await;
    presence.run_inquiry(&source).await;
    assert!(presence.unpaired_bricks().is_empty());
}

#[tokio::test(start_paused = true)]
async fn keeps_a_brick_one_missed_inquiry_window_did_not_hear() {
    let presence = monitor(quick_queue(), Duration::from_millis(10));
    let source = Source::default().hearing(vec![sighting(STRANGER, "Stranger", false, -40)]);
    presence.run_inquiry(&source).await;
    source.inquiry.lock().unwrap().clear();
    sleep(Duration::from_millis(15)).await;
    presence.run_inquiry(&source).await;
    assert_eq!(
        presence.unpaired_bricks().len(),
        1,
        "one miss can be the radio"
    );
}

#[tokio::test(start_paused = true)]
async fn forget_drops_both_what_the_checks_said_and_what_the_inquiry_heard_however_the_address_is_written()
 {
    let presence = monitor(quick_queue(), Duration::from_secs(60));
    let source = Source::targets(&[AAA, BBB])
        .answering(AAA, &[true])
        .answering(BBB, &[true])
        .hearing(vec![
            sighting(AAA, "CCC", false, -40),
            sighting(STRANGER, "CCC", false, -40),
        ]);
    presence.run_checks(&source).await;
    presence.run_inquiry(&source).await;
    assert!(presence.presence_of(AAA).unwrap().heard);
    let macs: Vec<String> = presence
        .unpaired_bricks()
        .into_iter()
        .map(|b| b.mac)
        .collect();
    assert_eq!(macs, [AAA, STRANGER]);

    presence.forget(&AAA.replace(':', "").to_lowercase());

    assert_eq!(presence.presence_of(AAA), None);
    let macs: Vec<String> = presence
        .unpaired_bricks()
        .into_iter()
        .map(|b| b.mac)
        .collect();
    assert_eq!(macs, [STRANGER]);
    assert!(
        presence.presence_of(BBB).unwrap().heard,
        "other bricks stay"
    );
}

#[tokio::test(start_paused = true)]
async fn a_pairing_drops_the_checks_from_before_it_however_the_address_is_written_and_keeps_the_rest()
 {
    let presence = monitor(quick_queue(), Duration::from_secs(60));
    let source = Source::targets(&[AAA, BBB])
        .answering(AAA, &[false, false, false])
        .answering(BBB, &[false, false, false]);
    for _ in 0..3 {
        presence.run_checks(&source).await;
    }
    assert!(
        !presence.presence_of(AAA).unwrap().heard,
        "the checks did not miss it, so this test shows nothing"
    );

    presence.note_paired(&AAA.replace(':', "").to_lowercase());

    assert_eq!(presence.presence_of(AAA), None);
    assert!(
        !presence.presence_of(BBB).unwrap().heard,
        "other bricks stay"
    );
}

#[tokio::test(start_paused = true)]
async fn tells_its_listener_after_a_round_that_changed_what_is_known() {
    let told = Arc::new(AtomicUsize::new(0));
    let presence = {
        let told = Arc::clone(&told);
        Arc::new(
            PresenceMonitor::new(quick_queue(), PresenceTimings::default()).with_on_change(
                move || {
                    told.fetch_add(1, Ordering::SeqCst);
                },
            ),
        )
    };
    let source = Source::targets(&[AAA]).answering(AAA, &[false]);
    presence.run_checks(&source).await;
    assert_eq!(told.load(Ordering::SeqCst), 1, "a first check is news");
    presence.run_checks(&source).await;
    assert_eq!(
        told.load(Ordering::SeqCst),
        1,
        "a second miss changes nothing"
    );
}
