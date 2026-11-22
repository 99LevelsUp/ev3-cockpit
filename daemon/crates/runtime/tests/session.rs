//! Sessions against a fake brick: connect and disconnect, the heartbeat, reconnect, the queue
//! and the guard as a session uses them.
//!
//! Time is tokio's paused clock: a test that waits ten minutes of backoff runs at once.

mod support;

use std::sync::Arc;
use std::time::Duration;

use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_runtime::{
    BackoffConfig, ConnectionState, Guard, GuardConfig, HeartbeatState, SessionConfig,
    SessionError, SessionEvent, SessionManager,
};
use ev3_transports::{BrickKey, ErrorCode, Transport, TransportError};
use support::{Battery, FakeProvider, SendFault, bt_key, settle, usb_key};
use tokio::sync::Semaphore;
use tokio::time::{Instant, sleep};

/// A manager whose heartbeat stays quiet unless a test asks for it.
fn quiet() -> SessionConfig {
    SessionConfig {
        heartbeat_interval: Duration::from_secs(3600),
        ..SessionConfig::default()
    }
}

fn manager(
    providers: &[&Arc<FakeProvider>],
    guard: Guard,
    config: SessionConfig,
) -> SessionManager {
    SessionManager::new(
        providers.iter().map(|p| p.as_provider()),
        Arc::new(guard),
        config,
    )
}

fn state(manager: &SessionManager, key: &BrickKey) -> Option<ConnectionState> {
    manager.session(key).map(|s| s.connection_state)
}

async fn battery(manager: &SessionManager, key: &BrickKey) -> Result<BrickResponse, SessionError> {
    manager.send(key, &BrickCommand::Battery, None).await
}

/// Waits on the paused clock, in steps, until `done` holds or `limit` passes.
async fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        sleep(Duration::from_millis(5)).await;
    }
    done()
}

// ── Connect and disconnect ──────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn connects_sends_and_disconnects() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), quiet());
    let mut events = manager.subscribe();
    let key = usb_key();

    manager.connect(&key, Some("Alpha")).await.unwrap();
    let session = manager.session(&key).unwrap();
    assert_eq!(session.connection_state, ConnectionState::Connected);
    assert_eq!(session.display_name, "Alpha");
    assert_eq!(session.heartbeat_state, HeartbeatState::Ok);
    assert_eq!(
        events.recv().await.unwrap(),
        SessionEvent::StateChanged {
            brick_key: key.clone(),
            previous: ConnectionState::Connecting,
            new: ConnectionState::Connected,
        }
    );

    match battery(&manager, &key).await.unwrap() {
        BrickResponse::Battery { level, .. } => assert_eq!(level, 80),
        other => panic!("not a battery reply: {other:?}"),
    }
    assert_eq!(
        manager.connect(&key, None).await,
        Err(SessionError::AlreadyConnected {
            brick_key: key.clone()
        })
    );

    manager.disconnect(&key, true).await;
    assert_eq!(manager.session(&key), None);
    assert!(manager.is_suppressed(&key));
    assert_eq!(usb.state().open_links, 0);
    assert_eq!(
        battery(&manager, &key).await,
        Err(SessionError::NotConnected {
            brick_key: key.clone()
        })
    );

    manager.connect(&key, None).await.unwrap();
    assert!(
        !manager.is_suppressed(&key),
        "connecting by hand clears the sign-out"
    );
    manager.disconnect(&key, false).await;
    assert!(
        !manager.is_suppressed(&key),
        "only a disconnect by hand suppresses"
    );
}

#[tokio::test(start_paused = true)]
async fn refuses_a_transport_without_a_provider() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), quiet());
    assert_eq!(
        manager.connect(&bt_key(), None).await,
        Err(SessionError::NoProvider {
            transport: Transport::Bt
        })
    );
    assert_eq!(manager.session(&bt_key()), None);
}

#[tokio::test(start_paused = true)]
async fn a_failed_connect_leaves_no_session() {
    let usb = FakeProvider::new(Transport::Usb);
    usb.pull_cable();
    let manager = manager(&[&usb], Guard::default(), quiet());
    let error = manager.connect(&usb_key(), None).await.unwrap_err();
    assert_eq!(error.transport_code(), Some(ErrorCode::TransportFailed));
    assert_eq!(manager.session(&usb_key()), None);
}

