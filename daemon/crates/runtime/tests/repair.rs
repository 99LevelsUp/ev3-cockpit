//! The one-sided pairing repair and the Bluetooth joins it holds back: on the real brick layer,
//! sessions, discovery and list over a fake brick, with the check installed as the brick layer's
//! gate. Expected values come from today's TypeScript behavior.
//!
//! Time is tokio's paused clock.

mod support_forget;

use std::sync::Arc;
use std::time::Duration;

use ev3_runtime::BluetoothGate;
use ev3_runtime::forget::{PairingRemoval, PeerRemoval};
use ev3_runtime::repair::{OneSidedFound, RepairEvent, RepairRemoval};
use ev3_transports::Transport;
use support_forget::{
    AAA, HOSTA, Kind, Options, World, bt_key, settle, strings, usb_key, wait_for, world,
};
use tokio::sync::Semaphore;
use tokio::time::sleep;

fn checked(options: Options) -> World {
    world(Options {
        check: true,
        ..options
    })
}

async fn signed_in(w: &World) {
    w.scan().await;
    w.bricks.sign_in(AAA).await.unwrap();
}

fn check(w: &World) -> &ev3_runtime::repair::OneSidedCheck {
    w.check.as_ref().unwrap()
}

/// Connecting the brick as the person asks it: the check first, then every channel.
async fn connect(w: &World) {
    check(w).connect_requested(AAA);
    let _ = w.bricks.connect_again(AAA).await;
}

/// Signs the brick in over USB with its paired Bluetooth channel not connected: the presence
/// checks miss it, and the sign-in's own try of it gets no answer. Bluetooth answers again
/// afterwards, so whatever tries it next connects; its connects count from zero from here on.
async fn signed_in_over_usb_with_bluetooth_missed(w: &World) {
    w.bt.state().unheard = true;
    w.bt.state().off = true;
    w.signed_in_over(&[Transport::Usb]).await;
    wait_for(2000, "the sign-in's Bluetooth try", || {
        w.bt.state().connects == 1
    })
    .await;
    settle().await;
    assert!(
        !w.connected(&bt_key()),
        "Bluetooth was joined at the sign-in, so this test shows nothing"
    );
    let mut bt = w.bt.state();
    bt.off = false;
    bt.connects = 0;
    bt.usb_reads_at_connect.clear();
}

/// USB leaves and joins again; its list is read and checked again.
async fn usb_joins_again(w: &World) {
    let connects = w.usb.state().connects;
    w.sessions.disconnect(&usb_key(), false).await;
    wait_for(2000, "USB to join again", || {
        w.usb.state().connects == connects + 1 && w.connected(&usb_key())
    })
    .await;
    w.quiet().await;
}

// ── A pairing broken on one side, repaired over USB ─────────────────

#[tokio::test(start_paused = true)]
async fn computer_paired_brick_without_it_unpairs_keeps_usb_pairs_again_and_joins_bluetooth() {
    let w = checked(Options {
        peers: strings(&["Office PC"]),
        ..Options::default()
    });
    // The brick refuses a link from a computer it does not list.
    w.bt.state().needs_entry = true;

    signed_in(&w).await;
    wait_for(3000, "Bluetooth to join", || w.connected(&bt_key())).await;

    assert_eq!(w.bt.state().unpairs, [bt_key()]);
    assert_eq!(w.bt.state().pair_calls, 1);
    assert!(w.connected(&usb_key()), "USB dropped");
    let repairs = w.repairs();
    assert_eq!(repairs.len(), 1);
    assert_eq!(repairs[0].found, OneSidedFound::ComputerOnly);
    assert_eq!(
        repairs[0].removal,
        Some(RepairRemoval::Pairing(PairingRemoval::Removed {
            channel: bt_key()
        }))
    );
    assert!(repairs[0].pairing_again);
    assert!(w.removals().is_empty());
    assert_eq!(
        w.bt.state().connects,
        1,
        "Bluetooth was tried on the one-sided pairing before the repair"
    );
}

