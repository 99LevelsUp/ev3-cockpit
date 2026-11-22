//! The brick layer: one brick over several channels, on the real session manager, discovery and
//! list over fake providers, so what is tested is the shipped wiring between them.
//!
//! Time is tokio's paused clock: backoffs and reconnects run at once.

mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ev3_protocol::commands::info_layout;
use ev3_protocol::{BrickCommand, BrickResponse, build_command};
use ev3_runtime::{
    BackoffConfig, BluetoothGate, BrickConfig, BrickError, BrickEvent, BrickLog, BrickManager,
    BrickOptions, CommandOptions, ConnectionState, DiscoveryConfig, DiscoveryScheduler, Guard,
    PresenceAggregator, SessionConfig, SessionManager,
};
use ev3_transports::{BrickKey, DiscoveryItem, NameSource, Transport};
use support::{FakeProvider, SendFault, bt_key, settle, sighting, tcp_key, usb_key, wall_ms};
use tokio::sync::{Semaphore, broadcast};
use tokio::time::{Instant, sleep};

const AAA: &str = "00165300000A";

#[derive(Default)]
struct Lines(Mutex<Vec<String>>);

impl BrickLog for Lines {
    fn warn(&self, message: &str) {
        self.0.lock().unwrap().push(format!("warn {message}"));
    }

    fn info(&self, message: &str) {
        self.0.lock().unwrap().push(format!("info {message}"));
    }
}

impl Lines {
    fn starting(&self, prefix: &str) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.starts_with(prefix))
            .cloned()
            .collect()
    }
}

struct World {
    usb: Arc<FakeProvider>,
    bt: Arc<FakeProvider>,
    scheduler: Arc<DiscoveryScheduler>,
    list: Arc<PresenceAggregator>,
    sessions: SessionManager,
    bricks: BrickManager,
    log: Arc<Lines>,
}

fn options() -> BrickOptions {
    BrickOptions {
        config: BrickConfig {
            rejoin_backoff: BackoffConfig {
                base: Duration::from_millis(20),
                max: Duration::from_millis(40),
                ..BackoffConfig::default()
            },
            slow_probe_retry: Duration::from_millis(20),
        },
        ..BrickOptions::default()
    }
}

fn world() -> World {
    world_with(options())
}

fn world_with(options: BrickOptions) -> World {
    world_over(
        FakeProvider::new(Transport::Usb),
        FakeProvider::new(Transport::Bt),
        options,
    )
}

fn world_over(usb: Arc<FakeProvider>, bt: Arc<FakeProvider>, mut options: BrickOptions) -> World {
    let providers = [usb.as_provider(), bt.as_provider()];
    let scheduler = DiscoveryScheduler::new(
        providers.clone(),
        DiscoveryConfig {
            unavailable_after_misses: 1,
            removed_after_misses: 5,
            ..DiscoveryConfig::default()
        },
    );
    let list = PresenceAggregator::new(scheduler.clone());
    let sessions = SessionManager::new(
        providers,
        Arc::new(Guard::default()),
        SessionConfig {
            heartbeat_interval: Duration::from_secs(3600),
            backoff: BackoffConfig {
                base: Duration::from_millis(20),
                max: Duration::from_millis(40),
                ..BackoffConfig::default()
            },
            ..SessionConfig::default()
        },
    );
    let log = Arc::new(Lines::default());
    options.log = Some(log.clone());
    let bricks = BrickManager::new(sessions.clone(), list.clone(), options);
    World {
        usb,
        bt,
        scheduler,
        list,
        sessions,
        bricks,
        log,
    }
}

/// A Bluetooth sighting is paired, as the system lists every brick it remembers.
fn bt_item() -> DiscoveryItem {
    DiscoveryItem {
        paired: Some(true),
        ..sighting(&bt_key(), "AAA", Some(NameSource::BtCache))
    }
}

impl World {
    fn show_usb(&self) {
        self.usb.state().seen = vec![sighting(&usb_key(), "AAA", Some(NameSource::UsbDescriptor))];
    }

    fn show_bt(&self) {
        self.bt.state().seen = vec![bt_item()];
    }

    fn hide_bt(&self) {
        self.bt.state().seen.clear();
    }

    /// The Bluetooth presence check heard the brick just now.
    fn bt_answers(&self) {
        self.bt.state().seen = vec![DiscoveryItem {
            heard: Some(true),
            heard_at: Some(wall_ms() + 1000),
            ..bt_item()
        }];
    }

    async fn scan(&self) {
        self.scheduler.scan_once().await;
        settle().await;
    }

    fn state(&self, key: &BrickKey) -> Option<ConnectionState> {
        self.sessions.session(key).map(|s| s.connection_state)
    }

    fn route(&self) -> Option<BrickKey> {
        self.bricks.route_of(AAA)
    }

    async fn battery(&self) -> Result<BrickResponse, BrickError> {
        self.bricks
            .send(AAA, &BrickCommand::Battery, CommandOptions::default())
            .await
    }

    fn name(&self) -> (String, NameSource, bool) {
        let name = self.list.brick(AAA).unwrap().name;
        (name.value, name.source, name.confirmed)
    }
}

/// How many times `command` reached the provider's link.
fn sent(provider: &FakeProvider, command: &BrickCommand) -> usize {
    let encoded = build_command(command).unwrap();
    provider
        .state()
        .requests
        .iter()
        .filter(|r| r[4] == encoded.packet_type && r[5..] == encoded.payload[..])
        .count()
}

/// The next `n` connects of the provider fail.
fn fail_next_connects(provider: &FakeProvider, n: u32) {
    let mut state = provider.state();
    let next = state.connect_calls + state.recover_calls + 1;
    state.failing_calls = (next..next + n).collect();
}

/// The provider's connect number `call` waits until the returned gate lets it go.
fn hold_connect(provider: &FakeProvider, calls: &[u32]) -> Arc<Semaphore> {
    let gate = Arc::new(Semaphore::new(0));
    let mut state = provider.state();
    state.gate = Some(gate.clone());
    state.gated_calls = calls.to_vec();
    gate
}

/// Waits on the paused clock, in steps, until `done` holds.
async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "never happened: {what}");
        sleep(Duration::from_millis(1)).await;
    }
}