#[tokio::test(start_paused = true)]
async fn reads_the_brick_name_only_up_to_its_terminator() {
    // The firmware writes a string reply only up to its terminator and never clears a direct
    // command's globals, so what an earlier reply left rides along after the name (seen: part of
    // a Wi-Fi network name inside the brick-name field).
    let usb = FakeProvider::new(Transport::Usb);
    let mut field = b"AAA\0HomeNet".to_vec();
    field.resize(16, b'x');
    usb.state().name_field = field;
    let manager = manager(&[&usb], Guard::default(), quiet());
    manager.connect(&usb_key(), None).await.unwrap();
    match manager
        .send(&usb_key(), &BrickCommand::Info, None)
        .await
        .unwrap()
    {
        BrickResponse::Info { display_name, .. } => assert_eq!(display_name, "AAA"),
        other => panic!("not an info reply: {other:?}"),
    }
}

// ── Reconnect ───────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_dead_usb_link_reconnects_when_the_cable_returns_without_an_explicit_disconnect() {
    // The provider keeps its record of the link when the link dies on its own, as the real ones
    // do. A reconnect that asks for a link before releasing that record is refused "already
    // connected" every time, at once, forever: a USB session once never recovered from a power
    // cycle or a pulled cable.
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), SessionConfig::default());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();

    usb.pull_cable();
    // Two missed beats, three seconds apart, and the session knows.
    sleep(Duration::from_millis(6100)).await;
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));

    sleep(Duration::from_secs(20)).await;
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));
    usb.plug_cable();
    assert!(
        wait_until(Duration::from_secs(31), || state(&manager, &key)
            == Some(ConnectionState::Connected))
        .await,
        "the session never came back"
    );
    let (connect_calls, refused_while_held) = {
        let fake = usb.state();
        (fake.connect_calls, fake.refused_while_held)
    };
    assert!(
        connect_calls > 2,
        "reconnect never asked the provider for a link"
    );
    assert_eq!(
        refused_while_held, 0,
        "reconnect asked for a link while the provider still held the brick"
    );
    battery(&manager, &key)
        .await
        .expect("the new link carries commands");
}

#[tokio::test(start_paused = true)]
async fn the_heartbeat_reconnects_a_silent_usb_channel() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), SessionConfig::default());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    usb.state().fault = Some(SendFault::Silent {
        after: Duration::from_millis(1000),
    });
    sleep(Duration::from_millis(5000)).await;
    assert_eq!(
        state(&manager, &key),
        Some(ConnectionState::Connected),
        "one late reply"
    );
    sleep(Duration::from_millis(3200)).await;
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));
}

#[tokio::test(start_paused = true)]
async fn reconnects_as_soon_as_the_brick_is_seen_again() {
    // A brick that booted in about 40 s took 121 s to be picked up while the backoff waited out
    // its 30 s steps.
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    usb.pull_cable();
    assert!(!manager.probe_now(&key).await);
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));

    // Attempts at 1, 3, 7, 15 and 31 s; the next waits until 61 s.
    sleep(Duration::from_secs(40)).await;
    usb.plug_cable();
    manager.notify_brick_available(&key);
    sleep(Duration::from_millis(50)).await;
    assert_eq!(
        state(&manager, &key),
        Some(ConnectionState::Connected),
        "the brick was seen again and the session kept waiting anyway"
    );
}

#[tokio::test(start_paused = true)]
async fn a_sighting_leaves_a_session_that_is_not_reconnecting_alone() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), quiet());
    manager.notify_brick_available(&usb_key());
    manager.connect(&usb_key(), None).await.unwrap();
    manager.notify_brick_available(&usb_key());
    settle().await;
    assert_eq!(usb.state().connect_calls, 1);
    assert_eq!(
        state(&manager, &usb_key()),
        Some(ConnectionState::Connected)
    );
}

#[tokio::test(start_paused = true)]
async fn keeps_trying_for_as_long_as_the_sign_in_stands() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    usb.pull_cable();
    manager.probe_now(&key).await;
    sleep(Duration::from_secs(600)).await;
    let attempts = usb.state().connect_calls - 1;
    assert!(attempts > 20, "only {attempts} attempts in ten minutes");
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));
}

