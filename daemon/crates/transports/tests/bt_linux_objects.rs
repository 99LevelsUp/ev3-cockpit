//! BlueZ's objects kept in memory, and the session that keeps them: one bus, BlueZ's owner
//! tracked, the bluetooth-group question asked once. Against a fake BlueZ.
#![cfg(target_os = "linux")]

mod bt_linux_support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use bt_linux_support::*;
use ev3_transports::bt_linux::access::{
    AccessQuestion, Answer, CommandRunner, Consent, Question, QuestionKind, RunOutcome,
};
use ev3_transports::bt_linux::bluez::{
    ACCESS_DENIED, BluezError, BluezObjects, BluezSignal, BusSignal, DEVICE_INTERFACE, PropValue,
    device_name,
};
use ev3_transports::bt_linux::session::BluezSession;

fn loaded(devices: Vec<(String, ev3_transports::bt_linux::bluez::Interfaces)>) -> BluezObjects {
    let objects = BluezObjects::new();
    let mut snapshot = vec![adapter_object()];
    snapshot.extend(devices);
    objects.load(snapshot);
    objects
}

#[test]
fn answers_the_devices_and_the_adapter_from_memory() {
    let objects = loaded(vec![device_object(AAA_PATH, AAA, Some("AAA"), true, None)]);
    let devices = objects.devices();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].address.as_deref(), Some(AAA));
    assert!(devices[0].paired);
    let adapter = objects.adapter().unwrap();
    assert_eq!(adapter.path, ADAPTER);
    assert_eq!(adapter.hci(), "hci0");
    assert!(adapter.powered);
}

#[test]
fn adds_an_object_interfaces_added_announces_and_drops_one_interfaces_removed_removes() {
    let objects = loaded(Vec::new());
    let (path, interfaces) = device_object(BBB_PATH, BBB, Some("BBB"), false, None);
    assert!(objects.apply(&BluezSignal::InterfacesAdded { path, interfaces }));
    assert_eq!(objects.devices().len(), 1);
    assert!(objects.apply(&BluezSignal::InterfacesRemoved {
        path: BBB_PATH.into(),
        interfaces: vec![DEVICE_INTERFACE.into()],
    }));
    assert!(objects.devices().is_empty());
}

#[test]
fn applies_properties_changed_and_keeps_a_boolean_bluez_invalidates() {
    let objects = loaded(vec![device_object(
        AAA_PATH,
        AAA,
        Some("AAA"),
        true,
        Some(-50),
    )]);
    objects.apply(&BluezSignal::PropertiesChanged {
        path: AAA_PATH.into(),
        interface: DEVICE_INTERFACE.into(),
        changed: props(&[("Connected", PropValue::Bool(true))]),
        invalidated: vec!["RSSI".into(), "Paired".into()],
    });
    let device = objects.device(AAA_PATH).unwrap();
    assert!(device.connected);
    assert_eq!(device.rssi, None);
    assert!(device.paired, "a boolean invalidated keeps its last value");
}

#[test]
fn ignores_a_change_about_an_object_it_does_not_hold() {
    let objects = loaded(Vec::new());
    assert!(!objects.apply(&rssi_report(CCC_PATH, -40)));
    assert!(objects.devices().is_empty());
}

#[test]
fn refuses_to_list_before_bluez_is_read_so_discovery_says_so_once() {
    let objects = BluezObjects::new();
    assert!(objects.list_devices().unwrap_err().contains("not ready"));
    objects.load(vec![adapter_object()]);
    assert!(objects.list_devices().unwrap().is_empty());
    objects.clear();
    assert!(objects.list_devices().is_err());
}

#[test]
fn lists_only_bricks_among_what_bluez_knows() {
    let objects = loaded(vec![
        device_object(AAA_PATH, AAA, Some("AAA"), true, None),
        device_object(
            "/org/bluez/hci0/dev_00_00_5E_00_53_99",
            "00:00:5E:00:53:99",
            Some("headphones"),
            true,
            None,
        ),
    ]);
    let bricks = objects.list_bricks().unwrap();
    assert_eq!(bricks.len(), 1);
    assert_eq!(bricks[0].address.as_deref(), Some(AAA));
}

