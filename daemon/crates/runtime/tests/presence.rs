//! The list of bricks: one channel's state machine, and one entry per brick however many channels
//! reach it, fed by real discovery over fake providers.

mod support;

use std::sync::Arc;
use std::time::Duration;

use ev3_runtime::{
    BrickChannel, ChannelEvent, ChannelMachine, ChannelState, ConnectionState, DiscoveryConfig,
    DiscoveryScheduler, PresenceAggregator, PresenceEvent,
};
use ev3_transports::{BrickKey, DiscoveryItem, NameSource, PresenceState, Transport};
use support::{FakeProvider, bt_key, sighting, tcp_key, usb_key, wall_ms};
use tokio::sync::broadcast;

const AAA: &str = "00165300000A";

// ── One channel's state machine ─────────────────────────────────────

/// Drives a fresh machine through `events` and returns the state after each.
fn walk(events: &[ChannelEvent]) -> Vec<ChannelState> {
    let mut machine = ChannelMachine::default();
    events
        .iter()
        .map(|event| {
            machine.apply(*event).unwrap();
            machine.state()
        })
        .collect()
}

use ChannelEvent::{Closed, Gone, LinkDown, LinkUp, Seen};
use ChannelState::{Absent, Available, Connected, Lost};

#[test]
fn a_channel_starts_absent() {
    assert_eq!(ChannelMachine::default().state(), Absent);
}

#[test]
fn a_channel_follows_the_arena_seen_connected_cable_out_cable_back() {
    assert_eq!(
        walk(&[Seen, LinkUp, LinkDown, Seen, LinkUp]),
        [Available, Connected, Lost, Available, Connected]
    );
}

#[test]
fn an_available_channel_discovery_stops_seeing_is_lost_and_found_again() {
    assert_eq!(walk(&[Seen, Gone, Seen]), [Available, Lost, Available]);
}

#[test]
fn a_signed_out_channel_returns_to_available() {
    assert_eq!(
        walk(&[Seen, LinkUp, Closed]),
        [Available, Connected, Available]
    );
}

#[test]
fn a_lost_channel_reconnects_straight_to_connected() {
    assert_eq!(
        walk(&[Seen, LinkUp, LinkDown, LinkUp]),
        [Available, Connected, Lost, Connected]
    );
}

#[test]
fn a_lost_channel_stays_lost_when_its_session_closes() {
    assert_eq!(
        walk(&[Seen, LinkUp, LinkDown, Closed]),
        [Available, Connected, Lost, Lost]
    );
}

#[test]
fn a_connected_channel_stays_connected_when_discovery_misses_it() {
    assert_eq!(
        walk(&[Seen, LinkUp, Gone]),
        [Available, Connected, Connected]
    );
}

#[test]
fn a_channel_nothing_has_seen_refuses_to_connect() {
    let mut machine = ChannelMachine::default();
    assert!(!machine.accepts(LinkUp));
    assert!(machine.apply(LinkUp).is_err());
    assert_eq!(machine.state(), Absent);
}

#[test]
fn a_channel_that_never_had_a_link_refuses_a_lost_link() {
    let mut machine = ChannelMachine::default();
    machine.apply(Seen).unwrap();
    assert!(machine.apply(LinkDown).is_err());
}

#[test]
fn a_transition_says_whether_it_changed_the_state() {
    let mut machine = ChannelMachine::default();
    assert_eq!(machine.apply(Seen), Ok(true));
    assert_eq!(machine.apply(Seen), Ok(false));
}

#[test]
fn a_channel_remembers_it_was_connected_once_through_a_later_loss() {
    let mut channel = BrickChannel::new(usb_key(), Transport::Usb, 30);
    for event in [Seen, LinkUp, LinkDown] {
        channel.apply(event).unwrap();
    }
    assert!(channel.ever_connected());
}

#[test]
fn a_channel_stops_being_expired_once_seen_again() {
    let mut channel = BrickChannel::new(usb_key(), Transport::Usb, 30);
    channel.apply(Seen).unwrap();
    channel.apply(Gone).unwrap();
    channel.mark_expired();
    assert!(channel.expired());
    channel.apply(Seen).unwrap();
    assert!(!channel.expired());
}

