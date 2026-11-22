//! Pairing a brick through BlueZ with the cockpit's own agent, against a fake BlueZ.
#![cfg(target_os = "linux")]

mod bt_linux_support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use bt_linux_support::*;
use ev3_transports::bt::parse_mac;
use ev3_transports::bt_linux::agent::{
    AGENT_PATH, AgentRefusal, PAIR_TIMEOUT, PAIRING_CANCELLED, PairingAgent, PairingContext,
    SEARCH_TIME, pair_brick,
};
use ev3_transports::bt_linux::bluez::{
    AGENT_CAPABILITY, BluezError, BluezObjects, BluezSignal, CancelFlag, DiscoveryGate, device_path,
};
use ev3_transports::provider::PairingOutcome;

const AAA_ADDRESS: u64 = 0x0016_53F0_0A0A;
const BBB_ADDRESS: u64 = 0x0016_53F0_0A0B;

fn objects_with(
    devices: Vec<(String, ev3_transports::bt_linux::bluez::Interfaces)>,
) -> Arc<BluezObjects> {
    let objects = Arc::new(BluezObjects::new());
    let mut snapshot = vec![adapter_object()];
    snapshot.extend(devices);
    objects.load(snapshot);
    objects
}

fn context(bus: &Arc<FakeBus>, objects: &Arc<BluezObjects>) -> PairingContext {
    PairingContext {
        bus: Arc::clone(bus) as _,
        objects: Arc::clone(objects),
        owner: Arc::new(|| Some(BLUEZ_OWNER.to_owned())),
        gate: Arc::new(DiscoveryGate::default()),
        one_at_a_time: Arc::new(tokio::sync::Mutex::new(())),
        search_time: SEARCH_TIME,
        pair_timeout: PAIR_TIMEOUT,
    }
}

async fn pair(context: PairingContext, address: u64) -> PairingOutcome {
    pair_brick(context, address, Arc::new(CancelFlag::default())).await
}

#[tokio::test(start_paused = true)]
async fn answers_a_brick_already_paired_without_touching_the_radio() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), true, None)]);
    let bus = FakeBus::new(Vec::new());
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(outcome.ok);
    assert_eq!(outcome.status.as_deref(), Some("AlreadyPaired"));
    assert!(bus.members().is_empty());
}

#[tokio::test(start_paused = true)]
async fn answers_the_pin_request_with_1234_and_does_not_displace_the_desktop_agent() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), false, None)]);
    let bus = FakeBus::new(Vec::new());
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(outcome.status.as_deref(), Some("Paired"));
    assert_eq!(*bus.pin_answers.lock().unwrap(), [Ok("1234".to_owned())]);
    assert_eq!(
        bus.members(),
        [
            "ExportAgent",
            "RegisterAgent",
            "Pair",
            "UnregisterAgent",
            "WithdrawAgent"
        ]
    );
    let calls = bus.calls.lock().unwrap().clone();
    assert_eq!(calls[1].args, [AGENT_PATH, AGENT_CAPABILITY]);
    assert_eq!(AGENT_CAPABILITY, "KeyboardDisplay");
    assert_eq!(calls[2].args, [AAA_PATH]);
    // Registered for this connection only: never made the default agent.
    assert!(bus.members().iter().all(|m| m != "RequestDefaultAgent"));
}

#[test]
fn the_agent_refuses_to_answer_for_any_other_device() {
    let agent = PairingAgent::new(AAA_PATH, || Some(BLUEZ_OWNER.to_owned()));
    assert_eq!(
        agent.request_pin_code(Some(BLUEZ_OWNER), BBB_PATH),
        Err(AgentRefusal::NotThisBrick)
    );
    assert_eq!(agent.request_passkey(Some(BLUEZ_OWNER), AAA_PATH), Ok(1234));
    assert_eq!(
        agent.request_confirmation(Some(BLUEZ_OWNER), BBB_PATH),
        Err(AgentRefusal::NotThisBrick)
    );
}