#[tokio::test(start_paused = true)]
async fn records_and_reports_each_failed_reconnect_attempt() {
    let usb = FakeProvider::new(Transport::Usb);
    let config = SessionConfig {
        backoff: BackoffConfig {
            base: Duration::from_millis(50),
            max: Duration::from_millis(200),
            multiplier: 2,
            max_attempts: Some(3),
        },
        ..quiet()
    };
    let manager = manager(&[&usb], Guard::default(), config);
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    let mut events = manager.subscribe();
    usb.pull_cable();
    manager.probe_now(&key).await;

    sleep(Duration::from_millis(250)).await;
    assert!(
        manager
            .session(&key)
            .and_then(|s| s.last_error)
            .is_some_and(|e| e.contains("No EV3 found")),
        "the reason a reconnect failed has to survive somewhere a person can read it"
    );
    sleep(Duration::from_millis(500)).await;

    let mut failures = Vec::new();
    let mut ended = false;
    while let Ok(event) = events.try_recv() {
        match event {
            SessionEvent::ReconnectFailed {
                attempt,
                error,
                next_delay,
                ..
            } => {
                assert!(error.contains("No EV3 found"));
                failures.push((attempt, next_delay.map(|d| d.as_millis())));
            }
            SessionEvent::StateChanged {
                new: ConnectionState::Disconnected,
                ..
            } => ended = true,
            SessionEvent::StateChanged { .. } => {}
        }
    }
    assert_eq!(failures, [(1, Some(100)), (2, Some(200)), (3, None)]);
    assert!(ended, "a session out of attempts ends");
    assert_eq!(manager.session(&key), None);
}

#[tokio::test(start_paused = true)]
async fn refuses_a_command_sent_while_reconnecting_without_queueing_it() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    usb.pull_cable();
    manager.probe_now(&key).await;
    let sent = usb.state().requests.len();

    usb.plug_cable();
    let refused = battery(&manager, &key).await;
    assert_eq!(
        refused,
        Err(SessionError::LinkLost {
            brick_key: key.clone()
        })
    );
    assert!(refused.unwrap_err().is_link_fault());
    // Back on a new link, the refused command is not sent late.
    sleep(Duration::from_secs(2)).await;
    assert_eq!(state(&manager, &key), Some(ConnectionState::Connected));
    assert_eq!(
        usb.state().requests.len(),
        sent,
        "the refused command went out"
    );
}

#[tokio::test(start_paused = true)]
async fn explicit_disconnect_during_an_in_flight_recover_leaks_nothing() {
    let usb = FakeProvider::recovering(Transport::Usb);
    let gate = Arc::new(Semaphore::new(0));
    let manager = manager(&[&usb], Guard::default(), quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    assert_eq!(usb.state().open_links, 1);
    {
        // The first recover hangs until the test lets it finish.
        let mut fake = usb.state();
        fake.gate = Some(gate.clone());
        fake.gated_calls = vec![1];
    }

    usb.state().fault = Some(SendFault::Fail(TransportError::transport_failed(
        "USB send failed: LIBUSB_ERROR_NO_DEVICE",
    )));
    manager.probe_now(&key).await;
    assert!(wait_until(Duration::from_secs(5), || usb.state().recover_calls == 1).await);
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));

    manager.disconnect(&key, true).await;
    assert_eq!(manager.session(&key), None);

    gate.add_permits(1);
    settle().await;
    sleep(Duration::from_secs(5)).await;
    assert_eq!(
        usb.state().open_links,
        0,
        "the recovered link was left open"
    );
    assert_eq!(
        manager.session(&key),
        None,
        "the disconnected session came back"
    );
}

#[tokio::test(start_paused = true)]
async fn keeps_one_reconnect_timer_however_many_attempts_fail() {
    // An attempt the backoff started and one a sighting started fail one after the other, and
    // each asks for the next. One timer: attempts go on at the backoff's pace. A timer per
    // failure: a second chain of attempts runs beside the first.
    let usb = FakeProvider::new(Transport::Usb);
    let config = SessionConfig {
        backoff: BackoffConfig {
            base: Duration::from_millis(1000),
            max: Duration::from_millis(1000),
            multiplier: 2,
            max_attempts: None,
        },
        ..quiet()
    };
    let manager = manager(&[&usb], Guard::default(), config);
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    usb.pull_cable();
    usb.state().connect_delay = Duration::from_millis(50);
    manager.probe_now(&key).await;

    // The backoff's attempt is inside the provider; the sighting's waits for it.
    sleep(Duration::from_millis(1010)).await;
    assert_eq!(usb.state().connect_calls, 2);
    manager.notify_brick_available(&key);
    sleep(Duration::from_millis(200)).await;
    assert_eq!(usb.state().connect_calls, 3);

    let before = usb.state().connect_calls;
    sleep(Duration::from_millis(10_500)).await;
    let attempts = usb.state().connect_calls - before;
    // One attempt every 1050 ms (1000 ms wait, 50 ms connect).
    assert_eq!(
        attempts, 10,
        "{attempts} attempts in 10.5 s: more than one timer ran"
    );
}

