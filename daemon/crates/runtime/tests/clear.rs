//! Clearing a brick's Bluetooth list: every entry removed and proved by reading the list back,
//! this computer's entry last over Bluetooth alone, the refusals when nothing tells that entry
//! apart, and what happens to this computer's pairing. On the real brick layer, sessions,
//! discovery and list over a fake brick; expected values come from today's TypeScript behavior.
//!
//! Time is tokio's paused clock.

mod support_forget;

use std::sync::Arc;
use std::time::Duration;

use ev3_runtime::ConsentAnswer;
use ev3_runtime::clear::{ClearPairingSkip, ClearSkip, ClearSkipped, ClearedEntry};
use ev3_runtime::forget::{PairingRemoval, Refused};
use ev3_transports::Transport;
use support_forget::{
    AAA, HOSTA, Options, World, bt_key, requester, residue, settle, strings, usb_key, wait_for,
    world,
};
use tokio::sync::Semaphore;
use tokio::time::sleep;

fn confirmed(name: &str) -> ClearedEntry {
    ClearedEntry::Confirmed { name: name.into() }
}

fn cut(name: &str) -> ClearedEntry {
    ClearedEntry::Sent {
        name: name.into(),
        detail: "BT reply timed out".into(),
    }
}

fn skip(reason: ClearSkip) -> Option<ClearSkipped> {
    Some(ClearSkipped {
        reason,
        detail: None,
    })
}

fn transports(w: &World) -> Vec<Transport> {
    w.list
        .brick(AAA)
        .map(|entry| entry.channels.iter().map(|c| c.transport).collect())
        .unwrap_or_default()
}

/// The question the person was asked, if one was.
fn question(w: &World) -> Option<String> {
    let asked = w.asked();
    assert!(asked.len() <= 1, "asked more than once: {asked:?}");
    asked.first().map(|request| request.action.clone())
}

// ── Removing every entry ────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn removes_three_entries_over_usb_each_confirmed_and_reads_the_list_back_empty() {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA, "Zed"]),
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    let asked = w.asked();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].requester, requester());
    assert_eq!(
        asked[0].action,
        "Remove 3 entries from AAA's list of paired devices: \"OLD-PC\", \"HOSTA\", \"Zed\"? \
         This computer (HOSTA) is among them, so its Bluetooth pairing with the brick ends too."
    );
    // What the person is shown besides the text, as the contract's question carries it.
    assert_eq!(
        asked[0].subject,
        ev3_runtime::ConsentSubject::ClearBluetoothList {
            brick_id: AAA.into(),
            entries: strings(&["OLD-PC", HOSTA, "Zed"]),
            includes_this_computer: true,
            this_computer: Some(HOSTA.into()),
        }
    );
    assert_eq!(w.removals(), ["OLD-PC", HOSTA, "Zed"]);
    assert!(w.brick.peers().is_empty());
    assert_eq!(report.over, Some(usb_key()));
    assert_eq!(report.peers, Some(strings(&["OLD-PC", HOSTA, "Zed"])));
    assert_eq!(
        report.entries,
        [confirmed("OLD-PC"), confirmed(HOSTA), confirmed("Zed")]
    );
    assert_eq!(
        report.left,
        Some(Vec::new()),
        "the report does not carry the list as read back"
    );
    assert_eq!(report.skipped, None);
    assert!(
        report.pairing.is_empty(),
        "a brick this computer has not paired has no pairing to remove"
    );
    assert_eq!(report.pairing_left, Some(ClearPairingSkip::NotPaired));
    assert!(w.connected(&usb_key()));
    assert!(w.bricks.is_signed_in(AAA));
}

#[tokio::test(start_paused = true)]
async fn sends_a_name_held_twice_twice_and_both_entries_go() {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA, "OLD-PC"]),
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(w.removals().iter().filter(|n| *n == "OLD-PC").count(), 2);
    assert!(w.brick.peers().is_empty());
    assert!(
        report
            .entries
            .iter()
            .all(|e| matches!(e, ClearedEntry::Confirmed { .. })),
        "{:?}",
        report.entries
    );
}

