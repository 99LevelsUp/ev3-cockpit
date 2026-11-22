//! Every entry of the method table has a message in `contract/vectors/messages.json`, and each
//! message survives JSON → generated Rust type → JSON unchanged. The TypeScript test type-checks
//! the same file against the generated TypeScript maps.

mod common;

use common::{contract_json, round_trip, same};
use ev3_contract::*;
use serde_json::Value;

macro_rules! method_round_trips {
    ($($name:literal $method:ident $params:ty => $result:ty;)*) => {
        /// Round-trips the sample of request `name`; false for a name the contract does not have.
        fn round_trip_method(name: &str, sample: &Value) -> bool {
            match name {
                $($name => {
                    round_trip::<$params>(concat!($name, " params"), &sample["params"]);
                    round_trip::<$result>(concat!($name, " result"), &sample["result"]);
                    true
                })*
                _ => false,
            }
        }
    };
}
for_each_method!(method_round_trips);

fn names(value: &Value) -> Vec<String> {
    let mut names: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
    names.sort();
    names
}

#[test]
fn every_method_has_a_message_that_round_trips() {
    let vectors = contract_json("vectors/messages.json");
    let samples = &vectors["methods"];
    let mut table: Vec<String> = METHODS.iter().map(|m| m.name.to_string()).collect();
    table.sort();
    assert_eq!(
        names(samples),
        table,
        "messages.json and the method table list different requests"
    );
    for (name, sample) in samples.as_object().expect("methods") {
        assert!(
            round_trip_method(name, sample),
            "{name} is not a request of the contract"
        );
    }
}

#[test]
fn every_notification_has_a_message_that_round_trips() {
    let vectors = contract_json("vectors/messages.json");
    let table = contract_json("methods.json");
    let samples = &vectors["notifications"];
    assert_eq!(names(samples), names(&table["notifications"]));
    for (name, payload) in samples.as_object().expect("notifications") {
        let notification = Notification::parse(name, payload.clone())
            .unwrap_or_else(|| panic!("{name} is not a notification of the contract"))
            .unwrap_or_else(|e| panic!("{name} does not decode: {e}"));
        assert_eq!(notification.method(), name);
        let again = notification.params().expect("encodes");
        assert!(same(payload, &again), "{name}: sent {payload}, got {again}");
    }
}

#[test]
fn the_hello_and_the_question_round_trip() {
    let vectors = contract_json("vectors/messages.json");
    let hello = &vectors["hello"];
    round_trip::<HelloStart>("hello/start params", &hello["hello/start"]["params"]);
    round_trip::<HelloChallenge>("hello/start result", &hello["hello/start"]["result"]);
    round_trip::<HelloFinish>("hello/finish params", &hello["hello/finish"]["params"]);
    let accepted =
        round_trip::<HelloAccepted>("hello/finish result", &hello["hello/finish"]["result"]);
    assert_eq!(
        BuildKind::read_open(&accepted.build_kind),
        BuildKind::Development
    );
    assert_eq!(DaemonMode::read_open(&accepted.mode), DaemonMode::Hardware);
    assert_eq!(
        DaemonState::read_open(accepted.state.as_deref().unwrap_or_default()),
        DaemonState::Serving
    );

    let ask = &vectors["clientRequests"]["question/ask"];
    let question = round_trip::<Question>("question/ask params", &ask["params"]);
    let Question::ClearBluetoothList { requester, .. } = question else {
        panic!("the sample asks about clearing a Bluetooth list");
    };
    assert_eq!(requester.kind, ClientKind::Mcp);
    assert_eq!(requester.name, "an agent (MCP)");
    round_trip::<QuestionReply>("question/ask result", &ask["result"]);
}

/// The sample with a property no version of the contract has, as a newer writer might add.
fn with_unknown(sample: &Value) -> Value {
    let mut message = sample.clone();
    message
        .as_object_mut()
        .expect("object")
        .insert("addedLater".into(), serde_json::json!({ "nested": [1, 2] }));
    message
}

#[test]
fn stable_core_messages_accept_unknown_properties() {
    let vectors = contract_json("vectors/messages.json");
    let hello = &vectors["hello"];
    let exit = &vectors["methods"]["daemon/exit"];
    let start = with_unknown(&hello["hello/start"]["params"]);
    let parsed: HelloStart = serde_json::from_value(start).expect("HelloStart");
    assert_eq!(
        ClientKind::read_open(&parsed.client_kind),
        ClientKind::Vscode
    );
    serde_json::from_value::<HelloChallenge>(with_unknown(&hello["hello/start"]["result"]))
        .expect("HelloChallenge");
    serde_json::from_value::<HelloFinish>(with_unknown(&hello["hello/finish"]["params"]))
        .expect("HelloFinish");
    let accepted: HelloAccepted =
        serde_json::from_value(with_unknown(&hello["hello/finish"]["result"]))
            .expect("HelloAccepted");
    assert_eq!(accepted.version, "0.3.0");
    serde_json::from_value::<DaemonExitParams>(with_unknown(&exit["params"]))
        .expect("DaemonExitParams");
    let result: DaemonExitResult =
        serde_json::from_value(with_unknown(&exit["result"])).expect("DaemonExitResult");
    assert!(!result.accepted);
}

/// A hello from a version that knows more kinds, build kinds, modes and states than this one.
#[test]
fn a_hello_with_values_this_version_does_not_know_reads_as_the_least_privileged() {
    let vectors = contract_json("vectors/messages.json");
    let hello = &vectors["hello"];
    let mut start = hello["hello/start"]["params"].clone();
    start["clientKind"] = "python".into();
    start["buildKind"] = "nightly".into();
    let start: HelloStart = serde_json::from_value(start).expect("an unknown kind still parses");
    assert_eq!(ClientKind::read_open(&start.client_kind), ClientKind::Mcp);
    assert_eq!(BuildKind::read_open(&start.build_kind), BuildKind::Release);
    for known in ["vscode", "cli", "mcp", "addon"] {
        assert_eq!(
            ClientKind::read_open(known).to_string(),
            known,
            "a known kind reads as itself"
        );
    }

    let mut accepted = hello["hello/finish"]["result"].clone();
    accepted["mode"] = "record".into();
    accepted["state"] = "draining".into();
    let accepted: HelloAccepted =
        serde_json::from_value(accepted).expect("an unknown mode still parses");
    assert_eq!(DaemonMode::read_open(&accepted.mode), DaemonMode::Hardware);
    assert_eq!(
        DaemonState::read_open(accepted.state.as_deref().unwrap_or_default()),
        DaemonState::Serving
    );
    assert_eq!(DaemonState::read_open("exiting"), DaemonState::Exiting);
}