// ── The list ────────────────────────────────────────────────────────

/// Discovery over USB, Bluetooth and TCP; one missed scan loses a channel, one more expires it.
struct World {
    usb: Arc<FakeProvider>,
    bt: Arc<FakeProvider>,
    tcp: Arc<FakeProvider>,
    scheduler: Arc<DiscoveryScheduler>,
    list: Arc<PresenceAggregator>,
}

fn world() -> World {
    let usb = FakeProvider::new(Transport::Usb);
    let bt = FakeProvider::new(Transport::Bt);
    let tcp = FakeProvider::new(Transport::Tcp);
    world_of(usb, bt, tcp)
}

fn world_of(usb: Arc<FakeProvider>, bt: Arc<FakeProvider>, tcp: Arc<FakeProvider>) -> World {
    let scheduler = DiscoveryScheduler::new(
        [usb.as_provider(), bt.as_provider(), tcp.as_provider()],
        DiscoveryConfig {
            unavailable_after_misses: 1,
            removed_after_misses: 1,
            ..DiscoveryConfig::default()
        },
    );
    let list = PresenceAggregator::new(scheduler.clone());
    World {
        usb,
        bt,
        tcp,
        scheduler,
        list,
    }
}

fn show(provider: &FakeProvider, item: DiscoveryItem) {
    provider.state().seen = vec![item];
}

fn hide(provider: &FakeProvider) {
    provider.state().seen.clear();
}

impl World {
    async fn scan(&self) {
        self.scheduler.scan_once().await;
    }

    async fn scans(&self, n: usize) {
        for _ in 0..n {
            self.scan().await;
        }
    }

    fn state_of(&self, transport: Transport) -> ChannelState {
        self.list
            .brick(AAA)
            .and_then(|entry| entry.channel(transport).map(|c| c.state))
            .unwrap_or(Absent)
    }

    fn name(&self) -> (String, NameSource, bool) {
        let name = self.list.brick(AAA).unwrap().name;
        (name.value, name.source, name.confirmed)
    }
}

fn paired_bt(heard: Option<bool>, heard_at: Option<i64>) -> DiscoveryItem {
    DiscoveryItem {
        paired: Some(true),
        heard,
        heard_at,
        ..sighting(&bt_key(), "AAA", None)
    }
}

/// How many list changes a receiver has waiting.
fn list_changes(events: &mut broadcast::Receiver<PresenceEvent>) -> usize {
    let mut count = 0;
    while let Ok(event) = events.try_recv() {
        if event == PresenceEvent::ListChanged {
            count += 1;
        }
    }
    count
}

#[tokio::test(start_paused = true)]
async fn groups_the_usb_and_bluetooth_sightings_of_one_brick_into_one_entry() {
    let w = world();
    show(
        &w.usb,
        sighting(&usb_key(), "AAA", Some(NameSource::UsbDescriptor)),
    );
    show(&w.bt, sighting(&bt_key(), "AAA", Some(NameSource::BtCache)));
    w.scan().await;

    let list = w.list.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].brick_id, AAA);
    let channels: Vec<_> = list[0]
        .channels
        .iter()
        .map(|c| (c.transport, c.state))
        .collect();
    assert_eq!(
        channels,
        [(Transport::Usb, Available), (Transport::Bt, Available)]
    );
}

#[tokio::test(start_paused = true)]
async fn turns_a_channel_that_disappears_lost_while_the_others_stay_available() {
    let w = world();
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    show(&w.bt, sighting(&bt_key(), "AAA", None));
    w.scan().await;
    hide(&w.usb); // the cable comes out
    w.scan().await;
    assert_eq!(w.state_of(Transport::Usb), Lost);
    assert_eq!(w.state_of(Transport::Bt), Available);
}

