//! The daemon's surface over its real channel: questions for a person, write leases, holds in
//! `held.json`, the confinement of local paths, and the brick methods on recorded USB exchanges
//! of a real brick (`daemon/fixtures/link`).

mod common;

use std::time::{Duration, Instant};

use common::{Client, Daemon, TempRoot};
use serde_json::{Value, json};

/// AAA's id: its hardware digits, as the recordings hold them.
const AAA: &str = "001653F00A0A";

async fn client(daemon: &Daemon, root: &TempRoot, kind: &str, name: &str) -> Client {
    let mut client = Client::connect(&daemon.path()).await;
    client.hello_as(&root.key(), kind, name).await;
    client
}

fn code(answer: &Value) -> &str {
    answer["error"]["data"]["code"].as_str().unwrap_or("")
}

#[tokio::test(flavor = "multi_thread")]
async fn with_only_an_mcp_client_switching_to_full_is_refused_at_once_naming_the_person_command() {
    let root = TempRoot::new("agent-only");
    let daemon = Daemon::start(&root, "t");
    let mut agent = client(&daemon, &root, "mcp", "an agent").await;
    let started = Instant::now();
    let answer = agent
        .request(
            "settings/set",
            json!({"key": "access-mode", "value": "full"}),
        )
        .await
        .expect("answered");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "refused at once, not after a question's timeout"
    );
    assert_eq!(code(&answer), "needs_person", "{answer}");
    assert_eq!(answer["error"]["code"], 1200);
    assert_eq!(
        answer["error"]["data"]["command"],
        "ev3 config set access-mode full"
    );
    let mode = agent
        .request("settings/accessMode", json!({}))
        .await
        .expect("answered");
    assert_eq!(mode["result"]["mode"], "safe");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_question_an_mcp_request_raises_reaches_vscode_naming_the_mcp_client() {
    let root = TempRoot::new("ask");
    let daemon = Daemon::start(&root, "t");
    let mut vscode = client(&daemon, &root, "vscode", "VS Code").await;
    let mut agent = client(&daemon, &root, "mcp", "an agent").await;

    let asked = agent
        .send_request(
            "settings/set",
            json!({"key": "access-mode", "value": "full"}),
        )
        .await;
    let question = vscode.question().await.expect("VS Code was asked");
    let params = &question["params"];
    assert_eq!(params["kind"], "setting");
    assert_eq!(params["key"], "accessMode");
    assert_eq!(params["value"], "full");
    assert_eq!(params["requester"]["name"], "an agent");
    assert_eq!(params["requester"]["kind"], "mcp");
    assert_eq!(params["timeoutMs"], 60_000);
    vscode.reply(&question, json!({"answer": "yes"})).await;
    let answer = agent.answer_to(asked).await.expect("answered");
    assert_eq!(answer["result"]["value"], "full", "{answer}");
    let changed = vscode
        .next_matching(|m| m["method"] == "settings/accessModeChanged")
        .await
        .expect("told");
    assert_eq!(changed["params"]["mode"], "full");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_remembered_answer_does_not_answer_a_question_another_client_raises() {
    let root = TempRoot::new("remember");
    let daemon = Daemon::start(&root, "t");
    let mut vscode = client(&daemon, &root, "vscode", "VS Code").await;
    let mut agent = client(&daemon, &root, "mcp", "an agent").await;

    // VS Code's own switch: yes, remembered; its next own switch asks nothing.
    let own = vscode
        .send_request(
            "settings/set",
            json!({"key": "access-mode", "value": "full"}),
        )
        .await;
    let question = vscode.question().await.expect("asked");
    assert_eq!(question["params"]["requester"]["kind"], "vscode");
    vscode
        .reply(&question, json!({"answer": "yes", "remember": true}))
        .await;
    assert_eq!(
        vscode.answer_to(own).await.expect("answered")["result"]["value"],
        "full"
    );
    for (value, expected) in [("safe", "safe"), ("full", "full")] {
        let answer = vscode
            .request(
                "settings/set",
                json!({"key": "access-mode", "value": value}),
            )
            .await
            .expect("answered");
        assert_eq!(answer["result"]["value"], expected, "{answer}");
    }
    vscode
        .request(
            "settings/set",
            json!({"key": "access-mode", "value": "safe"}),
        )
        .await
        .expect("back to safe needs nobody");

    // The agent's switch is put to the person again, and their no stands.
    let other = agent
        .send_request(
            "settings/set",
            json!({"key": "access-mode", "value": "full"}),
        )
        .await;
    let question = vscode.question().await.expect("asked again");
    assert_eq!(question["params"]["requester"]["kind"], "mcp");
    vscode.reply(&question, json!({"answer": "no"})).await;
    let answer = agent.answer_to(other).await.expect("answered");
    assert_eq!(code(&answer), "cancelled", "{answer}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_forget_an_agent_asks_for_with_nobody_to_ask_is_refused_naming_the_person_command() {
    let root = TempRoot::new("forget");
    let daemon = Daemon::replaying(&root, "t", "usb-discovery-aaa");
    let mut agent = client(&daemon, &root, "mcp", "an agent").await;
    let started = Instant::now();
    let answer = agent
        .request("bricks/forget", json!({"brick": "AAA"}))
        .await
        .expect("answered");
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "refused at once"
    );
    assert_eq!(code(&answer), "needs_person", "{answer}");
    assert_eq!(answer["error"]["data"]["command"], "ev3 forget AAA");
    let list = agent
        .request("bricks/list", json!({}))
        .await
        .expect("answered");
    assert_eq!(
        list["result"]["bricks"][0]["brickId"], AAA,
        "nothing was forgotten"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_path_into_the_state_root_is_refused_for_every_client_kind() {
    let root = TempRoot::new("confine");
    let daemon = Daemon::start(&root, "t");
    let state = root.channel_dir("t");
    let key = root.path().join("key");
    for kind in ["vscode", "cli", "mcp", "addon"] {
        let mut c = client(&daemon, &root, kind, "a client").await;
        let read = c
            .request(
                "files/read",
                json!({"brick": "AAA", "path": "/home/root/lms2012/prjs/a.rbf",
                       "toLocalPath": state.join("stolen.bin")}),
            )
            .await
            .expect("answered");
        assert_eq!(code(&read), "access_denied", "{kind}: {read}");
        let write = c
            .request(
                "files/write",
                json!({"brick": "AAA", "path": "/home/root/lms2012/prjs/k", "fromLocalPath": key}),
            )
            .await
            .expect("answered");
        assert_eq!(code(&write), "access_denied", "{kind}: {write}");
        let deploy = c
            .request(
                "programs/deployAndRun",
                json!({"brick": "AAA", "runPath": "/home/root/lms2012/prjs/a/a.rbf",
                       "files": [{"remotePath": "/home/root/lms2012/prjs/a/k", "localPath": key}]}),
            )
            .await
            .expect("answered");
        assert_eq!(code(&deploy), "access_denied", "{kind}: {deploy}");
    }
    assert!(!state.join("stolen.bin").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_leased_write_to_a_brick_gets_brick_busy_naming_the_holder() {
    let root = TempRoot::new("lease");
    let daemon = Daemon::replaying(&root, "t", "usb-discovery-aaa");
    let mut vscode = client(&daemon, &root, "vscode", "VS Code").await;
    let mut terminal = client(&daemon, &root, "cli", "ev3 (terminal)").await;
    let list = vscode
        .request("bricks/list", json!({"waitForDiscovery": true}))
        .await
        .expect("answered");
    assert_eq!(list["result"]["bricks"][0]["brickId"], AAA, "{list}");

    // A forget holds the brick's lease while it waits for the person's answer.
    let forgetting = vscode
        .send_request("bricks/forget", json!({"brick": "AAA"}))
        .await;
    let question = vscode.question().await.expect("asked");
    assert_eq!(question["params"]["kind"], "forget");
    assert_eq!(question["params"]["brickId"], AAA);

    let busy = terminal
        .request(
            "files/makeDirectory",
            json!({"brick": "AAA", "path": "/home/root/lms2012/prjs/new"}),
        )
        .await
        .expect("answered");
    assert_eq!(code(&busy), "brick_busy", "{busy}");
    assert_eq!(busy["error"]["code"], 1100);
    assert_eq!(busy["error"]["data"]["holder"], "VS Code");
    let status = terminal
        .request("daemon/status", json!({}))
        .await
        .expect("answered");
    let _ = status;

    vscode.reply(&question, json!({"answer": "no"})).await;
    let refused = vscode.answer_to(forgetting).await.expect("answered");
    assert_eq!(code(&refused), "cancelled", "{refused}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hold_ev3_connect_leaves_is_in_held_json_and_goes_with_ev3_disconnect() {
    let root = TempRoot::new("hold");
    let daemon = Daemon::replaying(&root, "t", "usb-connect-commands-aaa");
    let mut terminal = client(&daemon, &root, "cli", "ev3 connect").await;
    let held_file = root.channel_dir("t").join("held.json");

    let connected = terminal
        .request("bricks/connect", json!({"brick": "aaa", "hold": true}))
        .await
        .expect("answered");
    assert_eq!(connected["result"]["brickId"], AAA, "{connected}");
    assert_eq!(connected["result"]["connected"], true);
    assert_eq!(connected["result"]["holders"], json!([{"kind": "hold"}]));
    let held: Value = serde_json::from_str(&std::fs::read_to_string(&held_file).unwrap()).unwrap();
    assert_eq!(held["bricks"], json!([AAA]));

    let status = terminal
        .request("daemon/status", json!({}))
        .await
        .expect("answered");
    assert_eq!(status["result"]["bricks"][0]["brickId"], AAA, "{status}");
    assert_eq!(
        status["result"]["bricks"][0]["holders"],
        json!([{"kind": "hold"}])
    );

    // The CLI may leave the brick out: exactly one is connected.
    let released = terminal
        .request("bricks/disconnect", json!({"releaseHold": true}))
        .await
        .expect("answered");
    assert_eq!(released["result"]["stillHeldBy"], json!([]), "{released}");
    let held: Value = serde_json::from_str(&std::fs::read_to_string(&held_file).unwrap()).unwrap();
    assert_eq!(held["bricks"], json!([]));
    let list = terminal
        .request("bricks/list", json!({}))
        .await
        .expect("answered");
    assert_eq!(list["result"]["bricks"][0]["connected"], false, "{list}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_brick_held_by_the_previous_daemon_is_connected_again_at_start() {
    let root = TempRoot::new("held-again");
    let dir = root.channel_dir("t");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("held.json"), format!("{{\"bricks\":[\"{AAA}\"]}}")).unwrap();
    let daemon = Daemon::replaying(&root, "t", "usb-connect-commands-aaa");
    let mut terminal = client(&daemon, &root, "cli", "ev3").await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let list = terminal
            .request("bricks/list", json!({"waitForDiscovery": true}))
            .await
            .expect("answered");
        let brick = &list["result"]["bricks"][0];
        assert_eq!(brick["holders"], json!([{"kind": "hold"}]), "{list}");
        if brick["connected"] == true && brick.get("reconnecting").is_none() {
            break;
        }
        assert!(Instant::now() < deadline, "never connected again: {list}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connect_tells_every_client_the_brick_came_and_the_list_changed() {
    let root = TempRoot::new("notify");
    let daemon = Daemon::replaying(&root, "t", "usb-connect-commands-aaa");
    let mut vscode = client(&daemon, &root, "vscode", "VS Code").await;
    vscode
        .request("bricks/list", json!({"waitForDiscovery": true}))
        .await
        .expect("answered");
    let id = vscode
        .send_request("bricks/connect", json!({"brick": "AAA"}))
        .await;
    let (mut answered, mut reconnected, mut changed) = (None, false, false);
    while answered.is_none() || !reconnected || !changed {
        let message = vscode.next().await.expect("open");
        match message["method"].as_str() {
            Some("bricks/reconnected") => {
                assert_eq!(message["params"]["brickId"], AAA);
                reconnected = true;
            }
            Some("bricks/changed") => {
                changed |= message["params"]["bricks"][0]["connected"] == true;
            }
            _ if message["id"] == json!(id) => answered = Some(message),
            _ => {}
        }
    }
    let answer = answered.unwrap();
    assert_eq!(answer["result"]["connected"], true, "{answer}");
    assert_eq!(
        answer["result"]["holders"],
        json!([{"kind": "client", "client": "VS Code"}])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hold_survives_the_client_that_made_it_and_a_client_hold_does_not() {
    let root = TempRoot::new("survive");
    let daemon = Daemon::replaying(&root, "t", "usb-connect-commands-aaa");
    let mut terminal = client(&daemon, &root, "cli", "ev3 connect").await;
    let held = terminal
        .request("bricks/connect", json!({"brick": "AAA", "hold": true}))
        .await
        .expect("answered");
    assert_eq!(held["result"]["connected"], true, "{held}");
    drop(terminal);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let mut next = client(&daemon, &root, "cli", "ev3 list").await;
    let list = next
        .request("bricks/list", json!({}))
        .await
        .expect("answered");
    let brick = &list["result"]["bricks"][0];
    assert_eq!(brick["connected"], true, "the hold kept it: {list}");
    assert_eq!(brick["holders"], json!([{"kind": "hold"}]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_gone_while_its_brick_connects_leaves_it_signed_out_with_no_holder() {
    let root = TempRoot::new("orphan");
    let daemon = Daemon::replaying(&root, "t", "usb-connect-commands-aaa");
    let mut leaving = client(&daemon, &root, "vscode", "VS Code").await;
    leaving
        .request("bricks/list", json!({"waitForDiscovery": true}))
        .await
        .expect("answered");
    leaving
        .send_request("bricks/connect", json!({"brick": "AAA"}))
        .await;
    drop(leaving);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let mut next = client(&daemon, &root, "cli", "ev3 list").await;
    let list = next
        .request("bricks/list", json!({}))
        .await
        .expect("answered");
    let brick = &list["result"]["bricks"][0];
    assert_eq!(brick["holders"], json!([]), "{list}");
    assert_eq!(brick["connected"], false, "nobody holds it: {list}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_ledger_is_moved_aside_and_the_daemon_serves() {
    let root = TempRoot::new("ledger");
    let dir = root.channel_dir("t");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("ledger.json"), "{ not json").unwrap();
    let daemon = Daemon::start(&root, "t");
    let mut c = client(&daemon, &root, "cli", "ev3").await;
    let list = c.request("bricks/list", json!({})).await.expect("answered");
    assert_eq!(list["result"]["bricks"], json!([]));
    let aside: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("ledger.json.damaged-"))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert!(
        !dir.join("ledger.json").exists()
            || std::fs::read_to_string(dir.join("ledger.json")).unwrap() != "{ not json"
    );
}

/// Parameters each method accepts, naming a brick the daemon does not have.
fn params_of(method: &str) -> Value {
    let brick = "AAA";
    match method {
        "log/notice" => json!({"level": "info", "text": "a notice"}),
        "settings/set" => json!({"key": "rememberBricks", "value": "wait"}),
        "subscriptions/cancel" => json!({"subscriptionId": "none"}),
        "transfer/begin" => json!({"size": 4}),
        "transfer/write" | "transfer/read" | "transfer/close" => {
            json!({"handle": "none", "data": "AAAA"})
        }
        "files/list" | "files/exists" | "files/size" | "files/makeDirectory" => {
            json!({"brick": brick, "path": "/home/root/lms2012/prjs/x"})
        }
        "files/read" => {
            json!({"brick": brick, "path": "/home/root/lms2012/prjs/x", "inline": true})
        }
        "files/write" => {
            json!({"brick": brick, "path": "/home/root/lms2012/prjs/x", "content": "AAAA"})
        }
        "files/remove" => json!({"brick": brick, "path": "/home/root/lms2012/prjs/x"}),
        "files/removePaths" => json!({"brick": brick, "paths": ["/home/root/lms2012/prjs/x"]}),
        "files/move" => json!({"brick": brick, "from": "/home/root/lms2012/prjs/x",
                               "to": "/home/root/lms2012/prjs/y"}),
        "programs/deployAndRun" => json!({"brick": brick, "files": [],
                                          "runPath": "/home/root/lms2012/prjs/a/a.rbf"}),
        "programs/run" => json!({"brick": brick, "path": "/home/root/lms2012/prjs/a/a.rbf"}),
        "shell/run" => json!({"brick": brick, "command": "true"}),
        "telemetry/subscribe" => json!({"brick": brick, "request": {"rows": ["brick.battery"],
                                        "intervalMs": 1000}}),
        _ => json!({"brick": brick}),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_method_answers_without_no_provider() {
    let root = TempRoot::new("all");
    let mut daemon = Daemon::start(&root, "t");
    let mut c = client(&daemon, &root, "vscode", "VS Code").await;
    for info in ev3_contract::METHODS {
        if info.name == "daemon/exit" {
            continue;
        }
        let answer = c
            .request(info.name, params_of(info.name))
            .await
            .unwrap_or_else(|| panic!("{} closed the connection", info.name));
        assert_ne!(code(&answer), "no_provider", "{}: {answer}", info.name);
        assert_ne!(code(&answer), "internal", "{}: {answer}", info.name);
        let message = answer["error"]["message"].as_str().unwrap_or("");
        assert!(
            !message.contains("has no method"),
            "{}: {answer}",
            info.name
        );
        if let Some(error) = answer.get("error") {
            assert!(
                ["brick_not_found", "invalid_request", "cancelled"].contains(&code(&answer)),
                "{}: an unexpected refusal {error}",
                info.name
            );
        }
    }
    // A development client asking a development daemon: a restart, after the person's yes.
    let id = c.send_request("daemon/exit", json!({})).await;
    let question = c.question().await.expect("asked");
    assert_eq!(question["params"]["kind"], "restart");
    c.reply(&question, json!({"answer": "yes"})).await;
    let exit = c.answer_to(id).await.expect("answered");
    assert_eq!(exit["result"]["accepted"], true);
    assert!(daemon.wait_exit(Duration::from_secs(10)).is_some());
}
