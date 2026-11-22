//! Forgetting a brick: the consent, this computer's entry on the brick's own list, the
//! operating-system pairing and the cockpit's memory, on the real brick layer, sessions, discovery
//! and list over a fake brick. Expected values come from today's TypeScript behavior.
//!
//! Time is tokio's paused clock.

mod support_forget;

use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::Duration;

use ev3_runtime::forget::{BrickSideOutcome, BrickSideSkip, PairingRemoval, PeerRemoval, Refused};
use ev3_runtime::{BrickError, ConsentAnswer};
use ev3_transports::Transport;
use support_forget::{
    AAA, HOSTA, Kind, Options, bt_key, requester, residue, settle, strings, usb_key, wait_for,
    world,
};
use tokio::sync::Semaphore;
use tokio::time::sleep;

fn removal(brick_side: &BrickSideOutcome) -> &PeerRemoval {
    match brick_side {
        BrickSideOutcome::Removal(removal) => removal,
        other => panic!("expected a removal, got {other:?}"),
    }
}

fn skipped(reason: BrickSideSkip) -> BrickSideOutcome {
    BrickSideOutcome::Skipped {
        reason,
        detail: None,
    }
}

// ── This computer's entry on the brick ──────────────────────────────

#[tokio::test(start_paused = true)]
async fn removes_the_entry_over_usb_and_confirms_it_from_the_list_read_back() {
    let w = world(Options {
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    assert_eq!(
        report.brick_side,
        BrickSideOutcome::Removal(PeerRemoval::Confirmed {
            name: HOSTA.into(),
            over: usb_key(),
            remaining: None,
        })
    );
    assert_eq!(report.peers, Some(strings(&["Office PC", HOSTA])));
    assert_eq!(
        w.peer_traffic(Some(Transport::Usb)),
        [
            Kind::PeerCount,
            Kind::Peer,
            Kind::Peer,
            Kind::Remove,
            Kind::PeerCount,
            Kind::Peer
        ]
    );
    assert_eq!(w.brick.peers(), ["Office PC"]);
    assert!(
        report.pairing.is_empty(),
        "a brick known over USB alone has no pairing to remove"
    );
    assert!(report.residue.is_empty());
    assert_eq!(w.state(&usb_key()), None, "the USB session is still open");
    assert!(!w.bricks.is_signed_in(AAA));
}

#[tokio::test(start_paused = true)]
async fn reports_failed_over_usb_when_the_brick_acks_the_removal_but_the_list_still_holds_it() {
    let w = world(Options {
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;
    w.brick.state().ignores_removal = true;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    assert!(matches!(
        removal(&report.brick_side),
        PeerRemoval::Failed { .. }
    ));
    assert_eq!(
        w.peer_traffic(Some(Transport::Usb))[3..],
        [Kind::Remove, Kind::PeerCount, Kind::Peer, Kind::Peer],
        "the list was not read back after the removal"
    );
}

#[tokio::test(start_paused = true)]
async fn confirms_one_removal_of_a_name_held_twice_and_says_one_entry_under_it_remains() {
    let w = world(Options {
        peers: strings(&[HOSTA, HOSTA]),
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    // The firmware removes the first entry whose name matches (`c_bt.c` 2215, 3603-3622).
    assert_eq!(w.removals(), [HOSTA]);
    assert_eq!(w.brick.peers(), [HOSTA]);
    assert_eq!(
        *removal(&report.brick_side),
        PeerRemoval::Confirmed {
            name: HOSTA.into(),
            over: usb_key(),
            remaining: NonZeroU64::new(1),
        }
    );
    assert_eq!(report.peers, Some(strings(&[HOSTA, HOSTA])));
}

#[tokio::test(start_paused = true)]
async fn reports_a_removal_over_the_bluetooth_link_it_cuts_as_sent_and_nothing_reconnects() {
    let w = world(Options {
        cabled: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;

    let report = w.service.forget(AAA, &requester()).await.unwrap();
    sleep(Duration::from_millis(200)).await;

    assert_eq!(
        *removal(&report.brick_side),
        PeerRemoval::Sent {
            name: HOSTA.into(),
            over: bt_key(),
            detail: "BT reply timed out".into(),
        }
    );
    assert_eq!(
        w.peer_traffic(Some(Transport::Bt)),
        [Kind::PeerCount, Kind::Peer, Kind::Peer, Kind::Remove]
    );
    assert_eq!(
        w.bt.state().connects,
        1,
        "a reconnect reached the Bluetooth provider after the removal cut the link"
    );
    assert_eq!(
        w.state(&bt_key()),
        None,
        "the Bluetooth session did not end"
    );
    assert_eq!(
        report.pairing,
        [PairingRemoval::Removed { channel: bt_key() }]
    );
    assert_eq!(
        report.residue,
        residue(),
        "the provider's residue was not carried unchanged"
    );
}

#[tokio::test(start_paused = true)]
async fn reads_the_list_back_over_bluetooth_after_a_normal_reply_and_reports_failed_when_the_entry_stays()
 {
    let w = world(Options {
        cabled: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;
    // The brick's Bluetooth is busy: it answers and does nothing.
    w.brick.state().ignores_removal = true;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    assert!(matches!(
        removal(&report.brick_side),
        PeerRemoval::Failed { .. }
    ));
    assert_eq!(
        w.peer_traffic(Some(Transport::Bt)),
        [
            Kind::PeerCount,
            Kind::Peer,
            Kind::Peer,
            Kind::Remove,
            Kind::PeerCount,
            Kind::Peer,
            Kind::Peer
        ]
    );
    assert_eq!(w.brick.peers(), ["Office PC", HOSTA]);
}

#[tokio::test(start_paused = true)]
async fn reports_sent_not_failed_when_the_brick_answers_the_removal_but_the_list_cannot_be_read_back()
 {
    let w = world(Options {
        cabled: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;
    w.brick.state().ignores_removal = true;
    w.brick.state().read_back_fails = true;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    assert_eq!(
        *removal(&report.brick_side),
        PeerRemoval::Sent {
            name: HOSTA.into(),
            over: bt_key(),
            detail: "no reply to the read-back".into(),
        }
    );
}

#[tokio::test(start_paused = true)]
async fn removes_nothing_when_no_entry_carries_this_computers_exact_name_and_reports_the_names() {
    let w = world(Options {
        peers: strings(&["Office PC", "hosta", "HOSTA "]),
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    assert_eq!(report.brick_side, skipped(BrickSideSkip::NoMatch));
    assert_eq!(
        report.peers,
        Some(strings(&["Office PC", "hosta", "HOSTA "]))
    );
    assert!(
        !w.peer_traffic(None).contains(&Kind::Remove),
        "a removal was sent"
    );
}

#[tokio::test(start_paused = true)]
async fn tries_a_paired_bluetooth_channel_the_presence_checks_do_not_hear_and_says_why_it_cannot_open()
 {
    let w = world(Options {
        cabled: false,
        ..Options::default()
    });
    // Paired, but the presence checks no longer hear it, and it is indeed switched off.
    w.bt.state().unheard = true;
    w.bt.state().off = true;
    w.scan().await;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    match &report.brick_side {
        BrickSideOutcome::Skipped {
            reason: BrickSideSkip::NotReachable,
            detail: Some(detail),
        } => assert!(detail.contains("no answer"), "{detail}"),
        other => panic!("expected not reachable with why, got {other:?}"),
    }
    assert_eq!(report.peers, None);
    assert!(w.brick.state().received.is_empty());
    assert_eq!(w.bt.state().connects, 1, "the channel was not tried");
    assert_eq!(w.bt.state().unpairs, [bt_key()]);
    assert_eq!(
        report.pairing,
        [PairingRemoval::Removed { channel: bt_key() }]
    );
    assert!(
        w.list.brick(AAA).is_none(),
        "the cockpit still lists the brick"
    );
}

#[tokio::test(start_paused = true)]
async fn removes_this_computers_entry_over_a_paired_bluetooth_channel_the_presence_checks_missed() {
    // Measured on hardware: the checks miss bricks right next to the computer.
    let w = world(Options {
        cabled: false,
        ..Options::default()
    });
    w.bt.state().unheard = true;
    w.scan().await;
    assert_eq!(
        w.list
            .brick(AAA)
            .unwrap()
            .channel(Transport::Bt)
            .unwrap()
            .state,
        ev3_runtime::ChannelState::Lost,
        "the channel is not lost, so this test shows nothing"
    );

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    assert!(matches!(
        removal(&report.brick_side),
        PeerRemoval::Sent { .. }
    ));
    assert_eq!(w.removals(), [HOSTA]);
    assert_eq!(w.bt.state().unpairs, [bt_key()]);
}

#[tokio::test(start_paused = true)]
async fn removes_nothing_when_this_computers_bluetooth_name_is_unknown_and_says_so() {
    let w = world(Options {
        radio: None,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    assert_eq!(report.brick_side, skipped(BrickSideSkip::RadioNameUnknown));
    assert!(
        w.peer_traffic(None).is_empty(),
        "the brick was asked about its list"
    );
    assert_eq!(w.brick.peers(), ["Office PC", HOSTA]);
    assert_eq!(w.bt.state().unpairs, [bt_key()]);
}

#[tokio::test(start_paused = true)]
async fn opens_only_the_usb_channel_of_a_brick_available_on_usb_and_bluetooth_with_no_session() {
    let w = world(Options::default());
    w.scan().await;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    assert_eq!(
        *removal(&report.brick_side),
        PeerRemoval::Confirmed {
            name: HOSTA.into(),
            over: usb_key(),
            remaining: None,
        }
    );
    assert_eq!(w.usb.state().connects, 1);
    assert_eq!(
        w.bt.state().connects,
        0,
        "a Bluetooth connect reached the provider"
    );
    assert!(!w.bricks.is_signed_in(AAA));
    assert_eq!(
        w.state(&usb_key()),
        None,
        "the channel the forget opened is still open"
    );
}

#[tokio::test(start_paused = true)]
async fn closes_the_bluetooth_session_before_a_usb_removal_and_nothing_reconnects_it() {
    let w = world(Options::default());
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    assert_eq!(w.bt.state().connects, 1);

    let report = w.service.forget(AAA, &requester()).await.unwrap();
    sleep(Duration::from_millis(200)).await;

    assert!(removal(&report.brick_side).confirmed());
    let removed = w
        .brick
        .state()
        .received
        .iter()
        .find(|r| r.kind == Kind::Remove)
        .cloned()
        .unwrap();
    assert!(
        !removed.bt_link_open,
        "the Bluetooth link was still open when the removal ran"
    );
    // The Bluetooth close is a session ending while the brick is signed in, which would otherwise
    // rejoin it.
    assert_eq!(
        w.bt.state().connects,
        1,
        "a connect reached the Bluetooth provider during or after the forget"
    );
}

/// The USB channel is refused from now on, as a degraded channel is: nothing it is asked reaches
/// the brick.
fn degrade(w: &support_forget::World) {
    let guard = w.sessions.guard();
    while !guard.is_degraded(&usb_key()) {
        guard.record_failure(&usb_key());
    }
}

#[tokio::test(start_paused = true)]
async fn reports_this_computers_removal_as_failed_not_sent_when_it_is_refused_before_it_left() {
    let w = world(Options {
        peers: strings(&[HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    // The removal closes the Bluetooth session first; the USB channel is refused meanwhile.
    let closing = Arc::new(Semaphore::new(0));
    w.bt.state().disconnect_gate = Some(closing.clone());

    let forgetting = tokio::spawn({
        let service = w.service.clone();
        async move { service.forget(AAA, &requester()).await }
    });
    wait_for(1000, "the Bluetooth close", || {
        w.bt.state().disconnects == 1
    })
    .await;
    degrade(&w);
    closing.add_permits(1);
    let report = forgetting.await.unwrap().unwrap();

    assert!(w.removals().is_empty());
    assert!(
        matches!(removal(&report.brick_side), PeerRemoval::Failed { .. }),
        "{:?}",
        report.brick_side
    );
}

// ── Nothing opens the brick meanwhile ───────────────────────────────

#[tokio::test(start_paused = true)]
async fn holds_the_bricks_links_while_it_runs_and_refuses_a_sign_in_from_outside() {
    let w = world(Options::default());
    w.scan().await;
    let unpair = Arc::new(Semaphore::new(0));
    w.bt.state().forget_gate = Some(unpair.clone());

    let forgetting = tokio::spawn({
        let service = w.service.clone();
        async move { service.forget(AAA, &requester()).await }
    });
    wait_for(1000, "the unpair", || w.bt.state().unpairs.len() == 1).await;
    let connects = w.usb.state().connects;
    let refused = w.bricks.sign_in(AAA).await;
    let held = w.bricks.is_held(AAA);
    unpair.add_permits(1);
    forgetting.await.unwrap().unwrap();

    assert!(
        held,
        "the brick's links were not held while it was forgotten"
    );
    assert_eq!(
        refused,
        Err(BrickError::Held {
            brick_id: AAA.into()
        })
    );
    assert_eq!(
        w.usb.state().connects,
        connects,
        "the refused sign-in opened a channel"
    );
    assert!(!w.bricks.is_held(AAA), "the hold outlived the forget");
}

#[tokio::test(start_paused = true)]
async fn cancels_a_pending_reconnect_none_reaches_the_provider_after_the_forget() {
    let w = world(Options {
        cabled: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;
    // The link dies and the brick does not answer: the session reconnects on a backoff.
    w.bt.state().off = true;
    w.brick.state().bt_link_open = false;
    assert!(!w.sessions.probe_now(&bt_key()).await);
    settle().await;

    let report = w.service.forget(AAA, &requester()).await.unwrap();
    let connects = w.bt.state().connects;
    sleep(Duration::from_millis(500)).await;

    assert_eq!(report.brick_side, skipped(BrickSideSkip::NotReachable));
    assert_eq!(
        w.bt.state().connects,
        connects,
        "the reconnect the lost link scheduled still ran"
    );
    assert_eq!(w.state(&bt_key()), None);
}

#[tokio::test(start_paused = true)]
async fn runs_one_forget_for_two_calls_made_at_once() {
    let w = world(Options {
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;

    let who = requester();
    let (first, second) = tokio::join!(w.service.forget(AAA, &who), w.service.forget(AAA, &who));

    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(
        w.asked().len(),
        2,
        "a caller joined a forget nobody asked it about"
    );
    assert_eq!(
        w.peer_traffic(None)
            .iter()
            .filter(|k| **k == Kind::Remove)
            .count(),
        1
    );
}

// ── What the cockpit remembers afterwards ───────────────────────────

#[tokio::test(start_paused = true)]
async fn leaves_out_a_brick_bluetooth_no_longer_lists_and_shows_a_still_cabled_one_as_a_stranger() {
    let w = world(Options::default());
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    w.list.update_brick(AAA, Some(true), Some(true));
    assert!(w.list.brick(AAA).unwrap().paired);

    w.service.forget(AAA, &requester()).await.unwrap();
    // The scan the forget starts and does not wait for.
    sleep(Duration::from_millis(50)).await;

    let entry = w
        .list
        .brick(AAA)
        .expect("the cabled brick is missing from the list");
    assert!(!entry.paired);
    assert!(!entry.remembered);
    assert!(!entry.favorite);
    assert_eq!(
        entry
            .channels
            .iter()
            .map(|c| c.transport)
            .collect::<Vec<_>>(),
        [Transport::Usb]
    );
}

#[tokio::test(start_paused = true)]
async fn leaves_the_brick_out_when_it_is_reachable_on_nothing_after_the_forget() {
    let w = world(Options {
        cabled: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;

    w.service.forget(AAA, &requester()).await.unwrap();
    sleep(Duration::from_millis(50)).await;

    assert!(w.list.brick(AAA).is_none());
}

#[tokio::test(start_paused = true)]
async fn reports_a_refused_unpair_with_the_systems_reason_and_still_clears_the_cockpits_memory() {
    let w = world(Options {
        cabled: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;
    w.list.update_brick(AAA, Some(true), None);
    w.bt.state().refuse = Some("error 5: access denied".into());

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    match report.pairing.as_slice() {
        [PairingRemoval::Refused { channel, reason }] => {
            assert_eq!(*channel, bt_key());
            assert!(reason.contains("error 5: access denied"), "{reason}");
        }
        other => panic!("expected one refusal, got {other:?}"),
    }
    assert!(report.residue.is_empty());
    assert!(matches!(
        report.to_contract().memory,
        ev3_contract::MemoryOutcome::Cleared
    ));
    // The system still lists it, so the scan brings it back; the cockpit's own flag is gone.
    wait_for(1000, "the brick to come back", || {
        w.list.brick(AAA).is_some()
    })
    .await;
    assert!(!w.list.brick(AAA).unwrap().favorite);
}

#[tokio::test(start_paused = true)]
async fn reports_without_waiting_for_a_scan_in_flight_which_does_not_bring_the_brick_back() {
    let w = world(Options {
        cabled: false,
        radio: None,
        ..Options::default()
    });
    w.scan().await;
    let held = Arc::new(Semaphore::new(0));
    w.bt.state().discover_gate = Some(held.clone());
    // Reads the paired list now, answers when let.
    let stale = tokio::spawn({
        let scheduler = w.scheduler.clone();
        async move { scheduler.scan_once().await }
    });
    settle().await;

    let reported =
        tokio::time::timeout(Duration::from_secs(1), w.service.forget(AAA, &requester())).await;
    assert!(
        reported.is_ok(),
        "the forget waited for a scan, which can hang in the operating system"
    );
    held.add_permits(1);
    stale.await.unwrap();
    settle().await;

    assert!(
        w.list.brick(AAA).is_none(),
        "the stale scan brought the forgotten brick back"
    );
}

#[tokio::test(start_paused = true)]
async fn reports_without_waiting_for_the_scan_it_starts_itself() {
    let w = world(Options {
        cabled: false,
        radio: None,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Bt]).await;
    // The next Bluetooth scan, the forget's own, answers only when let.
    let held = Arc::new(Semaphore::new(0));
    w.bt.state().discover_gate = Some(held.clone());

    let reported =
        tokio::time::timeout(Duration::from_secs(1), w.service.forget(AAA, &requester())).await;
    settle().await;
    let started = w.bt.state().discover_gate.is_none();
    held.add_permits(1);

    assert!(
        reported.is_ok(),
        "the forget waited for its own scan, which can hang in the operating system"
    );
    assert!(
        started,
        "the forget started no scan, so this test shows nothing"
    );
}

// ── A person's yes ──────────────────────────────────────────────────

async fn refused_changes_nothing(answer: ConsentAnswer, expected: Refused) {
    let w = world(Options::default());
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;
    w.answer(answer);

    let outcome = w.service.forget(AAA, &requester()).await;
    sleep(Duration::from_millis(100)).await;

    assert_eq!(outcome, Err(expected));
    assert!(
        w.brick.state().received.is_empty(),
        "the brick was asked something"
    );
    assert_eq!(w.brick.peers(), ["Office PC", HOSTA]);
    assert!(w.bt.state().unpairs.is_empty(), "the pairing was removed");
    assert!(w.bricks.is_signed_in(AAA));
    assert!(w.connected(&usb_key()) && w.connected(&bt_key()));
    let entry = w.list.brick(AAA).unwrap();
    assert!(entry.paired);
    assert_eq!(entry.channels.len(), 2);
    assert!(!w.bricks.is_held(AAA));
}

#[tokio::test(start_paused = true)]
async fn a_forget_the_person_declines_changes_nothing() {
    refused_changes_nothing(ConsentAnswer::Declined, Refused::Declined).await;
}

#[tokio::test(start_paused = true)]
async fn a_forget_nobody_answers_changes_nothing() {
    refused_changes_nothing(ConsentAnswer::Unanswered, Refused::Unanswered).await;
}

#[tokio::test(start_paused = true)]
async fn asks_a_person_once_naming_the_client_that_asked_and_the_brick() {
    let w = world(Options {
        paired: false,
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb]).await;

    w.service.forget(AAA, &requester()).await.unwrap();

    let asked = w.asked();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].requester, requester());
    assert_eq!(asked[0].brick_key, Some(usb_key()));
    assert!(
        asked[0].action.starts_with("Forget AAA?"),
        "{}",
        asked[0].action
    );
    assert_eq!(
        asked[0].subject,
        ev3_runtime::ConsentSubject::Forget {
            brick_id: AAA.into()
        }
    );
}

// ── The contract ────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn maps_onto_the_contracts_forget_report() {
    let w = world(Options {
        peers: strings(&[HOSTA, HOSTA]),
        ..Options::default()
    });
    w.signed_in_over(&[Transport::Usb, Transport::Bt]).await;

    let report = w.service.forget(AAA, &requester()).await.unwrap();

    let json = serde_json::to_value(report.to_contract()).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "brickId": AAA,
            "brickSide": {
                "status": "confirmed", "name": HOSTA, "over": "usb:00165300000A", "remaining": 1
            },
            "peers": [HOSTA, HOSTA],
            "pairing": [{ "status": "removed", "channel": "bt:00:16:53:00:00:0A" }],
            "memory": { "status": "cleared" },
            "residue": [{
                "location": "the system's record of 00165300000A",
                "reason": "owned by the system"
            }],
        })
    );
}