#[tokio::test(start_paused = true)]
async fn reports_a_channel_never_seen_as_absent_not_lost() {
    let w = world();
    show(&w.bt, sighting(&bt_key(), "AAA", None));
    w.scan().await;
    assert_eq!(w.state_of(Transport::Usb), Absent);
    assert_eq!(w.list.brick(AAA).unwrap().channels.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn keeps_a_tcp_brick_known_only_by_its_address_as_its_own_entry() {
    let w = world();
    show(&w.bt, sighting(&bt_key(), "AAA", None));
    let by_address = BrickKey::new(Transport::Tcp, "192.0.2.20").unwrap();
    show(&w.tcp, sighting(&by_address, "EV3 [192.0.2.20]", None));
    w.scan().await;

    let list = w.list.list();
    assert_eq!(list.len(), 2);
    let entry = list
        .iter()
        .find(|b| b.brick_id == "tcp:192.0.2.20")
        .unwrap();
    let transports: Vec<_> = entry.channels.iter().map(|c| c.transport).collect();
    assert_eq!(transports, [Transport::Tcp]);
}

#[tokio::test(start_paused = true)]
async fn leaves_a_mock_brick_as_one_entry_with_one_channel() {
    let mock = FakeProvider::new(Transport::Mock);
    let key = BrickKey::new(Transport::Mock, "brick-a").unwrap();
    show(&mock, sighting(&key, "Brick A", Some(NameSource::Brick)));
    let scheduler = DiscoveryScheduler::new([mock.as_provider()], DiscoveryConfig::default());
    let list = PresenceAggregator::new(scheduler.clone());
    scheduler.scan_once().await;
    let entries = list.list();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].brick_id, "mock:brick-a");
    assert_eq!(entries[0].name.value, "Brick A");
}

#[tokio::test(start_paused = true)]
async fn orders_channels_by_the_priority_their_providers_declare_whatever_the_transport() {
    // A transport the list has never heard of slots in by its own priority alone.
    let tcp = FakeProvider::new(Transport::Tcp);
    tcp.state().priority = Some(25);
    let w = world_of(
        FakeProvider::new(Transport::Usb),
        FakeProvider::new(Transport::Bt),
        tcp,
    );
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    show(&w.bt, sighting(&bt_key(), "AAA", None));
    show(&w.tcp, sighting(&tcp_key(), "AAA", None));
    w.scan().await;
    let order: Vec<_> = w
        .list
        .brick(AAA)
        .unwrap()
        .channels
        .iter()
        .map(|c| c.transport)
        .collect();
    assert_eq!(order, [Transport::Usb, Transport::Tcp, Transport::Bt]);
}

#[tokio::test(start_paused = true)]
async fn keeps_each_channels_evidence_for_the_views_to_sort_by() {
    let w = world();
    let mut item = sighting(&bt_key(), "AAA", None);
    item.signal_info = Some(ev3_transports::SignalInfo {
        rssi: Some(-48),
        strength: None,
    });
    show(&w.bt, item);
    w.scan().await;
    let entry = w.list.brick(AAA).unwrap();
    let bt = entry.channel(Transport::Bt).unwrap();
    assert_eq!(bt.signal_info.as_ref().and_then(|s| s.rssi), Some(-48));
    assert!(bt.last_seen_at > 0);
    assert_eq!(entry.last_seen_at, bt.last_seen_at);
}

// ── Channel state follows the session ───────────────────────────────

#[tokio::test(start_paused = true)]
async fn marks_a_channel_connected_lost_while_it_reconnects_and_available_once_signed_out() {
    let w = world();
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    w.scan().await;
    w.list
        .update_channel_session(&usb_key(), ConnectionState::Connected);
    assert_eq!(w.state_of(Transport::Usb), Connected);
    w.list
        .update_channel_session(&usb_key(), ConnectionState::Reconnecting);
    assert_eq!(w.state_of(Transport::Usb), Lost);
    w.list
        .update_channel_session(&usb_key(), ConnectionState::Connected);
    w.list
        .update_channel_session(&usb_key(), ConnectionState::Disconnected);
    assert_eq!(w.state_of(Transport::Usb), Available);
}

#[tokio::test(start_paused = true)]
async fn takes_a_connected_session_as_proof_the_brick_is_there_before_discovery_lists_it() {
    let w = world();
    w.list
        .update_channel_session(&bt_key(), ConnectionState::Connected);
    assert_eq!(w.state_of(Transport::Bt), Connected);
}

