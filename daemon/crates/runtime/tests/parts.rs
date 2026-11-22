//! The session layer's parts on their own: the guard, the queue, the heartbeat's rule, the
//! backoff and the ports.

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ev3_runtime::{
    ActivityEvent, ActivityPort, Backoff, BackoffConfig, Beat, ClientKind, CommandQueue,
    ConsentAnswer, ConsentPort, ConsentRequest, ConsentSubject, DrainReason, Guard, GuardConfig,
    MissCounter, Probe, Requester, SessionError, WriteActivity, WriteScope, brick_id_of,
};
use support::{bt_key, settle, usb_key};
use tokio::sync::oneshot;
use tokio::time::Instant;

// ── Guard ───────────────────────────────────────────────────────────

#[test]
fn one_brick_has_one_identity_across_its_channels() {
    assert_eq!(brick_id_of(&usb_key()), brick_id_of(&bt_key()));
    let mock = ev3_transports::BrickKey::new(ev3_transports::Transport::Mock, "brick-a").unwrap();
    assert_eq!(brick_id_of(&mock), "mock:brick-a");
}

#[tokio::test(start_paused = true)]
async fn a_full_window_delays_the_1001st_command_instead_of_refusing_it() {
    let guard = Guard::default();
    let key = usb_key();
    let started = Instant::now();
    for _ in 0..1000 {
        guard.acquire(&key).await.unwrap();
    }
    assert_eq!(
        started.elapsed(),
        Duration::ZERO,
        "the guard metered a burst below the ceiling"
    );
    guard
        .acquire(&key)
        .await
        .expect("a full window must wait, not refuse");
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_secs(1) && waited <= Duration::from_millis(1002),
        "the 1001st command waited {waited:?}, not until the oldest left the window"
    );
}

#[tokio::test(start_paused = true)]
async fn the_window_is_shared_by_every_channel_of_a_brick() {
    let guard = Guard::new(GuardConfig {
        max_commands_per_sec: 3,
        ..GuardConfig::default()
    });
    let started = Instant::now();
    guard.acquire(&usb_key()).await.unwrap();
    guard.acquire(&bt_key()).await.unwrap();
    guard.acquire(&usb_key()).await.unwrap();
    guard.acquire(&bt_key()).await.unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(1000),
        "the fourth command in the brick's window must wait for it to turn"
    );
}

#[tokio::test]
async fn failures_degrade_one_channel_and_leave_the_other_channel_of_the_brick_alone() {
    let guard = Guard::default();
    for _ in 0..3 {
        guard.record_failure(&usb_key());
    }
    assert!(guard.is_degraded(&usb_key()));
    assert_eq!(
        guard.acquire(&usb_key()).await,
        Err(SessionError::Degraded {
            brick_key: usb_key()
        })
    );
    assert!(!guard.is_degraded(&bt_key()));
    guard
        .acquire(&bt_key())
        .await
        .expect("a pulled cable must not block the brick's other channel");
}

#[tokio::test]
async fn a_success_or_a_reset_clears_a_channel_and_only_that_channel() {
    let guard = Guard::default();
    guard.record_failure(&usb_key());
    guard.record_failure(&usb_key());
    guard.record_success(&usb_key(), Some(Duration::from_millis(9)));
    guard.record_failure(&usb_key());
    guard.record_failure(&usb_key());
    assert!(
        !guard.is_degraded(&usb_key()),
        "three in a row, not three in all"
    );
    assert_eq!(guard.last_rtt(&usb_key()), Some(Duration::from_millis(9)));

    for _ in 0..3 {
        guard.record_failure(&usb_key());
        guard.record_failure(&bt_key());
    }
    guard.reset_health(&usb_key());
    assert!(!guard.is_degraded(&usb_key()));
    assert_eq!(guard.last_rtt(&usb_key()), None);
    assert!(
        guard.is_degraded(&bt_key()),
        "the reset reached another channel"
    );
}

// ── Queue ───────────────────────────────────────────────────────────

fn ok_now() -> std::future::Ready<Result<(), SessionError>> {
    std::future::ready(Ok(()))
}