#[test]
fn reads_this_computers_name_from_the_adapters_alias() {
    assert_eq!(loaded(Vec::new()).radio_name().as_deref(), Some("HOSTD"));
    let objects = BluezObjects::new();
    objects.load(Vec::new());
    assert_eq!(objects.radio_name(), None);
}

#[test]
fn gives_a_device_without_a_name_no_name_not_its_dashed_address() {
    let objects = loaded(vec![device_object(AAA_PATH, AAA, None, false, None)]);
    assert_eq!(device_name(&objects.device(AAA_PATH).unwrap()), "");
    let objects = loaded(vec![device_object(AAA_PATH, AAA, Some("AAA"), false, None)]);
    assert_eq!(device_name(&objects.device(AAA_PATH).unwrap()), "AAA");
}

#[test]
fn counts_every_rssi_bearing_signal_a_same_value_too_and_nothing_else() {
    let objects = loaded(vec![device_object(
        AAA_PATH,
        AAA,
        Some("AAA"),
        true,
        Some(-50),
    )]);
    assert_eq!(
        objects.rssi_reports(AAA_PATH),
        0,
        "the snapshot is no evidence"
    );
    objects.apply(&rssi_report(AAA_PATH, -50));
    objects.apply(&rssi_report(AAA_PATH, -50));
    objects.apply(&BluezSignal::PropertiesChanged {
        path: AAA_PATH.into(),
        interface: DEVICE_INTERFACE.into(),
        changed: props(&[("Connected", PropValue::Bool(true))]),
        invalidated: Vec::new(),
    });
    assert_eq!(objects.rssi_reports(AAA_PATH), 2);
    let (path, interfaces) = device_object(BBB_PATH, BBB, None, false, Some(-70));
    objects.apply(&BluezSignal::InterfacesAdded { path, interfaces });
    assert_eq!(objects.rssi_reports(BBB_PATH), 1);
}

#[test]
fn forgets_the_counts_on_clear_and_keeps_them_across_a_device_removed_and_added() {
    let objects = loaded(vec![device_object(AAA_PATH, AAA, Some("AAA"), true, None)]);
    objects.apply(&rssi_report(AAA_PATH, -50));
    objects.apply(&BluezSignal::InterfacesRemoved {
        path: AAA_PATH.into(),
        interfaces: vec![DEVICE_INTERFACE.into()],
    });
    let (path, interfaces) = device_object(AAA_PATH, AAA, Some("AAA"), true, Some(-52));
    objects.apply(&BluezSignal::InterfacesAdded { path, interfaces });
    assert_eq!(objects.rssi_reports(AAA_PATH), 2);
    objects.clear();
    assert_eq!(objects.rssi_reports(AAA_PATH), 0);
}

#[test]
fn tells_its_listeners_after_each_change() {
    let objects = loaded(Vec::new());
    let told = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&told);
    let id = objects.on_change(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let (path, interfaces) = device_object(AAA_PATH, AAA, None, false, None);
    objects.apply(&BluezSignal::InterfacesAdded { path, interfaces });
    objects.clear();
    assert_eq!(told.load(Ordering::SeqCst), 2);
    objects.remove_listener(id);
    objects.load(Vec::new());
    assert_eq!(told.load(Ordering::SeqCst), 2);
}

// ── The session ─────────────────────────────────────────────────────

fn session_over(connector: Arc<FakeConnector>, said: &Arc<Said>) -> Arc<BluezSession> {
    BluezSession::new(
        connector,
        Arc::clone(said) as _,
        None,
        "student",
        Duration::from_secs(1),
    )
}