// ── One link opening per channel ────────────────────────────────────

async fn newer_connect_waits_for_the_abandoned_first(first_opens: bool) {
    let usb = FakeProvider::new(Transport::Usb);
    let gate = Arc::new(Semaphore::new(0));
    {
        let mut fake = usb.state();
        fake.gate = Some(gate.clone());
        fake.gated_calls = vec![1];
        if !first_opens {
            fake.failing_calls = vec![1];
        }
    }
    let manager = manager(&[&usb], Guard::default(), quiet());
    let key = usb_key();

    let first = {
        let manager = manager.clone();
        let key = key.clone();
        tokio::spawn(async move { manager.connect(&key, None).await })
    };
    assert!(wait_until(Duration::from_secs(1), || usb.state().connect_calls == 1).await);
    manager.disconnect(&key, true).await;
    let second = {
        let manager = manager.clone();
        let key = key.clone();
        tokio::spawn(async move { manager.connect(&key, None).await })
    };
    sleep(Duration::from_millis(20)).await;
    assert_eq!(
        usb.state().connect_calls,
        1,
        "the newer connect reached the provider beside the first"
    );

    gate.add_permits(1);
    let first = first.await.unwrap();
    if first_opens {
        assert_eq!(
            first,
            Err(SessionError::ConnectionAbandoned {
                brick_key: key.clone()
            })
        );
    } else {
        assert!(first.is_err());
    }
    second.await.unwrap().unwrap();

    let fake = usb.state();
    let expected: &[&str] = if first_opens {
        &[
            "connect 1",
            "link 1 open",
            "link closed",
            "connect 2",
            "link 2 open",
        ]
    } else {
        &["connect 1", "link 1 failed", "connect 2", "link 2 open"]
    };
    assert_eq!(fake.events, expected);
    assert_eq!(
        fake.open_links, 1,
        "a link was left open with nobody to close it"
    );
    drop(fake);
    assert_eq!(
        state(&manager, &key),
        Some(ConnectionState::Connected),
        "the abandoned connect ended the newer session"
    );
}

#[tokio::test(start_paused = true)]
async fn a_newer_connect_starts_only_once_the_abandoned_first_has_opened() {
    newer_connect_waits_for_the_abandoned_first(true).await;
}

#[tokio::test(start_paused = true)]
async fn a_newer_connect_starts_only_once_the_abandoned_first_has_failed() {
    newer_connect_waits_for_the_abandoned_first(false).await;
}

#[tokio::test(start_paused = true)]
async fn does_not_open_a_link_for_a_connect_disconnected_while_it_waited_its_turn() {
    let usb = FakeProvider::new(Transport::Usb);
    let gate = Arc::new(Semaphore::new(0));
    {
        let mut fake = usb.state();
        fake.gate = Some(gate.clone());
        fake.gated_calls = vec![1];
    }
    let manager = manager(&[&usb], Guard::default(), quiet());
    let key = usb_key();
    let first = {
        let (manager, key) = (manager.clone(), key.clone());
        tokio::spawn(async move { manager.connect(&key, None).await })
    };
    assert!(wait_until(Duration::from_secs(1), || usb.state().connect_calls == 1).await);
    manager.disconnect(&key, true).await;
    let second = {
        let (manager, key) = (manager.clone(), key.clone());
        tokio::spawn(async move { manager.connect(&key, None).await })
    };
    settle().await;
    manager.disconnect(&key, true).await;
    gate.add_permits(1);
    assert!(matches!(
        first.await.unwrap(),
        Err(SessionError::ConnectionAbandoned { .. })
    ));
    assert!(matches!(
        second.await.unwrap(),
        Err(SessionError::ConnectionAbandoned { .. })
    ));
    assert_eq!(
        usb.state().connect_calls,
        1,
        "a connect nobody wanted any more reached the brick"
    );
    assert_eq!(usb.state().open_links, 0);
    assert_eq!(manager.session(&key), None);
}

