//! An add-on as EVƎ C uses ev3-client: no daemon runs, the client starts the one the installed
//! cockpit recorded in install.json, and talks to it with typed calls and typed errors.

use std::path::{Path, PathBuf};

use ev3_client::contract::{ClientKind, ErrorCode, Notification};
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

/// An add-on connected to a daemon it started from install.json, replaying `scenario`; `None`
/// when no daemon is built or this process may not run one. The root goes when the test ends.
async fn addon_on(scenario: &str, tag: &str) -> Option<(Client, PathBuf)> {
    let daemon = daemon()?;
    let root = std::env::temp_dir().join(format!(
        "ev3c-{tag}-{}",
        ev3_channel::hex(&ev3_channel::random_bytes::<6>())
    ));
    let paths = Paths::new(&root, Some(tag));
    ev3_channel::fsutil::create_private_dir_all(&paths.dir).expect("channel dir");
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
            fixture(scenario).display().to_string(),
        ],
        asker: None,
        notice: &notice,
    })
    .await
    .expect("connected");
    Some((client, root))
}

/// Waits until CCC is listed with its name confirmed, as the recording's own probe ran first.
async fn find_ccc(client: &Client) {
    client
        .request("bricks/list", json!({ "waitForDiscovery": true }))
        .await
        .expect("list");
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let bricks = client
            .call::<method::BricksList>(serde_json::from_value(json!({})).expect("params"))
            .await
            .expect("list");
        if bricks
            .bricks
            .iter()
            .any(|b| b.name == "CCC" && b.name_confirmed)
        {
            return;
        }
        assert!(std::time::Instant::now() < until, "CCC was not listed");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_program_subscription_hears_the_state_now_and_every_change_in_order() {
    let Some((client, root)) = addon_on("service/usb-deploy-and-run-ccc", "programs").await else {
        return;
    };
    const DIR: &str = "/home/root/lms2012/prjs/CockpitFixture";
    const WAIT_RBF: &str = "TEVHTyQAAABtAAEAAAAAABwAAAAAAAAABAAAAIWCQB9AhkAK";
    find_ccc(&client).await;
    let mut events = client.events();
    client
        .request("bricks/connect", json!({ "brick": "CCC" }))
        .await
        .expect("connect");
    // The connect reaches every client as a typed bricks/changed.
    let connected = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while let Some(event) = events.next().await {
            if let Notification::BricksChanged(list) = event
                && list.bricks.iter().any(|b| b.name == "CCC" && b.connected)
            {
                return true;
            }
        }
        false
    })
    .await;
    assert_eq!(connected, Ok(true), "no bricks/changed with CCC connected");
    let exists = client
        .request("files/exists", json!({ "brick": "CCC", "path": DIR }))
        .await
        .expect("exists");
    assert_eq!(exists["exists"], false);

    let mut states = client.subscribe_programs("CCC").await.expect("subscribe");
    assert!(!states.state.running);
    assert_eq!(states.state.run_seq, 0);
    let program = format!("{DIR}/Wait.rbf");
    let deployed = client
        .request(
            "programs/deployAndRun",
            json!({ "brick": "CCC", "files": [{ "remotePath": program, "content": WAIT_RBF }],
                    "runPath": program }),
        )
        .await
        .expect("deploy and run");
    assert_eq!(deployed["outcome"], "started", "{deployed}");
    let mut heard = Vec::new();
    for _ in 0..2 {
        let state = tokio::time::timeout(std::time::Duration::from_secs(30), states.next())
            .await
            .expect("a change within 30 s")
            .expect("the subscription is open");
        heard.push((state.run_seq, state.running));
    }
    assert_eq!(heard, [(1, true), (1, false)]);

    drop(states);
    client
        .request(
            "files/remove",
            json!({ "brick": "CCC", "path": DIR, "recursive": true }),
        )
        .await
        .expect("remove");
    client
        .request("bricks/disconnect", json!({ "brick": "CCC" }))
        .await
        .expect("disconnect");
    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
