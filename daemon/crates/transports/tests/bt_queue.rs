//! The Bluetooth connection queue: one slot, grants spaced by the gap after a release and the
//! longer recovery after a failure, hold-only slots for presence, and the per-brick pause after a
//! close. On tokio's paused clock, so the shipped pauses run in no real time.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use ev3_transports::TransportError;
use ev3_transports::bt::queue::{
    ACQUIRE_TIMEOUT, BtConnectionQueue, ERROR_BACKOFF_MAX, ERROR_RECOVERY_COOLDOWN,
    INTER_CONNECTION_COOLDOWN, QueueTimings, RECONNECT_GAP_AFTER_CLOSE, ReconnectGap, SlotKind,
};
use tokio::time::{Instant, sleep};

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn queue(inter: u64, error: u64, acquire: u64) -> Arc<BtConnectionQueue> {
    Arc::new(BtConnectionQueue::new(QueueTimings {
        inter_connection_cooldown: ms(inter),
        error_recovery_cooldown: ms(error),
        error_backoff_max: Duration::from_secs(30),
        acquire_timeout: ms(acquire),
    }))
}

#[test]
fn ships_the_measured_pauses() {
    assert_eq!(INTER_CONNECTION_COOLDOWN, Duration::from_secs(15));
    assert_eq!(ERROR_RECOVERY_COOLDOWN, Duration::from_secs(30));
    assert_eq!(ERROR_BACKOFF_MAX, Duration::from_secs(30));
    assert_eq!(ACQUIRE_TIMEOUT, Duration::from_secs(45));
    assert_eq!(RECONNECT_GAP_AFTER_CLOSE, Duration::from_secs(5));
    let defaults = QueueTimings::default();
    assert_eq!(
        defaults.inter_connection_cooldown,
        INTER_CONNECTION_COOLDOWN
    );
    assert_eq!(defaults.acquire_timeout, ACQUIRE_TIMEOUT);
}

#[tokio::test(start_paused = true)]
async fn waits_longer_after_a_failed_connection_than_after_a_clean_one() {
    let queue = queue(40, 400, 45_000);
    queue
        .acquire("brick-a", SlotKind::Open)
        .await
        .unwrap()
        .release(false);
    let after_clean = Instant::now();
    queue
        .acquire("brick-a", SlotKind::Open)
        .await
        .unwrap()
        .release(false);
    let clean_wait = after_clean.elapsed();

    queue
        .acquire("brick-a", SlotKind::Open)
        .await
        .unwrap()
        .release(true);
    let after_failure = Instant::now();
    queue
        .acquire("brick-a", SlotKind::Open)
        .await
        .unwrap()
        .release(false);
    let failure_wait = after_failure.elapsed();

    assert!(
        clean_wait < ms(200),
        "a clean release waited {clean_wait:?}, the failure pause"
    );
    assert!(
        failure_wait > ms(300),
        "a failed release waited only {failure_wait:?}: a failing brick would be hammered"
    );
}

#[tokio::test(start_paused = true)]
async fn acquires_and_releases_a_slot() {
    let queue = queue(0, 0, 45_000);
    let slot = queue.acquire("brick1", SlotKind::Open).await.unwrap();
    assert_eq!(queue.active(), 1);
    slot.release(false);
    assert_eq!(queue.active(), 0);
}

#[tokio::test(start_paused = true)]
async fn serializes_concurrent_connections() {
    let queue = queue(0, 0, 45_000);
    let order = Arc::new(Mutex::new(Vec::new()));
    let first = {
        let (queue, order) = (Arc::clone(&queue), Arc::clone(&order));
        tokio::spawn(async move {
            queue
                .enqueue("brick1", async {
                    order.lock().unwrap().push("start-1");
                    sleep(ms(20)).await;
                    order.lock().unwrap().push("end-1");
                    Ok::<_, TransportError>(())
                })
                .await
        })
    };
    tokio::task::yield_now().await;
    let second = {
        let (queue, order) = (Arc::clone(&queue), Arc::clone(&order));
        tokio::spawn(async move {
            queue
                .enqueue("brick2", async {
                    order.lock().unwrap().push("start-2");
                    order.lock().unwrap().push("end-2");
                    Ok::<_, TransportError>(())
                })
                .await
        })
    };
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(
        *order.lock().unwrap(),
        ["start-1", "end-1", "start-2", "end-2"]
    );
}