#[test]
fn the_agent_answers_only_bluez_itself_every_method_checked() {
    let agent = PairingAgent::new(AAA_PATH, || Some(BLUEZ_OWNER.to_owned()));
    let stranger = Some(":1.99");
    assert_eq!(
        agent.request_pin_code(stranger, AAA_PATH),
        Err(AgentRefusal::NotBluez)
    );
    assert_eq!(
        agent.display_pin_code(stranger, AAA_PATH),
        Err(AgentRefusal::NotBluez)
    );
    assert_eq!(
        agent.display_passkey(stranger, AAA_PATH),
        Err(AgentRefusal::NotBluez)
    );
    assert_eq!(
        agent.authorize_service(stranger, AAA_PATH),
        Err(AgentRefusal::NotBluez)
    );
    assert_eq!(
        agent.request_authorization(stranger, AAA_PATH),
        Err(AgentRefusal::NotBluez)
    );
    assert_eq!(agent.cancel(stranger), Err(AgentRefusal::NotBluez));
    assert_eq!(agent.release(stranger), Err(AgentRefusal::NotBluez));
    assert_eq!(agent.cancel(Some(BLUEZ_OWNER)), Ok(()));
    assert_eq!(
        AgentRefusal::NotBluez.error_name(),
        "org.bluez.Error.Rejected"
    );
}

#[test]
fn the_agent_answers_nobody_while_bluezs_owner_is_unknown() {
    let agent = PairingAgent::new(AAA_PATH, || None);
    assert_eq!(
        agent.request_pin_code(Some(BLUEZ_OWNER), AAA_PATH),
        Err(AgentRefusal::NotBluez)
    );
    assert_eq!(agent.cancel(Some(BLUEZ_OWNER)), Err(AgentRefusal::NotBluez));
    assert_eq!(agent.release(None), Err(AgentRefusal::NotBluez));
}

/// BlueZ hears the brick once the discovery starts.
fn heard_on_start(bus: &FakeBus, objects: &Arc<BluezObjects>, paired: bool) {
    let objects = Arc::clone(objects);
    bus.on_call(move |_, call| {
        if call.member == "StartDiscovery" {
            let (path, interfaces) = device_object(AAA_PATH, AAA, Some("AAA"), paired, Some(-60));
            objects.apply(&BluezSignal::InterfacesAdded { path, interfaces });
        }
    });
}

#[tokio::test(start_paused = true)]
async fn finds_a_brick_bluez_does_not_know_with_a_bredr_discovery_first_then_stops_it() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    heard_on_start(&bus, &objects, false);
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(
        bus.members(),
        [
            "SetDiscoveryFilter",
            "StartDiscovery",
            "StopDiscovery",
            "ExportAgent",
            "RegisterAgent",
            "Pair",
            "UnregisterAgent",
            "WithdrawAgent"
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_brick_found_already_paired_by_the_search_is_answered_so() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    heard_on_start(&bus, &objects, true);
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert_eq!(outcome.status.as_deref(), Some("AlreadyPaired"));
    assert_eq!(bus.count("Pair"), 0);
}

#[tokio::test(start_paused = true)]
async fn gives_up_when_the_search_does_not_find_the_brick_and_stops_the_discovery() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    let started = tokio::time::Instant::now();
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(started.elapsed() >= SEARCH_TIME);
    assert!(!outcome.ok);
    assert_eq!(outcome.status.as_deref(), Some("NotFound"));
    assert_eq!(bus.count("StopDiscovery"), 1);
    assert_eq!(bus.count("Pair"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_discovery_the_adapter_refuses_is_answered_with_a_status_not_an_error() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "StartDiscovery",
        Reply::Err(BluezError::new(
            "org.bluez.Error.NotReady",
            "Resource Not Ready",
        )),
    );
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert_eq!(outcome.status.as_deref(), Some("NotFound"));
    assert_eq!(bus.count("StopDiscovery"), 0);
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_brick_dialog_reaches_the_user_as_bluezs_reason_not_a_timeout() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), false, None)]);
    let bus = FakeBus::new(Vec::new());
    // BlueZ itself ends an unanswered brick dialog after 60 s.
    bus.reply(
        "Pair",
        Reply::After(
            Duration::from_secs(60),
            Box::new(Reply::Err(BluezError::new(
                "org.bluez.Error.AuthenticationRejected",
                "Authentication Rejected",
            ))),
        ),
    );
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(!outcome.ok);
    assert_eq!(outcome.status.as_deref(), Some("AuthenticationRejected"));
    assert!(
        outcome
            .reason
            .as_deref()
            .unwrap()
            .contains("not confirmed in time"),
        "{outcome:?}"
    );
    assert_eq!(bus.count("UnregisterAgent"), 1);
}