#[tokio::test]
async fn runs_commands_in_the_order_they_were_sent() {
    let queue = Arc::new(CommandQueue::new(usb_key()));
    let order = Arc::new(Mutex::new(Vec::new()));
    let mut tasks = Vec::new();
    for n in 0..5 {
        let queue = queue.clone();
        let order = order.clone();
        let epoch = queue.epoch();
        tasks.push(tokio::spawn(async move {
            queue
                .submit(epoch, ok_now(), async {
                    tokio::task::yield_now().await;
                    order.lock().unwrap().push(n);
                    Ok(())
                })
                .await
        }));
        settle().await;
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    assert_eq!(*order.lock().unwrap(), vec![0, 1, 2, 3, 4]);
}

#[tokio::test]
async fn a_drain_refuses_a_command_waiting_for_admission_unsent() {
    let queue = Arc::new(CommandQueue::new(usb_key()));
    let (_open, admission) = oneshot::channel::<()>();
    let sent = Arc::new(Mutex::new(false));
    let waiting = {
        let queue = queue.clone();
        let sent = sent.clone();
        let epoch = queue.epoch();
        tokio::spawn(async move {
            queue
                .submit(
                    epoch,
                    async move {
                        let _ = admission.await;
                        Ok(())
                    },
                    async move {
                        *sent.lock().unwrap() = true;
                        Ok(())
                    },
                )
                .await
        })
    };
    settle().await;
    queue.drain(DrainReason::Disconnected);
    assert_eq!(
        waiting.await.unwrap(),
        Err(SessionError::Disconnected {
            brick_key: usb_key()
        })
    );
    assert!(!*sent.lock().unwrap());
}

#[tokio::test]
async fn a_drain_refuses_what_waits_its_turn_and_leaves_the_command_on_the_wire_alone() {
    let queue = Arc::new(CommandQueue::new(usb_key()));
    let (finish, on_wire) = oneshot::channel::<()>();
    let first = {
        let queue = queue.clone();
        let epoch = queue.epoch();
        tokio::spawn(async move {
            queue
                .submit(epoch, ok_now(), async move {
                    let _ = on_wire.await;
                    Ok("first")
                })
                .await
        })
    };
    settle().await;
    let second = {
        let queue = queue.clone();
        let epoch = queue.epoch();
        tokio::spawn(async move { queue.submit(epoch, ok_now(), async { Ok("second") }).await })
    };
    settle().await;
    queue.drain(DrainReason::LinkLost);
    assert_eq!(
        second.await.unwrap(),
        Err(SessionError::LinkLost {
            brick_key: usb_key()
        })
    );
    finish.send(()).unwrap();
    assert_eq!(first.await.unwrap(), Ok("first"));
}

#[tokio::test]
async fn a_command_sent_after_a_drain_gets_its_own_admission() {
    let queue = Arc::new(CommandQueue::new(usb_key()));
    let (open_first, first_admission) = oneshot::channel::<()>();
    let first = {
        let queue = queue.clone();
        let epoch = queue.epoch();
        tokio::spawn(async move {
            queue
                .submit(
                    epoch,
                    async move {
                        let _ = first_admission.await;
                        Ok(())
                    },
                    async { Ok("first") },
                )
                .await
        })
    };
    settle().await;
    queue.drain(DrainReason::Disconnected);
    assert!(first.await.unwrap().is_err());
    // The drained command's slot opening must not let the next one through.
    let _ = open_first.send(());
    let (open_second, second_admission) = oneshot::channel::<()>();
    let second = {
        let queue = queue.clone();
        let epoch = queue.epoch();
        tokio::spawn(async move {
            queue
                .submit(
                    epoch,
                    async move {
                        let _ = second_admission.await;
                        Ok(())
                    },
                    async { Ok("second") },
                )
                .await
        })
    };
    settle().await;
    assert!(
        !second.is_finished(),
        "the second command went out on the first one's admission"
    );
    open_second.send(()).unwrap();
    assert_eq!(second.await.unwrap(), Ok("second"));
}

#[tokio::test]
async fn a_refused_admission_fails_the_head_and_the_queue_goes_on() {
    let queue = CommandQueue::new(usb_key());
    let refused = queue
        .submit(
            queue.epoch(),
            std::future::ready(Err(SessionError::Degraded {
                brick_key: usb_key(),
            })),
            async { Ok(1) },
        )
        .await;
    assert!(matches!(refused, Err(SessionError::Degraded { .. })));
    assert_eq!(
        queue.submit(queue.epoch(), ok_now(), async { Ok(2) }).await,
        Ok(2)
    );
}

#[tokio::test(start_paused = true)]
async fn an_abandoned_command_frees_its_turn() {
    // Dropping the caller drops the exchange, as the provider contract expects; a worker that
    // kept waiting on it would hold every command behind it.
    let queue = CommandQueue::new(usb_key());
    let abandoned = tokio::time::timeout(
        Duration::from_millis(200),
        queue.submit(
            queue.epoch(),
            ok_now(),
            std::future::pending::<Result<(), SessionError>>(),
        ),
    )
    .await;
    assert!(abandoned.is_err());
    assert_eq!(
        queue.submit(queue.epoch(), ok_now(), async { Ok(7) }).await,
        Ok(7)
    );
}

// ── Heartbeat rule ──────────────────────────────────────────────────

#[test]
fn an_unreadable_reply_is_not_a_miss() {
    let mut counter = MissCounter::new(1);
    assert_eq!(counter.record(Probe::Unreadable), Beat::Anomaly);
    assert_eq!(counter.misses(), 0);
    assert_eq!(
        counter.record(Probe::Missed),
        Beat::Failed,
        "detection still works"
    );
}

#[test]
fn misses_fail_at_the_threshold_and_start_again_for_the_next_link() {
    let mut counter = MissCounter::new(2);
    assert_eq!(counter.record(Probe::Missed), Beat::Missed);
    assert_eq!(counter.record(Probe::Answered), Beat::Ok);
    assert_eq!(
        counter.record(Probe::Missed),
        Beat::Missed,
        "an answer in between resets"
    );
    assert_eq!(counter.record(Probe::Missed), Beat::Failed);
    assert_eq!(
        counter.misses(),
        0,
        "a restarted heartbeat must begin from zero"
    );
}

#[test]
fn the_heartbeat_interval_has_a_floor() {
    assert_eq!(
        ev3_runtime::heartbeat::effective_interval(Duration::from_millis(500)),
        Duration::from_millis(3000)
    );
    assert_eq!(
        ev3_runtime::heartbeat::effective_interval(Duration::from_secs(60)),
        Duration::from_secs(60)
    );
}

// ── Backoff ─────────────────────────────────────────────────────────

#[test]
fn backoff_doubles_from_one_second_to_thirty_and_never_gives_up() {
    let mut backoff = Backoff::new(BackoffConfig::default());
    let delays: Vec<u64> = (0..8)
        .map(|_| backoff.next_delay().unwrap().as_millis() as u64)
        .collect();
    assert_eq!(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    for _ in 0..10_000 {
        assert_eq!(backoff.next_delay(), Some(Duration::from_secs(30)));
    }
    assert!(!backoff.exhausted());
}

#[test]
fn backoff_resets_and_honours_a_ceiling_when_given_one() {
    let mut backoff = Backoff::new(BackoffConfig {
        base: Duration::from_millis(100),
        max: Duration::from_millis(10_000),
        multiplier: 2,
        max_attempts: Some(2),
    });
    assert_eq!(backoff.next_delay(), Some(Duration::from_millis(100)));
    assert_eq!(backoff.next_delay(), Some(Duration::from_millis(200)));
    assert_eq!(backoff.next_delay(), None);
    assert!(backoff.exhausted());
    backoff.reset();
    assert_eq!(backoff.attempts(), 0);
    assert_eq!(backoff.next_delay(), Some(Duration::from_millis(100)));
}

// ── Ports ───────────────────────────────────────────────────────────

fn requester() -> Requester {
    Requester {
        name: "a test client".into(),
        kind: ClientKind::Cli,
        connection: None,
    }
}

#[derive(Default)]
struct Reports(Mutex<Vec<ActivityEvent>>);

impl ActivityPort for Reports {
    fn report(&self, event: ActivityEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[tokio::test]
async fn a_write_reports_its_end_even_when_its_caller_abandons_it() {
    let reports = Arc::new(Reports::default());
    let activity = WriteActivity {
        brick_key: usb_key(),
        requester: requester(),
        what: "write /home/root/lms2012/prjs/a.rbf".into(),
    };
    let write = {
        let port: Arc<dyn ActivityPort> = reports.clone();
        let activity = activity.clone();
        async move {
            let _scope = WriteScope::begin(port, activity);
            std::future::pending::<()>().await;
        }
    };
    assert!(
        tokio::time::timeout(Duration::from_millis(10), write)
            .await
            .is_err()
    );
    assert_eq!(
        *reports.0.lock().unwrap(),
        vec![
            ActivityEvent::WriteStarted(activity.clone()),
            ActivityEvent::WriteEnded(activity)
        ]
    );
}

struct Answers(Mutex<Vec<ConsentRequest>>, ConsentAnswer);

#[async_trait]
impl ConsentPort for Answers {
    async fn ask(&self, request: ConsentRequest) -> ConsentAnswer {
        self.0.lock().unwrap().push(request);
        self.1
    }
}

#[tokio::test]
async fn consent_names_the_requester_and_only_a_yes_counts() {
    let asked = Answers(Mutex::new(Vec::new()), ConsentAnswer::Unanswered);
    let port: &dyn ConsentPort = &asked;
    let answer = port
        .ask(ConsentRequest {
            requester: requester(),
            brick_key: Some(usb_key()),
            action: "Delete /home/root/lms2012/prjs/a.rbf".into(),
            subject: ConsentSubject::ReleaseSlots {
                brick_id: "00165300000A".into(),
            },
        })
        .await;
    assert!(!answer.granted(), "silence is not consent");
    assert!(ConsentAnswer::Granted.granted());
    assert!(!ConsentAnswer::Declined.granted());
    assert_eq!(asked.0.lock().unwrap()[0].requester.kind, ClientKind::Cli);
}