#[tokio::test(start_paused = true)]
async fn enqueue_auto_releases_on_error() {
    let queue = queue(0, 0, 45_000);
    let failed = queue
        .enqueue("brick1", async {
            Err::<(), _>(TransportError::transport_failed("fail"))
        })
        .await
        .unwrap_err();
    assert_eq!(failed.message, "fail");
    assert_eq!(queue.active(), 0);
}

#[tokio::test(start_paused = true)]
async fn enqueue_counts_a_failed_task_as_a_failed_release() {
    let queue = queue(0, 400, 45_000);
    let _ = queue
        .enqueue("brick1", async {
            Err::<(), _>(TransportError::transport_failed("fail"))
        })
        .await;
    let at = Instant::now();
    queue
        .acquire("brick1", SlotKind::Open)
        .await
        .unwrap()
        .release(false);
    assert!(at.elapsed() >= ms(400), "waited {:?}", at.elapsed());
}

#[tokio::test(start_paused = true)]
async fn dispose_rejects_pending_entries() {
    let queue = queue(50_000, 0, 45_000);
    let slot = queue.acquire("brick1", SlotKind::Open).await.unwrap();
    let waiter = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move { queue.acquire("brick2", SlotKind::Open).await })
    };
    tokio::task::yield_now().await;
    slot.release(false);
    // brick2 now waits out the 50 s gap; the dispose ends that wait.
    queue.dispose();
    let result = waiter.await.unwrap();
    assert_eq!(result.unwrap_err().message, "BT connection queue disposed.");
}

#[tokio::test(start_paused = true)]
async fn reports_pending_count() {
    let queue = queue(0, 0, 45_000);
    let slot = queue.acquire("brick1", SlotKind::Open).await.unwrap();
    assert_eq!(queue.pending(), 0);
    let waiter = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move { queue.acquire("brick2", SlotKind::Open).await })
    };
    sleep(ms(10)).await;
    assert_eq!(queue.pending(), 1);
    slot.release(false);
    waiter.await.unwrap().unwrap().release(false);
    assert_eq!(queue.pending(), 0);
}

#[tokio::test(start_paused = true)]
async fn fails_a_queued_acquire_with_a_stated_reason_once_the_slot_wait_times_out() {
    let queue = queue(0, 0, 30);
    let slot = queue.acquire("brick1", SlotKind::Open).await.unwrap();
    let error = queue.acquire("brick2", SlotKind::Open).await.unwrap_err();
    assert!(error.message.contains("timed out"), "{}", error.message);
    assert!(
        error.message.contains("waiting for a slot"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("busy opening another connection"),
        "{}",
        error.message
    );
    slot.release(false);
    assert_eq!(queue.pending(), 0, "the timed-out waiter leaves the line");
}

#[tokio::test(start_paused = true)]
async fn does_not_time_out_a_waiter_while_the_slot_is_free_and_only_the_recovery_pause_runs() {
    let queue = queue(0, 80, 50);
    let slot = queue.acquire("brick1", SlotKind::Open).await.unwrap();
    let waiter = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move { queue.acquire("brick2", SlotKind::Open).await })
    };
    sleep(ms(20)).await;
    slot.release(true);
    let second = waiter
        .await
        .unwrap()
        .expect("granted after the pause, not timed out");
    assert_eq!(queue.active(), 1);
    second.release(false);
}

#[tokio::test(start_paused = true)]
async fn still_times_out_a_waiter_whose_slot_another_operation_takes_after_a_recovery_pause() {
    let queue = queue(0, 40, 30);
    let slot = queue.acquire("brick1", SlotKind::Open).await.unwrap();
    let first = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move { queue.acquire("brick2", SlotKind::Open).await })
    };
    tokio::task::yield_now().await;
    let second = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move { queue.acquire("brick3", SlotKind::Open).await })
    };
    tokio::task::yield_now().await;
    slot.release(true);
    let held = first.await.unwrap().unwrap();
    let error = second.await.unwrap().unwrap_err();
    assert!(error.message.contains("(1/1 in use)"), "{}", error.message);
    drop(held);
}