fn sign_in_in_background(w: &World) -> tokio::task::JoinHandle<Result<(), BrickError>> {
    let bricks = w.bricks.clone();
    tokio::spawn(async move { bricks.sign_in(AAA).await })
}

// ── Signing in ──────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn signs_in_over_every_available_channel_and_routes_traffic_over_usb() {
    let w = world();
    w.show_usb();
    w.show_bt();
    w.scan().await;

    w.bricks.sign_in(AAA).await.unwrap();
    wait_until("Bluetooth connected", || {
        w.state(&bt_key()) == Some(ConnectionState::Connected)
    })
    .await;
    assert_eq!(w.state(&usb_key()), Some(ConnectionState::Connected));
    assert_eq!(w.route(), Some(usb_key()));
    let entry = w.list.brick(AAA).unwrap();
    assert_eq!(w.list.list().len(), 1, "one brick, shown once");
    assert_eq!(entry.channels.len(), 2, "with two channels");

    w.battery().await.unwrap();
    assert_eq!(
        (
            sent(&w.usb, &BrickCommand::Battery),
            sent(&w.bt, &BrickCommand::Battery)
        ),
        (1, 0)
    );
}

#[tokio::test(start_paused = true)]
async fn makes_the_signed_in_brick_active_and_clears_it_on_sign_out() {
    let w = world();
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    assert_eq!(w.bricks.active_brick().as_deref(), Some(AAA));
    w.bricks.sign_out(AAA).await;
    assert_eq!(w.bricks.active_brick(), None);
}

#[tokio::test(start_paused = true)]
async fn refuses_to_sign_in_a_brick_available_on_no_channel() {
    let w = world();
    assert_eq!(
        w.bricks.sign_in(AAA).await,
        Err(BrickError::NotAvailable {
            brick_id: AAA.into()
        })
    );
    assert!(!w.bricks.is_signed_in(AAA));
}

#[tokio::test(start_paused = true)]
async fn leaves_a_bluetooth_sighting_nobody_has_paired_out_of_a_sign_in() {
    // An inquiry's sighting, or the system relisting a brick unpaired after a forget: not a link.
    let w = world();
    w.bt.state().seen = vec![DiscoveryItem {
        paired: Some(false),
        ..bt_item()
    }];
    w.scan().await;
    assert!(matches!(
        w.bricks.sign_in(AAA).await,
        Err(BrickError::NotAvailable { .. })
    ));
    assert_eq!(w.bt.state().connect_calls, 0);
}

#[tokio::test(start_paused = true)]
async fn routes_a_single_channel_brick_over_its_one_channel_whatever_its_priority() {
    let mock = FakeProvider::new(Transport::Mock);
    let key = BrickKey::new(Transport::Mock, "brick-a").unwrap();
    mock.state().seen = vec![sighting(&key, "Brick A", None)];
    let scheduler = DiscoveryScheduler::new([mock.as_provider()], DiscoveryConfig::default());
    let list = PresenceAggregator::new(scheduler.clone());
    let sessions = SessionManager::new(
        [mock.as_provider()],
        Arc::new(Guard::default()),
        SessionConfig::default(),
    );
    let bricks = BrickManager::new(sessions, list, BrickOptions::default());
    scheduler.scan_once().await;
    bricks.sign_in("mock:brick-a").await.unwrap();
    assert_eq!(bricks.route_of("mock:brick-a"), Some(key));
}

// ── The packet a pinned operation uses ──────────────────────────────

fn chosen_packets() -> BrickOptions {
    BrickOptions {
        transfer_packet_bytes: Some(Arc::new(|transport| match transport {
            Transport::Bt => Some(4096),
            Transport::Usb => Some(2048),
            _ => None,
        })),
        ..options()
    }
}

#[tokio::test(start_paused = true)]
async fn gives_a_pinned_operation_over_bluetooth_the_chosen_packet() {
    let w = world_with(chosen_packets());
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    assert_eq!(w.route(), Some(bt_key()));
    assert_eq!(w.bricks.pin(AAA).unwrap().max_packet_bytes(), Some(4096));
}

#[tokio::test(start_paused = true)]
async fn keeps_usb_at_its_links_own_packet_whatever_is_chosen() {
    let w = world_with(chosen_packets());
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    assert_eq!(w.route(), Some(usb_key()));
    assert_eq!(
        w.bricks.pin(AAA).unwrap().max_packet_bytes(),
        w.sessions.max_packet_bytes(&usb_key())
    );
}

#[tokio::test(start_paused = true)]
async fn leaves_the_bricks_own_packet_at_the_links_a_chosen_size_is_for_transfers_only() {
    let w = world_with(chosen_packets());
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    assert_eq!(
        w.bricks.max_packet_bytes(AAA),
        w.sessions.max_packet_bytes(&bt_key())
    );
    assert_ne!(w.bricks.max_packet_bytes(AAA), Some(4096));
}

// ── Failing over ────────────────────────────────────────────────────

/// AAA signed in over USB and Bluetooth, both connected, traffic over USB.
async fn both_channels() -> World {
    let w = world();
    w.show_usb();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    wait_until("Bluetooth connected", || {
        w.state(&bt_key()) == Some(ConnectionState::Connected)
    })
    .await;
    settle().await; // the name reads after the joins
    w
}

#[tokio::test(start_paused = true)]
async fn sends_the_next_command_over_bluetooth_after_one_fails_on_a_pulled_cable() {
    let w = both_channels().await;
    w.usb.pull_cable();
    let failed = w.battery().await.unwrap_err();
    assert!(
        failed.to_string().contains("LIBUSB_ERROR_NO_DEVICE"),
        "{failed}"
    );
    assert_eq!(
        sent(&w.bt, &BrickCommand::Battery),
        0,
        "the failed command must not have been resent over Bluetooth"
    );

    // No heartbeat in between: its interval here is an hour.
    w.battery().await.unwrap();
    assert_eq!(w.route(), Some(bt_key()));
    assert_eq!(sent(&w.bt, &BrickCommand::Battery), 1);
}

