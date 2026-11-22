//! Exit requests and replacement, judged by the daemon binary itself on private test channels: who
//! replaces a daemon without asking, who needs a person, the wait for a write in progress, holds
//! that survive a replacement, the build kind nothing at run time can change, and a client on
//! another contract version.
//!
//! The binary `cargo test` builds is a development build. It meets clients as a release daemon
//! with `--report-release`, an argument only development builds know. A release-marked binary
//! (compiled with `EV3_COCKPIT_RELEASE_BUILD=1`) is checked as well when `EV3_COCKPITD_RELEASE_BIN`
//! names one.

mod common;

use std::ffi::OsStr;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use common::{Client, Daemon, Hello, TempRoot};
use serde_json::{Value, json};

/// AAA's id: its hardware digits, as the recordings hold them.
const AAA: &str = "001653F00A0A";
const REPORT_RELEASE: &str = "--report-release";

fn release_daemon(root: &TempRoot) -> Daemon {
    Daemon::start_with(root, "t", &[OsStr::new(REPORT_RELEASE)])
}

async fn client(daemon: &Daemon, root: &TempRoot, hello: Hello<'_>) -> (Client, Value) {
    let mut client = Client::connect(&daemon.path()).await;
    let accepted = client.hello_from(&root.key(), hello).await;
    (client, accepted)
}

/// A version newer than `version` in its first part.
fn newer_than(version: &str) -> String {
    let major: u64 = version
        .split('.')
        .next()
        .and_then(|part| part.parse().ok())
        .unwrap_or(0);
    format!("{}.0.0", major + 1)
}

fn is_question(message: &Value) -> bool {
    message["method"] == "question/ask"
}

fn answers(id: u64) -> impl Fn(&Value) -> bool {
    move |m: &Value| m.get("id") == Some(&json!(id)) && m.get("method").is_none()
}

/// Sends `daemon/exit` and returns its answer, failing if the daemon asks this client anything
/// first.
async fn exit_without_a_question(client: &mut Client) -> Value {
    let id = client.send_request("daemon/exit", json!({})).await;
    let message = client
        .next_matching(|m| is_question(m) || answers(id)(m))
        .await
        .expect("answered");
    assert!(
        !is_question(&message),
        "a replacement asks nobody: {message}"
    );
    message
}

/// Sends `daemon/exit`, expects the restart question at this client, answers it with `answer`,
/// and returns the question and the exit's answer.
async fn exit_with_restart_answer(client: &mut Client, answer: &str) -> (Value, Value) {
    let id = client.send_request("daemon/exit", json!({})).await;
    let question = client.question().await.expect("asked");
    assert_eq!(question["params"]["kind"], "restart", "{question}");
    client.reply(&question, json!({ "answer": answer })).await;
    let exit = client.answer_to(id).await.expect("answered");
    (question, exit)
}

fn assert_runs(daemon: &mut Daemon) {
    assert!(
        daemon.wait_exit(Duration::from_millis(500)).is_none(),
        "the daemon keeps running"
    );
}

fn assert_exits_cleanly(daemon: &mut Daemon, root: &TempRoot) {
    let status = daemon.wait_exit(Duration::from_secs(10)).expect("exits");
    assert_eq!(status.code(), Some(0));
    assert!(!root.record_file("t").exists(), "the record goes");
}

