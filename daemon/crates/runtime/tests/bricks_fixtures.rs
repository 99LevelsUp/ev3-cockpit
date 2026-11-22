//! The brick layer on a real brick's recorded USB exchanges, under `daemon/fixtures/link`: from
//! discovery to a brick in the list, and from a sign-in to a command over its route.
//!
//! When a test here fails with `replay_deviation` or `replay_unmatched`, the brick layer changed
//! what it sends; that is answered by recording the scenario again on hardware, never by editing
//! the recording.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_runtime::{
    BrickManager, BrickOptions, ChannelState, CommandOptions, ConnectionState, DiscoveryConfig,
    DiscoveryScheduler, Guard, PresenceAggregator, SessionConfig, SessionManager,
};
use ev3_transports::fixture::RECORDING_FILE;
use ev3_transports::{NameSource, Replay, ReplayMode, Transport};
use tokio::time::sleep;

/// AAA's hardware digits as the recordings hold them.
const AAA: &str = "001653F00A0A";

fn fixture(name: &str) -> PathBuf {
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/link");
    // A test binary built on one system and run on another (cross-built for Linux, run under
    // WSL) finds the workspace from its own path instead.
    let root = if compiled.is_dir() {
        compiled
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.ancestors()
                    .map(|dir| dir.join("fixtures/link"))
                    .find(|dir| dir.is_dir())
            })
            .unwrap_or(compiled)
    };
    root.join(name).join(RECORDING_FILE)
}

#[tokio::test(start_paused = true)]
async fn a_brick_discovered_over_usb_is_one_entry_named_by_its_descriptor() {
    let replay = Replay::load(&fixture("usb-discovery-aaa"), ReplayMode::Strict).unwrap();
    let usb = replay.provider(Transport::Usb).unwrap();
    let scheduler = DiscoveryScheduler::new([usb], DiscoveryConfig::default());
    let list = PresenceAggregator::new(scheduler.clone());

    scheduler.scan_once().await;

    let entries = list.list();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.brick_id, AAA);
    assert_eq!(entry.name.value, "AAA");
    assert_eq!(entry.name.source, NameSource::UsbDescriptor);
    assert!(
        !entry.name.confirmed,
        "a descriptor goes stale; only the brick confirms a name"
    );
    let channels: Vec<_> = entry
        .channels
        .iter()
        .map(|c| (c.transport, c.state))
        .collect();
    assert_eq!(channels, [(Transport::Usb, ChannelState::Available)]);
    replay.finish().expect("discovery made every recorded call");
}

#[tokio::test(start_paused = true)]
async fn a_brick_signed_in_from_discovery_reads_its_name_and_carries_commands_over_usb() {
    // Matched: the brick layer reads the name as its first command, where the recording cleared
    // the globals first, so the counters differ from the recorded run.
    let replay = Replay::load(&fixture("usb-connect-commands-aaa"), ReplayMode::Matched).unwrap();
    let usb = replay.provider(Transport::Usb).unwrap();
    let scheduler = DiscoveryScheduler::new([usb.clone()], DiscoveryConfig::default());
    let list = PresenceAggregator::new(scheduler.clone());
    let sessions = SessionManager::new(
        [usb],
        Arc::new(Guard::default()),
        SessionConfig {
            heartbeat_interval: Duration::from_secs(3600),
            ..SessionConfig::default()
        },
    );
    let bricks = BrickManager::new(sessions.clone(), list.clone(), BrickOptions::default());

    scheduler.scan_once().await;
    // The recording holds no probe: the name probe fails, and the descriptor's name stays.
    sleep(Duration::from_millis(10)).await;
    bricks.sign_in(AAA).await.unwrap();
    let key = bricks.route_of(AAA).expect("a route over USB");
    assert_eq!(key.transport(), Transport::Usb);
    assert_eq!(
        sessions.session(&key).map(|s| s.connection_state),
        Some(ConnectionState::Connected)
    );
    assert_eq!(bricks.max_packet_bytes(AAA), Some(1024));

    // The name read after the join, from the recorded info reply.
    for _ in 0..100 {
        if list.brick(AAA).is_some_and(|e| e.name.confirmed) {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    let name = list.brick(AAA).unwrap().name;
    assert_eq!(
        (name.value.as_str(), name.source),
        ("AAA", NameSource::Brick)
    );

    match bricks
        .send(AAA, &BrickCommand::Battery, CommandOptions::default())
        .await
        .unwrap()
    {
        BrickResponse::Battery { level, .. } => assert_eq!(level, 100),
        other => panic!("not a battery reply: {other:?}"),
    }
    bricks.sign_out(AAA).await;
    assert_eq!(sessions.session(&key), None);
    assert_eq!(bricks.route_of(AAA), None);
}