#[tokio::test(start_paused = true)]
async fn takes_a_dead_usb_channel_to_reconnecting_at_once_and_back_to_usb_when_the_cable_returns() {
    let w = both_channels().await;
    w.usb.pull_cable();
    assert!(w.battery().await.is_err());
    wait_until("USB reconnecting", || {
        w.state(&usb_key()) == Some(ConnectionState::Reconnecting)
    })
    .await;
    assert_eq!(w.route(), Some(bt_key()));

    w.usb.plug_cable(); // the session reconnects on its own backoff
    wait_until("traffic back on USB", || w.route() == Some(usb_key())).await;
}

#[tokio::test(start_paused = true)]
async fn puts_a_channel_back_into_routing_when_the_failure_was_a_one_off() {
    let w = both_channels().await;
    w.usb.state().fault = Some(SendFault::Fail(
        ev3_transports::TransportError::transport_failed("USB send failed: LIBUSB_ERROR_IO"),
    ));
    let failed = w.battery().await;
    w.usb.state().fault = None; // only that command hit the fault; the probe that follows answers
    assert!(failed.is_err());

    wait_until("USB routed again", || w.route() == Some(usb_key())).await;
    assert_eq!(w.state(&usb_key()), Some(ConnectionState::Connected));
}

#[tokio::test(start_paused = true)]
async fn keeps_a_slow_usb_channel_connected_and_routes_it_again_once_the_brick_answers() {
    let w = both_channels().await;
    let mut events = w.sessions.subscribe();
    // The brick is busy: replies come late, the cable is in.
    w.usb.state().fault = Some(SendFault::Silent {
        after: Duration::from_millis(1000),
    });
    let failed = w
        .bricks
        .send(
            AAA,
            &BrickCommand::Battery,
            CommandOptions {
                timeout: Some(Duration::from_millis(1000)),
                ..CommandOptions::default()
            },
        )
        .await;
    assert!(failed.is_err());
    assert_eq!(
        w.route(),
        Some(bt_key()),
        "traffic goes over Bluetooth meanwhile"
    );
    assert_eq!(w.state(&usb_key()), Some(ConnectionState::Connected));

    w.usb.state().fault = None; // no longer busy: the next check answers, with no heartbeat
    wait_until("USB routed again", || w.route() == Some(usb_key())).await;
    while let Ok(event) = events.try_recv() {
        assert!(
            !matches!(event, ev3_runtime::SessionEvent::StateChanged { ref brick_key, new: ConnectionState::Reconnecting, .. } if *brick_key == usb_key()),
            "the USB session went to reconnecting"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn reconnects_a_usb_channel_that_stays_silent_at_the_heartbeats_own_threshold() {
    let w = both_channels().await;
    w.usb.state().fault = Some(SendFault::Silent {
        after: Duration::from_millis(1000),
    });
    assert!(w.battery().await.is_err());
    wait_until("USB reconnecting", || {
        w.state(&usb_key()) == Some(ConnectionState::Reconnecting)
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn keeps_the_only_channel_routed_when_a_command_fails_on_it() {
    // Nowhere to move traffic to: dropping it left a gap in which the next command failed with
    // no connected channel.
    let w = world();
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    settle().await;
    let mut routes = w.bricks.subscribe();

    w.usb.state().fault = Some(SendFault::Fail(
        ev3_transports::TransportError::transport_failed("USB send failed: LIBUSB_ERROR_IO"),
    ));
    let failed = w.battery().await;
    w.usb.state().fault = None;
    assert!(failed.is_err());

    assert_eq!(
        w.route(),
        Some(usb_key()),
        "there is nowhere to move traffic to"
    );
    w.battery().await.expect("at once, with no gap");
    settle().await;
    while let Ok(event) = routes.try_recv() {
        assert!(
            !matches!(event, BrickEvent::RouteChanged { .. }),
            "the route went to none and back: {event:?}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn moves_no_traffic_and_sends_no_probe_for_a_command_its_caller_dropped() {
    let w = both_channels().await;
    w.usb.state().hang_next = 1;
    let dropped = tokio::time::timeout(Duration::from_millis(50), w.battery()).await;
    assert!(
        dropped.is_err(),
        "the command answered before its caller dropped it"
    );
    settle().await;
    assert_eq!(w.route(), Some(usb_key()));
    assert_eq!(
        sent(&w.usb, &BrickCommand::Battery),
        1,
        "a dropped command must not have started a probe"
    );
}

// ── Channels that come later ────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn joins_a_usb_channel_that_appears_after_a_bluetooth_only_sign_in_and_moves_traffic_to_it() {
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    assert_eq!(w.route(), Some(bt_key()));

    w.show_usb(); // cable plugged in
    w.scan().await;
    wait_until("traffic on USB", || w.route() == Some(usb_key())).await;
}

#[tokio::test(start_paused = true)]
async fn retries_a_failed_usb_join_on_a_backoff_without_the_cable_being_replugged() {
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();

    fail_next_connects(&w.usb, 1);
    w.show_usb();
    w.scan().await;
    wait_until("traffic on USB", || w.route() == Some(usb_key())).await;
    assert_eq!(w.usb.state().connect_calls, 2);
}

#[tokio::test(start_paused = true)]
async fn says_a_join_that_keeps_failing_the_same_way_once_and_says_when_it_finally_joins() {
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();

    fail_next_connects(&w.usb, 3);
    w.show_usb();
    w.scan().await;
    wait_until("traffic on USB", || w.route() == Some(usb_key())).await;
    assert_eq!(w.usb.state().connect_calls, 4);
    assert_eq!(
        w.log.starting("warn Joining").len(),
        1,
        "{:?}",
        w.log.0.lock().unwrap()
    );
    let joined = w.log.starting("info Joined");
    assert_eq!(joined.len(), 1);
    assert!(joined[0].contains("after it had failed"));
}

#[tokio::test(start_paused = true)]
async fn leaves_a_failed_bluetooth_join_alone_until_the_brick_is_seen_again() {
    let w = world();
    w.show_usb();
    w.show_bt();
    w.scan().await;
    fail_next_connects(&w.bt, 1);

    w.bricks.sign_in(AAA).await.unwrap(); // USB connects; Bluetooth fails
    wait_until("one Bluetooth connect", || w.bt.state().connect_calls == 1).await;
    for _ in 0..3 {
        w.scan().await;
    }
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        w.bt.state().connect_calls,
        1,
        "Bluetooth must not be retried on a timer or on every scan"
    );

    w.hide_bt(); // out of range
    w.scan().await;
    w.show_bt(); // and back: new evidence
    w.scan().await;
    wait_until("Bluetooth connected", || {
        w.state(&bt_key()) == Some(ConnectionState::Connected)
    })
    .await;
    assert_eq!(w.bt.state().connect_calls, 2);
}

#[tokio::test(start_paused = true)]
async fn retries_a_failed_bluetooth_join_once_the_brick_answers_a_presence_check() {
    let w = world();
    w.show_usb();
    w.show_bt();
    w.scan().await;
    fail_next_connects(&w.bt, 1);
    w.bricks.sign_in(AAA).await.unwrap(); // USB connects; Bluetooth fails and waits for evidence
    wait_until("one Bluetooth connect", || w.bt.state().connect_calls == 1).await;
    settle().await;

    w.bt_answers();
    w.scan().await;
    wait_until("Bluetooth connected", || {
        w.state(&bt_key()) == Some(ConnectionState::Connected)
    })
    .await;
    assert_eq!(w.bt.state().connect_calls, 2);
}

// ── A multi-step operation keeps its channel ────────────────────────

#[tokio::test(start_paused = true)]
async fn finishes_a_bluetooth_transfer_over_bluetooth_when_usb_joins_midway() {
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    let link = w.bricks.pin(AAA).unwrap();
    link.send(&BrickCommand::Ports, None).await.unwrap();

    w.show_usb(); // the cable goes back in mid-transfer
    w.scan().await;
    wait_until("traffic on USB", || w.route() == Some(usb_key())).await;
    w.battery().await.unwrap(); // everyone else follows the new route

    link.send(&BrickCommand::Ports, None).await.unwrap();
    link.send(&BrickCommand::Ports, None).await.unwrap();
    assert_eq!(
        sent(&w.usb, &BrickCommand::Ports),
        0,
        "no step may have gone over USB"
    );
    assert_eq!(sent(&w.usb, &BrickCommand::Battery), 1);
    assert_eq!(sent(&w.bt, &BrickCommand::Ports), 3);
}

#[tokio::test(start_paused = true)]
async fn fails_a_usb_transfer_with_channel_changed_when_usb_is_lost_midway_and_sends_no_step_over_bluetooth()
 {
    let w = both_channels().await;
    let link = w.bricks.pin(AAA).unwrap();
    assert_eq!(link.brick_key(), &usb_key());
    link.send(&BrickCommand::Ports, None).await.unwrap();

    // The cable goes while the transfer runs, and the check finds it gone.
    w.usb.pull_cable();
    assert!(!w.sessions.probe_now(&usb_key()).await);

    assert_eq!(
        link.send(&BrickCommand::Ports, None).await,
        Err(BrickError::ChannelChanged {
            brick_key: usb_key()
        })
    );
    assert_eq!(sent(&w.bt, &BrickCommand::Ports), 0);
}

#[tokio::test(start_paused = true)]
async fn fails_a_pinned_step_with_channel_changed_once_its_channel_left_routing() {
    let w = both_channels().await;
    let link = w.bricks.pin(AAA).unwrap();
    // A failed command takes USB out of routing while it is checked; it stays connected.
    w.usb.state().fault = Some(SendFault::Silent {
        after: Duration::from_millis(1000),
    });
    assert!(w.battery().await.is_err());
    assert_eq!(w.state(&usb_key()), Some(ConnectionState::Connected));
    assert_eq!(
        link.send(&BrickCommand::Ports, None).await,
        Err(BrickError::ChannelChanged {
            brick_key: usb_key()
        })
    );
}

// ── The sign-in ends ────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn says_a_sign_in_ended_even_when_the_brick_had_no_route_left_to_lose() {
    let w = world();
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    w.usb.pull_cable(); // and it stays out
    assert!(w.battery().await.is_err());
    wait_until("no route", || w.route().is_none()).await;
    let mut events = w.bricks.subscribe();

    w.bricks.sign_out(AAA).await;

    let mut ended = false;
    while let Ok(event) = events.try_recv() {
        match event {
            BrickEvent::SignInEnded { brick_id } => ended = brick_id == AAA,
            BrickEvent::RouteChanged { .. } => panic!("no route was left to change"),
            BrickEvent::ActiveBrickChanged { .. } => {}
        }
    }
    assert!(ended, "telemetry would keep the brick's claims for good");
}

// ── The name the brick reports ──────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn asks_a_brick_that_appears_on_usb_for_its_name_once_without_signing_it_in() {
    let w = world();
    // Renamed since the cable went in; the descriptor still says AAA.
    w.usb.state().name_field = name_field(b"AAAx");
    w.show_usb();
    w.scan().await;
    wait_until("the probed name", || w.name().0 == "AAAx").await;
    assert_eq!(w.name(), ("AAAx".into(), NameSource::Brick, true));
    w.scan().await;
    assert_eq!(w.usb.state().probes, 1);
    assert_eq!(
        w.usb.state().connect_calls,
        0,
        "asking the name must not open a session"
    );
}

#[tokio::test(start_paused = true)]
async fn reads_the_name_over_the_session_when_a_signed_in_brick_gains_usb_without_a_probe() {
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    w.usb.state().name_field = name_field(b"AAAj");
    w.show_usb();
    w.scan().await;
    wait_until("the name over the session", || w.name().0 == "AAAj").await;
    assert_eq!(w.usb.state().probes, 0);
}

#[tokio::test(start_paused = true)]
async fn keeps_the_descriptor_name_when_the_probe_cannot_open_the_device_and_says_so_once() {
    let w = world();
    w.usb.state().probe_failure = Some("LIBUSB_ERROR_BUSY".into());
    w.show_usb();
    w.scan().await;
    w.usb.state().seen.clear();
    w.scan().await;
    w.show_usb(); // plugged in again
    w.scan().await;
    sleep(Duration::from_millis(20)).await;
    assert_eq!(w.name(), ("AAA".into(), NameSource::UsbDescriptor, false));
    assert_eq!(w.log.starting("warn Could not read the name").len(), 1);
}

#[tokio::test(start_paused = true)]
async fn shows_a_rename_made_through_the_cockpit_as_soon_as_the_brick_confirms_it() {
    let w = world();
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    // The brick took the name: what it answers from now on.
    w.usb.state().name_field = name_field(b"Rover");
    w.bricks
        .send(
            AAA,
            &BrickCommand::SetName {
                name: "Rover".into(),
            },
            CommandOptions::default(),
        )
        .await
        .unwrap();
    wait_until("the new name", || w.name().0 == "Rover").await;
    assert!(w.name().2);
}

/// The info reply's name field: `name`, its terminator, zeros.
fn name_field(name: &[u8]) -> Vec<u8> {
    let mut field = name.to_vec();
    field.resize(info_layout::LEN_BRICK_NAME, 0);
    field
}

/// What an earlier reply left in the globals: the firmware writes a string only up to its
/// terminator and never clears a direct command's globals, so part of a Wi-Fi network name rode
/// along in the brick-name field.
fn name_with_leftovers() -> Vec<u8> {
    let mut field = b"AAA\0wifi-net".to_vec();
    field.resize(info_layout::LEN_BRICK_NAME, b'Z');
    field
}

#[tokio::test(start_paused = true)]
async fn cuts_the_name_read_over_a_session_at_its_terminator() {
    let w = world();
    w.usb.state().name_field = name_with_leftovers();
    w.usb.state().probe_failure = Some("held".into());
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    wait_until("the confirmed name", || w.name().2).await;
    assert_eq!(w.name().0, "AAA");
}

#[tokio::test(start_paused = true)]
async fn cuts_the_name_read_over_a_probe_at_its_terminator() {
    let w = world();
    w.usb.state().name_field = name_with_leftovers();
    w.show_usb();
    w.scan().await;
    wait_until("the probed name", || w.name().2).await;
    assert_eq!(w.name().0, "AAA");
    assert_eq!(w.usb.state().probes, 1);
}

// ── Signing out ─────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn closes_every_channel_on_sign_out_and_joins_none_that_appears_afterwards() {
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    w.bricks.sign_out(AAA).await;
    assert_eq!(w.state(&bt_key()), None);

    w.show_usb();
    w.scan().await;
    sleep(Duration::from_millis(50)).await;
    assert_eq!(w.usb.state().connect_calls, 0);
    assert_eq!(w.route(), None);
}

/// A Bluetooth join waits seconds in the connection queue, long enough to sign the brick out and
/// in again. The first join used to come back as if it had connected, find its sign-in gone and
/// close the channel — the one the second sign-in had just opened.
async fn sign_in_again_while_the_first_bluetooth_join_waits(first_fails: bool) {
    let w = world();
    w.show_bt();
    w.scan().await;
    let gate = hold_connect(&w.bt, &[1]);

    let first = sign_in_in_background(&w);
    wait_until("the first connect inside the provider", || {
        w.bt.state().connecting == 1
    })
    .await;
    w.bricks.sign_out(AAA).await;
    let second = sign_in_in_background(&w);
    sleep(Duration::from_millis(20)).await;

    if first_fails {
        w.bt.state().failing_calls = vec![1];
    }
    gate.add_permits(1);
    assert_eq!(
        first.await.unwrap(),
        Err(BrickError::ConnectionAbandoned {
            brick_id: AAA.into()
        })
    );
    second.await.unwrap().unwrap();

    assert_eq!(
        w.bt.state().most_connecting,
        1,
        "two connects were inside the provider at once on one channel"
    );
    assert_eq!(w.state(&bt_key()), Some(ConnectionState::Connected));
    assert!(
        w.bt.state().held,
        "the provider closed the link the second sign-in opened"
    );
    assert_eq!(w.route(), Some(bt_key()));
    assert_eq!(w.bricks.active_brick().as_deref(), Some(AAA));
}

#[tokio::test(start_paused = true)]
async fn signs_in_again_while_the_first_bluetooth_join_still_waits_and_it_connects() {
    sign_in_again_while_the_first_bluetooth_join_waits(false).await;
}

#[tokio::test(start_paused = true)]
async fn signs_in_again_while_the_first_bluetooth_join_still_waits_and_it_fails() {
    sign_in_again_while_the_first_bluetooth_join_waits(true).await;
}

#[tokio::test(start_paused = true)]
async fn does_not_page_the_brick_for_a_sign_in_signed_out_while_it_waited_its_turn() {
    let w = world();
    w.show_bt();
    w.scan().await;
    let gate = hold_connect(&w.bt, &[1]);

    let first = sign_in_in_background(&w);
    wait_until("the first connect inside the provider", || {
        w.bt.state().connecting == 1
    })
    .await;
    w.bricks.sign_out(AAA).await;
    let second = sign_in_in_background(&w);
    settle().await;
    w.bricks.sign_out(AAA).await;
    gate.add_permits(1);
    let abandoned = Err(BrickError::ConnectionAbandoned {
        brick_id: AAA.into(),
    });
    assert_eq!(first.await.unwrap(), abandoned);
    assert_eq!(second.await.unwrap(), abandoned);

    assert_eq!(
        w.bt.state().connect_calls,
        1,
        "a connect nobody wanted any more reached the brick"
    );
    assert_eq!(w.state(&bt_key()), None);
    assert!(!w.bricks.is_signed_in(AAA));
}

#[tokio::test(start_paused = true)]
async fn signs_in_again_while_an_automatic_bluetooth_reconnect_still_waits_and_leaves_one_link() {
    // The reconnect after a lost link is the session manager's own, not a join; it too can wait
    // in the connection queue when the user signs out and in again.
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    let gate = hold_connect(&w.bt, &[2]);
    w.bt.pull_cable();
    assert!(!w.sessions.probe_now(&bt_key()).await);
    w.bt.plug_cable();
    wait_until("the reconnect inside the provider", || {
        w.bt.state().connecting == 1
    })
    .await;

    w.bricks.sign_out(AAA).await;
    w.bt_answers(); // the brick answers a presence check: available again
    w.scan().await;
    let second = sign_in_in_background(&w);
    sleep(Duration::from_millis(20)).await;
    gate.add_permits(1);
    second.await.unwrap().unwrap();

    assert_eq!(
        w.bt.state().most_connecting,
        1,
        "two connects were inside the provider at once on one channel"
    );
    assert_eq!(
        w.bt.state().open_links,
        1,
        "a link was left open with nobody to close it"
    );
    assert_eq!(w.state(&bt_key()), Some(ConnectionState::Connected));
    assert_eq!(w.route(), Some(bt_key()));
}

#[tokio::test(start_paused = true)]
async fn says_a_sign_in_was_signed_out_not_that_the_cable_failed_before_that() {
    // The extension stays quiet about a connect the user cancelled; it can only tell that one
    // apart if the sign-in says so, whatever its other channels failed with first.
    let w = world();
    w.show_usb();
    w.show_bt();
    w.scan().await;
    fail_next_connects(&w.usb, 1);
    let gate = hold_connect(&w.bt, &[1]);

    let signing_in = sign_in_in_background(&w);
    wait_until("USB failed and Bluetooth waits", || {
        w.usb.state().connect_calls == 1 && w.bt.state().connecting == 1
    })
    .await;
    w.bricks.sign_out(AAA).await;
    gate.add_permits(1);
    assert_eq!(
        signing_in.await.unwrap(),
        Err(BrickError::ConnectionAbandoned {
            brick_id: AAA.into()
        })
    );
}

#[tokio::test(start_paused = true)]
async fn ends_a_sign_in_whose_every_join_failed_though_its_caller_dropped_it() {
    let w = world();
    w.show_usb();
    w.scan().await;
    let gate = hold_connect(&w.usb, &[1]);
    w.usb.state().failing_calls = vec![1];
    let dropped = tokio::time::timeout(Duration::from_millis(10), w.bricks.sign_in(AAA)).await;
    assert!(
        dropped.is_err(),
        "the sign-in ended before its caller dropped it"
    );

    gate.add_permits(1);
    wait_until("the sign-in ended", || !w.bricks.is_signed_in(AAA)).await;
    sleep(Duration::from_millis(200)).await;
    assert_eq!(
        w.usb.state().connect_calls,
        1,
        "a failed sign-in nobody waited for kept retrying"
    );
}

#[tokio::test(start_paused = true)]
async fn closes_every_channel_though_the_sign_out_was_dropped() {
    let w = world();
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    // The link takes a moment to close, and the caller gives up before it has.
    w.usb.state().disconnect_delay = Duration::from_millis(10);
    let _ = tokio::time::timeout(Duration::ZERO, w.bricks.sign_out(AAA)).await;
    wait_until("the session closed", || w.state(&usb_key()).is_none()).await;
    assert!(!w.bricks.is_signed_in(AAA));
}

#[tokio::test(start_paused = true)]
async fn keeps_a_sign_in_whose_candidates_failed_when_a_channel_found_meanwhile_joined() {
    // A cable plugged in just after the sign-in joined while the only first candidate, Bluetooth,
    // failed: the brick is connected, so the sign-in stands.
    let w = world();
    w.show_bt();
    w.scan().await;
    let gate = hold_connect(&w.bt, &[1]);
    w.bt.state().failing_calls = vec![1];
    let signing_in = sign_in_in_background(&w);
    wait_until("Bluetooth inside the provider", || {
        w.bt.state().connecting == 1
    })
    .await;

    w.show_usb();
    w.scan().await;
    wait_until("USB connected", || {
        w.state(&usb_key()) == Some(ConnectionState::Connected)
    })
    .await;
    gate.add_permits(1);
    signing_in.await.unwrap().unwrap();
    assert!(w.bricks.is_signed_in(AAA));
    assert_eq!(w.bricks.active_brick().as_deref(), Some(AAA));
    assert_eq!(w.route(), Some(usb_key()));
}

#[tokio::test(start_paused = true)]
async fn connects_again_a_bluetooth_channel_that_waited_for_evidence_without_a_new_sighting() {
    let w = world();
    w.show_usb();
    w.show_bt();
    w.scan().await;
    fail_next_connects(&w.bt, 1);
    w.bricks.sign_in(AAA).await.unwrap();
    wait_until("one Bluetooth connect", || w.bt.state().connect_calls == 1).await;
    settle().await;

    // The user asks now: what the failed join waited for goes.
    w.bricks.connect_again(AAA).await.unwrap();
    assert_eq!(w.state(&bt_key()), Some(ConnectionState::Connected));
    assert_eq!(w.bt.state().connect_calls, 2);
}

#[tokio::test(start_paused = true)]
async fn signs_in_a_brick_that_is_not_signed_in_when_asked_to_connect_it_again() {
    let w = world();
    w.show_usb();
    w.scan().await;
    w.bricks.connect_again(AAA).await.unwrap();
    assert!(w.bricks.is_signed_in(AAA));
    assert_eq!(w.route(), Some(usb_key()));
}

#[tokio::test(start_paused = true)]
async fn ends_every_sign_in_when_the_brick_layer_is_disposed() {
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    let mut events = w.bricks.subscribe();
    w.bricks.dispose();
    let ended: Vec<_> = std::iter::from_fn(|| events.try_recv().ok())
        .filter(|e| matches!(e, BrickEvent::SignInEnded { .. }))
        .collect();
    assert_eq!(
        ended,
        [BrickEvent::SignInEnded {
            brick_id: AAA.into()
        }]
    );
    assert!(!w.bricks.is_signed_in(AAA));
    w.show_usb();
    w.scan().await;
    sleep(Duration::from_millis(50)).await;
    assert_eq!(
        w.usb.state().connect_calls,
        0,
        "a disposed brick layer joined a channel"
    );
}

#[tokio::test(start_paused = true)]
async fn goes_on_joining_after_it_missed_events() {
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    // More list changes than the event channel holds, with no chance to read them in between.
    for i in 0..300 {
        w.list
            .confirm_name(AAA, if i % 2 == 0 { "AAA1" } else { "AAA2" });
    }
    w.show_usb();
    w.scan().await;
    wait_until("USB joined after the missed events", || {
        w.route() == Some(usb_key())
    })
    .await;
}

// ── Waiting for a route ─────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn waits_for_a_route_until_the_deadline_and_sends_over_the_one_that_comes_back() {
    let w = world();
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    w.usb.pull_cable();
    assert!(w.battery().await.is_err());
    wait_until("no route", || w.route().is_none()).await;

    let waiting = {
        let bricks = w.bricks.clone();
        tokio::spawn(async move {
            bricks
                .send(
                    AAA,
                    &BrickCommand::Battery,
                    CommandOptions {
                        deadline: Some(Instant::now() + Duration::from_secs(10)),
                        ..CommandOptions::default()
                    },
                )
                .await
        })
    };
    sleep(Duration::from_millis(100)).await;
    assert!(
        !waiting.is_finished(),
        "a command with a deadline failed at once"
    );
    w.usb.plug_cable();
    assert!(
        waiting.await.unwrap().is_ok(),
        "the command did not go over the route that came back"
    );
}

#[tokio::test(start_paused = true)]
async fn fails_at_the_deadline_with_what_the_channels_last_failed_with() {
    let w = world();
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    w.usb.pull_cable();
    assert!(w.battery().await.is_err());
    wait_until("no route", || w.route().is_none()).await;

    let started = Instant::now();
    let failed = w
        .bricks
        .wait_for_route(AAA, Some(started + Duration::from_secs(2)))
        .await
        .unwrap_err();
    assert!(
        started.elapsed() >= Duration::from_secs(2),
        "it did not wait out the deadline"
    );
    let message = failed.to_string();
    assert!(
        message.contains("no channel came back in time"),
        "{message}"
    );
    assert!(message.contains("Last failure"), "{message}");

    assert!(matches!(
        w.bricks.wait_for_route(AAA, None).await,
        Err(BrickError::NoRoute { .. })
    ));
}

#[tokio::test(start_paused = true)]
async fn stops_waiting_for_a_route_when_the_brick_is_signed_out() {
    let w = world();
    w.show_usb();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    w.usb.pull_cable();
    assert!(w.battery().await.is_err());
    wait_until("no route", || w.route().is_none()).await;
    let waiting = {
        let bricks = w.bricks.clone();
        tokio::spawn(async move {
            bricks
                .wait_for_route(AAA, Some(Instant::now() + Duration::from_secs(60)))
                .await
        })
    };
    settle().await;
    w.bricks.sign_out(AAA).await;
    let message = waiting.await.unwrap().unwrap_err().to_string();
    assert!(
        message.contains("disconnected while the operation waited"),
        "{message}"
    );
}

// ── Holding a brick's links ─────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn refuses_a_sign_in_and_probes_nothing_while_the_bricks_links_are_held() {
    let w = world();
    let hold = w.bricks.hold_links(AAA);
    w.show_usb();
    w.scan().await;
    settle().await;
    assert_eq!(
        w.usb.state().probes,
        0,
        "a probe opened a link a forget is closing"
    );
    assert_eq!(
        w.bricks.sign_in(AAA).await,
        Err(BrickError::Held {
            brick_id: AAA.into()
        })
    );
    drop(hold);
    assert!(!w.bricks.is_held(AAA));
    w.bricks.sign_in(AAA).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn joins_no_channel_and_moves_no_traffic_while_the_bricks_links_are_held() {
    let w = world();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
    let outer = w.bricks.hold_links(AAA);
    let inner = w.bricks.hold_links(AAA);
    w.show_usb();
    w.scan().await;
    sleep(Duration::from_millis(50)).await;
    assert_eq!(
        w.usb.state().connect_calls,
        0,
        "a channel joined under a forget"
    );
    drop(inner);
    assert!(w.bricks.is_held(AAA), "one hold ended and lifted the other");
    drop(outer);
    w.scan().await;
    wait_until("USB joined once the hold ended", || {
        w.route() == Some(usb_key())
    })
    .await;
}

// ── The Bluetooth gate ──────────────────────────────────────────────

#[derive(Default)]
struct Gate {
    holds: AtomicBool,
    /// Starts holding when it hears a USB or TCP channel connect, as the pairing check does: the
    /// brick's list is read over that channel before Bluetooth may go.
    holds_on_cable: AtomicBool,
    reconciled: Mutex<u32>,
}

impl BluetoothGate for Gate {
    fn holds(&self, _brick_id: &str) -> bool {
        self.holds.load(Ordering::SeqCst)
    }

    fn channel_state(&self, _brick_id: &str, brick_key: &BrickKey, state: ConnectionState) {
        if self.holds_on_cable.load(Ordering::SeqCst)
            && brick_key.transport() != Transport::Bt
            && state == ConnectionState::Connected
        {
            self.holds.store(true, Ordering::SeqCst);
        }
    }

    fn reconciled(&self, _brick_id: &str) {
        *self.reconciled.lock().unwrap() += 1;
    }
}

#[tokio::test(start_paused = true)]
async fn tells_the_gate_of_a_usb_connect_before_the_bluetooth_join_it_held_looks_again() {
    let (w, gate) = gated();
    gate.holds_on_cable.store(true, Ordering::SeqCst);
    w.show_usb();
    w.show_bt();
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap(); // over USB
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        w.bt.state().connect_calls,
        0,
        "Bluetooth went before the gate could check the list read over USB"
    );

    gate.holds.store(false, Ordering::SeqCst); // the check found both halves
    w.bricks.wake_bluetooth();
    wait_until("Bluetooth connected", || {
        w.state(&bt_key()) == Some(ConnectionState::Connected)
    })
    .await;
}

fn gated() -> (World, Arc<Gate>) {
    let gate = Arc::new(Gate::default());
    let w = world_with(BrickOptions {
        bluetooth_gate: Some(gate.clone()),
        ..options()
    });
    (w, gate)
}

#[tokio::test(start_paused = true)]
async fn holds_a_bluetooth_join_while_the_first_usb_join_is_under_way() {
    let (w, _gate) = gated();
    w.show_usb();
    w.show_bt();
    w.scan().await;
    let usb_gate = hold_connect(&w.usb, &[1]);
    let signing_in = sign_in_in_background(&w);
    wait_until("the USB connect inside the provider", || {
        w.usb.state().connecting == 1
    })
    .await;
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        w.bt.state().connect_calls,
        0,
        "Bluetooth went before the USB join ended"
    );

    usb_gate.add_permits(1);
    signing_in.await.unwrap().unwrap();
    wait_until("Bluetooth connected", || {
        w.state(&bt_key()) == Some(ConnectionState::Connected)
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_usb_join_retrying_on_its_backoff_does_not_hold_the_bluetooth_join() {
    let (w, gate) = gated();
    w.show_usb();
    w.show_bt();
    w.scan().await;
    // The first USB join fails; its retry waits in the provider for good.
    fail_next_connects(&w.usb, 1);
    let _retry = hold_connect(&w.usb, &[2]);
    w.bricks.sign_in(AAA).await.unwrap(); // over Bluetooth, once the first USB join failed
    wait_until("the USB retry inside the provider", || {
        w.usb.state().connecting == 1
    })
    .await;
    assert_eq!(w.route(), Some(bt_key()));

    // The Bluetooth session ends while the USB retry is under way; it joins again at once.
    w.sessions.disconnect(&bt_key(), false).await;
    wait_until("Bluetooth joined again beside the USB retry", || {
        w.state(&bt_key()) == Some(ConnectionState::Connected)
    })
    .await;
    assert_eq!(w.bt.state().connect_calls, 2);
    assert_eq!(
        w.usb.state().connecting,
        1,
        "the USB retry is still under way"
    );
    assert!(
        *gate.reconciled.lock().unwrap() > 0,
        "the gate never heard the brick was joined again"
    );
}

#[tokio::test(start_paused = true)]
async fn holds_bluetooth_while_the_gate_holds_and_lets_it_go_when_woken() {
    let (w, gate) = gated();
    gate.holds.store(true, Ordering::SeqCst);
    w.show_bt();
    w.scan().await;
    let signing_in = sign_in_in_background(&w);
    sleep(Duration::from_millis(100)).await;
    assert_eq!(w.bt.state().connect_calls, 0);
    assert!(!signing_in.is_finished());

    gate.holds.store(false, Ordering::SeqCst);
    w.bricks.wake_bluetooth();
    signing_in.await.unwrap().unwrap();
    assert_eq!(w.route(), Some(bt_key()));
}

#[tokio::test(start_paused = true)]
async fn abandons_a_held_bluetooth_join_whose_pairing_went_meanwhile() {
    let (w, gate) = gated();
    gate.holds.store(true, Ordering::SeqCst);
    w.show_bt();
    w.scan().await;
    let signing_in = sign_in_in_background(&w);
    settle().await;
    w.list.forget_channel(&bt_key()); // the check removed the pairing
    gate.holds.store(false, Ordering::SeqCst);
    w.bricks.wake_bluetooth();
    assert!(matches!(
        signing_in.await.unwrap(),
        Err(BrickError::ConnectionAbandoned { .. })
    ));
    assert_eq!(w.bt.state().connect_calls, 0);
}

// ── Channels of one brick ───────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn prefers_usb_then_bluetooth_then_tcp_for_traffic() {
    let usb = FakeProvider::new(Transport::Usb);
    let bt = FakeProvider::new(Transport::Bt);
    let tcp = FakeProvider::new(Transport::Tcp);
    let providers = [usb.as_provider(), bt.as_provider(), tcp.as_provider()];
    let scheduler = DiscoveryScheduler::new(providers.clone(), DiscoveryConfig::default());
    let list = PresenceAggregator::new(scheduler.clone());
    let sessions = SessionManager::new(
        providers,
        Arc::new(Guard::default()),
        SessionConfig {
            heartbeat_interval: Duration::from_secs(3600),
            ..SessionConfig::default()
        },
    );
    let bricks = BrickManager::new(sessions.clone(), list.clone(), options());
    bt.state().seen = vec![bt_item()];
    tcp.state().seen = vec![sighting(&tcp_key(), "AAA", Some(NameSource::Beacon))];
    scheduler.scan_once().await;
    bricks.sign_in(AAA).await.unwrap();
    wait_until("both connected", || {
        sessions
            .sessions()
            .iter()
            .filter(|s| s.connection_state == ConnectionState::Connected)
            .count()
            == 2
    })
    .await;
    assert_eq!(bricks.route_of(AAA), Some(bt_key()), "Bluetooth before TCP");
    let order: Vec<_> = list
        .brick(AAA)
        .unwrap()
        .channels
        .iter()
        .map(|c| c.transport)
        .collect();
    assert_eq!(
        order,
        [Transport::Bt, Transport::Tcp],
        "the line reads [B][T]"
    );

    usb.state().seen = vec![sighting(&usb_key(), "AAA", Some(NameSource::UsbDescriptor))];
    scheduler.scan_once().await;
    wait_until("USB routed", || bricks.route_of(AAA) == Some(usb_key())).await;
    let order: Vec<_> = list
        .brick(AAA)
        .unwrap()
        .channels
        .iter()
        .map(|c| c.transport)
        .collect();
    assert_eq!(order, [Transport::Usb, Transport::Bt, Transport::Tcp]);
}

#[tokio::test(start_paused = true)]
async fn refuses_a_command_to_a_brick_that_is_not_signed_in_without_sending_it() {
    let w = world();
    w.show_usb();
    w.scan().await;
    assert!(matches!(w.battery().await, Err(BrickError::NoRoute { .. })));
    assert!(w.usb.state().requests.is_empty());
    assert!(matches!(
        w.bricks.set_active_brick(AAA),
        Err(BrickError::NotSignedIn { .. })
    ));
}

#[tokio::test(start_paused = true)]
async fn says_the_active_brick_changed_once() {
    let w = world();
    w.show_usb();
    w.scan().await;
    let mut events: broadcast::Receiver<BrickEvent> = w.bricks.subscribe();
    w.bricks.sign_in(AAA).await.unwrap();
    w.bricks.sign_in(AAA).await.unwrap(); // signed in already: active again, no change
    let changes: Vec<_> = std::iter::from_fn(|| events.try_recv().ok())
        .filter(|e| matches!(e, BrickEvent::ActiveBrickChanged { .. }))
        .collect();
    assert_eq!(
        changes,
        [BrickEvent::ActiveBrickChanged {
            previous: None,
            current: Some(AAA.into())
        }]
    );
}