fn owner_changed(old: &str, new: &str) -> BusSignal {
    BusSignal {
        sender: "org.freedesktop.DBus".into(),
        signal: BluezSignal::NameOwnerChanged {
            name: "org.bluez".into(),
            old: old.into(),
            new: new.into(),
        },
    }
}

#[tokio::test(start_paused = true)]
async fn opens_one_bus_learns_bluezs_owner_watches_it_and_reads_its_objects() {
    let bus = FakeBus::new(vec![
        adapter_object(),
        device_object(AAA_PATH, AAA, Some("AAA"), true, None),
    ]);
    let connector = FakeConnector::with(vec![Ok(Arc::clone(&bus))]);
    let said = Arc::new(Said::default());
    let session = session_over(Arc::clone(&connector), &said);
    session.start();
    session.start();
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
    assert_eq!(connector.opened.load(Ordering::SeqCst), 1);
    assert_eq!(
        bus.members(),
        ["AddMatch", "GetNameOwner", "GetManagedObjects"]
    );
    assert_eq!(session.owner().as_deref(), Some(BLUEZ_OWNER));
    assert_eq!(session.objects().devices().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn takes_signals_only_from_bluezs_current_owner() {
    let bus = FakeBus::new(vec![adapter_object()]);
    let said = Arc::new(Said::default());
    let session = ready_session(Arc::clone(&bus), said).await;
    let (path, interfaces) = device_object(AAA_PATH, AAA, None, false, None);
    bus.emit(BusSignal {
        sender: ":1.99".into(),
        signal: BluezSignal::InterfacesAdded {
            path: path.clone(),
            interfaces: interfaces.clone(),
        },
    });
    bus.emit(from_bluez(BluezSignal::InterfacesAdded {
        path: BBB_PATH.into(),
        interfaces,
    }));
    let watched = Arc::clone(&session);
    until(move || !watched.objects().devices().is_empty()).await;
    let paths: Vec<String> = session
        .objects()
        .devices()
        .into_iter()
        .map(|d| d.path)
        .collect();
    assert_eq!(paths, [BBB_PATH]);
}

#[tokio::test(start_paused = true)]
async fn applies_signals_that_arrive_with_the_snapshot_after_it_never_under_it() {
    let bus = FakeBus::new(vec![
        adapter_object(),
        device_object(AAA_PATH, AAA, Some("AAA"), false, None),
    ]);
    // BlueZ pairs the brick while its objects are being read: the change comes in before the
    // reply, and must win over the older snapshot.
    bus.on_call(|bus, call| {
        if call.member == "GetManagedObjects" {
            bus.emit(from_bluez(BluezSignal::PropertiesChanged {
                path: AAA_PATH.into(),
                interface: DEVICE_INTERFACE.into(),
                changed: props(&[("Paired", PropValue::Bool(true))]),
                invalidated: Vec::new(),
            }));
        }
    });
    let said = Arc::new(Said::default());
    let session = ready_session(Arc::clone(&bus), said).await;
    let watched = Arc::clone(&session);
    until(move || watched.objects().device(AAA_PATH).is_some_and(|d| d.paired)).await;
}

#[tokio::test(start_paused = true)]
async fn clears_when_bluez_goes_and_reads_afresh_when_it_comes_back() {
    let bus = FakeBus::new(vec![adapter_object()]);
    let said = Arc::new(Said::default());
    let session = ready_session(Arc::clone(&bus), Arc::clone(&said)).await;
    bus.emit(owner_changed(BLUEZ_OWNER, ""));
    let watched = Arc::clone(&session);
    until(move || !watched.objects().is_ready()).await;
    assert_eq!(session.owner(), None);
    assert!(said.count_containing("BlueZ stopped") == 1);
    bus.emit(owner_changed("", ":1.8"));
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
    assert_eq!(session.owner().as_deref(), Some(":1.8"));
    assert_eq!(bus.count("GetManagedObjects"), 2);
}

#[tokio::test(start_paused = true)]
async fn drops_the_old_daemons_objects_at_once_when_bluez_hands_over() {
    let bus = FakeBus::new(vec![
        adapter_object(),
        device_object(AAA_PATH, AAA, Some("AAA"), true, None),
    ]);
    let said = Arc::new(Said::default());
    let session = ready_session(Arc::clone(&bus), said).await;
    // The new daemon's objects are slow to come.
    bus.reply("GetManagedObjects", Reply::Hang);
    bus.emit(owner_changed(BLUEZ_OWNER, ":1.8"));
    let watched = Arc::clone(&session);
    until(move || !watched.objects().is_ready()).await;
    assert!(session.objects().devices().is_empty());
}

#[tokio::test(start_paused = true)]
async fn ignores_a_name_owner_changed_the_bus_itself_did_not_send() {
    let bus = FakeBus::new(vec![adapter_object()]);
    let said = Arc::new(Said::default());
    let session = ready_session(Arc::clone(&bus), said).await;
    let mut forged = owner_changed(BLUEZ_OWNER, "");
    forged.sender = ":1.42".into();
    bus.emit(forged);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(session.objects().is_ready());
    assert_eq!(session.owner().as_deref(), Some(BLUEZ_OWNER));
}

#[tokio::test(start_paused = true)]
async fn waits_for_bluez_when_it_is_not_running_and_reads_it_once_it_starts() {
    let bus = FakeBus::new(vec![adapter_object()]);
    *bus.owner.lock().unwrap() = Ok(None);
    let connector = FakeConnector::with(vec![Ok(Arc::clone(&bus))]);
    let said = Arc::new(Said::default());
    let session = session_over(connector, &said);
    session.start();
    let watching = Arc::clone(&said);
    until(move || watching.count_containing("BlueZ is not running") == 1).await;
    assert!(!session.objects().is_ready());
    assert_eq!(bus.count("GetManagedObjects"), 0);
    bus.emit(owner_changed("", BLUEZ_OWNER));
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
}

#[tokio::test(start_paused = true)]
async fn tells_a_bus_that_refuses_this_user_from_bluez_not_running() {
    let bus = FakeBus::new(vec![adapter_object()]);
    *bus.owner.lock().unwrap() = Err(BluezError::new(ACCESS_DENIED, "Rejected send message"));
    let connector = FakeConnector::with(vec![Ok(Arc::clone(&bus))]);
    let said = Arc::new(Said::default());
    let session = session_over(connector, &said);
    session.start();
    let watching = Arc::clone(&said);
    until(move || watching.count_containing("BlueZ refused this user") == 1).await;
    assert_eq!(said.count_containing("not running"), 0);
    assert!(said.count_containing("sudo usermod -aG bluetooth student") == 1);
    drop(session);
}

#[tokio::test(start_paused = true)]
async fn says_why_when_there_is_no_system_bus_keeps_trying_and_stays_not_ready() {
    let no_bus = || Err(BluezError::local("No such file or directory"));
    let connector = FakeConnector::with(vec![no_bus(), no_bus(), no_bus()]);
    let said = Arc::new(Said::default());
    let session = session_over(Arc::clone(&connector), &said);
    session.start();
    let opened = Arc::clone(&connector);
    let started = tokio::time::Instant::now();
    until(move || opened.opened.load(Ordering::SeqCst) == 3).await;
    // 1 s, then 2 s apart.
    assert!(started.elapsed() >= Duration::from_secs(3));
    assert!(said.count_containing("cannot reach the system bus") >= 2);
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
    assert_eq!(connector.opened.load(Ordering::SeqCst), 4);
}

#[tokio::test(start_paused = true)]
async fn reconnects_with_a_backoff_when_the_bus_closes_and_not_after_dispose() {
    let first = FakeBus::new(vec![adapter_object()]);
    let connector = FakeConnector::with(vec![Ok(Arc::clone(&first))]);
    let said = Arc::new(Said::default());
    let session = session_over(Arc::clone(&connector), &said);
    session.start();
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
    first.drop_connection();
    let watched = Arc::clone(&session);
    until(move || !watched.objects().is_ready()).await;
    assert_eq!(said.count_containing("connection closed"), 1);
    let opened = Arc::clone(&connector);
    until(move || opened.opened.load(Ordering::SeqCst) == 2).await;
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
    session.dispose();
    let second = connector.last.lock().unwrap().clone().unwrap();
    assert!(second.closed.load(Ordering::SeqCst));
    second.drop_connection();
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(connector.opened.load(Ordering::SeqCst), 2);
    assert!(!session.objects().is_ready());
}

#[tokio::test(start_paused = true)]
async fn a_retry_opens_a_new_bus_and_closes_the_old_one() {
    let first = FakeBus::new(vec![adapter_object()]);
    let connector = FakeConnector::with(vec![Ok(Arc::clone(&first))]);
    let said = Arc::new(Said::default());
    let session = session_over(Arc::clone(&connector), &said);
    session.start();
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
    session.retry();
    assert!(first.closed.load(Ordering::SeqCst));
    let opened = Arc::clone(&connector);
    until(move || opened.opened.load(Ordering::SeqCst) == 2).await;
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
}

// ── The bluetooth-group question, asked once ────────────────────────

struct FakeConsent {
    asked: Mutex<Vec<Question>>,
    answer: Answer,
}

#[async_trait]
impl Consent for FakeConsent {
    fn can_ask(&self) -> bool {
        true
    }
    async fn ask(&self, question: Question) -> Answer {
        self.asked.lock().unwrap().push(question);
        self.answer
    }
}

struct NeverRun;

#[async_trait]
impl CommandRunner for NeverRun {
    async fn run(&self, program: &str, _args: &[String]) -> RunOutcome {
        panic!("{program} must not run without a yes");
    }
}

fn refusing_bus() -> Arc<FakeBus> {
    let bus = FakeBus::new(vec![adapter_object()]);
    bus.objects
        .lock()
        .unwrap()
        .push_back(Err(BluezError::new(ACCESS_DENIED, "Rejected send message")));
    bus
}

#[tokio::test(start_paused = true)]
async fn bluez_refusing_this_user_raises_the_group_question_once() {
    let consent = Arc::new(FakeConsent {
        asked: Mutex::new(Vec::new()),
        answer: Answer::No,
    });
    let said = Arc::new(Said::default());
    let access = Arc::new(AccessQuestion::new(
        "student",
        Arc::clone(&consent) as _,
        Arc::new(NeverRun),
        Arc::clone(&said) as _,
    ));
    let connector = FakeConnector::with(vec![Ok(refusing_bus()), Ok(refusing_bus())]);
    let session = BluezSession::new(
        Arc::clone(&connector) as _,
        Arc::clone(&said) as _,
        Some(access),
        "student",
        Duration::from_secs(1),
    );
    session.start();
    let watching = Arc::clone(&consent);
    until(move || watching.asked.lock().unwrap().len() == 1).await;
    let question = consent.asked.lock().unwrap()[0].clone();
    assert_eq!(question.kind, QuestionKind::BluetoothAccess);
    assert_eq!(question.details, ["pkexec usermod -aG bluetooth student"]);

    // BlueZ refuses again at the retry, as it does until the person logs in again.
    session.retry();
    let opened = Arc::clone(&connector);
    until(move || opened.opened.load(Ordering::SeqCst) == 2).await;
    let watching = Arc::clone(&said);
    until(move || watching.count_containing("BlueZ refused this user:") == 2).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(consent.asked.lock().unwrap().len(), 1, "asked only once");
}

#[test]
fn a_bus_refusal_is_told_apart() {
    assert!(BluezError::new(ACCESS_DENIED, "x").is_access_denied());
    assert!(!BluezError::new("org.bluez.Error.Failed", "x").is_access_denied());
}