#[tokio::test(start_paused = true)]
async fn keeps_a_connected_channel_connected_when_a_scan_misses_it() {
    // USB discovery skips a device its own transport holds claimed; the session decides.
    let w = world();
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    w.scan().await;
    w.list
        .update_channel_session(&usb_key(), ConnectionState::Connected);
    hide(&w.usb);
    w.scan().await;
    assert_eq!(w.state_of(Transport::Usb), Connected);
}

// ── Bricks that leave ───────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn drops_a_strangers_brick_once_discovery_gives_up_on_all_its_channels() {
    let w = world();
    show(&w.bt, sighting(&bt_key(), "AAA", None));
    w.scan().await;
    hide(&w.bt);
    w.scans(3).await;
    assert!(w.list.brick(AAA).is_none());
}

#[tokio::test(start_paused = true)]
async fn keeps_a_brick_it_was_connected_to_with_the_expired_channel_shown_lost() {
    let w = world();
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    w.scan().await;
    w.list
        .update_channel_session(&usb_key(), ConnectionState::Connected);
    w.list
        .update_channel_session(&usb_key(), ConnectionState::Reconnecting);
    hide(&w.usb);
    w.scans(3).await;
    assert_eq!(w.state_of(Transport::Usb), Lost);
}

#[tokio::test(start_paused = true)]
async fn brings_an_expired_channel_back_when_it_is_seen_again() {
    let w = world();
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    show(&w.bt, sighting(&bt_key(), "AAA", None));
    w.scan().await;
    hide(&w.usb);
    w.scans(3).await;
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    w.scan().await;
    assert_eq!(w.state_of(Transport::Usb), Available);
}

// ── A paired brick nobody hears ─────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn turns_a_paired_brick_that_stopped_answering_lost_and_keeps_it_lost_across_scans() {
    let w = world();
    show(&w.bt, paired_bt(Some(false), None));
    w.scan().await;
    assert_eq!(w.state_of(Transport::Bt), Lost);
    w.scan().await;
    assert_eq!(w.state_of(Transport::Bt), Lost);
    assert!(
        w.list.brick(AAA).is_some(),
        "a paired brick nobody hears stays in the list"
    );
}

#[tokio::test(start_paused = true)]
async fn brings_a_paired_brick_back_when_it_answers_again() {
    let w = world();
    show(&w.bt, paired_bt(Some(false), None));
    w.scan().await;
    show(&w.bt, paired_bt(Some(true), Some(wall_ms())));
    w.scan().await;
    assert_eq!(w.state_of(Transport::Bt), Available);
}

#[tokio::test(start_paused = true)]
async fn says_once_when_the_checks_stop_hearing_a_paired_brick_and_once_when_they_hear_it_again() {
    let w = world();
    let mut events = w.list.subscribe();
    let heard_changes = |events: &mut broadcast::Receiver<PresenceEvent>| {
        let mut flips = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let PresenceEvent::HeardChanged { heard, .. } = event {
                flips.push(heard);
            }
        }
        flips
    };
    let first = wall_ms();
    show(&w.bt, paired_bt(Some(true), Some(first)));
    w.scan().await;
    assert_eq!(
        heard_changes(&mut events),
        [false; 0],
        "a brick first listed as heard is no change"
    );

    show(&w.bt, paired_bt(Some(false), Some(first)));
    w.scans(2).await; // still not heard: nothing new
    assert_eq!(heard_changes(&mut events), [false]);

    show(&w.bt, paired_bt(Some(true), Some(first + 1)));
    w.scans(2).await; // the same answer again: nothing new
    assert_eq!(heard_changes(&mut events), [true]);
}

#[tokio::test(start_paused = true)]
async fn does_not_bring_back_a_channel_lost_to_a_dropped_session_on_an_old_answer() {
    let w = world();
    show(&w.bt, paired_bt(Some(true), Some(wall_ms())));
    w.scan().await;
    w.list
        .update_channel_session(&bt_key(), ConnectionState::Connected);
    w.list
        .update_channel_session(&bt_key(), ConnectionState::Reconnecting);
    w.scan().await; // the same answer as before: not news
    assert_eq!(w.state_of(Transport::Bt), Lost);
}