#[tokio::test(start_paused = true)]
async fn grants_a_slot_to_a_queued_acquire_before_its_ceiling_timeout_without_failing_it() {
    let queue = queue(0, 0, 500);
    let slot = queue.acquire("brick1", SlotKind::Open).await.unwrap();
    let waiter = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move { queue.acquire("brick2", SlotKind::Open).await })
    };
    sleep(ms(20)).await;
    slot.release(false);
    let second = waiter.await.unwrap().unwrap();
    assert_eq!(queue.active(), 1);
    second.release(false);
}

#[tokio::test(start_paused = true)]
async fn starts_no_cooldown_when_a_hold_only_slot_is_released() {
    let queue = queue(10_000, 0, 45_000);
    queue
        .acquire("presence", SlotKind::HoldOnly)
        .await
        .unwrap()
        .release(false);
    let at = Instant::now();
    queue
        .acquire("connect", SlotKind::Open)
        .await
        .unwrap()
        .release(false);
    assert!(at.elapsed() < ms(200));
}

#[tokio::test(start_paused = true)]
async fn counts_no_error_when_a_hold_only_slot_is_released_with_one() {
    let queue = queue(0, 10_000, 45_000);
    queue
        .acquire("presence", SlotKind::HoldOnly)
        .await
        .unwrap()
        .release(true);
    let at = Instant::now();
    queue
        .acquire("connect", SlotKind::Open)
        .await
        .unwrap()
        .release(false);
    assert!(at.elapsed() < ms(200));
}

#[tokio::test(start_paused = true)]
async fn an_open_slot_dropped_without_a_release_counts_as_failed() {
    let queue = queue(0, 400, 45_000);
    drop(queue.acquire("brick1", SlotKind::Open).await.unwrap());
    assert_eq!(queue.active(), 0);
    let at = Instant::now();
    queue
        .acquire("brick1", SlotKind::Open)
        .await
        .unwrap()
        .release(false);
    assert!(at.elapsed() >= ms(400), "waited only {:?}", at.elapsed());
}

#[tokio::test(start_paused = true)]
async fn a_dropped_acquire_leaves_the_line() {
    let queue = queue(0, 0, 45_000);
    let slot = queue.acquire("brick1", SlotKind::Open).await.unwrap();
    let abandoned = tokio::time::timeout(ms(10), queue.acquire("brick2", SlotKind::Open)).await;
    assert!(abandoned.is_err());
    assert_eq!(queue.pending(), 0);
    slot.release(false);
    queue
        .acquire("brick3", SlotKind::Open)
        .await
        .unwrap()
        .release(false);
}

#[tokio::test(start_paused = true)]
async fn the_recovery_doubles_with_each_failure_up_to_its_ceiling() {
    let queue = Arc::new(BtConnectionQueue::new(QueueTimings {
        inter_connection_cooldown: ms(0),
        error_recovery_cooldown: ms(100),
        error_backoff_max: ms(250),
        acquire_timeout: Duration::from_secs(45),
    }));
    let mut waits = Vec::new();
    queue
        .acquire("b", SlotKind::Open)
        .await
        .unwrap()
        .release(true);
    for _ in 0..3 {
        let at = Instant::now();
        let slot = queue.acquire("b", SlotKind::Open).await.unwrap();
        waits.push(at.elapsed().as_millis());
        slot.release(true);
    }
    assert_eq!(waits, [100, 200, 250]);
}

#[tokio::test(start_paused = true)]
async fn gives_a_brick_its_gap_after_a_close_and_holds_no_other_brick() {
    let gap = ReconnectGap::default();
    gap.note_closed("00:16:53:AA:BB:CC");
    let at = Instant::now();
    gap.wait("00:16:53:bb:bb:dd").await;
    assert_eq!(at.elapsed(), Duration::ZERO, "another brick waited");
    // However the address is spelled.
    gap.wait("001653aabbcc").await;
    assert_eq!(at.elapsed(), Duration::from_secs(5));
}

#[tokio::test(start_paused = true)]
async fn a_forgotten_brick_is_not_held_back() {
    let gap = ReconnectGap::default();
    gap.note_closed("00:16:53:AA:BB:CC");
    gap.forget("00:16:53:AA:BB:CC");
    assert_eq!(gap.ready_at("00:16:53:AA:BB:CC"), None);
}