// ── A release daemon ─────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_release_daemon_is_replaced_by_a_development_client_without_asking_anyone() {
    let root = TempRoot::new("rel-dev");
    let mut daemon = release_daemon(&root);
    // A development build replaces it whatever the versions: the same one, where a release
    // client would not.
    let (mut dev, accepted) = client(
        &daemon,
        &root,
        Hello {
            version: ev3_cockpitd::build_info::VERSION,
            ..Hello::default()
        },
    )
    .await;
    assert_eq!(accepted["buildKind"], "release");
    let exit = exit_without_a_question(&mut dev).await;
    assert_eq!(exit["result"]["accepted"], true, "{exit}");
    assert_exits_cleanly(&mut daemon, &root);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_daemon_is_replaced_by_a_newer_release_client_without_asking_anyone() {
    let root = TempRoot::new("rel-newer");
    let mut daemon = release_daemon(&root);
    let newer = newer_than(ev3_cockpitd::build_info::VERSION);
    let (mut release, _) = client(
        &daemon,
        &root,
        Hello {
            version: &newer,
            build_kind: "release",
            ..Hello::default()
        },
    )
    .await;
    let exit = exit_without_a_question(&mut release).await;
    assert_eq!(exit["result"]["accepted"], true, "{exit}");
    assert_exits_cleanly(&mut daemon, &root);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_equal_release_client_or_an_unknown_build_kind_does_not_replace_a_release_daemon() {
    let root = TempRoot::new("rel-equal");
    let mut daemon = release_daemon(&root);
    let version = ev3_cockpitd::build_info::VERSION;
    // An unknown build kind reads as release: it never counts as a development build.
    for build_kind in ["release", "nightly"] {
        let (mut equal, _) = client(
            &daemon,
            &root,
            Hello {
                name: "ev3 (terminal)",
                version,
                build_kind,
                ..Hello::default()
            },
        )
        .await;
        let (question, exit) = exit_with_restart_answer(&mut equal, "no").await;
        assert_eq!(question["params"]["requester"]["name"], "ev3 (terminal)");
        assert_eq!(exit["result"]["accepted"], false, "{build_kind}: {exit}");
        assert!(
            exit["result"]["reason"]
                .as_str()
                .unwrap()
                .contains("declined"),
            "{exit}"
        );
        assert_runs(&mut daemon);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_add_on_never_replaces_a_release_daemon_whatever_its_own_build() {
    let root = TempRoot::new("rel-addon");
    let mut daemon = release_daemon(&root);
    let (mut vscode, _) = client(
        &daemon,
        &root,
        Hello {
            kind: "vscode",
            name: "VS Code",
            ..Hello::default()
        },
    )
    .await;
    let newer = newer_than(ev3_cockpitd::build_info::VERSION);
    for (build_kind, version) in [("development", "0.0.1"), ("release", newer.as_str())] {
        let (mut addon, _) = client(
            &daemon,
            &root,
            Hello {
                kind: "addon",
                name: "an add-on",
                version,
                build_kind,
                ..Hello::default()
            },
        )
        .await;
        let id = addon.send_request("daemon/exit", json!({})).await;
        let question = vscode.question().await.expect("a person is asked");
        assert_eq!(question["params"]["kind"], "restart", "{build_kind}");
        assert_eq!(question["params"]["requester"]["kind"], "addon");
        vscode.reply(&question, json!({"answer": "no"})).await;
        let exit = addon.answer_to(id).await.expect("answered");
        assert_eq!(exit["result"]["accepted"], false, "{build_kind}: {exit}");
        assert_runs(&mut daemon);
    }
}

// ── A development daemon ─────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_development_daemon_stays_when_a_newer_release_client_asks() {
    let root = TempRoot::new("dev-rel");
    let mut daemon = Daemon::start(&root, "t");
    let newer = newer_than(ev3_cockpitd::build_info::VERSION);
    let (mut release, accepted) = client(
        &daemon,
        &root,
        Hello {
            version: &newer,
            build_kind: "release",
            ..Hello::default()
        },
    )
    .await;
    assert_eq!(accepted["buildKind"], "development");
    let (_, exit) = exit_with_restart_answer(&mut release, "no").await;
    assert_eq!(exit["result"]["accepted"], false, "{exit}");
    assert_runs(&mut daemon);
}

#[tokio::test(flavor = "multi_thread")]
async fn another_development_client_restarts_a_development_daemon_only_after_a_yes() {
    let root = TempRoot::new("dev-dev");
    let mut daemon = Daemon::start(&root, "t");
    let newer = newer_than(ev3_cockpitd::build_info::VERSION);
    let (mut dev, _) = client(
        &daemon,
        &root,
        Hello {
            version: &newer,
            ..Hello::default()
        },
    )
    .await;
    let (_, refused) = exit_with_restart_answer(&mut dev, "no").await;
    assert_eq!(refused["result"]["accepted"], false, "{refused}");
    assert_runs(&mut daemon);
    let (_, exit) = exit_with_restart_answer(&mut dev, "yes").await;
    assert_eq!(exit["result"]["accepted"], true, "{exit}");
    assert_exits_cleanly(&mut daemon, &root);
}

// ── Who is asked ─────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn an_add_ons_restart_asks_the_person_in_vs_code_naming_it_and_with_nobody_there_is_refused()
{
    let root = TempRoot::new("addon");
    let mut daemon = Daemon::start(&root, "t");
    let (mut addon, _) = client(
        &daemon,
        &root,
        Hello {
            kind: "addon",
            name: "an add-on",
            ..Hello::default()
        },
    )
    .await;
    let alone = exit_without_a_question(&mut addon).await;
    assert_eq!(alone["result"]["accepted"], false, "{alone}");
    assert!(
        alone["result"]["reason"]
            .as_str()
            .unwrap()
            .contains("ev3 daemon restart"),
        "{alone}"
    );
    assert_runs(&mut daemon);

    let (mut vscode, _) = client(
        &daemon,
        &root,
        Hello {
            kind: "vscode",
            name: "VS Code",
            ..Hello::default()
        },
    )
    .await;
    let id = addon.send_request("daemon/exit", json!({})).await;
    let question = vscode.question().await.expect("VS Code is asked");
    assert_eq!(question["params"]["kind"], "restart");
    assert_eq!(
        question["params"]["requester"],
        json!({"name": "an add-on", "kind": "addon"})
    );
    vscode.reply(&question, json!({"answer": "yes"})).await;
    let exit = addon.answer_to(id).await.expect("answered");
    assert_eq!(exit["result"]["accepted"], true, "{exit}");
    assert_exits_cleanly(&mut daemon, &root);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_mcp_client_may_not_ask_even_a_release_daemon_it_would_otherwise_replace() {
    let root = TempRoot::new("mcp");
    let mut daemon = release_daemon(&root);
    let (mut agent, _) = client(
        &daemon,
        &root,
        Hello {
            kind: "mcp",
            ..Hello::default()
        },
    )
    .await;
    let answer = agent
        .request("daemon/exit", json!({}))
        .await
        .expect("answered");
    assert_eq!(answer["error"]["data"]["code"], "access_denied", "{answer}");
    assert_runs(&mut daemon);
}

// ── Writes in progress ───────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_write_in_progress_finishes_before_the_daemon_exits_for_a_replacing_client() {
    let root = TempRoot::new("drain");
    let mut daemon = Daemon::replaying_with(
        &root,
        "t",
        "usb-discovery-aaa",
        &[OsStr::new(REPORT_RELEASE)],
    );
    let (mut vscode, _) = client(
        &daemon,
        &root,
        Hello {
            kind: "vscode",
            name: "VS Code",
            ..Hello::default()
        },
    )
    .await;
    let (mut newer, _) = client(&daemon, &root, Hello::default()).await;
    let list = vscode
        .request("bricks/list", json!({"waitForDiscovery": true}))
        .await
        .expect("answered");
    assert_eq!(list["result"]["bricks"][0]["brickId"], AAA, "{list}");

    // A forget holds the brick's write lease while the person has not answered: a write runs.
    let forgetting = vscode
        .send_request("bricks/forget", json!({"brick": "AAA"}))
        .await;
    let forget_question = vscode.question().await.expect("asked");
    assert_eq!(forget_question["params"]["kind"], "forget");

    let exit = newer.send_request("daemon/exit", json!({})).await;
    assert!(
        newer
            .within(Duration::from_secs(2), |m| is_question(m)
                || answers(exit)(m))
            .await
            .is_none(),
        "no answer and no question while the write runs"
    );
    assert_runs(&mut daemon);

    vscode
        .reply(&forget_question, json!({"answer": "no"}))
        .await;
    let forgot = vscode.answer_to(forgetting).await.expect("the write ended");
    assert_eq!(forgot["error"]["data"]["code"], "cancelled", "{forgot}");
    let answer = newer.answer_to(exit).await.expect("answered");
    assert_eq!(answer["result"]["accepted"], true, "{answer}");
    assert_exits_cleanly(&mut daemon, &root);
}

// ── Holds across a replacement ───────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_held_brick_is_connected_again_by_the_daemon_that_replaced_the_one_holding_it() {
    let root = TempRoot::new("replace-hold");
    let mut old = Daemon::replaying_with(
        &root,
        "t",
        "usb-connect-commands-aaa",
        &[OsStr::new(REPORT_RELEASE)],
    );
    let (mut terminal, _) = client(
        &old,
        &root,
        Hello {
            name: "ev3 connect",
            ..Hello::default()
        },
    )
    .await;
    let connected = terminal
        .request("bricks/connect", json!({"brick": "AAA", "hold": true}))
        .await
        .expect("answered");
    assert_eq!(connected["result"]["connected"], true, "{connected}");
    let exit = exit_without_a_question(&mut terminal).await;
    assert_eq!(exit["result"]["accepted"], true, "{exit}");
    assert_exits_cleanly(&mut old, &root);
    drop(terminal);

    // The replacing build: nobody asks it to connect anything.
    let new = Daemon::replaying(&root, "t", "usb-connect-commands-aaa");
    let (mut watcher, _) = client(
        &new,
        &root,
        Hello {
            kind: "vscode",
            name: "VS Code",
            ..Hello::default()
        },
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let list = watcher
            .request("bricks/list", json!({"waitForDiscovery": true}))
            .await
            .expect("answered");
        let brick = &list["result"]["bricks"][0];
        assert_eq!(brick["brickId"], AAA, "{list}");
        assert_eq!(brick["holders"], json!([{"kind": "hold"}]), "{list}");
        if brick["connected"] == true && brick.get("reconnecting").is_none() {
            break;
        }
        assert!(Instant::now() < deadline, "never connected again: {list}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ── The build kind ───────────────────────────────────────────────────

/// Variables a person or a script might try at run time.
const BUILD_KIND_ENV: &[(&str, &str)] = &[
    ("EV3_COCKPIT_RELEASE_BUILD", "0"),
    ("EV3_COCKPIT_BUILD_KIND", "development"),
    ("EV3_COCKPITD_BUILD_KIND", "development"),
    ("EV3_BUILD_KIND", "development"),
    ("BUILD_KIND", "development"),
];

async fn reported_build_kind(bin: &std::path::Path, extra: &[&OsStr]) -> String {
    let root = TempRoot::new("kind");
    let daemon = Daemon::start_binary(bin, &root, "t", extra, BUILD_KIND_ENV);
    let (_client, accepted) = client(&daemon, &root, Hello::default()).await;
    accepted["buildKind"]
        .as_str()
        .expect("build kind")
        .to_owned()
}

fn usage_exit(bin: &std::path::Path, extra: &[&str]) -> Option<i32> {
    let root = TempRoot::new("usage");
    std::process::Command::new(bin)
        .args(["--channel", "t", "--state-root"])
        .arg(root.path())
        .args(extra)
        .output()
        .expect("runs")
        .status
        .code()
}

#[tokio::test(flavor = "multi_thread")]
async fn no_environment_variable_or_argument_makes_a_build_report_development_against_its_kind() {
    let bin = common::bin();
    // This development build: the variables change nothing, and its one argument only ever
    // reports release.
    assert_eq!(reported_build_kind(bin, &[]).await, "development");
    assert_eq!(
        reported_build_kind(bin, &[OsStr::new(REPORT_RELEASE)]).await,
        "release"
    );
    for argument in [
        &["--build-kind", "development"][..],
        &["--development"],
        &["--report-development"],
    ] {
        assert_eq!(usage_exit(bin, argument), Some(64), "{argument:?}");
    }

    // A release-marked build, when one was built for this run.
    let Some(release) = std::env::var_os("EV3_COCKPITD_RELEASE_BIN").map(PathBuf::from) else {
        eprintln!(
            "skipped the release-marked binary: EV3_COCKPITD_RELEASE_BIN names none \
             (build one with EV3_COCKPIT_RELEASE_BUILD=1)"
        );
        return;
    };
    assert_eq!(reported_build_kind(&release, &[]).await, "release");
    for argument in [
        &[REPORT_RELEASE][..],
        &["--build-kind", "development"],
        &["--development"],
    ] {
        assert_eq!(usage_exit(&release, argument), Some(64), "{argument:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_development_client_replaces_a_release_marked_daemon() {
    let Some(release) = std::env::var_os("EV3_COCKPITD_RELEASE_BIN").map(PathBuf::from) else {
        eprintln!("skipped: EV3_COCKPITD_RELEASE_BIN names no release-marked binary");
        return;
    };
    let root = TempRoot::new("rel-bin");
    let mut daemon = Daemon::start_binary(&release, &root, "t", &[], &[]);
    let (mut dev, accepted) = client(&daemon, &root, Hello::default()).await;
    assert_eq!(accepted["buildKind"], "release");
    let exit = exit_without_a_question(&mut dev).await;
    assert_eq!(exit["result"]["accepted"], true, "{exit}");
    assert_exits_cleanly(&mut daemon, &root);
}

// ── Another contract version ─────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_client_on_another_contract_learns_the_daemons_and_is_served_only_the_stable_core() {
    let root = TempRoot::new("contract");
    let mut daemon = release_daemon(&root);
    let ours = u64::from(ev3_contract::CONTRACT_VERSION);
    let theirs = ours + 1;
    let (mut newer, accepted) = client(
        &daemon,
        &root,
        Hello {
            contract_version: theirs,
            ..Hello::default()
        },
    )
    .await;
    assert_eq!(accepted["contractVersion"], ours, "{accepted}");
    assert_eq!(accepted["buildKind"], "release");
    for method in ["daemon/status", "bricks/list", "settings/list"] {
        let refused = newer.request(method, json!({})).await.expect("answered");
        assert_eq!(
            refused["error"]["data"]["code"], "invalid_request",
            "{refused}"
        );
        let message = refused["error"]["message"].as_str().unwrap();
        assert!(message.contains(&format!("contract {theirs}")), "{message}");
        assert!(message.contains(&format!("contract {ours}")), "{message}");
    }
    // The exit request is stable core: the newer build still replaces the daemon.
    let exit = exit_without_a_question(&mut newer).await;
    assert_eq!(exit["result"]["accepted"], true, "{exit}");
    assert_exits_cleanly(&mut daemon, &root);
}