// ── The name shown ──────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn prefers_the_beacons_name_confirmed_over_the_usb_descriptor() {
    let w = world();
    show(
        &w.usb,
        sighting(&usb_key(), "AAA", Some(NameSource::UsbDescriptor)),
    );
    w.scan().await;
    assert_eq!(w.name(), ("AAA".into(), NameSource::UsbDescriptor, false));
    // Renamed on the brick: the descriptor keeps the old name, the beacon has the new one.
    show(
        &w.tcp,
        sighting(&tcp_key(), "AAAx", Some(NameSource::Beacon)),
    );
    w.scan().await;
    assert_eq!(w.name(), ("AAAx".into(), NameSource::Beacon, true));
}

#[tokio::test(start_paused = true)]
async fn does_not_let_a_later_bluetooth_record_overrule_a_confirmed_name() {
    let w = world();
    show(
        &w.tcp,
        sighting(&tcp_key(), "AAAx", Some(NameSource::Beacon)),
    );
    w.scan().await;
    show(&w.bt, sighting(&bt_key(), "AAA", Some(NameSource::BtCache)));
    w.scan().await;
    assert_eq!(w.name().0, "AAAx");
}

#[tokio::test(start_paused = true)]
async fn keeps_a_name_the_brick_just_confirmed_while_the_beacon_still_repeats_the_old_one() {
    // The cockpit renamed the brick and read the new name back; the beacon catches up seconds
    // later and until then keeps announcing the old name every scan.
    let w = world();
    show(
        &w.tcp,
        sighting(&tcp_key(), "AAA", Some(NameSource::Beacon)),
    );
    w.scan().await;
    std::thread::sleep(Duration::from_millis(5));
    w.list.confirm_name(AAA, "Rover");
    std::thread::sleep(Duration::from_millis(5)); // the next scans are later on the wall clock
    w.scans(2).await;
    assert_eq!(w.name().0, "Rover");
}

#[tokio::test(start_paused = true)]
async fn prefers_the_usb_descriptor_over_the_bluetooth_record_while_nothing_is_confirmed() {
    let w = world();
    show(
        &w.bt,
        sighting(
            &bt_key(),
            "Xfer data to and from EV3 brick",
            Some(NameSource::BtCache),
        ),
    );
    show(
        &w.usb,
        sighting(&usb_key(), "AAA", Some(NameSource::UsbDescriptor)),
    );
    w.scan().await;
    assert_eq!(w.name().0, "AAA");
}

// ── What the list owns ──────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn reports_a_brick_paired_when_its_bluetooth_channel_says_so() {
    let w = world();
    show(&w.bt, paired_bt(None, None));
    w.scan().await;
    assert!(w.list.brick(AAA).unwrap().paired);
}

#[tokio::test(start_paused = true)]
async fn takes_the_pairing_back_when_the_bluetooth_listing_says_unpaired_but_never_on_usb() {
    let w = world();
    show(&w.bt, paired_bt(None, None));
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    w.scan().await;
    assert!(w.list.brick(AAA).unwrap().paired);
    // Unpaired in the system's settings, outside the cockpit: the Bluetooth listing says so.
    show(
        &w.bt,
        DiscoveryItem {
            paired: Some(false),
            ..sighting(&bt_key(), "AAA", None)
        },
    );
    w.scan().await;
    assert!(!w.list.brick(AAA).unwrap().paired);
    // A USB sighting saying unpaired takes nothing back; only adds.
    show(&w.bt, paired_bt(None, None));
    show(
        &w.usb,
        DiscoveryItem {
            paired: Some(false),
            ..sighting(&usb_key(), "AAA", None)
        },
    );
    w.scan().await;
    assert!(w.list.brick(AAA).unwrap().paired);
}

#[tokio::test(start_paused = true)]
async fn keeps_favorite_across_scans() {
    let w = world();
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    w.scan().await;
    w.list.update_brick(AAA, Some(true), None);
    w.scan().await;
    assert!(w.list.brick(AAA).unwrap().favorite);
}