#[tokio::test(start_paused = true)]
async fn brick_lists_this_computer_not_paired_removes_the_entry_over_usb_reads_it_back_then_pairs()
{
    let w = checked(Options {
        paired: false,
        ..Options::default()
    });

    signed_in(&w).await;
    wait_for(3000, "the pairing", || w.bt.state().pair_calls == 1).await;
    wait_for(3000, "Bluetooth to join", || w.connected(&bt_key())).await;

    assert_eq!(w.removals(), [HOSTA]);
    assert_eq!(
        w.bt.state().peers_at_pair,
        [strings(&["Office PC"])],
        "the pairing started before the entry was removed"
    );
    let repairs = w.repairs();
    assert_eq!(repairs[0].found, OneSidedFound::BrickOnly);
    assert_eq!(
        repairs[0].removal,
        Some(RepairRemoval::Entry(PeerRemoval::Confirmed {
            name: HOSTA.into(),
            over: usb_key(),
            remaining: None,
        }))
    );
    assert!(w.bt.state().unpairs.is_empty());
    assert!(
        w.asked().is_empty(),
        "a person was asked: the brick's dialog is the consent"
    );
    // Told in order: the pairing started, the repair, the pairing's end.
    let events = w.repairs.lock().unwrap().clone();
    assert!(matches!(events[0], RepairEvent::PairingStarted { .. }));
    assert!(matches!(events[1], RepairEvent::Repaired(_)));
    assert!(matches!(&events[2], RepairEvent::PairingDone { outcome, .. } if outcome.ok));
    assert_eq!(
        serde_json::to_value(repairs[0].to_contract()).unwrap(),
        serde_json::json!({
            "brickId": AAA,
            "found": "brick-only",
            "removal": { "status": "confirmed", "name": HOSTA, "over": "usb:00165300000A" },
            "others": ["Office PC"],
        })
    );
}

#[tokio::test(start_paused = true)]
async fn removes_the_entry_before_pairing_a_bluetooth_sighting_listed_when_the_brick_signs_in() {
    let w = checked(Options {
        paired: false,
        ..Options::default()
    });
    // An unpaired sighting, there before the sign-in.
    w.bt.state().cached_after_unpair = true;

    signed_in(&w).await;
    wait_for(3000, "the pairing", || w.bt.state().pair_calls == 1).await;

    assert_eq!(
        w.bt.state().peers_at_pair,
        [strings(&["Office PC"])],
        "the sighting was paired before the check ran"
    );
    assert_eq!(w.removals(), [HOSTA]);
}

#[tokio::test(start_paused = true)]
async fn removes_nothing_and_pairs_nothing_when_both_halves_are_there() {
    let w = checked(Options::default());

    signed_in(&w).await;
    wait_for(2000, "Bluetooth to join", || w.connected(&bt_key())).await;
    w.quiet().await;

    assert!(w.removals().is_empty());
    assert!(w.bt.state().unpairs.is_empty());
    assert_eq!(w.bt.state().pair_calls, 0);
    assert!(w.repairs().is_empty());
    assert_eq!(w.bt.state().connects, 1);
    assert!(
        w.bt.state().usb_reads_at_connect[0] >= 1,
        "Bluetooth was joined before the list was read over USB"
    );
    assert!(
        !w.log.warnings().iter().any(|line| line.contains("Joining")),
        "a channel was joined twice: {:?}",
        w.log.warnings()
    );
}

#[tokio::test(start_paused = true)]
async fn does_not_check_without_this_computers_radio_name() {
    let w = checked(Options {
        paired: false,
        radio: None,
        ..Options::default()
    });

    signed_in(&w).await;
    w.quiet().await;
    sleep(Duration::from_millis(100)).await;

    assert!(w.removals().is_empty());
    assert!(w.repairs().is_empty());
}

#[tokio::test(start_paused = true)]
async fn joins_bluetooth_when_this_computers_radio_name_is_unknown() {
    let w = checked(Options {
        radio: None,
        ..Options::default()
    });

    signed_in(&w).await;

    wait_for(3000, "Bluetooth to join", || w.connected(&bt_key())).await;
}

#[tokio::test(start_paused = true)]
async fn does_not_check_when_only_bluetooth_reaches_the_brick() {
    let w = checked(Options {
        cabled: false,
        peers: strings(&["Office PC"]),
        ..Options::default()
    });

    signed_in(&w).await;
    wait_for(2000, "Bluetooth to join", || w.connected(&bt_key())).await;
    w.quiet().await;
    sleep(Duration::from_millis(100)).await;

    assert!(w.bt.state().unpairs.is_empty());
    assert!(w.repairs().is_empty());
}