#[tokio::test(start_paused = true)]
async fn counts_already_exists_as_paired() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), false, None)]);
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "Pair",
        Reply::Err(BluezError::new(
            "org.bluez.Error.AlreadyExists",
            "Already Exists",
        )),
    );
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(outcome.ok);
    assert_eq!(outcome.status.as_deref(), Some("AlreadyPaired"));
}

#[tokio::test(start_paused = true)]
async fn does_not_count_an_agent_bluez_refused_as_a_paired_brick() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), false, None)]);
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "RegisterAgent",
        Reply::Err(BluezError::new(
            "org.bluez.Error.AlreadyExists",
            "Already Exists",
        )),
    );
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(!outcome.ok);
    assert!(outcome.reason.unwrap().contains("still registered"));
    assert_eq!(bus.count("Pair"), 0);
    assert_eq!(bus.count("WithdrawAgent"), 1);
}

#[tokio::test(start_paused = true)]
async fn cancels_a_pairing_in_flight_at_bluez_and_answers_cancelled() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), false, None)]);
    let bus = FakeBus::new(Vec::new());
    // BlueZ acknowledges the cancel, but Pair keeps hanging.
    bus.reply("Pair", Reply::Hang);
    let cancel = Arc::new(CancelFlag::default());
    let stopper = Arc::clone(&cancel);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        stopper.cancel();
    });
    let started = tokio::time::Instant::now();
    let outcome = pair_brick(context(&bus, &objects), AAA_ADDRESS, cancel).await;
    assert!(started.elapsed() < Duration::from_secs(6));
    assert_eq!(outcome.reason.as_deref(), Some(PAIRING_CANCELLED));
    assert_eq!(
        bus.members(),
        [
            "ExportAgent",
            "RegisterAgent",
            "Pair",
            "CancelPairing",
            "UnregisterAgent",
            "WithdrawAgent"
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn answers_cancelled_at_once_for_a_cancel_already_set_touching_nothing() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), false, None)]);
    let bus = FakeBus::new(Vec::new());
    let cancel = Arc::new(CancelFlag::default());
    cancel.cancel();
    let outcome = pair_brick(context(&bus, &objects), AAA_ADDRESS, cancel).await;
    assert_eq!(outcome.reason.as_deref(), Some(PAIRING_CANCELLED));
    assert!(bus.members().is_empty());
}

#[tokio::test(start_paused = true)]
async fn cancels_the_pairing_at_bluez_when_pair_runs_past_its_time_here() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), false, None)]);
    let bus = FakeBus::new(Vec::new());
    bus.reply("Pair", Reply::Hang);
    let started = tokio::time::Instant::now();
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(started.elapsed() >= PAIR_TIMEOUT);
    assert_eq!(outcome.status.as_deref(), Some("Timeout"));
    assert_eq!(bus.count("CancelPairing"), 1);
}

#[test]
fn the_pairing_time_here_outlasts_bluezs_own_60_s() {
    assert!(PAIR_TIMEOUT > Duration::from_secs(60));
}

#[tokio::test(start_paused = true)]
async fn pairs_one_brick_at_a_time() {
    let objects = objects_with(vec![
        device_object(AAA_PATH, AAA, Some("AAA"), false, None),
        device_object(BBB_PATH, BBB, Some("BBB"), false, None),
    ]);
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "Pair",
        Reply::After(Duration::from_secs(10), Box::new(Reply::Ok)),
    );
    let shared = context(&bus, &objects);
    let first = tokio::spawn(pair(shared.clone(), AAA_ADDRESS));
    tokio::time::sleep(Duration::from_millis(1)).await;
    let second = tokio::spawn(pair(shared, BBB_ADDRESS));
    let (first, second) = (first.await.unwrap(), second.await.unwrap());
    assert_eq!(first.status.as_deref(), Some("Paired"));
    assert_eq!(second.status.as_deref(), Some("Paired"));
    let members = bus.members();
    let first_withdraw = members.iter().position(|m| m == "WithdrawAgent").unwrap();
    let second_export = members.iter().rposition(|m| m == "ExportAgent").unwrap();
    assert!(first_withdraw < second_export, "{members:?}");
}

