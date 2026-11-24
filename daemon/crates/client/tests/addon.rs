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

/// A replay daemon on `paths`' channel, started by the test (not by a client), killed on drop.
struct ReplayDaemon(std::process::Child);

impl ReplayDaemon {
    fn start(paths: &Paths, scenario: &str) -> Option<Self> {
        let binary = daemon()?;
        let child = std::process::Command::new(binary)
            .args([
                "--channel",
                paths.channel.as_deref().expect("a test channel"),
            ])
            .arg("--state-root")
            .arg(&paths.root)
            .args(["--mode", "replay", "--fixtures"])
            .arg(fixture(scenario))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("the daemon starts");
        let daemon = Self(child);
        // Serving once its channel record names it: a killed daemon leaves its record behind.
        let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let ours = std::fs::read_to_string(&paths.record)
                .ok()
                .and_then(|text| ev3_channel::record::parse_record(&text))
                .is_some_and(|r| u64::from(r.pid) == u64::from(daemon.0.id()));
            if ours {
                return Some(daemon);
            }
            assert!(
                std::time::Instant::now() < until,
                "the replay daemon did not come up"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

impl Drop for ReplayDaemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cockpit_connects_again_after_its_daemon_went_and_holds_its_own_brick_again() {
    let root = std::env::temp_dir().join(format!(
        "ev3c-again-{}",
        ev3_channel::hex(&ev3_channel::random_bytes::<6>())
    ));
    let paths = Paths::new(&root, Some("again"));
    let scenario = "service/usb-info-storage-listing-ccc";
    let Some(first) = ReplayDaemon::start(&paths, scenario) else {
        return;
    };
    let cockpit = ev3_client::Cockpit::connect(ev3_client::CockpitOptions {
        name: "EVƎ C test".into(),
        kind: "addon",
        version: "1.0.0".into(),
        build_kind: "release".into(),
        daemon: Launch::Nothing,
        paths: paths.clone(),
        daemon_args: Vec::new(),
        asker: None,
        notice: std::sync::Arc::new(|_: &str| {}),
    })
    .await
    .expect("connected");
    let holders = |list: &serde_json::Value| -> Vec<String> {
        list["bricks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["name"] == "CCC")
            .flat_map(|b| b["holders"].as_array().cloned().unwrap_or_default())
            .filter_map(|h| h["client"].as_str().map(str::to_owned))
            .collect()
    };
    cockpit
        .request("bricks/list", json!({ "waitForDiscovery": true }))
        .await
        .expect("list");
    cockpit
        .request("bricks/connect", json!({ "brick": "CCC" }))
        .await
        .expect("connect");
    let listed = cockpit
        .request("bricks/list", json!({}))
        .await
        .expect("list");
    assert_eq!(holders(&listed), ["EVƎ C test"], "{listed}");

    // The daemon goes; a new one comes. Nothing passes from one to the next.
    let mut events = cockpit.events();
    drop(first);
    std::thread::sleep(std::time::Duration::from_millis(500));
    let _second = ReplayDaemon::start(&paths, scenario).expect("again");
    let reconnected = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            match events.recv().await {
                Ok(ev3_client::CockpitEvent::Reconnected(_)) => return true,
                // Tried before the new daemon was up: the next request connects again.
                Ok(ev3_client::CockpitEvent::Lost(_)) => {
                    if cockpit.request("bricks/list", json!({})).await.is_ok() {
                        return true;
                    }
                }
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    })
    .await;
    assert_eq!(reconnected, Ok(true), "not connected again");
    let listed = cockpit
        .request("bricks/list", json!({}))
        .await
        .expect("list");
    assert_eq!(holders(&listed), ["EVƎ C test"], "{listed}");
    cockpit.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_readers_events_end_when_the_daemon_goes() {
    let root = std::env::temp_dir().join(format!(
        "ev3c-ends-{}",
        ev3_channel::hex(&ev3_channel::random_bytes::<6>())
    ));
    let paths = Paths::new(&root, Some("ends"));
    let Some(daemon) = ReplayDaemon::start(&paths, "service/usb-info-storage-listing-ccc") else {
        return;
    };
    let notice = |_: &str| {};
    let client = Client::connect(ClientOptions {
        name: "EVƎ C test".into(),
        kind: "addon",
        version: "1.0.0",
        build_kind: "release",
        daemon: Launch::Nothing,
        paths: &paths,
        daemon_args: Vec::new(),
        asker: None,
        notice: &notice,
    })
    .await
    .expect("connected");
    let mut events = client.events();
    drop(daemon);
    let ended = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while events.next().await.is_some() {}
    })
    .await;
    assert!(
        ended.is_ok(),
        "the reader still waits on a closed connection"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cockpit_dropped_without_shutdown_lets_go_of_its_brick() {
    let root = std::env::temp_dir().join(format!(
        "ev3c-drop-{}",
        ev3_channel::hex(&ev3_channel::random_bytes::<6>())
    ));
    let paths = Paths::new(&root, Some("drop"));
    let Some(_daemon) = ReplayDaemon::start(&paths, "service/usb-info-storage-listing-ccc") else {
        return;
    };
    let options = |name: &str| ev3_client::CockpitOptions {
        name: name.into(),
        kind: "addon",
        version: "1.0.0".into(),
        build_kind: "release".into(),
        daemon: Launch::Nothing,
        paths: paths.clone(),
        daemon_args: Vec::new(),
        asker: None,
        notice: std::sync::Arc::new(|_: &str| {}),
    };
    let watcher = ev3_client::Cockpit::connect(options("watcher"))
        .await
        .expect("watcher");
    let holder = ev3_client::Cockpit::connect(options("holder"))
        .await
        .expect("holder");
    holder
        .request("bricks/list", json!({ "waitForDiscovery": true }))
        .await
        .expect("list");
    holder
        .request("bricks/connect", json!({ "brick": "CCC" }))
        .await
        .expect("connect");
    let held_by = |list: serde_json::Value| -> Vec<String> {
        list["bricks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["name"] == "CCC")
            .flat_map(|b| b["holders"].as_array().cloned().unwrap_or_default())
            .filter_map(|h| h["client"].as_str().map(str::to_owned))
            .collect()
    };
    let listed = watcher
        .request("bricks/list", json!({}))
        .await
        .expect("list");
    assert_eq!(held_by(listed), ["holder"]);

    drop(holder);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let listed = watcher
            .request("bricks/list", json!({}))
            .await
            .expect("list");
        if held_by(listed).is_empty() {
            break;
        }
        assert!(
            std::time::Instant::now() < until,
            "the dropped cockpit still holds CCC"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    watcher.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cockpits_file_follow_hands_over_every_byte_and_follows_again_from_where_it_reached() {
    use ev3_client::FileEvent;
    let root = std::env::temp_dir().join(format!(
        "ev3c-follow-{}",
        ev3_channel::hex(&ev3_channel::random_bytes::<6>())
    ));
    let paths = Paths::new(&root, Some("follow"));
    let scenario = "service/usb-follow-bbb";
    let Some(first) = ReplayDaemon::start(&paths, scenario) else {
        return;
    };
    const DIR: &str = "/home/root/lms2012/prjs/CockpitFixture";
    const LINE: &str = "the quick brown fox jumps over the lazy dog\n";
    const BYTES: usize = 10_000;
    let file = format!("{DIR}/out.txt");
    let cockpit = ev3_client::Cockpit::connect(ev3_client::CockpitOptions {
        name: "EVƎ C test".into(),
        kind: "addon",
        version: "1.0.0".into(),
        build_kind: "release".into(),
        daemon: Launch::Nothing,
        paths: paths.clone(),
        daemon_args: Vec::new(),
        asker: None,
        notice: std::sync::Arc::new(|_: &str| {}),
    })
    .await
    .expect("connected");
    cockpit
        .request("bricks/list", json!({ "waitForDiscovery": true }))
        .await
        .expect("list");
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !cockpit
        .bricks()
        .await
        .expect("bricks")
        .iter()
        .any(|b| b.name == "BBB" && b.name_confirmed)
    {
        assert!(std::time::Instant::now() < until, "BBB was not listed");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let call = |method: &'static str, params: serde_json::Value| {
        let cockpit = cockpit.clone();
        async move {
            cockpit
                .request(method, params)
                .await
                .unwrap_or_else(|e| panic!("{method}: {e}"))
        }
    };
    call("bricks/connect", json!({ "brick": "BBB" })).await;
    let exists = call("files/exists", json!({ "brick": "BBB", "path": DIR })).await;
    assert_eq!(exists["exists"], false);
    call(
        "files/makeDirectory",
        json!({ "brick": "BBB", "path": DIR }),
    )
    .await;
    call(
        "files/write",
        json!({ "brick": "BBB", "path": file, "content": "" }),
    )
    .await;
    let mut follow = cockpit
        .follow_file("BBB", &file, Some(0))
        .await
        .expect("follow");
    assert_eq!((follow.offset, follow.size), (0, 0));
    let content = LINE.repeat(BYTES / LINE.len() + 1)[..BYTES].to_owned();
    let begun = call("transfer/begin", json!({ "size": BYTES })).await;
    call(
        "transfer/write",
        json!({ "handle": begun["handle"],
                "data": ev3_client::contract::base64::encode(content.as_bytes()) }),
    )
    .await;
    call(
        "files/write",
        json!({ "brick": "BBB", "path": file, "handle": begun["handle"] }),
    )
    .await;
    let mut followed = Vec::new();
    while followed.len() < BYTES {
        let event = tokio::time::timeout(std::time::Duration::from_secs(30), follow.next())
            .await
            .expect("bytes within 30 s")
            .expect("the follow is open");
        let FileEvent::Appended { offset, data } = event else {
            panic!("ended before every byte came: {event:?}");
        };
        assert_eq!(offset, followed.len() as u64, "in order, nothing twice");
        followed.extend(data);
    }
    assert_eq!(String::from_utf8_lossy(&followed), content);

    // The daemon goes and a new one comes. The follow is made again from 10000, where the new
    // daemon's brick holds nothing more until the file is removed (as recorded): no byte comes
    // twice, and the follow ends as removed.
    let mut events = cockpit.events();
    drop(first);
    std::thread::sleep(std::time::Duration::from_millis(500));
    let _second = ReplayDaemon::start(&paths, scenario).expect("again");
    let reconnected = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        loop {
            if let Ok(ev3_client::CockpitEvent::Reconnected(_)) = events.recv().await {
                return;
            }
        }
    })
    .await;
    assert!(reconnected.is_ok(), "not connected again");
    let after = tokio::time::timeout(std::time::Duration::from_secs(30), follow.next())
        .await
        .expect("the follow's end within 30 s");
    assert_eq!(
        after,
        Some(FileEvent::Ended(
            ev3_client::contract::FileFollowEndedReason::Removed
        )),
        "nothing again after the reconnect, then the end"
    );
    cockpit.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cockpit_keeps_trying_after_its_daemon_went_and_needs_no_request_to_come_back() {
    let root = std::env::temp_dir().join(format!(
        "ev3c-retry-{}",
        ev3_channel::hex(&ev3_channel::random_bytes::<6>())
    ));
    let paths = Paths::new(&root, Some("retry"));
    let scenario = "service/usb-info-storage-listing-ccc";
    let Some(first) = ReplayDaemon::start(&paths, scenario) else {
        return;
    };
    let cockpit = ev3_client::Cockpit::connect(ev3_client::CockpitOptions {
        name: "EVƎ C test".into(),
        kind: "addon",
        version: "1.0.0".into(),
        build_kind: "release".into(),
        daemon: Launch::Nothing,
        paths: paths.clone(),
        daemon_args: Vec::new(),
        asker: None,
        notice: std::sync::Arc::new(|_: &str| {}),
    })
    .await
    .expect("connected");
    let mut events = cockpit.events();
    drop(first);
    // No daemon for a while: the cockpit says so once.
    let lost = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            if let Ok(ev3_client::CockpitEvent::Lost(_)) = events.recv().await {
                return;
            }
        }
    })
    .await;
    assert!(lost.is_ok(), "no Lost while no daemon ran");
    // A daemon comes back; nobody sends a request.
    let _second = ReplayDaemon::start(&paths, scenario).expect("again");
    let back = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        loop {
            if let Ok(ev3_client::CockpitEvent::Reconnected(_)) = events.recv().await {
                return;
            }
        }
    })
    .await;
    assert!(back.is_ok(), "not connected again without a request");
    cockpit.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