#[tokio::test(start_paused = true)]
async fn waits_for_a_bluetooth_scan_to_answer_before_it_judges_this_computers_side() {
    let w = checked(Options {
        paired: false,
        ..Options::default()
    });
    // The first scan lists USB; the Bluetooth one fails, so nobody has looked yet.
    w.bt.state().scan_fails = 1;

    signed_in(&w).await;
    w.quiet().await;
    sleep(Duration::from_millis(100)).await;
    assert!(
        w.removals().is_empty(),
        "judged this computer unpaired before any Bluetooth scan answered"
    );

    // Answers, and lists nothing new.
    w.scan().await;

    wait_for(2000, "the removal", || w.removals().len() == 1).await;
}

#[tokio::test(start_paused = true)]
async fn checks_again_as_soon_as_this_computer_unpairs_a_brick_signed_in_over_usb() {
    let w = checked(Options::default());
    // Its Bluetooth link plays no part here.
    w.bt.state().off = true;
    signed_in(&w).await;
    w.quiet().await;
    sleep(Duration::from_millis(100)).await;
    assert!(w.repairs().is_empty(), "both halves were there");
    // Removed in the system's settings: its cache lists the brick unpaired, while the brick still
    // lists this computer.
    w.bt.state().paired = false;
    w.bt.state().cached_after_unpair = true;

    w.scan().await;
    wait_for(3000, "the repair", || w.repairs().len() == 1).await;

    assert_eq!(w.repairs()[0].found, OneSidedFound::BrickOnly);
    assert_eq!(w.removals(), [HOSTA]);
    wait_for(3000, "the pairing", || w.bt.state().pair_calls == 1).await;
    assert_eq!(
        w.bt.state().peers_at_pair,
        [strings(&["Office PC"])],
        "paired beside the entry the brick still held"
    );
}

#[tokio::test(start_paused = true)]
async fn does_not_take_a_pairing_the_system_no_longer_lists_for_one_it_still_has() {
    let w = checked(Options::default());
    w.bt.state().off = true;
    signed_in(&w).await;
    w.quiet().await;
    sleep(Duration::from_millis(100)).await;
    // Removed in the system's settings and gone from its list; discovery still tracks it as
    // paired, missed.
    w.bt.state().paired = false;
    w.scan().await;

    usb_joins_again(&w).await;
    wait_for(3000, "the repair", || w.repairs().len() == 1).await;

    assert_eq!(w.repairs()[0].found, OneSidedFound::BrickOnly);
}

#[tokio::test(start_paused = true)]
async fn pairs_nothing_when_the_entry_the_repair_removes_stays_on_the_brick() {
    let w = checked(Options {
        paired: false,
        ..Options::default()
    });
    // The brick's Bluetooth is busy: it answers the removal and does nothing.
    w.brick.state().ignores_removal = true;

    signed_in(&w).await;
    wait_for(3000, "the repair", || w.repairs().len() == 1).await;
    sleep(Duration::from_millis(100)).await;

    let repair = &w.repairs()[0];
    assert!(matches!(
        repair.removal,
        Some(RepairRemoval::Entry(PeerRemoval::Failed { .. }))
    ));
    assert!(!repair.pairing_again);
    assert_eq!(
        w.bt.state().pair_calls,
        0,
        "paired beside the entry the brick kept"
    );
}

#[tokio::test(start_paused = true)]
async fn names_the_other_entries_the_brick_holds() {
    let w = checked(Options {
        paired: false,
        peers: strings(&["OLD-PC", HOSTA, " "]),
        ..Options::default()
    });

    signed_in(&w).await;
    wait_for(3000, "the repair", || w.repairs().len() == 1).await;

    assert_eq!(w.repairs()[0].others, ["OLD-PC"]);
}

