//! Every recorded link fixture under `daemon/fixtures/link` replays strictly against this build.
//!
//! Each fixture directory is named `<scenario>-<brick>`. The test runs the recording harness's
//! own scenario function (`examples/record.rs`) against strict replay of the recording, so the
//! scenario has to send exactly the recorded bytes in the recorded order and use every recorded
//! call. When it no longer does, the fixture is stale: record the scenario again on hardware with
//! the command in its `scenario.md`; never edit the recording.
//!
//! A directory with only a `scenario.md` describes a scenario still waiting for its hardware
//! round; it is checked for a known scenario name and otherwise skipped.

#[path = "../examples/record.rs"]
#[allow(dead_code)]
mod record;

use std::path::PathBuf;
use std::sync::Arc;

use ev3_transports::fixture::RECORDING_FILE;
use ev3_transports::{Replay, ReplayMode};

fn fixtures_dir() -> PathBuf {
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/link");
    if compiled.is_dir() {
        return compiled;
    }
    // A test binary built on one system and run on another finds the fixtures from its own path.
    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.ancestors()
                .map(|dir| dir.join("fixtures/link"))
                .find(|dir| dir.is_dir())
        })
        .unwrap_or(compiled)
}

/// Every fixture directory, by name, sorted.
fn fixture_names() -> Vec<String> {
    let dir = fixtures_dir();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn every_fixture_directory_names_a_known_scenario_and_says_what_it_is() {
    let names = fixture_names();
    assert!(!names.is_empty(), "no fixtures under {:?}", fixtures_dir());
    for name in names {
        let (scenario, brick) = record::scenario_of(&name)
            .unwrap_or_else(|| panic!("{name} does not name a scenario of the harness"));
        assert_eq!(record::fixture_name(scenario.name, brick), name);
        assert!(
            fixtures_dir().join(&name).join("scenario.md").is_file(),
            "{name} has no scenario.md"
        );
    }
}

/// The harness refuses a recording that still carries a real identifier; its search has to find
/// one in each spelling a recording can hold.
#[test]
fn the_harness_search_finds_identifiers_in_every_spelling() {
    use ev3_transports::fixture::to_hex;
    // Made at run time, so no address-shaped literal sits in the repository.
    let serial = format!("{:02X}{:010X}", 0x02, 0x00AB_CDEF_u64);
    let secrets = [
        record::Secret {
            label: "serial".into(),
            value: serial.clone(),
            address: true,
        },
        record::Secret {
            label: "host".into(),
            value: "Wkstn".into(),
            address: false,
        },
    ];
    let colons: Vec<String> = (0..6)
        .map(|i| serial[i * 2..i * 2 + 2].to_owned())
        .collect();
    let mut reversed = ev3_transports::fixture::from_hex(&serial).unwrap();
    reversed.reverse();
    for planted in [
        format!("{{\"brick_key\":\"usb:{serial}\"}}"),
        format!("{{\"x\":\"{}\"}}", colons.join(":").to_ascii_lowercase()),
        format!("{{\"reply_hex\":\"00{}00\"}}", to_hex(serial.as_bytes())),
        format!("{{\"reply_hex\":\"00{}00\"}}", to_hex(&reversed)),
        "{\"name\":\"WKSTN\"}".to_owned(),
        format!("{{\"reply_hex\":\"{}\"}}", to_hex(b"wkstn")),
        // A private LAN address, assembled so no such literal sits in the repository.
        format!("{{\"ip\":\"{}.{}.{}.{}\"}}", 192, 168, 1, 20),
    ] {
        assert!(
            !record::search(&planted, &secrets).is_empty(),
            "missed in {planted}"
        );
    }
    assert!(record::search("{\"brick_key\":\"usb:001653F00A0A\"}", &secrets).is_empty());
}

#[tokio::test(start_paused = true)]
async fn every_recorded_scenario_replays_strictly() {
    let mut replayed = 0;
    for name in fixture_names() {
        let Some((scenario, brick)) = record::scenario_of(&name) else {
            panic!("{name} does not name a scenario of the harness");
        };
        let path = fixtures_dir().join(&name).join(RECORDING_FILE);
        if !path.is_file() {
            println!("{name}: not recorded yet, skipped");
            continue;
        }
        let replay = Replay::load(&path, ReplayMode::Strict)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        assert_eq!(
            replay.header().scenario,
            name,
            "{name}: header names another scenario"
        );
        let provider = replay.provider(scenario.transport).unwrap_or_else(|| {
            panic!(
                "{name}: the recording has no {} provider",
                scenario.transport
            )
        });
        let summary = (scenario.run)(provider, brick.to_owned(), Arc::default())
            .await
            .unwrap_or_else(|e| panic!("{name} no longer replays; re-record it. {e}"));
        replay
            .finish()
            .unwrap_or_else(|e| panic!("{name} no longer replays; re-record it. {}", e.message));
        println!("{name}: {summary}");
        replayed += 1;
    }
    assert!(
        replayed > 0,
        "no recorded fixture under {:?}",
        fixtures_dir()
    );
}
