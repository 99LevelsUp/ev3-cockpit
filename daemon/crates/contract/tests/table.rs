//! What the build script generates from `contract/methods.json` matches the table: the contract
//! version, each request's flags, each error code's family and number, and the settings spec.

mod common;

use common::contract_json;
use ev3_contract::*;
use serde_json::Value;

#[test]
fn the_contract_version_is_the_tables() {
    let table = contract_json("methods.json");
    assert_eq!(
        u64::from(CONTRACT_VERSION),
        table["contractVersion"].as_u64().expect("contractVersion")
    );
}

#[test]
fn every_request_carries_the_tables_flags() {
    let table = contract_json("methods.json");
    let methods = table["methods"].as_object().expect("methods");
    assert_eq!(METHODS.len(), methods.len());
    for info in METHODS {
        let entry = &methods[info.name];
        assert_eq!(info.leased, entry["leased"].as_bool().expect("leased"));
        assert_eq!(
            info.needs_person,
            entry["needsPerson"].as_bool().expect("needsPerson")
        );
        assert_eq!(
            info.stable_core,
            entry["stableCore"].as_bool().unwrap_or(false)
        );
        let kinds: Vec<Value> = info
            .callable_by
            .iter()
            .map(|k| serde_json::to_value(k).expect("kind"))
            .collect();
        assert_eq!(&Value::Array(kinds), &entry["callableBy"], "{}", info.name);
    }
}

#[test]
fn every_error_code_is_in_its_family() {
    let table = contract_json("methods.json");
    let families = &table["errorFamilies"];
    for (code, entry) in table["errors"].as_object().expect("errors") {
        let error = ContractError::new(
            serde_json::from_value(Value::String(code.clone())).expect("a generated code"),
            "test",
        );
        assert_eq!(
            serde_json::to_value(error.data.family).expect("family"),
            entry["family"]
        );
        assert_eq!(
            error.number(),
            families[entry["family"].as_str().expect("family")]["number"]
                .as_i64()
                .expect("number"),
            "{code}"
        );
    }
}

#[test]
fn the_settings_spec_comes_from_the_settings_definition() {
    let specs = setting_specs();
    let access = specs
        .iter()
        .find(|s| s.key == "accessMode")
        .expect("accessMode");
    assert_eq!(access.cli_key, "access-mode");
    assert!(access.dangerous);
    assert!(!access.stored);
    let step = specs
        .iter()
        .find(|s| s.key == "telemetry.throttle.step")
        .expect("step");
    assert_eq!(step.exclusive_minimum, Some(1.0));
    assert!(step.stored);
    let schema = contract_json("schema/settings.json");
    let mut keys: Vec<&String> = schema["definitions"]["Settings"]["properties"]
        .as_object()
        .expect("properties")
        .keys()
        .collect();
    keys.sort();
    let mut spec_keys: Vec<&String> = specs.iter().map(|s| &s.key).collect();
    spec_keys.sort();
    assert_eq!(keys, spec_keys);
}