/// A repair of a computer-only pairing whose pairing the brick records without this computer's
/// name: the name request has not answered yet.
async fn repaired_with_an_unnamed_entry(w: &World) {
    w.bt.state().stored_name = Some(Some(String::new()));
    signed_in(w).await;
    wait_for(3000, "the repair's pairing", || {
        w.bt.state().pair_calls == 1
    })
    .await;
    wait_for(3000, "Bluetooth to join", || w.connected(&bt_key())).await;
    assert_eq!(w.repairs().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn waits_for_the_brick_to_name_this_computer_after_a_pairing_of_its_own_and_unpairs_nothing()
{
    let w = checked(Options {
        peers: strings(&["Office PC"]),
        ..Options::default()
    });
    repaired_with_an_unnamed_entry(&w).await;
    // The name request answers a moment later, and the brick fills the name in.
    let brick = w.brick.clone();
    tokio::spawn(async move {
        sleep(Duration::from_millis(60)).await;
        let mut state = brick.state();
        let at = state.peers.iter().position(String::is_empty).unwrap();
        state.peers[at] = HOSTA.to_owned();
    });

    usb_joins_again(&w).await;
    sleep(Duration::from_millis(600)).await;

    assert_eq!(
        w.bt.state().unpairs.len(),
        1,
        "unpaired a pairing the brick had not named yet"
    );
    assert_eq!(w.repairs().len(), 1, "{:?}", w.repairs());
    assert_eq!(w.bt.state().pair_calls, 1);
    assert!(
        !w.log
            .warnings()
            .iter()
            .any(|m| m.contains("without a name")),
        "{:?}",
        w.log.warnings()
    );
}

#[tokio::test(start_paused = true)]
async fn leaves_its_own_pairing_alone_with_one_line_in_the_log_when_the_brick_never_names_it() {
    let w = checked(Options {
        peers: strings(&["Office PC"]),
        ..Options::default()
    });
    repaired_with_an_unnamed_entry(&w).await;

    usb_joins_again(&w).await;
    sleep(Duration::from_millis(600)).await;

    assert_eq!(w.bt.state().unpairs.len(), 1);
    assert_eq!(w.repairs().len(), 1, "{:?}", w.repairs());
    assert_eq!(
        w.log
            .warnings()
            .iter()
            .filter(|m| m.contains("without a name"))
            .count(),
        1,
        "{:?}",
        w.log.warnings()
    );
    assert!(
        !check(&w).holds(AAA),
        "Bluetooth is still held after the last read"
    );
}

#[tokio::test(start_paused = true)]
async fn leaves_the_removed_half_removed_and_suspends_the_brick_when_the_repairs_pairing_is_cancelled()
 {
    let w = checked(Options {
        paired: false,
        ..Options::default()
    });
    w.bt.state().pair_accepts = false;

    signed_in(&w).await;
    wait_for(3000, "the pairing", || w.bt.state().pair_calls == 1).await;
    settle().await;
    w.bt.state().cached_after_unpair = true;
    w.scan().await;
    sleep(Duration::from_millis(100)).await;

    assert_eq!(w.brick.peers(), ["Office PC"]);
    assert_eq!(
        w.bt.state().pair_calls,
        1,
        "paired again after the cancel without a connect"
    );
    assert!(check(&w).is_suspended(AAA));
    let events = w.repairs.lock().unwrap().clone();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, RepairEvent::PairingDone { outcome, .. } if !outcome.ok)),
        "{events:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn finds_both_halves_after_a_pairing_it_just_made_and_removes_nothing_when_usb_joins_again() {
    let w = checked(Options {
        peers: strings(&["Office PC"]),
        ..Options::default()
    });

    signed_in(&w).await;
    wait_for(3000, "Bluetooth to join", || w.connected(&bt_key())).await;
    w.brick.state().received.clear();
    usb_joins_again(&w).await;
    sleep(Duration::from_millis(100)).await;

    assert_eq!(w.bt.state().pair_calls, 1);
    assert!(w.removals().is_empty());
    assert_eq!(w.bt.state().unpairs.len(), 1);
    assert_eq!(w.repairs().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn repairs_a_suspended_brick_only_when_it_is_connected_again() {
    let w = checked(Options {
        paired: false,
        peers: strings(&["Office PC", HOSTA]),
        ..Options::default()
    });
    w.bt.state().pair_accepts = false;
    signed_in(&w).await;
    // Declined: the brick is suspended.
    wait_for(3000, "the pairing", || w.bt.state().pair_calls == 1).await;
    settle().await;
    w.bt.state().pair_accepts = true;
    // One-sided again.
    w.brick.state().peers.push(HOSTA.to_owned());
    w.brick.state().received.clear();

    usb_joins_again(&w).await;
    sleep(Duration::from_millis(100)).await;
    assert!(
        w.removals().is_empty(),
        "a suspended brick was repaired without a connect"
    );
    assert_eq!(w.bt.state().pair_calls, 1);
    assert!(
        w.log.warnings().iter().any(|m| m.contains("one-sided")),
        "the one-sided state was not logged"
    );

    connect(&w).await;
    wait_for(3000, "the second pairing", || w.bt.state().pair_calls == 2).await;

    assert_eq!(w.removals(), [HOSTA]);
}

#[tokio::test(start_paused = true)]
async fn repairs_once_a_pairing_that_still_looks_one_sided_afterwards_is_reported_not_repaired() {
    let w = checked(Options {
        peers: strings(&["Office PC"]),
        ..Options::default()
    });
    // The brick stores this computer under a name that is not byte-exact.
    w.bt.state().stored_name = Some(Some(format!("{HOSTA} ")));

    signed_in(&w).await;
    wait_for(3000, "the pairing", || w.bt.state().pair_calls == 1).await;
    settle().await;
    usb_joins_again(&w).await;
    sleep(Duration::from_millis(100)).await;

    assert_eq!(w.bt.state().unpairs.len(), 1, "repaired again");
    assert_eq!(w.bt.state().pair_calls, 1);
    let repairs = w.repairs();
    assert_eq!(repairs.len(), 2);
    assert!(repairs[1].repeated);
    assert_eq!(repairs[1].removal, None);

    // The person asks: a repair is allowed again.
    connect(&w).await;
    wait_for(3000, "the second repair", || {
        w.bt.state().unpairs.len() == 2
    })
    .await;
}

// ── Bluetooth joins after the check when USB is there ───────────────

#[tokio::test(start_paused = true)]
async fn joins_bluetooth_when_the_list_cannot_be_read_over_usb() {
    let w = checked(Options::default());
    w.usb.state().fail_kinds.insert(Kind::PeerCount);

    signed_in(&w).await;

    wait_for(3000, "Bluetooth to join", || w.connected(&bt_key())).await;
    assert!(
        w.log
            .warnings()
            .iter()
            .any(|m| m.contains("Reading the list")),
        "{:?}",
        w.log.warnings()
    );
}

#[tokio::test(start_paused = true)]
async fn joins_bluetooth_when_usb_goes_before_the_check_could_run() {
    let w = checked(Options::default());
    // The first read over USB hangs.
    let read = w.brick.hold_next_count();

    signed_in(&w).await;
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        w.bt.state().connects,
        0,
        "Bluetooth did not wait for the check, so this test shows nothing"
    );
    w.usb.state().cabled = false;
    w.scan().await;
    w.sessions.disconnect(&usb_key(), false).await;

    wait_for(3000, "Bluetooth to join", || w.connected(&bt_key())).await;
    read.add_permits(1);
}

#[tokio::test(start_paused = true)]
async fn a_connect_tries_the_unheard_bluetooth_channel_of_a_signed_in_brick_after_the_check() {
    let w = checked(Options::default());
    signed_in_over_usb_with_bluetooth_missed(&w).await;
    assert_eq!(
        w.bt.state().connects,
        0,
        "Bluetooth was joined already, so this test shows nothing"
    );
    // The connect's read of the list hangs.
    let read = w.brick.hold_next_count();

    let connecting = tokio::spawn({
        let bricks = w.bricks.clone();
        let check = check(&w).clone();
        async move {
            check.connect_requested(AAA);
            bricks.connect_again(AAA).await
        }
    });
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        w.bt.state().connects,
        0,
        "Bluetooth was tried before the check ran"
    );

    read.add_permits(1);
    connecting.await.unwrap().unwrap();

    assert_eq!(w.bt.state().connects, 1);
    assert!(w.connected(&bt_key()));
}