#[tokio::test(start_paused = true)]
async fn a_reconnect_the_brick_s_return_asked_for_finds_the_one_in_flight_done() {
    let usb = FakeProvider::new(Transport::Usb);
    let gate = Arc::new(Semaphore::new(0));
    let manager = manager(&[&usb], Guard::default(), quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    {
        let mut fake = usb.state();
        fake.gate = Some(gate.clone());
        fake.gated_calls = vec![2];
    }
    usb.state().fault = Some(SendFault::Fail(TransportError::transport_failed(
        "USB send failed: LIBUSB_ERROR_NO_DEVICE",
    )));
    manager.probe_now(&key).await;
    usb.state().fault = None;
    assert!(wait_until(Duration::from_secs(5), || usb.state().connect_calls == 2).await);

    manager.notify_brick_available(&key);
    gate.add_permits(1);
    assert!(
        wait_until(Duration::from_secs(1), || state(&manager, &key)
            == Some(ConnectionState::Connected))
        .await
    );
    sleep(Duration::from_millis(50)).await;
    let fake = usb.state();
    assert_eq!(
        fake.connect_calls, 2,
        "the brick was asked for a link the session already had"
    );
    assert_eq!(
        fake.open_links, 1,
        "the session reports connected over a link that was closed"
    );
}

// ── Heartbeat ───────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn an_unreadable_heartbeat_reply_is_not_a_miss() {
    let usb = FakeProvider::new(Transport::Usb);
    usb.state().battery = Battery::Unreadable;
    let config = SessionConfig {
        heartbeat_miss_threshold: 1,
        ..SessionConfig::default()
    };
    let manager = manager(&[&usb], Guard::default(), config);
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();

    sleep(Duration::from_secs(30)).await;
    let session = manager.session(&key).unwrap();
    assert_eq!(session.connection_state, ConnectionState::Connected);
    assert_eq!(session.heartbeat_state, HeartbeatState::Ok);
    assert!(
        session
            .last_error
            .is_some_and(|e| e.contains("not a percentage")),
        "the anomaly is kept for whoever looks"
    );
    assert!(
        usb.state().requests.len() >= 9,
        "the heartbeat stopped probing"
    );
    assert!(
        !manager.guard().is_degraded(&key),
        "unreadable replies degraded a working link"
    );

    // A real failure is still noticed.
    usb.pull_cable();
    sleep(Duration::from_millis(3100)).await;
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));
}

#[tokio::test(start_paused = true)]
async fn the_heartbeat_comes_back_after_a_reconnect() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), SessionConfig::default());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    usb.pull_cable();
    sleep(Duration::from_millis(6100)).await;
    usb.plug_cable();
    assert!(
        wait_until(Duration::from_secs(5), || state(&manager, &key)
            == Some(ConnectionState::Connected))
        .await
    );
    // A second loss has to be noticed too.
    usb.pull_cable();
    sleep(Duration::from_millis(6100)).await;
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));
}

// ── A busy brick on USB ─────────────────────────────────────────────

async fn probed(
    transport: Transport,
    fault: TransportError,
) -> (SessionManager, Arc<FakeProvider>, BrickKey) {
    let fake = FakeProvider::new(transport);
    let manager = manager(&[&fake], Guard::default(), quiet());
    let key = if transport == Transport::Usb {
        usb_key()
    } else {
        bt_key()
    };
    manager.connect(&key, None).await.unwrap();
    fake.state().fault = Some(SendFault::Fail(fault));
    (manager, fake, key)
}

fn usb_budget_spent() -> TransportError {
    TransportError::timeout("USB send timed out after 1000 ms with no matching reply.")
}

#[tokio::test(start_paused = true)]
async fn a_usb_check_that_times_out_is_one_missed_beat() {
    let (manager, _fake, key) = probed(Transport::Usb, usb_budget_spent()).await;
    assert!(!manager.probe_now(&key).await, "it did not answer");
    assert_eq!(
        state(&manager, &key),
        Some(ConnectionState::Connected),
        "one slow reply is not a lost cable"
    );
    assert!(!manager.probe_now(&key).await);
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));
}

#[tokio::test(start_paused = true)]
async fn libusb_s_own_transfer_timeout_is_a_slow_reply_too() {
    let (manager, _fake, key) = probed(
        Transport::Usb,
        TransportError::transport_failed("USB receive failed: LIBUSB_ERROR_TIMEOUT"),
    )
    .await;
    assert!(!manager.probe_now(&key).await);
    assert_eq!(state(&manager, &key), Some(ConnectionState::Connected));
}

