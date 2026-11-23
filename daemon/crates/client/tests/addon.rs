//! An add-on as EVƎ C uses ev3-client: no daemon runs, the client starts the one the installed
//! cockpit recorded in install.json, and talks to it with typed calls and typed errors.

use std::path::{Path, PathBuf};

use ev3_client::contract::{ClientKind, ErrorCode};
use ev3_client::launch::{LaunchSpec, hash_file, record_install};
use ev3_client::{Client, ClientOptions, Launch, Paths, method};
use serde_json::json;

/// The daemon cargo built next to or above this test, when it was built and would run for this
/// process: never elevated, as GitHub's Windows runners run every step.
fn daemon() -> Option<PathBuf> {
    if ev3_channel::security::is_elevated().unwrap_or(false) {
        eprintln!("skipped: this process runs elevated, and the cockpit daemon refuses to run so");
        return None;
    }
    let name = if cfg!(windows) {
        "ev3-cockpitd.exe"
    } else {
        "ev3-cockpitd"
    };
    // Next to or above this test: where the binary lies depends on cargo's build layout.
    let exe = std::env::current_exe().ok()?;
    let daemon = exe
        .ancestors()
        .map(|dir| dir.join(name))
        .find(|path| path.is_file());
    if daemon.is_none() {
        eprintln!("skipped: build ev3-cockpitd first (npm run daemon:build)");
    }
    daemon
}

/// A recording; `EV3_FIXTURES` names their folder where the source tree is not at its build path.
fn fixture(scenario: &str) -> PathBuf {
    std::env::var_os("EV3_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures"))
        .join(scenario)
}

#[tokio::test(flavor = "multi_thread")]
async fn an_add_on_starts_the_installed_daemon_and_calls_it_typed() {
    let Some(daemon) = daemon() else {
        return;
    };
    let root = std::env::temp_dir().join(format!(
        "ev3c-addon-{}",
        ev3_channel::hex(&ev3_channel::random_bytes::<6>())
    ));
    let paths = Paths::new(&root, Some("addon"));
    ev3_channel::fsutil::create_private_dir_all(&paths.dir).expect("channel dir");
    // What the installed cockpit records for its add-ons.
    let launch = LaunchSpec {
        sha256: hash_file(&daemon).expect("hash").expect("there"),
        binary: daemon,
        version: "0.0.0".into(),
        build_kind: "development".into(),
    };
    record_install(&paths.dir, &launch);

    let notice = |_: &str| {};
    let client = Client::connect(ClientOptions {
        name: "EVƎ C test".into(),
        kind: "addon",
        version: "1.0.0",
        build_kind: "release",
        daemon: Launch::Installed,
        paths: &paths,
        daemon_args: vec![
            "--mode".into(),
            "replay".into(),
            "--fixtures".into(),
            fixture("service/usb-info-storage-listing-ccc")
                .display()
                .to_string(),
        ],
        asker: None,
        notice: &notice,
    })
    .await
    .expect("the add-on starts the installed daemon and connects");

    let bricks = client
        .call::<method::BricksList>(
            serde_json::from_value(json!({ "waitForDiscovery": true })).expect("params"),
        )
        .await
        .expect("bricks/list");
    assert!(
        bricks.bricks.iter().any(|b| b.name == "CCC"),
        "{:?}",
        bricks.bricks
    );
    // The cache: typed, and the same bricks the list answered.
    let cached = client.bricks().await.expect("bricks");
    assert!(cached.iter().any(|b| b.name == "CCC"), "{cached:?}");
    let status = client
        .call::<method::DaemonStatus>(serde_json::from_value(json!({})).expect("params"))
        .await
        .expect("daemon/status");
    assert!(
        status
            .clients
            .iter()
            .any(|c| c.kind == ClientKind::Addon && c.name == "EVƎ C test"),
        "{:?}",
        status.clients
    );

    // A refusal arrives typed, its code exactly the contract's.
    let refused = client
        .call::<method::BricksInfo>(
            serde_json::from_value(json!({ "brick": "NoSuchBrick" })).expect("params"),
        )
        .await
        .expect_err("no such brick");
    assert_eq!(refused.code(), Some("brick_not_found"), "{refused:?}");
    assert_eq!(refused.error_code(), Some(ErrorCode::BrickNotFound));
    assert!(refused.error_data().is_some());

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_add_on_without_an_installed_daemon_says_how_to_get_one() {
    let root = std::env::temp_dir().join(format!(
        "ev3c-none-{}",
        ev3_channel::hex(&ev3_channel::random_bytes::<6>())
    ));
    let paths = Paths::new(&root, Some("none"));
    let notice = |_: &str| {};
    let error = Client::connect(ClientOptions {
        name: "EVƎ C test".into(),
        kind: "addon",
        version: "1.0.0",
        build_kind: "release",
        daemon: Launch::Installed,
        paths: &paths,
        daemon_args: Vec::new(),
        asker: None,
        notice: &notice,
    })
    .await
    .err()
    .expect("nothing to start");
    assert_eq!(error.failure(), Some(ev3_client::Failure::MissingBinary));
    assert!(error.message().contains("install EVƎ Cockpit"), "{error}");
    let _ = std::fs::remove_dir_all(&root);
}