#[tokio::test(start_paused = true)]
async fn ends_a_connect_whose_bluetooth_join_waits_for_the_check_when_the_brick_is_signed_out() {
    let w = checked(Options::default());
    signed_in_over_usb_with_bluetooth_missed(&w).await;
    // The check never gets its list.
    let read = w.brick.hold_next_count();
    let connecting = tokio::spawn({
        let bricks = w.bricks.clone();
        let check = check(&w).clone();
        async move {
            check.connect_requested(AAA);
            bricks.connect_again(AAA).await
        }
    });
    sleep(Duration::from_millis(50)).await;

    w.bricks.sign_out(AAA).await;

    let ended = tokio::time::timeout(Duration::from_millis(500), connecting).await;
    assert!(
        ended.is_ok(),
        "the connect still waits for a sign-in that ended"
    );
    assert_eq!(w.bt.state().connects, 0);
    read.add_permits(1);
}

#[tokio::test(start_paused = true)]
async fn ends_a_connect_whose_repairs_pairing_is_cancelled_with_no_bluetooth_join_left_waiting() {
    let w = checked(Options::default());
    w.bt.state().needs_entry = true;
    signed_in_over_usb_with_bluetooth_missed(&w).await;
    // The brick forgot this computer: one-sided now.
    w.brick.state().peers.retain(|p| p != HOSTA);
    // The person cancels the repair's pairing on the brick.
    w.bt.state().pair_accepts = false;

    let connecting = tokio::spawn({
        let bricks = w.bricks.clone();
        let check = check(&w).clone();
        async move {
            check.connect_requested(AAA);
            bricks.connect_again(AAA).await
        }
    });

    wait_for(3000, "the pairing", || w.bt.state().pair_calls == 1).await;
    let ended = tokio::time::timeout(Duration::from_secs(1), connecting).await;
    assert!(
        ended.is_ok(),
        "the connect waits for a Bluetooth join nothing will wake"
    );
    assert_eq!(w.bt.state().unpairs, [bt_key()]);
    assert_eq!(w.bt.state().connects, 0);
}