#[tokio::test(start_paused = true)]
async fn a_usb_link_failure_reconnects_at_once() {
    let (manager, _fake, key) = probed(
        Transport::Usb,
        TransportError::transport_failed("USB send failed: LIBUSB_ERROR_NO_DEVICE"),
    )
    .await;
    assert!(!manager.probe_now(&key).await);
    assert_eq!(
        state(&manager, &key),
        Some(ConnectionState::Reconnecting),
        "a pulled cable reconnects at once"
    );
}

#[tokio::test(start_paused = true)]
async fn a_bluetooth_timeout_reconnects_at_once() {
    let (manager, _fake, key) = probed(
        Transport::Bt,
        TransportError::timeout("BT send timed out after 2000 ms with no matching reply."),
    )
    .await;
    assert!(!manager.probe_now(&key).await);
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));
}

#[tokio::test(start_paused = true)]
async fn an_answer_between_two_slow_usb_replies_forgets_the_first() {
    let (manager, fake, key) = probed(Transport::Usb, usb_budget_spent()).await;
    assert!(!manager.probe_now(&key).await);
    fake.state().fault = None;
    assert!(manager.probe_now(&key).await);
    fake.state().fault = Some(SendFault::Fail(usb_budget_spent()));
    assert!(!manager.probe_now(&key).await);
    assert_eq!(
        state(&manager, &key),
        Some(ConnectionState::Connected),
        "two misses in a row reconnect, not two in all"
    );
}

#[tokio::test(start_paused = true)]
async fn an_unreadable_check_proves_the_link() {
    let usb = FakeProvider::new(Transport::Usb);
    usb.state().battery = Battery::Unreadable;
    let manager = manager(&[&usb], Guard::default(), quiet());
    manager.connect(&usb_key(), None).await.unwrap();
    assert!(manager.probe_now(&usb_key()).await);
    assert_eq!(
        state(&manager, &usb_key()),
        Some(ConnectionState::Connected)
    );
}

// ── The guard in a session ──────────────────────────────────────────

fn degrade_after_two() -> Guard {
    Guard::new(GuardConfig {
        degradation_threshold: 2,
        ..GuardConfig::default()
    })
}

#[tokio::test(start_paused = true)]
async fn degraded_sends_are_blocked_and_a_clean_reconnect_recovers_the_channel() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], degrade_after_two(), quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();

    usb.state().fault = Some(SendFault::Fail(TransportError::transport_failed(
        "USB send failed: LIBUSB_ERROR_IO",
    )));
    assert!(battery(&manager, &key).await.is_err());
    assert!(battery(&manager, &key).await.is_err());
    let sent = usb.state().requests.len();
    assert_eq!(
        battery(&manager, &key).await,
        Err(SessionError::Degraded {
            brick_key: key.clone()
        })
    );
    assert_eq!(
        usb.state().requests.len(),
        sent,
        "a degraded send reached the transport"
    );

    manager.disconnect(&key, true).await;
    usb.state().fault = None;
    manager.connect(&key, None).await.unwrap();
    battery(&manager, &key)
        .await
        .expect("a fresh connect must not inherit the old degradation");
}

#[tokio::test(start_paused = true)]
async fn a_usb_channel_that_reconnects_after_degrading_carries_traffic_again() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], degrade_after_two(), quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();

    usb.pull_cable();
    assert!(battery(&manager, &key).await.is_err());
    assert!(battery(&manager, &key).await.is_err());
    assert!(manager.guard().is_degraded(&key));
    // The check after a failure finds the channel degraded: a link fault, so it reconnects.
    assert!(!manager.probe_now(&key).await);
    assert_eq!(state(&manager, &key), Some(ConnectionState::Reconnecting));

    usb.plug_cable();
    assert!(
        wait_until(Duration::from_secs(5), || state(&manager, &key)
            == Some(ConnectionState::Connected))
        .await
    );
    battery(&manager, &key)
        .await
        .expect("a reconnected channel must not stay refused as degraded");
}

