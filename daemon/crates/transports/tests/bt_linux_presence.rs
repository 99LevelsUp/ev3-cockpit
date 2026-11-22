//! Linux Bluetooth presence: the L2CAP probe's verdicts and the BR/EDR discovery window, against
//! a fake BlueZ.
#![cfg(target_os = "linux")]

mod bt_linux_support;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bt_linux_support::*;
use ev3_transports::bt::presence::{
    PresenceFailure, PresenceMonitor, PresenceSource, PresenceTimings, ScannedBrick,
};
use ev3_transports::bt::queue::{BtConnectionQueue, QueueTimings};
use ev3_transports::bt_linux::bluez::{
    BluezError, BluezObjects, CancelFlag, ERROR_FAILED, ERROR_IN_PROGRESS,
};
use ev3_transports::bt_linux::presence::{
    INQUIRY_WINDOW, InquiryOutcome, PRESENCE_CHECK_TIMEOUT, RadioAnswer, answered_by_errno,
    inquiry_window, probe_answer,
};
use ev3_transports::bt_linux::rfcomm::SocketFailure;

#[test]
fn hears_a_brick_whose_connect_lands() {
    assert_eq!(probe_answer(Ok(())), Ok(true));
}

#[test]
fn does_not_hear_a_brick_that_is_off_and_that_is_not_an_error() {
    for code in [libc::EHOSTDOWN, libc::EHOSTUNREACH, libc::ETIMEDOUT] {
        assert_eq!(probe_answer(Err(SocketFailure::Connect(code))), Ok(false));
    }
    assert_eq!(
        probe_answer(Err(SocketFailure::TimedOut(PRESENCE_CHECK_TIMEOUT))),
        Ok(false)
    );
}

#[test]
fn hears_a_brick_that_refused_or_reset_the_channel() {
    assert_eq!(answered_by_errno(libc::ECONNREFUSED), Ok(true));
    assert_eq!(answered_by_errno(libc::ECONNRESET), Ok(true));
}

#[test]
fn fails_the_round_not_the_brick_on_any_other_errno() {
    for code in [libc::ENETDOWN, libc::ENETUNREACH, libc::EACCES] {
        match probe_answer(Err(SocketFailure::Connect(code))) {
            Err(PresenceFailure::Failed(reason)) => {
                assert!(reason.contains("not at the brick"), "{reason}");
            }
            other => panic!("errno {code}: {other:?}"),
        }
    }
}

#[test]
fn a_kernel_without_bluetooth_sockets_stops_the_monitor() {
    assert!(matches!(
        probe_answer(Err(SocketFailure::Socket(libc::EAFNOSUPPORT))),
        Err(PresenceFailure::Unavailable(_))
    ));
    assert!(matches!(
        probe_answer(Err(SocketFailure::Socket(libc::EMFILE))),
        Err(PresenceFailure::Failed(_))
    ));
}

#[test]
fn the_check_waits_longer_than_a_brick_that_is_off_takes_to_fail() {
    // A brick that is off fails with EHOSTDOWN after 5.12 s.
    assert!(PRESENCE_CHECK_TIMEOUT > Duration::from_millis(5_120));
}

struct OffBrick;

#[async_trait]
impl PresenceSource for OffBrick {
    async fn check(&self, _mac: &str) -> Result<bool, PresenceFailure> {
        probe_answer(Err(SocketFailure::Connect(libc::EHOSTDOWN)))
    }
    async fn inquire(&self) -> Result<Vec<ScannedBrick>, PresenceFailure> {
        Ok(Vec::new())
    }
    fn paired_without_session(&self) -> Vec<String> {
        vec![AAA.to_owned()]
    }
}

#[tokio::test(start_paused = true)]
async fn a_brick_that_is_off_turns_not_heard_only_after_the_misses_in_a_row() {
    let queue = Arc::new(BtConnectionQueue::new(QueueTimings::default()));
    let monitor = PresenceMonitor::new(queue, PresenceTimings::default());
    for round in 1..=3 {
        monitor.run_checks(&OffBrick).await;
        let heard = monitor.presence_of(AAA).expect("checked").heard;
        assert_eq!(heard, round < 3, "after round {round}");
    }
}

fn objects_with(
    devices: Vec<(String, ev3_transports::bt_linux::bluez::Interfaces)>,
) -> Arc<BluezObjects> {
    let objects = Arc::new(BluezObjects::new());
    let mut snapshot = vec![adapter_object()];
    snapshot.extend(devices);
    objects.load(snapshot);
    objects
}