#[tokio::test(start_paused = true)]
async fn does_not_join_a_held_bluetooth_channel_the_repair_unpaired_while_the_repairs_pairing_waits()
 {
    let w = checked(Options {
        peers: strings(&["Office PC"]),
        ..Options::default()
    });
    w.bt.state().needs_entry = true;
    // The person has not answered the brick's dialog yet.
    let answers = Arc::new(Semaphore::new(0));
    w.bt.state().pair_gate = Some(answers.clone());

    signed_in(&w).await;
    wait_for(3000, "the pairing", || w.bt.state().pair_calls == 1).await;
    // The list changes while the pairing waits.
    w.scan().await;
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        w.bt.state().connects,
        0,
        "joined a Bluetooth channel this computer no longer has paired"
    );

    answers.add_permits(1);

    wait_for(3000, "Bluetooth to join", || w.connected(&bt_key())).await;
    assert_eq!(w.bt.state().connects, 1);
}

// ── A pairing never starts beside a clear ───────────────────────────

/// A brick-only repair whose removal is at the brick, unanswered, until the returned gate opens.
async fn repair_removal_waiting(w: &World) -> Arc<Semaphore> {
    let removal = w.brick.hold_next(Kind::Remove);
    signed_in(w).await;
    wait_for(3000, "the repair's removal", || w.removals().len() == 1).await;
    removal
}

#[tokio::test(start_paused = true)]
async fn pairs_nothing_after_a_repair_whose_removal_ends_while_a_clear_has_begun() {
    // The brick lists this computer; this computer has it unpaired.
    let w = checked(Options {
        paired: false,
        ..Options::default()
    });
    let removal = repair_removal_waiting(&w).await;
    let thinking = Arc::new(Semaphore::new(0));
    *w.person.thinking.lock().unwrap() = Some(thinking.clone());
    w.answer(ev3_runtime::ConsentAnswer::Declined);
    let clearing = tokio::spawn({
        let service = w.service.clone();
        async move {
            service
                .clear_bluetooth_list(AAA, &support_forget::requester())
                .await
        }
    });
    sleep(Duration::from_millis(50)).await;

    removal.add_permits(1);
    sleep(Duration::from_millis(200)).await;

    assert_eq!(
        w.bt.state().pair_calls,
        0,
        "the repair paired a brick whose list is being cleared"
    );
    thinking.add_permits(1);
    clearing.await.unwrap().unwrap_err();
}

#[tokio::test(start_paused = true)]
async fn pairs_nothing_after_a_repair_whose_removal_outlasts_a_clear_the_person_declined() {
    let w = checked(Options {
        paired: false,
        ..Options::default()
    });
    let removal = repair_removal_waiting(&w).await;
    w.answer(ev3_runtime::ConsentAnswer::Declined);
    let clearing = tokio::spawn({
        let service = w.service.clone();
        async move {
            service
                .clear_bluetooth_list(AAA, &support_forget::requester())
                .await
        }
    });

    removal.add_permits(1);
    clearing.await.unwrap().unwrap_err();
    sleep(Duration::from_millis(200)).await;

    assert_eq!(
        w.bt.state().pair_calls,
        0,
        "the repair paired a brick the clear had suspended"
    );
}

#[tokio::test(start_paused = true)]
async fn holds_nothing_and_checks_nothing_once_detached() {
    let w = checked(Options {
        paired: false,
        ..Options::default()
    });
    check(&w).detach();

    signed_in(&w).await;
    w.quiet().await;
    sleep(Duration::from_millis(100)).await;

    assert!(w.removals().is_empty());
    assert!(w.repairs().is_empty());
}