#[tokio::test(start_paused = true)]
async fn a_failure_on_usb_does_not_degrade_the_bluetooth_channel_of_the_same_brick() {
    let usb = FakeProvider::new(Transport::Usb);
    let bt = FakeProvider::new(Transport::Bt);
    let manager = manager(&[&usb, &bt], degrade_after_two(), quiet());
    manager.connect(&usb_key(), None).await.unwrap();
    manager.connect(&bt_key(), None).await.unwrap();

    usb.pull_cable();
    assert!(battery(&manager, &usb_key()).await.is_err());
    assert!(battery(&manager, &usb_key()).await.is_err());
    assert!(matches!(
        battery(&manager, &usb_key()).await,
        Err(SessionError::Degraded { .. })
    ));
    battery(&manager, &bt_key())
        .await
        .expect("a pulled cable must not block the healthy channel to the same brick");
}

#[tokio::test(start_paused = true)]
async fn closing_the_usb_channel_leaves_the_bluetooth_failure_count_alone() {
    let usb = FakeProvider::new(Transport::Usb);
    let bt = FakeProvider::new(Transport::Bt);
    let manager = manager(&[&usb, &bt], degrade_after_two(), quiet());
    manager.connect(&usb_key(), None).await.unwrap();
    manager.connect(&bt_key(), None).await.unwrap();

    bt.state().fault = Some(SendFault::Fail(TransportError::transport_failed(
        "BT link down",
    )));
    assert!(battery(&manager, &bt_key()).await.is_err());
    manager.disconnect(&usb_key(), true).await;
    assert!(battery(&manager, &bt_key()).await.is_err());
    assert!(
        matches!(
            battery(&manager, &bt_key()).await,
            Err(SessionError::Degraded { .. })
        ),
        "the USB close wiped the Bluetooth failure that came before it"
    );
}

#[tokio::test(start_paused = true)]
async fn the_rate_window_counts_both_channels_of_one_brick() {
    let usb = FakeProvider::new(Transport::Usb);
    let bt = FakeProvider::new(Transport::Bt);
    let guard = Guard::new(GuardConfig {
        max_commands_per_sec: 3,
        ..GuardConfig::default()
    });
    let manager = manager(&[&usb, &bt], guard, quiet());
    manager.connect(&usb_key(), None).await.unwrap();
    manager.connect(&bt_key(), None).await.unwrap();
    battery(&manager, &usb_key()).await.unwrap();
    battery(&manager, &bt_key()).await.unwrap();
    battery(&manager, &usb_key()).await.unwrap();
    let started = Instant::now();
    battery(&manager, &bt_key()).await.unwrap();
    assert!(started.elapsed() >= Duration::from_millis(950));
}

#[tokio::test(start_paused = true)]
async fn a_full_window_delays_the_1001st_command_of_a_session_and_refuses_none() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    let started = Instant::now();
    for _ in 0..1000 {
        battery(&manager, &key).await.unwrap();
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "a burst below the ceiling was metered"
    );
    battery(&manager, &key)
        .await
        .expect("a full window waits, it does not refuse");
    assert!(started.elapsed() >= Duration::from_secs(1));
}

#[tokio::test(start_paused = true)]
async fn a_command_held_by_a_full_window_is_dropped_when_its_session_closes() {
    let usb = FakeProvider::new(Transport::Usb);
    let guard = Guard::new(GuardConfig {
        max_commands_per_sec: 2,
        ..GuardConfig::default()
    });
    let manager = manager(&[&usb], guard, quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    battery(&manager, &key).await.unwrap();
    battery(&manager, &key).await.unwrap();
    let held = {
        let (manager, key) = (manager.clone(), key.clone());
        tokio::spawn(async move { battery(&manager, &key).await })
    };
    settle().await;

    manager.disconnect(&key, true).await;
    manager.connect(&key, None).await.unwrap();
    assert_eq!(
        held.await.unwrap(),
        Err(SessionError::Disconnected {
            brick_key: key.clone()
        })
    );
    sleep(Duration::from_millis(1100)).await;
    assert_eq!(
        usb.state().requests.len(),
        2,
        "the held command reached a link"
    );
}

#[tokio::test(start_paused = true)]
async fn a_command_a_caller_abandons_does_not_hold_the_queue() {
    let usb = FakeProvider::new(Transport::Usb);
    let manager = manager(&[&usb], Guard::default(), quiet());
    let key = usb_key();
    manager.connect(&key, None).await.unwrap();
    usb.state().hang_next = 1;
    let abandoned = tokio::time::timeout(Duration::from_millis(200), battery(&manager, &key)).await;
    assert!(abandoned.is_err());
    battery(&manager, &key)
        .await
        .expect("the command after an abandoned one never went out");
}