#[tokio::test(start_paused = true)]
async fn merges_a_remembered_brick_once_and_keeps_it_when_its_channels_expire() {
    let w = world();
    w.list.merge_remembered(&[DiscoveryItem {
        presence_state: PresenceState::Remembered,
        remembered: true,
        ..sighting(&bt_key(), "AAA", None)
    }]);
    show(&w.bt, sighting(&bt_key(), "AAA", None));
    w.scan().await;
    assert_eq!(w.list.list().len(), 1);
    hide(&w.bt);
    w.scans(3).await;
    assert!(w.list.brick(AAA).unwrap().remembered);
}

#[tokio::test(start_paused = true)]
async fn forwards_channel_presence_changes_from_discovery() {
    let w = world();
    let mut events = w.list.subscribe();
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    w.scan().await;
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let PresenceEvent::PresenceChanged(change) = event {
            seen.push(change.current);
        }
    }
    assert_eq!(seen, [PresenceState::Available]);
}

#[tokio::test(start_paused = true)]
async fn lists_a_brick_paired_here_as_paired_and_available_at_once() {
    let w = world();
    show(
        &w.bt,
        DiscoveryItem {
            paired: Some(false),
            ..sighting(&bt_key(), "AAA", None)
        },
    );
    w.scan().await;
    hide(&w.bt);
    w.scans(3).await; // the sighting expired while its owner confirmed on the brick
    w.list.mark_paired(&bt_key());
    let entry = w.list.brick(AAA).unwrap();
    assert!(entry.paired);
    assert_eq!(
        entry.channel(Transport::Bt).map(|c| c.state),
        Some(Available)
    );
    assert_eq!(
        w.scheduler.tracked_item(&bt_key()).and_then(|i| i.paired),
        Some(true),
        "discovery holds the pairing too, or the next rebuild takes it back"
    );
}

#[tokio::test(start_paused = true)]
async fn forgets_one_channel_and_keeps_the_brick() {
    let w = world();
    show(&w.bt, paired_bt(None, None));
    show(&w.usb, sighting(&usb_key(), "AAA", None));
    w.scan().await;
    w.list.forget_channel(&bt_key());
    let entry = w.list.brick(AAA).unwrap();
    assert!(!entry.paired);
    assert!(entry.channel(Transport::Bt).is_none());
    w.list.forget_channel(&usb_key());
    assert!(w.list.brick(AAA).is_none(), "a row nothing can reach goes");
}

// ── Forgetting a brick ──────────────────────────────────────────────

/// AAA remembered as paired, from persistence, and plugged in over USB.
async fn remembered_paired_aaa() -> World {
    let w = world();
    w.list.merge_remembered(&[DiscoveryItem {
        presence_state: PresenceState::Remembered,
        remembered: true,
        paired: Some(true),
        ..sighting(&bt_key(), "AAA", Some(NameSource::BtCache))
    }]);
    show(
        &w.usb,
        sighting(&usb_key(), "AAA", Some(NameSource::UsbDescriptor)),
    );
    w.scan().await;
    w.list.update_brick(AAA, Some(true), None);
    let before = w.list.brick(AAA).unwrap();
    assert!(before.paired && before.remembered);
    w
}

#[tokio::test(start_paused = true)]
async fn drops_a_remembered_paired_brick_and_tells_the_list_once() {
    let w = remembered_paired_aaa().await;
    let mut events = w.list.subscribe();
    w.list.forget(AAA);
    assert!(w.list.brick(AAA).is_none());
    assert_eq!(list_changes(&mut events), 1);
}

#[tokio::test(start_paused = true)]
async fn brings_a_forgotten_brick_back_unpaired_and_not_remembered_when_a_scan_lists_it() {
    let w = remembered_paired_aaa().await;
    w.list.forget(AAA);
    w.scan().await;
    let back = w
        .list
        .brick(AAA)
        .expect("the brick is still in reach, so it returns");
    assert!(!back.paired);
    assert!(!back.remembered);
    assert!(!back.favorite);
    let transports: Vec<_> = back.channels.iter().map(|c| c.transport).collect();
    assert_eq!(transports, [Transport::Usb]);
}

#[tokio::test(start_paused = true)]
async fn tells_the_list_nothing_when_forgetting_a_brick_it_does_not_know() {
    let w = world();
    let mut events = w.list.subscribe();
    w.list.forget(AAA);
    assert_eq!(list_changes(&mut events), 0);
}