/// Reports `path`'s RSSI the moment the discovery starts.
fn report_on_start(bus: &FakeBus, objects: &Arc<BluezObjects>, reports: Vec<(&'static str, i64)>) {
    let objects = Arc::clone(objects);
    bus.on_call(move |_, call| {
        if call.member == "StartDiscovery" {
            for (path, rssi) in &reports {
                objects.apply(&rssi_report(path, *rssi));
            }
        }
    });
}

async fn window(
    bus: &Arc<FakeBus>,
    objects: &Arc<BluezObjects>,
    said: &Arc<Said>,
) -> (Result<Vec<ScannedBrick>, String>, InquiryOutcome) {
    inquiry_window(
        Arc::clone(bus) as _,
        Arc::clone(objects),
        INQUIRY_WINDOW,
        Arc::new(CancelFlag::default()),
        Arc::clone(said) as _,
    )
    .await
}

const PHONE_PATH: &str = "/org/bluez/hci0/dev_00_00_5E_00_53_99";

#[tokio::test(start_paused = true)]
async fn runs_a_bredr_discovery_for_its_window_then_stops_it_and_hears_the_bricks() {
    let objects = objects_with(vec![
        device_object(AAA_PATH, AAA, Some("AAA"), true, Some(-60)),
        device_object(BBB_PATH, BBB, Some("BBB"), false, Some(-70)),
        device_object(
            PHONE_PATH,
            "00:00:5E:00:53:99",
            Some("phone"),
            false,
            Some(-40),
        ),
    ]);
    let bus = FakeBus::new(Vec::new());
    report_on_start(
        &bus,
        &objects,
        vec![(AAA_PATH, -61), (BBB_PATH, -70), (PHONE_PATH, -40)],
    );
    let said = Arc::new(Said::default());
    let started = tokio::time::Instant::now();
    let (heard, outcome) = window(&bus, &objects, &said).await;
    assert!(started.elapsed() >= INQUIRY_WINDOW);
    let heard = heard.unwrap();
    let macs: Vec<&str> = heard.iter().map(|b| b.mac.as_str()).collect();
    assert_eq!(macs, [AAA, BBB]);
    assert!(heard[0].paired && !heard[1].paired);
    assert_eq!(heard[0].signal, Some(-61));
    assert_eq!(
        bus.members(),
        ["SetDiscoveryFilter", "StartDiscovery", "StopDiscovery"]
    );
    assert_eq!(bus.calls.lock().unwrap()[0].args, [ADAPTER, "bredr"]);
    assert_eq!(outcome.radio, RadioAnswer::Answered);
}

#[tokio::test(start_paused = true)]
async fn an_rssi_already_there_before_the_window_is_an_old_sighting() {
    let objects = objects_with(vec![device_object(
        AAA_PATH,
        AAA,
        Some("AAA"),
        true,
        Some(-60),
    )]);
    let bus = FakeBus::new(Vec::new());
    let said = Arc::new(Said::default());
    let (heard, _) = window(&bus, &objects, &said).await;
    assert!(heard.unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_report_with_the_same_value_is_heard() {
    let objects = objects_with(vec![device_object(
        AAA_PATH,
        AAA,
        Some("AAA"),
        true,
        Some(-60),
    )]);
    let bus = FakeBus::new(Vec::new());
    report_on_start(&bus, &objects, vec![(AAA_PATH, -60)]);
    let said = Arc::new(Said::default());
    let (heard, _) = window(&bus, &objects, &said).await;
    assert_eq!(heard.unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn names_a_brick_without_a_name_nothing_not_its_dashed_address() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, None, false, Some(-60))]);
    let bus = FakeBus::new(Vec::new());
    report_on_start(&bus, &objects, vec![(AAA_PATH, -59)]);
    let said = Arc::new(Said::default());
    let (heard, _) = window(&bus, &objects, &said).await;
    assert_eq!(heard.unwrap()[0].name, "");
}

#[tokio::test(start_paused = true)]
async fn hears_a_brick_whose_report_comes_12_s_into_the_window() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), true, None)]);
    let bus = FakeBus::new(Vec::new());
    let late = Arc::clone(&objects);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(12)).await;
        late.apply(&rssi_report(AAA_PATH, -65));
    });
    let said = Arc::new(Said::default());
    let (heard, _) = window(&bus, &objects, &said).await;
    assert_eq!(heard.unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn stops_the_discovery_even_when_the_window_fails_and_fails_the_round() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "StartDiscovery",
        Reply::Err(BluezError::new(
            "org.bluez.Error.NotReady",
            "Resource Not Ready",
        )),
    );
    let said = Arc::new(Said::default());
    let (heard, outcome) = window(&bus, &objects, &said).await;
    assert!(heard.is_err());
    assert_eq!(bus.count("StopDiscovery"), 1);
    // Switched off is not stopped answering.
    assert_eq!(outcome.radio, RadioAnswer::Unclear);
}

