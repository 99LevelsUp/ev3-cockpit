//! The daemon binary as clients meet it, each run on a private test channel with its own state:
//! the single-instance lock, the key, the hello, the size cap, idle exit, and a crash.

mod common;

use std::time::{Duration, Instant};

use common::{Client, Daemon, TempRoot, spawn, stderr_of, wait_exit, wait_for_record};
use serde_json::json;

const EXIT_LOCK_HELD: i32 = 2;
const EXIT_REFUSED: i32 = 3;

#[tokio::test(flavor = "multi_thread")]
async fn daemon_exit_is_answered_before_the_daemon_ends_and_the_record_goes() {
    let root = TempRoot::new("exit");
    // As a release daemon, which a development client replaces without asking anyone.
    let mut daemon = Daemon::start_with(&root, "t", &[std::ffi::OsStr::new("--report-release")]);
    let mut client = Client::connect(&daemon.path()).await;
    let accepted = client.hello(&root.key(), "cli").await;
    assert_eq!(accepted["mode"], "replay");
    assert_eq!(accepted["state"], "serving");
    let answer = client
        .request("daemon/exit", json!({}))
        .await
        .expect("answered before the daemon ends");
    assert_eq!(answer["result"]["accepted"], true);
    let status = daemon.wait_exit(Duration::from_secs(5)).expect("exits");
    assert_eq!(status.code(), Some(0));
    assert!(!root.record_file("t").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_hello_names_the_transports_the_daemon_loaded() {
    let root = TempRoot::new("transports");
    let daemon = Daemon::replaying(&root, "t", "usb-connect-commands-aaa");
    let mut client = Client::connect(&daemon.path()).await;
    let accepted = client.hello(&root.key(), "cli").await;
    assert_eq!(accepted["transports"], json!(["usb"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_mcp_client_may_not_ask_the_daemon_to_exit() {
    let root = TempRoot::new("mcp");
    let mut daemon = Daemon::start(&root, "t");
    let mut client = Client::connect(&daemon.path()).await;
    client.hello(&root.key(), "mcp").await;
    let answer = client
        .request("daemon/exit", json!({}))
        .await
        .expect("answered");
    assert_eq!(answer["error"]["data"]["code"], "access_denied");
    assert!(daemon.wait_exit(Duration::from_millis(500)).is_none());
}

#[test]
fn a_second_daemon_exits_with_code_2_while_the_first_holds_the_lock() {
    let root = TempRoot::new("lock");
    let _first = Daemon::start(&root, "t");
    let mut second = spawn(root.path(), "t");
    let status = wait_exit(&mut second, Duration::from_secs(10)).expect("the second exits");
    assert_eq!(
        status.code(),
        Some(EXIT_LOCK_HELD),
        "{}",
        stderr_of(&mut second)
    );
}

#[test]
fn two_daemons_started_at_once_leave_one() {
    let root = TempRoot::new("race");
    let mut a = spawn(root.path(), "t");
    let mut b = spawn(root.path(), "t");
    let deadline = Instant::now() + Duration::from_secs(10);
    let (mut exited, mut running) = (Vec::new(), 0);
    while Instant::now() < deadline && exited.is_empty() {
        for child in [&mut a, &mut b] {
            if let Some(status) = child.try_wait().expect("try_wait") {
                exited.push(status.code());
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    for child in [&mut a, &mut b] {
        if child.try_wait().expect("try_wait").is_none() {
            running += 1;
        }
    }
    assert_eq!(exited, vec![Some(EXIT_LOCK_HELD)]);
    assert_eq!(running, 1);
    for mut child in [a, b] {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_daemons_starting_at_once_on_an_empty_root_end_with_one_key() {
    let root = TempRoot::new("key");
    let mut a = spawn(root.path(), "a");
    let mut b = spawn(root.path(), "b");
    let record_a = wait_for_record(&root, "a", &mut a).expect("a runs");
    let record_b = wait_for_record(&root, "b", &mut b).expect("b runs");
    let key = root.key();
    assert_eq!(key.len(), 32);
    for record in [&record_a, &record_b] {
        let mut client = Client::connect(record["path"].as_str().expect("path")).await;
        client.hello(&key, "cli").await;
    }
    let leftovers: Vec<_> = std::fs::read_dir(root.path())
        .expect("list")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    for mut child in [a, b] {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replaced_key_ends_the_daemon_on_the_next_connection() {
    let root = TempRoot::new("rekey");
    let mut daemon = Daemon::start(&root, "t");
    let old = root.key();
    let replaced: Vec<u8> = old.iter().map(|b| b ^ 0x5a).collect();
    std::fs::write(root.path().join("key"), &replaced).expect("replace the key");
    let mut client = Client::connect(&daemon.path()).await;
    assert!(
        client.next().await.is_none(),
        "the connection is closed unanswered"
    );
    let status = daemon.wait_exit(Duration::from_secs(5)).expect("exits");
    assert_eq!(status.code(), Some(0));
    assert!(!root.record_file("t").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_message_over_1_mib_closes_the_connection() {
    let root = TempRoot::new("big");
    let daemon = Daemon::start(&root, "t");
    let mut client = Client::connect(&daemon.path()).await;
    client.hello(&root.key(), "cli").await;
    let huge = "x".repeat(1024 * 1024);
    client
        .send(json!({"jsonrpc": "2.0", "id": 9, "method": "log/notice", "params": {"level": "info", "text": huge}}))
        .await;
    assert!(client.next().await.is_none(), "closed");

    let mut again = Client::connect(&daemon.path()).await;
    again.hello(&root.key(), "cli").await;
    let fits = "y".repeat(1024 * 1024 - 200);
    let answer = again
        .request("log/notice", json!({"level": "info", "text": fits}))
        .await
        .expect("a message under the cap is served");
    assert_eq!(answer["result"], serde_json::Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn anything_but_the_hello_first_or_a_wrong_proof_closes_the_connection() {
    let root = TempRoot::new("hello");
    let daemon = Daemon::start(&root, "t");

    let mut early = Client::connect(&daemon.path()).await;
    assert!(early.request("daemon/status", json!({})).await.is_none());

    let mut wrong = Client::connect(&daemon.path()).await;
    let nonce = "ab".repeat(32);
    let challenge = wrong
        .request(
            "hello/start",
            json!({"clientNonce": nonce, "clientName": "x", "clientKind": "cli", "version": "0",
                   "contractVersion": 1, "buildKind": "release"}),
        )
        .await
        .expect("challenge");
    let daemon_nonce = challenge["result"]["daemonNonce"].as_str().expect("nonce");
    let proof = ev3_contract::hello::client_proof(&[0u8; 32], &nonce, daemon_nonce);
    assert!(
        wrong
            .request("hello/finish", json!({"clientProof": proof}))
            .await
            .is_none()
    );

    // A client on another contract version still finishes the hello; it decides itself.
    let mut other = Client::connect(&daemon.path()).await;
    let accepted = other.hello(&root.key(), "a-kind-added-later").await;
    assert_eq!(accepted["contractVersion"], ev3_contract::CONTRACT_VERSION);
    let refused = other
        .request("daemon/exit", json!({}))
        .await
        .expect("answered");
    assert_eq!(
        refused["error"]["data"]["code"], "access_denied",
        "an unknown kind reads as mcp"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replay_daemon_without_a_recording_has_no_brick() {
    let root = TempRoot::new("brick");
    let daemon = Daemon::start(&root, "t");
    let mut client = Client::connect(&daemon.path()).await;
    client.hello(&root.key(), "vscode").await;
    let answer = client
        .request("bricks/list", json!({"waitForDiscovery": true}))
        .await
        .expect("answered");
    assert_eq!(answer["result"]["bricks"], json!([]));
    let info = client
        .request("bricks/info", json!({"brick": "AAA"}))
        .await
        .expect("answered");
    assert_eq!(info["error"]["code"], 1000);
    assert_eq!(info["error"]["data"]["code"], "brick_not_found");
    let progress = client
        .request("settings/list", json!({"__progressToken": "p1"}))
        .await
        .expect("a progress token is not a parameter");
    assert!(progress["result"]["settings"].is_array());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_exits_10_s_after_the_last_client() {
    let root = TempRoot::new("idle");
    let mut daemon = Daemon::start(&root, "t");
    let mut client = Client::connect(&daemon.path()).await;
    client.hello(&root.key(), "cli").await;
    tokio::time::sleep(Duration::from_secs(11)).await;
    assert!(
        daemon.wait_exit(Duration::ZERO).is_none(),
        "a connected client keeps it alive"
    );
    drop(client);
    let left = Instant::now();
    let status = daemon
        .wait_exit(Duration::from_secs(14))
        .expect("exits once idle");
    let after = left.elapsed();
    assert_eq!(status.code(), Some(0));
    assert!(
        after >= Duration::from_millis(9500) && after < Duration::from_secs(13),
        "{after:?}"
    );
    assert!(!root.record_file("t").exists());
}

#[test]
fn a_test_channel_refuses_hardware_and_a_bad_argument_is_a_usage_error() {
    let root = TempRoot::new("mode");
    let mut hardware = std::process::Command::new(common::bin())
        .args(["--channel", "t", "--mode", "hardware", "--state-root"])
        .arg(root.path())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("starts");
    let status = wait_exit(&mut hardware, Duration::from_secs(10)).expect("exits");
    assert_eq!(status.code(), Some(EXIT_REFUSED));
    assert!(stderr_of(&mut hardware).contains("never opens real hardware"));
    assert!(
        !root.channel_dir("t").join("daemon.lock").exists(),
        "refused before the lock"
    );

    let usage = std::process::Command::new(common::bin())
        .arg("--state-root")
        .arg(root.path())
        .output()
        .expect("runs");
    assert_eq!(usage.status.code(), Some(64));
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_crash_a_fresh_daemon_takes_a_new_name_and_never_contacts_a_squatter() {
    let root = TempRoot::new("crash");
    let mut first = Daemon::start(&root, "t");
    let old = first.path();
    first.child.kill().expect("crash");
    first.child.wait().expect("gone");
    assert!(root.record_file("t").exists(), "a crash leaves the record");

    let squatter = Squatter::new(&old);
    let second = Daemon::start(&root, "t");
    assert_ne!(second.path(), old);
    let mut client = Client::connect(&second.path()).await;
    client.hello(&root.key(), "cli").await;
    let status = client
        .request("daemon/status", json!({}))
        .await
        .expect("status");
    assert_eq!(status["result"]["channel"], second.path());
    assert!(
        !squatter.contacted().await,
        "the squatted name was never contacted"
    );
}

/// Someone else's pipe or socket under a name a daemon used before.
struct Squatter {
    #[cfg(windows)]
    server: tokio::net::windows::named_pipe::NamedPipeServer,
    #[cfg(unix)]
    listener: tokio::net::UnixListener,
}

impl Squatter {
    fn new(path: &str) -> Self {
        #[cfg(windows)]
        {
            let server = tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(true)
                .create(path)
                .expect("the old name is free after the crash");
            Self { server }
        }
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(path);
            let listener = tokio::net::UnixListener::bind(path).expect("squat");
            Self { listener }
        }
    }

    async fn contacted(&self) -> bool {
        #[cfg(windows)]
        let attempt = self.server.connect();
        #[cfg(unix)]
        let attempt = self.listener.accept();
        tokio::time::timeout(Duration::from_millis(300), attempt)
            .await
            .is_ok()
    }
}