#[tokio::test(start_paused = true)]
async fn stops_after_a_pass_that_removes_nothing_and_names_the_entry_the_brick_keeps() {
    let w = world(Options {
        peers: strings(&["OLD-PC", "STUCK", "Zed"]),
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;
    w.brick.state().refuses.insert("STUCK".into());

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    // Once in the pass that removed the others, once in the pass that removed nothing.
    assert_eq!(
        w.removals().iter().filter(|n| *n == "STUCK").count(),
        2,
        "{:?}",
        w.removals()
    );
    assert_eq!(w.brick.peers(), ["STUCK"]);
    assert_eq!(
        report.entries,
        [
            confirmed("OLD-PC"),
            ClearedEntry::Failed {
                name: "STUCK".into(),
                detail: "The list read back still holds it.".into()
            },
            confirmed("Zed"),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn sends_no_removal_for_an_entry_without_a_name_and_closes_the_channel_it_opened() {
    let w = world(Options {
        peers: strings(&["", "OLD-PC", "  "]),
        paired: false,
        ..Options::default()
    });
    // Available on USB, not signed in.
    w.scan().await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    let action = question(&w).unwrap();
    assert!(
        action.contains("Remove 1 entry"),
        "the question offered a blank name: {action}"
    );
    assert_eq!(w.removals(), ["OLD-PC"]);
    assert_eq!(w.brick.peers(), ["", "  "]);
    assert_eq!(
        report.entries,
        [
            ClearedEntry::NotRemovable { name: "".into() },
            confirmed("OLD-PC"),
            ClearedEntry::NotRemovable { name: "  ".into() },
        ]
    );
    assert_eq!(w.usb.state().connects, 1);
    assert_eq!(
        w.state(&usb_key()),
        None,
        "the channel the clear opened is still open"
    );
}

async fn refused_sends_nothing(answer: ConsentAnswer, expected: Refused) {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA]),
        paired: false,
        ..Options::default()
    });
    w.scan().await;
    w.answer(answer);

    let outcome = w.service.clear_bluetooth_list(AAA, &requester()).await;

    assert_eq!(outcome, Err(expected));
    assert_eq!(w.asked().len(), 1);
    assert!(w.removals().is_empty());
    assert_eq!(w.brick.peers(), ["OLD-PC", HOSTA]);
    assert_eq!(w.usb.state().connects, 1);
    assert_eq!(
        w.state(&usb_key()),
        None,
        "the channel the clear opened is still open"
    );
    assert!(!w.bricks.is_held(AAA));
}

#[tokio::test(start_paused = true)]
async fn sends_nothing_and_closes_the_channel_it_opened_when_the_person_declines() {
    refused_sends_nothing(ConsentAnswer::Declined, Refused::Declined).await;
}

#[tokio::test(start_paused = true)]
async fn sends_nothing_and_closes_the_channel_it_opened_when_nobody_answers() {
    refused_sends_nothing(ConsentAnswer::Unanswered, Refused::Unanswered).await;
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_removes_every_other_entry_first_and_this_computers_last_sent() {
    let w = world(Options {
        cabled: false,
        peers: strings(&[HOSTA, "OLD-PC", "Zed"]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();
    w.scan().await;
    sleep(Duration::from_millis(100)).await;

    use support_forget::Kind::{Peer, PeerCount, Remove};
    assert_eq!(w.removals(), ["OLD-PC", "Zed", HOSTA]);
    assert_eq!(
        w.peer_traffic(Some(Transport::Bt))[4..],
        [
            Remove, PeerCount, Peer, Peer, Remove, PeerCount, Peer, Remove
        ],
        "each other entry was not read back over the same link before this computer's went"
    );
    assert_eq!(
        report.entries,
        [cut(HOSTA), confirmed("OLD-PC"), confirmed("Zed")]
    );
    assert_eq!(report.over, Some(bt_key()));
    assert_eq!(
        report.pairing,
        [PairingRemoval::Removed { channel: bt_key() }]
    );
    assert_eq!(
        w.bt.state().connects,
        1,
        "a connect reached the Bluetooth provider after the removal cut the link"
    );
    assert_eq!(w.state(&bt_key()), None);
    assert!(!w.bricks.is_signed_in(AAA));
    assert!(
        w.list.brick(AAA).is_none(),
        "a brick reachable on nothing is still listed"
    );
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_with_this_computers_name_unknown_removes_nothing_and_asks_nothing() {
    let w = world(Options {
        cabled: false,
        radio: None,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(report.skipped, skip(ClearSkip::RadioNameUnknown));
    assert_eq!(report.peers, Some(strings(&["Office PC", HOSTA])));
    assert_eq!(question(&w), None);
    assert!(w.removals().is_empty());
    assert!(w.bt.state().unpairs.is_empty());
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_removes_the_entry_marked_connected_last_though_it_carries_an_earlier_name()
 {
    let w = world(Options {
        cabled: false,
        peers: strings(&["OLD-PC", "Office PC", "Zed"]),
        ..Options::default()
    });
    w.brick.state().link_entry = "OLD-PC".into();
    w.brick.state().connected.insert("OLD-PC".into());
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    let action = question(&w).unwrap();
    assert!(
        action.contains("This computer (HOSTA) is among them"),
        "{action}"
    );
    assert_eq!(w.removals(), ["Office PC", "Zed", "OLD-PC"]);
    assert_eq!(
        report.entries,
        [cut("OLD-PC"), confirmed("Office PC"), confirmed("Zed")]
    );
    assert_eq!(
        w.bt.state().unpairs,
        [bt_key()],
        "the brick no longer knows this computer, and this computer still has it paired"
    );
    assert_eq!(
        report.pairing,
        [PairingRemoval::Removed { channel: bt_key() }]
    );
    assert_eq!(report.pairing_left, None);
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_with_the_name_unknown_goes_ahead_when_one_entry_is_marked_connected()
{
    let w = world(Options {
        cabled: false,
        radio: None,
        peers: strings(&["OLD-PC", "Office PC", "Zed"]),
        ..Options::default()
    });
    w.brick.state().link_entry = "OLD-PC".into();
    w.brick.state().connected.insert("OLD-PC".into());
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    let action = question(&w).unwrap();
    assert!(
        action.contains("is among them"),
        "the question does not say this computer is among them: {action}"
    );
    assert_eq!(report.skipped, None);
    assert_eq!(report.this_computer, None);
    assert_eq!(w.removals(), ["Office PC", "Zed", "OLD-PC"]);
    assert_eq!(
        report.pairing,
        [PairingRemoval::Removed { channel: bt_key() }]
    );
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_with_the_name_unknown_removes_nothing_when_two_entries_are_marked() {
    let w = world(Options {
        cabled: false,
        radio: None,
        peers: strings(&["OLD-PC", "Office PC", "Zed"]),
        ..Options::default()
    });
    w.brick.state().link_entry = "OLD-PC".into();
    w.brick.state().connected.insert("OLD-PC".into());
    w.brick.state().connected.insert("Zed".into());
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(report.skipped, skip(ClearSkip::RadioNameUnknown));
    assert_eq!(question(&w), None);
    assert!(w.removals().is_empty());
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_removes_nothing_when_no_entry_carries_the_name_and_two_are_marked() {
    // This computer paired as OLD-PC and is now HOSTA; another computer holds a link as OTHER-PC.
    let w = world(Options {
        cabled: false,
        peers: strings(&["OTHER-PC", "OLD-PC", "Zed"]),
        ..Options::default()
    });
    {
        let mut brick = w.brick.state();
        brick.link_entry = "OLD-PC".into();
        brick.connected.insert("OTHER-PC".into());
        brick.connected.insert("OLD-PC".into());
        brick.refuses.insert("OLD-PC".into());
    }
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(report.skipped, skip(ClearSkip::LinkEntryUnknown));
    assert_eq!(report.peers, Some(strings(&["OTHER-PC", "OLD-PC", "Zed"])));
    assert_eq!(question(&w), None);
    assert!(w.removals().is_empty());
    assert!(
        w.bt.state().unpairs.is_empty(),
        "this computer was unpaired from a brick that may still list it"
    );
}

#[tokio::test(start_paused = true)]
async fn over_usb_leaves_the_pairing_alone_when_no_entry_carries_the_name_though_entries_are_marked()
 {
    let w = world(Options {
        peers: strings(&["OTHER-PC", "OLD-PC", "Zed"]),
        ..Options::default()
    });
    {
        let mut brick = w.brick.state();
        brick.link_entry = "OLD-PC".into();
        brick.connected.insert("OTHER-PC".into());
        brick.connected.insert("OLD-PC".into());
        brick.refuses.insert("OLD-PC".into());
    }
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(report.over, Some(usb_key()));
    assert!(!question(&w).unwrap().contains("among them"));
    assert_eq!(
        w.brick.peers(),
        ["OLD-PC"],
        "the clear did not run, so this test shows nothing"
    );
    assert_eq!(report.left, Some(strings(&["OLD-PC"])));
    assert!(report.entries.contains(&confirmed("OTHER-PC")));
    assert!(
        w.bt.state().unpairs.is_empty(),
        "this computer was unpaired from a brick that may still list it"
    );
    assert!(report.pairing.is_empty());
    assert_eq!(report.pairing_left, Some(ClearPairingSkip::NotOnBrick));
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_removes_the_entry_marked_connected_after_the_one_carrying_the_name() {
    // The brick holds this computer's link under OLD-PC, and also lists it under its current name.
    let w = world(Options {
        cabled: false,
        peers: strings(&["OLD-PC", HOSTA, "Zed"]),
        ..Options::default()
    });
    w.brick.state().link_entry = "OLD-PC".into();
    w.brick.state().connected.insert("OLD-PC".into());
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(
        w.removals(),
        ["Zed", HOSTA, "OLD-PC"],
        "the entry marked connected went before another, and its removal cut the link the rest needed"
    );
    assert_eq!(
        report.entries,
        [cut("OLD-PC"), confirmed(HOSTA), confirmed("Zed")]
    );
    assert_eq!(w.bt.state().unpairs, [bt_key()]);
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_leaves_the_pairing_alone_when_the_named_entry_stays_though_the_marked_went()
 {
    let w = world(Options {
        cabled: false,
        peers: strings(&["OLD-PC", HOSTA]),
        ..Options::default()
    });
    {
        let mut brick = w.brick.state();
        brick.link_entry = "OLD-PC".into();
        brick.connected.insert("OLD-PC".into());
        brick.refuses.insert(HOSTA.into());
    }
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(w.removals(), [HOSTA, "OLD-PC"]);
    assert_eq!(report.entries[0], cut("OLD-PC"));
    assert_eq!(report.pairing_left, Some(ClearPairingSkip::NotRemoved));
    assert!(
        w.bt.state().unpairs.is_empty(),
        "this computer was unpaired from a brick that still lists it"
    );
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_removes_nothing_when_the_list_holds_this_computers_name_twice() {
    // The brick removes the first copy a name matches; that may be the one holding this link,
    // which cuts it before the other copy is sent.
    let w = world(Options {
        cabled: false,
        peers: strings(&[HOSTA, "Zed", HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(report.skipped, skip(ClearSkip::DuplicateLinkEntry));
    assert_eq!(report.peers, Some(strings(&[HOSTA, "Zed", HOSTA])));
    assert_eq!(question(&w), None);
    assert!(w.removals().is_empty());
    assert_eq!(w.brick.peers(), [HOSTA, "Zed", HOSTA]);
    assert!(w.bt.state().unpairs.is_empty());
}

#[tokio::test(start_paused = true)]
async fn over_bluetooth_alone_removes_nothing_when_the_marked_entry_shares_its_name_with_another() {
    // This computer paired as OLD-PC; the brick holds the link under the first copy.
    let w = world(Options {
        cabled: false,
        peers: strings(&["OLD-PC", "Zed", "OLD-PC"]),
        ..Options::default()
    });
    w.brick.state().link_entry = "OLD-PC".into();
    w.brick.state().connected_at.insert(0);
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(report.skipped, skip(ClearSkip::DuplicateLinkEntry));
    assert_eq!(question(&w), None);
    assert!(w.removals().is_empty());
    assert!(w.bt.state().unpairs.is_empty());
}

#[tokio::test(start_paused = true)]
async fn over_usb_clears_a_list_that_holds_this_computers_name_twice() {
    let w = world(Options {
        peers: strings(&[HOSTA, "Zed", HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(report.skipped, None);
    assert!(w.brick.peers().is_empty());
    assert_eq!(w.bt.state().unpairs, [bt_key()]);
}

#[tokio::test(start_paused = true)]
async fn is_refused_while_the_brick_is_being_forgotten() {
    let w = world(Options {
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;
    let read = w.brick.hold_next_count();

    let forgetting = tokio::spawn({
        let service = w.service.clone();
        async move { service.forget(AAA, &requester()).await }
    });
    wait_for(1000, "the forget's read", || {
        !w.peer_traffic(None).is_empty()
    })
    .await;
    let outcome = w.service.clear_bluetooth_list(AAA, &requester()).await;
    read.add_permits(1);
    forgetting.await.unwrap().unwrap();

    assert_eq!(
        outcome,
        Err(Refused::Busy {
            brick_id: AAA.into()
        })
    );
}

#[tokio::test(start_paused = true)]
async fn is_refused_while_a_clear_of_the_brick_runs() {
    let w = world(Options::default());
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    let read = w.brick.hold_next_count();

    let clearing = tokio::spawn({
        let service = w.service.clone();
        async move { service.clear_bluetooth_list(AAA, &requester()).await }
    });
    wait_for(1000, "the clear's read", || {
        !w.peer_traffic(None).is_empty()
    })
    .await;
    let outcome = w.service.clear_bluetooth_list(AAA, &requester()).await;
    read.add_permits(1);
    clearing.await.unwrap().unwrap();

    assert_eq!(
        outcome,
        Err(Refused::Busy {
            brick_id: AAA.into()
        })
    );
}

#[tokio::test(start_paused = true)]
async fn keeps_the_hold_for_a_clear_still_running_when_a_forget_that_started_during_it_ends() {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    // The clear waits in its unpair of the Bluetooth channel.
    let unpair = Arc::new(Semaphore::new(0));
    w.bt.state().forget_gate = Some(unpair.clone());

    let clearing = tokio::spawn({
        let service = w.service.clone();
        async move { service.clear_bluetooth_list(AAA, &requester()).await }
    });
    wait_for(1000, "the clear's unpair", || {
        w.bt.state().unpairs.len() == 1
    })
    .await;
    w.service.forget(AAA, &requester()).await.unwrap();
    let held = w.bricks.is_held(AAA);
    unpair.add_permits(1);
    clearing.await.unwrap().unwrap();

    assert!(
        held,
        "the forget lifted the hold while the clear was still removing entries"
    );
    assert!(
        !w.bricks.is_held(AAA),
        "the hold stayed after both had finished"
    );
}

#[tokio::test(start_paused = true)]
async fn reports_every_entry_as_not_sent_when_the_removals_are_refused_before_they_left() {
    let w = world(Options {
        peers: strings(&["OLD-PC", "Zed"]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    // The clear closes the Bluetooth session first; the USB channel is refused meanwhile.
    let closing = Arc::new(Semaphore::new(0));
    w.bt.state().disconnect_gate = Some(closing.clone());

    let clearing = tokio::spawn({
        let service = w.service.clone();
        async move { service.clear_bluetooth_list(AAA, &requester()).await }
    });
    wait_for(1000, "the Bluetooth close", || {
        w.bt.state().disconnects == 1
    })
    .await;
    let guard = w.sessions.guard();
    while !guard.is_degraded(&usb_key()) {
        guard.record_failure(&usb_key());
    }
    closing.add_permits(1);
    let report = clearing.await.unwrap().unwrap();

    assert!(w.removals().is_empty());
    assert!(
        report.entries.iter().all(|entry| matches!(
            entry,
            ClearedEntry::Failed { detail, .. } if detail.starts_with("Not sent")
        )),
        "{:?}",
        report.entries
    );
}

// ── This computer's pairing ─────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn with_this_computers_entry_gone_and_the_brick_paired_forgets_the_bluetooth_channel_only() {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA, "Zed"]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    assert!(w.list.brick(AAA).unwrap().paired);

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert!(w.brick.peers().is_empty());
    let first_removal = w
        .brick
        .state()
        .received
        .iter()
        .find(|r| r.name.is_some())
        .cloned()
        .unwrap();
    assert!(
        !first_removal.bt_link_open,
        "the Bluetooth link was still open when the removals ran"
    );
    assert_eq!(w.bt.state().unpairs, [bt_key()]);
    assert_eq!(
        report.pairing,
        [PairingRemoval::Removed { channel: bt_key() }]
    );
    assert_eq!(report.pairing_left, None);
    assert_eq!(report.residue, residue());
    assert!(report.channel_forgotten);
    assert!(w.connected(&usb_key()), "the USB session closed");
    assert!(w.bricks.is_signed_in(AAA));
    assert_eq!(w.bricks.route_of(AAA), Some(usb_key()));
    assert!(
        !w.list.brick(AAA).unwrap().paired,
        "the list still says the brick is paired"
    );
    assert_eq!(transports(&w), [Transport::Usb]);
    assert_eq!(w.bt.state().connects, 1);
}

#[tokio::test(start_paused = true)]
async fn reports_without_waiting_for_a_scan_in_flight_which_does_not_bring_the_pairing_back() {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    let held = Arc::new(Semaphore::new(0));
    w.bt.state().discover_gate = Some(held.clone());
    // Reads the paired list now, answers when let.
    let stale = tokio::spawn({
        let scheduler = w.scheduler.clone();
        async move { scheduler.scan_once().await }
    });
    settle().await;

    let reported = tokio::time::timeout(
        Duration::from_secs(1),
        w.service.clear_bluetooth_list(AAA, &requester()),
    )
    .await;
    assert!(
        reported.is_ok(),
        "the clear waited for a scan, which can hang in the operating system"
    );
    held.add_permits(1);
    stale.await.unwrap();
    sleep(Duration::from_millis(50)).await;

    assert!(
        !w.list.brick(AAA).unwrap().paired,
        "the stale scan listed the brick as paired again"
    );
    assert_eq!(transports(&w), [Transport::Usb]);
    assert_eq!(
        w.bt.state().connects,
        1,
        "the signed-in brick rejoined Bluetooth from the stale scan"
    );
}

#[tokio::test(start_paused = true)]
async fn does_not_rejoin_the_bluetooth_channel_when_the_systems_cache_lists_the_brick_again_unpaired()
 {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    w.bt.state().cached_after_unpair = true;

    w.service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();
    w.scan().await;
    sleep(Duration::from_millis(100)).await;

    assert_eq!(
        transports(&w),
        [Transport::Usb, Transport::Bt],
        "the cached sighting did not come back, so this test shows nothing"
    );
    assert!(!w.list.brick(AAA).unwrap().paired);
    assert_eq!(
        w.bt.state().connects,
        1,
        "the signed-in brick joined a Bluetooth channel nobody has paired"
    );
    assert!(w.bricks.is_signed_in(AAA));
}

#[tokio::test(start_paused = true)]
async fn signs_a_brick_in_again_over_usb_alone_after_its_list_was_cleared_and_relisted_unpaired() {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    w.bt.state().cached_after_unpair = true;
    w.service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();
    w.scan().await;
    assert_eq!(
        transports(&w),
        [Transport::Usb, Transport::Bt],
        "the cached sighting did not come back, so this test shows nothing"
    );

    w.bricks.sign_out(AAA).await;
    w.bricks.sign_in(AAA).await.unwrap();
    sleep(Duration::from_millis(100)).await;

    assert_eq!(
        w.bt.state().connects,
        1,
        "the new sign-in connected to a brick that no longer knows this computer"
    );
    assert_eq!(w.bricks.route_of(AAA), Some(usb_key()));
}

#[tokio::test(start_paused = true)]
async fn does_not_open_a_bluetooth_channel_nobody_has_paired_to_read_the_list() {
    let w = world(Options {
        cabled: false,
        paired: false,
        ..Options::default()
    });
    w.bt.state().cached_after_unpair = true;
    w.scan().await;
    assert!(
        w.list.brick(AAA).is_some(),
        "the unpaired sighting is not listed, so this test shows nothing"
    );

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(report.skipped, skip(ClearSkip::NotReachable));
    assert_eq!(
        w.bt.state().connects,
        0,
        "a connect reached the Bluetooth provider for a brick nobody has paired"
    );
}

#[tokio::test(start_paused = true)]
async fn does_not_try_a_lost_bluetooth_channel_of_a_brick_nobody_has_paired() {
    let w = world(Options {
        cabled: false,
        paired: false,
        ..Options::default()
    });
    // The system's cache lists it, unpaired, and the presence checks do not hear it.
    w.bt.state().cached_after_unpair = true;
    w.bt.state().unheard = true;
    w.scan().await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(report.skipped, skip(ClearSkip::NotReachable));
    assert_eq!(
        w.bt.state().connects,
        0,
        "a Bluetooth channel nobody has paired was opened"
    );
}

#[tokio::test(start_paused = true)]
async fn leaves_the_pairing_alone_when_this_computers_entry_was_not_on_the_brick() {
    let w = world(Options {
        peers: strings(&["OLD-PC", "Zed"]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert!(!question(&w).unwrap().contains("among them"));
    assert!(w.brick.peers().is_empty());
    assert!(w.bt.state().unpairs.is_empty());
    assert!(report.pairing.is_empty());
    assert_eq!(report.pairing_left, Some(ClearPairingSkip::NotOnBrick));
    assert!(
        report.paired,
        "the report does not say the pairing it left was there"
    );
    assert!(!report.channel_forgotten);
    assert!(w.list.brick(AAA).unwrap().paired);
}

#[tokio::test(start_paused = true)]
async fn leaves_the_pairing_alone_over_usb_when_this_computers_bluetooth_name_is_unknown() {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA]),
        radio: None,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert!(
        w.brick.peers().is_empty(),
        "the clear did not run, so this test shows nothing"
    );
    assert_eq!(
        report.pairing_left,
        Some(ClearPairingSkip::RadioNameUnknown)
    );
    assert!(
        w.bt.state().unpairs.is_empty(),
        "an unpair reached the Bluetooth provider"
    );
    assert!(report.pairing.is_empty());
    assert!(!report.channel_forgotten);
}

#[tokio::test(start_paused = true)]
async fn leaves_the_pairing_alone_when_the_brick_keeps_this_computers_entry() {
    let w = world(Options {
        peers: strings(&["OLD-PC", HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    w.brick.state().refuses.insert(HOSTA.into());

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(w.brick.peers(), [HOSTA]);
    assert_eq!(report.pairing_left, Some(ClearPairingSkip::NotRemoved));
    assert!(
        w.bt.state().unpairs.is_empty(),
        "an unpair reached the Bluetooth provider"
    );
    assert!(report.pairing.is_empty());
    assert!(!report.channel_forgotten);
    assert!(
        w.list.brick(AAA).unwrap().paired,
        "the cockpit forgot the pairing of a brick that still lists this computer"
    );
    assert_eq!(transports(&w), [Transport::Usb, Transport::Bt]);
}

#[tokio::test(start_paused = true)]
async fn leaves_the_pairing_alone_when_the_brick_lists_this_computer_twice_and_keeps_one_copy() {
    let w = world(Options {
        peers: strings(&[HOSTA, HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    w.brick.state().refuses_after.insert(HOSTA.into(), 1);

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    assert_eq!(w.brick.peers(), [HOSTA]);
    assert!(
        matches!(
            report.entries.as_slice(),
            [ClearedEntry::Confirmed { .. }, ClearedEntry::Failed { .. }]
        ),
        "the first copy did not go, so this test shows nothing: {:?}",
        report.entries
    );
    assert_eq!(report.pairing_left, Some(ClearPairingSkip::NotRemoved));
    assert!(
        w.bt.state().unpairs.is_empty(),
        "this computer was unpaired from a brick that still lists it"
    );
    assert!(report.pairing.is_empty());
    assert!(w.list.brick(AAA).unwrap().paired);
}

// ── The contract ────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn maps_onto_the_contracts_clear_list_report() {
    let w = world(Options {
        peers: strings(&["", "OLD-PC", HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;

    let report = w
        .service
        .clear_bluetooth_list(AAA, &requester())
        .await
        .unwrap();

    let json = serde_json::to_value(report.to_contract()).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "brickId": AAA,
            "over": "usb:00165300000A",
            "thisComputer": HOSTA,
            "paired": true,
            "peers": ["", "OLD-PC", HOSTA],
            "entries": [
                { "status": "not-removable", "name": "", "reason": "blank-name" },
                { "status": "confirmed", "name": "OLD-PC" },
                { "status": "confirmed", "name": HOSTA },
            ],
            "left": [""],
            "pairing": [{ "status": "removed", "channel": "bt:00:16:53:00:00:0A" }],
            "memory": { "status": "cleared" },
            "residue": [{
                "location": "the system's record of 00165300000A",
                "reason": "owned by the system"
            }],
        })
    );
}