#[tokio::test(start_paused = true)]
async fn fails_the_round_when_this_computer_has_no_adapter() {
    let objects = Arc::new(BluezObjects::new());
    objects.load(Vec::new());
    let bus = FakeBus::new(Vec::new());
    let said = Arc::new(Said::default());
    let (heard, _) = window(&bus, &objects, &said).await;
    assert!(heard.unwrap_err().contains("no Bluetooth adapter"));
    assert!(bus.members().is_empty());
}

#[tokio::test(start_paused = true)]
async fn says_so_when_stop_discovery_fails_for_any_reason_but_not_discovering() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "StopDiscovery",
        Reply::Err(BluezError::new(
            "org.freedesktop.DBus.Error.NoReply",
            "no reply",
        )),
    );
    let said = Arc::new(Said::default());
    let _ = window(&bus, &objects, &said).await;
    assert_eq!(said.count_containing("StopDiscovery failed"), 1);
}

#[tokio::test(start_paused = true)]
async fn our_own_discovery_refused_a_stop_is_stuck_and_not_logged() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "StopDiscovery",
        Reply::Err(BluezError::new(
            ERROR_IN_PROGRESS,
            "Operation already in progress",
        )),
    );
    let said = Arc::new(Said::default());
    let (_, outcome) = window(&bus, &objects, &said).await;
    assert_eq!(outcome.radio, RadioAnswer::Stuck);
    assert!(said.all().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_discovery_that_would_not_start_is_stuck() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "StartDiscovery",
        Reply::Err(BluezError::new(ERROR_FAILED, "Failed")),
    );
    bus.reply(
        "StopDiscovery",
        Reply::Err(BluezError::new(ERROR_FAILED, "No discovery started")),
    );
    let said = Arc::new(Said::default());
    let (_, outcome) = window(&bus, &objects, &said).await;
    assert_eq!(outcome.radio, RadioAnswer::Stuck);
    assert!(outcome.detail.unwrap().starts_with("StartDiscovery"));
}

#[tokio::test(start_paused = true)]
async fn a_start_refused_as_busy_while_no_discovery_of_ours_runs_is_stuck() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "StartDiscovery",
        Reply::Err(BluezError::new(ERROR_IN_PROGRESS, "busy")),
    );
    bus.reply(
        "StopDiscovery",
        Reply::Err(BluezError::new(ERROR_FAILED, "No discovery started")),
    );
    let said = Arc::new(Said::default());
    let (_, outcome) = window(&bus, &objects, &said).await;
    assert_eq!(outcome.radio, RadioAnswer::Stuck);
}

#[tokio::test(start_paused = true)]
async fn a_start_refused_as_busy_while_ours_still_runs_is_not_stuck() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "StartDiscovery",
        Reply::Err(BluezError::new(ERROR_IN_PROGRESS, "busy")),
    );
    let said = Arc::new(Said::default());
    let (_, outcome) = window(&bus, &objects, &said).await;
    assert_eq!(outcome.radio, RadioAnswer::Unclear);
}

#[tokio::test(start_paused = true)]
async fn a_stop_that_finds_nothing_running_after_a_start_that_went_through_answered() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "StopDiscovery",
        Reply::Err(BluezError::new(ERROR_FAILED, "No discovery started")),
    );
    let said = Arc::new(Said::default());
    let (_, outcome) = window(&bus, &objects, &said).await;
    assert_eq!(outcome.radio, RadioAnswer::Answered);
}

#[tokio::test(start_paused = true)]
async fn no_permission_or_a_refused_filter_says_nothing_about_the_radio() {
    for (member, name) in [
        (
            "SetDiscoveryFilter",
            "org.freedesktop.DBus.Error.AccessDenied",
        ),
        ("StartDiscovery", "org.bluez.Error.NotSupported"),
        ("StartDiscovery", "org.freedesktop.DBus.Error.AccessDenied"),
    ] {
        let objects = objects_with(Vec::new());
        let bus = FakeBus::new(Vec::new());
        bus.reply(member, Reply::Err(BluezError::new(name, "no")));
        let said = Arc::new(Said::default());
        let (_, outcome) = window(&bus, &objects, &said).await;
        assert_eq!(outcome.radio, RadioAnswer::Unclear, "{member} {name}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_cancel_ends_the_window_early_and_still_stops_the_discovery() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    let said = Arc::new(Said::default());
    let cancel = Arc::new(CancelFlag::default());
    let stopper = Arc::clone(&cancel);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        stopper.cancel();
    });
    let started = tokio::time::Instant::now();
    let _ = inquiry_window(
        Arc::clone(&bus) as _,
        Arc::clone(&objects),
        INQUIRY_WINDOW,
        cancel,
        said as _,
    )
    .await;
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(bus.count("StopDiscovery"), 1);
}

#[test]
fn the_window_outlasts_the_measured_14_s_report_cycle() {
    assert!(INQUIRY_WINDOW > Duration::from_secs(14));
}