#[tokio::test(start_paused = true)]
async fn a_cancel_while_start_discovery_is_unanswered_stops_a_discovery_that_starts_late() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply(
        "StartDiscovery",
        Reply::After(Duration::from_secs(5), Box::new(Reply::Ok)),
    );
    let context = context(&bus, &objects);
    let gate = Arc::clone(&context.gate);
    let cancel = Arc::new(CancelFlag::default());
    let stopper = Arc::clone(&cancel);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        stopper.cancel();
    });
    let outcome = pair_brick(context, AAA_ADDRESS, cancel).await;
    assert_eq!(outcome.reason.as_deref(), Some(PAIRING_CANCELLED));
    assert_eq!(bus.count("StopDiscovery"), 0);
    // The next discovery waits for the late stop.
    assert_eq!(gate.outstanding(), 1);
    gate.idle().await;
    assert_eq!(bus.count("StopDiscovery"), 1);
}

#[tokio::test(start_paused = true)]
async fn a_cancel_while_the_filter_is_unanswered_starts_no_discovery() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    bus.reply("SetDiscoveryFilter", Reply::Hang);
    let cancel = Arc::new(CancelFlag::default());
    let stopper = Arc::clone(&cancel);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        stopper.cancel();
    });
    let outcome = pair_brick(context(&bus, &objects), AAA_ADDRESS, cancel).await;
    assert_eq!(outcome.reason.as_deref(), Some(PAIRING_CANCELLED));
    assert_eq!(bus.count("StartDiscovery"), 0);
}

#[test]
fn an_address_written_without_separators_names_the_right_object() {
    let address = parse_mac("001653f00a0a").unwrap();
    assert_eq!(device_path(ADAPTER, address), AAA_PATH);
}

#[tokio::test(start_paused = true)]
async fn says_found_for_a_brick_bluez_already_holds_unpaired_without_searching() {
    let objects = objects_with(vec![device_object(AAA_PATH, AAA, Some("AAA"), false, None)]);
    let bus = FakeBus::new(Vec::new());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    bus.on_call(move |_, call| log.lock().unwrap().push(call.member.clone()));
    pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(!seen.lock().unwrap().iter().any(|m| m == "StartDiscovery"));
}

#[tokio::test(start_paused = true)]
async fn a_computer_without_an_adapter_is_told_so() {
    let objects = Arc::new(BluezObjects::new());
    objects.load(Vec::new());
    let bus = FakeBus::new(Vec::new());
    let outcome = pair(context(&bus, &objects), BBB_ADDRESS).await;
    assert_eq!(outcome.status.as_deref(), Some("NoAdapter"));
}

#[tokio::test(start_paused = true)]
async fn a_brick_heard_before_the_start_is_answered_is_paired_only_after_the_stop() {
    let objects = objects_with(Vec::new());
    let bus = FakeBus::new(Vec::new());
    // Another client's discovery reports the brick while BlueZ has not answered our start yet.
    heard_on_start(&bus, &objects, false);
    bus.reply(
        "StartDiscovery",
        Reply::After(Duration::from_secs(2), Box::new(Reply::Ok)),
    );
    let outcome = pair(context(&bus, &objects), AAA_ADDRESS).await;
    assert!(outcome.ok, "{outcome:?}");
    let members = bus.members();
    let stop = members.iter().position(|m| m == "StopDiscovery");
    let export = members.iter().position(|m| m == "ExportAgent");
    assert!(
        stop.is_some() && stop < export,
        "the discovery must stop before the pairing starts: {members:?}"
    );
}
