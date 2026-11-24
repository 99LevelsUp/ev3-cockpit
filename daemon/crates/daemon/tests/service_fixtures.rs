//! The service recordings (`daemon/fixtures/service`) replayed strictly through the daemon: each
//! test makes the surface calls `scripts/hardware-scenario.mts` made when the scenario was recorded
//! through the daemon on a real brick, checks the answers against what the brick said then (each
//! fixture's `scenario.md`), and ends the daemon the way the script did. A strict replay fails a
//! call that differs from the recorded one, and the daemon exits with code 1 when a recorded call
//! was never made, so these tests also say when the daemon's traffic to the brick changed: answer
//! that by recording the scenario again, never by editing the fixture.

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use common::{Client, Daemon, TempRoot};
use serde_json::{Value, json};

/// The brick of the recordings, and its id: its hardware digits, as the recorder replaced them.
const CCC: &str = "CCC";
const CCC_ID: &str = "001653F00A0A";
/// What the scenario script names itself in its hello; holders carry it.
const CLIENT: &str = "hardware scenario";

/// A recorded service scenario's directory.
fn service_fixture(name: &str) -> PathBuf {
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/service");
    let root = if compiled.is_dir() {
        compiled
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.ancestors()
                    .map(|dir| dir.join("fixtures/service"))
                    .find(|dir| dir.is_dir())
            })
            .unwrap_or(compiled)
    };
    std::fs::canonicalize(root.join(name)).expect("the fixture exists")
}

/// One replay: the daemon, the scenario's client, the notifications it heard, and the state root
/// they live in.
struct Replay {
    root: TempRoot,
    daemon: Daemon,
    client: Client,
    notes: Vec<Value>,
    strict: bool,
}

impl Replay {
    /// A strict replay of the fixture `name`.
    async fn start(name: &str) -> Self {
        Self::start_as(name, true).await
    }

    async fn start_as(name: &str, strict: bool) -> Self {
        Self::start_with_settings(name, strict, None).await
    }

    /// A replay whose daemon starts with `settings` stored in its `settings.json`.
    async fn start_with_settings(name: &str, strict: bool, settings: Option<Value>) -> Self {
        let root = TempRoot::new("service");
        if let Some(settings) = settings {
            let dir = root.channel_dir("t");
            std::fs::create_dir_all(&dir).expect("channel dir");
            std::fs::write(dir.join("settings.json"), settings.to_string()).expect("settings");
        }
        let dir = service_fixture(name);
        let mut args: Vec<&std::ffi::OsStr> = vec!["--fixtures".as_ref(), dir.as_os_str()];
        if strict {
            args.extend::<[&std::ffi::OsStr; 2]>(["--replay".as_ref(), "strict".as_ref()]);
        }
        let daemon = Daemon::start_with(&root, "t", &args);
        let client = Self::client_of(&root, &daemon).await;
        Self {
            root,
            daemon,
            client,
            notes: Vec::new(),
            strict,
        }
    }

    /// A replay, strict or matched, whose channel directory holds `files` (name, content) before
    /// the daemon starts, as a previous daemon left them.
    async fn start_seeded_as(name: &str, strict: bool, files: &[(&str, String)]) -> Self {
        let root = TempRoot::new("service");
        let dir = root.channel_dir("t");
        std::fs::create_dir_all(&dir).expect("channel dir");
        for (file, text) in files {
            std::fs::write(dir.join(file), text).expect("seeded file");
        }
        let fixture = service_fixture(name);
        let mut args: Vec<&std::ffi::OsStr> = vec!["--fixtures".as_ref(), fixture.as_os_str()];
        if strict {
            args.extend::<[&std::ffi::OsStr; 2]>(["--replay".as_ref(), "strict".as_ref()]);
        }
        let daemon = Daemon::start_with(&root, "t", &args);
        let client = Self::client_of(&root, &daemon).await;
        Self {
            root,
            daemon,
            client,
            notes: Vec::new(),
            strict,
        }
    }

    async fn client_of(root: &TempRoot, daemon: &Daemon) -> Client {
        let mut client = Client::connect(&daemon.path()).await;
        let hello = client.hello_as(&root.key(), "cli", CLIENT).await;
        assert_eq!(hello["mode"], "replay", "{hello}");
        client
    }

    /// A second client, named as the script names its second client.
    async fn other_client(&self) -> Client {
        Self::client_of(&self.root, &self.daemon).await
    }

    /// The answer to a request, keeping every notification that came meanwhile.
    async fn answer(&mut self, method: &str, params: Value) -> Value {
        let id = self.client.send_request(method, params).await;
        loop {
            let message = self
                .client
                .next()
                .await
                .unwrap_or_else(|| panic!("{method} closed the connection"));
            if message.get("method").is_none() && message["id"] == json!(id) {
                return message;
            }
            self.keep(message).await;
        }
    }

    /// A notification is kept; a question (none is expected before the exit) is answered no.
    async fn keep(&mut self, message: Value) {
        if message["method"] == "question/ask" {
            self.client.reply(&message, json!({"answer": "no"})).await;
        } else {
            self.notes.push(message);
        }
    }

    /// A call that must succeed; its result.
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let answer = self.answer(method, params.clone()).await;
        match answer.get("result") {
            Some(result) => result.clone(),
            None => panic!("{method} {params} failed: {answer}"),
        }
    }

    /// The notifications `method` heard so far, waiting up to `limit` until `count` of them came.
    async fn notes_of(&mut self, method: &str, count: usize, limit: Duration) -> Vec<Value> {
        let deadline = Instant::now() + limit;
        loop {
            let heard: Vec<Value> = self
                .notes
                .iter()
                .filter(|n| n["method"] == method)
                .map(|n| n["params"].clone())
                .collect();
            let left = deadline.saturating_duration_since(Instant::now());
            if heard.len() >= count || left.is_zero() {
                return heard;
            }
            if let Some(message) = self.client.within(left, |_| true).await {
                self.keep(message).await;
            }
        }
    }

    /// The first discovery round, then the brick listed on `transport` with its name confirmed,
    /// as the script waits before it connects.
    async fn find_brick(&mut self, transport: &str) -> Value {
        self.find_named(transport, CCC).await
    }

    /// The same for the brick named `name`.
    async fn find_named(&mut self, transport: &str, name: &str) -> Value {
        self.call("bricks/list", json!({"waitForDiscovery": true}))
            .await;
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let list = self.call("bricks/list", json!({})).await;
            let brick = list["bricks"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|b| b["name"] == name)
                .cloned();
            if let Some(brick) = brick {
                let on = brick["channels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|ch| ch["transport"] == transport);
                if on && brick["nameConfirmed"] == true {
                    return brick;
                }
            }
            assert!(Instant::now() < deadline, "{name} never listed: {list}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Waits until CCC's channel on `transport` is available to connect.
    async fn until_available(&mut self, transport: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let list = self.call("bricks/list", json!({})).await;
            let available = list["bricks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["name"] == CCC)
                .flat_map(|b| b["channels"].as_array().cloned().unwrap_or_default())
                .any(|ch| ch["transport"] == transport && ch["state"] == "available");
            if available {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "CCC never available again: {list}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// `daemon/exit` with its restart question answered yes, as the script ends; the daemon must
    /// exit 0, which in strict replay says every recorded call was made. Returns the state root,
    /// to read what the daemon left in it.
    async fn end(mut self) -> TempRoot {
        let id = self.client.send_request("daemon/exit", json!({})).await;
        let question = self.client.question().await.expect("asked");
        assert_eq!(question["params"]["kind"], "restart");
        self.client.reply(&question, json!({"answer": "yes"})).await;
        let exit = self.client.answer_to(id).await.expect("answered");
        assert_eq!(exit["result"]["accepted"], true, "{exit}");
        if !self.strict {
            let status = self
                .daemon
                .wait_exit(Duration::from_secs(20))
                .expect("the daemon ends");
            assert!(status.success(), "{status}");
            return self.root;
        }
        let status = self
            .daemon
            .wait_exit(Duration::from_secs(20))
            .expect("the daemon ends");
        let log = std::fs::read_to_string(self.root.channel_dir("t").join("daemon.log"))
            .unwrap_or_default();
        assert!(
            status.success(),
            "the strict replay fell short ({status}): {}",
            log.lines()
                .filter(|l| l.contains("Strict replay") || l.contains("replay"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert!(
            log.contains("Strict replay: every recorded call was made."),
            "{log}"
        );
        self.root
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn usb_info_storage_and_a_listing_replay_strictly() {
    if common::refuses_this_process() {
        return;
    }
    let mut run = Replay::start("usb-info-storage-listing-ccc").await;
    let listed = run.find_brick("usb").await;
    assert_eq!(listed["brickId"], CCC_ID);

    let connected = run.call("bricks/connect", json!({"brick": CCC})).await;
    assert_eq!(connected["connected"], true, "{connected}");
    assert_eq!(
        connected["holders"],
        json!([{"kind": "client", "client": CLIENT}])
    );
    let info = run.call("bricks/info", json!({"brick": CCC})).await;
    assert_eq!(
        info,
        json!({"brickId": CCC_ID, "name": CCC, "firmwareVersion": "V1.09H",
               "osVersion": "Linux 2.6.33-rc"})
    );
    let storage = run.call("bricks/storage", json!({"brick": CCC})).await;
    assert_eq!(storage, json!({"totalKb": 6000, "freeKb": 4608}));
    let listing = run
        .call(
            "files/list",
            json!({"brick": CCC, "path": "/home/root/lms2012/"}),
        )
        .await;
    let names: Vec<&str> = listing["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|e| e["name"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        names,
        ["tools", "sys", "source", "prjs", "lms2012", "apps"],
        "{listing}"
    );
    let firmware = &listing["entries"][4];
    assert_eq!(firmware["kind"], "file");
    assert_eq!(firmware["bytes"], 122_762);
    assert_eq!(firmware["md5"], "cb16168f4d1d317cc15074772e021876");
    let exists = run
        .call(
            "files/exists",
            json!({"brick": CCC, "path": "/home/root/lms2012/prjs/"}),
        )
        .await;
    assert_eq!(exists["exists"], true);
    let gone = run.call("bricks/disconnect", json!({"brick": CCC})).await;
    assert_eq!(gone["stillHeldBy"], json!([]));
    run.end().await;
}

/// The listing, info and storage answers both transports share.
fn assert_firmware_folder(listing: &Value) {
    let names: Vec<&str> = listing["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|e| e["name"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        names,
        ["tools", "sys", "source", "prjs", "lms2012", "apps"],
        "{listing}"
    );
    let firmware = &listing["entries"][4];
    assert_eq!(firmware["kind"], "file");
    assert_eq!(firmware["bytes"], 122_762);
    assert_eq!(firmware["md5"], "cb16168f4d1d317cc15074772e021876");
}

/// Whether `client` lists CCC as connected.
async fn ccc_connected(client: &mut Client) -> bool {
    let list = client
        .request("bricks/list", json!({}))
        .await
        .expect("answered");
    list["result"]["bricks"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|b| b["name"] == CCC && b["connected"] == true)
}

/// #9: a client that uses a brick connected already holds it with `reuse`, joining nothing, so
/// the brick stays when the client that connected it leaves.
#[tokio::test(flavor = "multi_thread")]
async fn a_brick_taken_with_reuse_stays_when_the_client_that_connected_it_leaves() {
    if common::refuses_this_process() {
        return;
    }
    let mut run = Replay::start_as("usb-info-storage-listing-ccc", false).await;
    run.find_brick("usb").await;
    let mut first = run.other_client().await;
    let connected = first
        .request("bricks/connect", json!({"brick": CCC}))
        .await
        .expect("answered");
    assert_eq!(connected["result"]["connected"], true, "{connected}");
    let mut second = run.other_client().await;
    let started = Instant::now();
    let reused = second
        .request("bricks/connect", json!({"brick": CCC, "reuse": true}))
        .await
        .expect("answered");
    assert_eq!(
        reused["result"]["holders"].as_array().map(Vec::len),
        Some(2),
        "{reused}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "taken as it is, nothing joined"
    );
    drop(first);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        ccc_connected(&mut second).await,
        "still held by the second client"
    );
    let info = second
        .request("bricks/info", json!({"brick": CCC}))
        .await
        .expect("answered");
    assert_eq!(info["result"]["name"], CCC, "{info}");
    drop(second);
    run.end().await;
}

/// #9: a brick a request of a client that does not hold it is working on is not signed out under
/// that request when its last holder leaves; the request's end signs it out. The request is held
/// on the brick by a question with no exchange before it: the transfer's settlement asks whether
/// to release a slot the seeded ledger owes.
#[tokio::test(flavor = "multi_thread")]
async fn a_brick_in_use_by_a_request_is_signed_out_only_when_that_request_ends() {
    in_use_until_the_request_ends(false).await;
}

/// The same when the last holder lets go with bricks/disconnect rather than by leaving.
#[tokio::test(flavor = "multi_thread")]
async fn a_brick_in_use_by_a_request_stays_through_its_last_holders_disconnect() {
    in_use_until_the_request_ends(true).await;
}

async fn in_use_until_the_request_ends(disconnect: bool) {
    if common::refuses_this_process() {
        return;
    }
    let ledger = json!({ CCC_ID: [{"kind": "unknown"}] }).to_string();
    let mut run = Replay::start_seeded_as(
        "usb-info-storage-listing-ccc",
        false,
        &[("ledger.json", ledger)],
    )
    .await;
    run.find_brick("usb").await;
    let mut holder = run.other_client().await;
    holder
        .request("bricks/connect", json!({"brick": CCC}))
        .await
        .expect("answered");
    let mut user = run.other_client().await;
    let reading = user
        .send_request(
            "files/read",
            json!({"brick": CCC, "path": "/home/root/lms2012/prjs/x.txt", "inline": true}),
        )
        .await;
    let question = user.question().await.expect("the release is asked");
    if disconnect {
        let gone = holder
            .request("bricks/disconnect", json!({"brick": CCC}))
            .await
            .expect("answered");
        assert_eq!(gone["result"]["stillHeldBy"], json!([]), "{gone}");
    }
    drop(holder);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut watcher = run.other_client().await;
    assert!(
        ccc_connected(&mut watcher).await,
        "signed out under the running request"
    );
    user.reply(&question, json!({"answer": "no"})).await;
    user.answer_to(reading).await.expect("answered");
    let deadline = Instant::now() + Duration::from_secs(5);
    while ccc_connected(&mut watcher).await {
        assert!(
            Instant::now() < deadline,
            "never signed out after the request"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(user);
    drop(watcher);
    run.end().await;
}
#[tokio::test(flavor = "multi_thread")]
async fn tcp_info_storage_and_a_listing_replay_strictly() {
    if common::refuses_this_process() {
        return;
    }
    let mut run = Replay::start("tcp-info-storage-listing-ccc").await;
    let listed = run.find_brick("tcp").await;
    assert!(
        listed["brickId"]
            .as_str()
            .is_some_and(|id| id.eq_ignore_ascii_case(CCC_ID)),
        "{listed}"
    );
    let connected = run.call("bricks/connect", json!({"brick": CCC})).await;
    assert_eq!(
        connected["channels"],
        json!([{"state": "connected", "transport": "tcp"}])
    );
    let info = run.call("bricks/info", json!({"brick": CCC})).await;
    assert_eq!(info["name"], CCC);
    assert_eq!(info["firmwareVersion"], "V1.09H");
    assert_eq!(info["osVersion"], "Linux 2.6.33-rc");
    let storage = run.call("bricks/storage", json!({"brick": CCC})).await;
    assert_eq!(storage, json!({"totalKb": 6000, "freeKb": 4544}));
    let listing = run
        .call(
            "files/list",
            json!({"brick": CCC, "path": "/home/root/lms2012/"}),
        )
        .await;
    assert_firmware_folder(&listing);
    let exists = run
        .call(
            "files/exists",
            json!({"brick": CCC, "path": "/home/root/lms2012/prjs/"}),
        )
        .await;
    assert_eq!(exists["exists"], true);
    run.call("bricks/disconnect", json!({"brick": CCC})).await;
    run.end().await;
}

/// The folder the writing scenarios create and remove, and the line their files repeat.
const DIR: &str = "/home/root/lms2012/prjs/CockpitFixture";
const LINE: &str = "the quick brown fox jumps over the lazy dog\n";
/// `Wait.rbf`: waits eight seconds and ends (see `usb-deploy-and-run-ccc/scenario.md`).
const WAIT_RBF: &str = "TEVHTyQAAABtAAEAAAAAABwAAAAAAAAABAAAAIWCQB9AhkAK";

fn repeated(bytes: usize) -> String {
    LINE.repeat(bytes / LINE.len() + 1)[..bytes].to_string()
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Connects CCC on USB after the first discovery round, and checks the folder is not there yet.
async fn connect_usb_and_check_folder(run: &mut Replay) {
    run.find_brick("usb").await;
    let connected = run.call("bricks/connect", json!({"brick": CCC})).await;
    assert_eq!(connected["connected"], true, "{connected}");
    let exists = run
        .call("files/exists", json!({"brick": CCC, "path": DIR}))
        .await;
    assert_eq!(exists["exists"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn usb_file_round_trip_replays_strictly() {
    if common::refuses_this_process() {
        return;
    }
    let mut run = Replay::start("usb-file-round-trip-ccc").await;
    connect_usb_and_check_folder(&mut run).await;
    let note = repeated(3000);
    let notes = format!("{DIR}/notes.txt");
    assert_eq!(
        run.call("files/makeDirectory", json!({"brick": CCC, "path": DIR}))
            .await,
        Value::Null
    );
    let written = run
        .call(
            "files/write",
            json!({"brick": CCC, "path": notes, "content": base64(note.as_bytes())}),
        )
        .await;
    assert_eq!(written, json!({"bytes": 3000}));
    let size = run
        .call("files/size", json!({"brick": CCC, "path": notes}))
        .await;
    assert_eq!(size, json!({"files": 0, "kilobytes": 3}));
    let back = run
        .call(
            "files/read",
            json!({"brick": CCC, "path": notes, "inline": true}),
        )
        .await;
    assert_eq!(back["bytes"], 3000);
    assert_eq!(back["content"], base64(note.as_bytes()));
    run.call(
        "files/move",
        json!({"brick": CCC, "from": notes, "to": format!("{DIR}/moved.txt")}),
    )
    .await;
    let listing = run
        .call("files/list", json!({"brick": CCC, "path": DIR}))
        .await;
    assert_eq!(
        listing["entries"],
        json!([{"bytes": 3000, "kind": "file", "md5": "57271eb06eca76d0aacbab96ae322981",
                "name": "moved.txt"}])
    );
    let removed = run
        .call(
            "files/remove",
            json!({"brick": CCC, "path": DIR, "recursive": true}),
        )
        .await;
    assert_eq!(removed["leftBehind"], json!([]));
    let exists = run
        .call("files/exists", json!({"brick": CCC, "path": DIR}))
        .await;
    assert_eq!(exists["exists"], false);
    run.call("bricks/disconnect", json!({"brick": CCC})).await;
    run.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn usb_writes_and_moves_without_replace_leave_files_there_as_they_are_replays_strictly() {
    if common::refuses_this_process() {
        return;
    }
    let mut run = Replay::start("usb-replace-aaa").await;
    const AAA: &str = "AAA";
    let (a, b, c) = (
        format!("{DIR}/a.txt"),
        format!("{DIR}/b.txt"),
        format!("{DIR}/c.txt"),
    );
    run.find_named("usb", AAA).await;
    run.call("bricks/connect", json!({"brick": AAA})).await;
    let exists = run
        .call("files/exists", json!({"brick": AAA, "path": DIR}))
        .await;
    assert_eq!(exists["exists"], false);
    run.call("files/makeDirectory", json!({"brick": AAA, "path": DIR}))
        .await;
    run.call(
        "files/write",
        json!({"brick": AAA, "path": a, "content": base64(b"first")}),
    )
    .await;
    let refused = run
        .answer(
            "files/write",
            json!({"brick": AAA, "path": a, "content": base64(b"second"), "replace": false}),
        )
        .await;
    assert_eq!(refused["error"]["data"]["code"], "file_exists", "{refused}");
    let back = run
        .call(
            "files/read",
            json!({"brick": AAA, "path": a, "inline": true}),
        )
        .await;
    assert_eq!(back["content"], base64(b"first"), "the file is as it was");
    run.call(
        "files/write",
        json!({"brick": AAA, "path": b, "content": base64(b"other")}),
    )
    .await;
    let refused = run
        .answer(
            "files/move",
            json!({"brick": AAA, "from": a, "to": b, "replace": false}),
        )
        .await;
    assert_eq!(refused["error"]["data"]["code"], "file_exists", "{refused}");
    run.call(
        "files/move",
        json!({"brick": AAA, "from": a, "to": c, "replace": false}),
    )
    .await;
    let listing = run
        .call("files/list", json!({"brick": AAA, "path": DIR}))
        .await;
    let names: Vec<&str> = listing["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .filter_map(|e| e["name"].as_str())
        .collect();
    assert_eq!(
        names,
        ["b.txt", "c.txt"],
        "b.txt kept, a.txt moved to c.txt"
    );
    run.call(
        "files/remove",
        json!({"brick": AAA, "path": DIR, "recursive": true}),
    )
    .await;
    run.call("bricks/disconnect", json!({"brick": AAA})).await;
    run.end().await;
}

/// The program states a subscription heard, as `(runSeq, running, endedBy)`.
fn states(notes: &[Value]) -> Vec<(u64, bool, Option<String>)> {
    notes
        .iter()
        .map(|n| {
            let s = &n["state"];
            (
                s["runSeq"].as_u64().unwrap_or(u64::MAX),
                s["running"].as_bool().unwrap_or(false),
                s["endedBy"].as_str().map(str::to_owned),
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn usb_deploy_and_run_replays_strictly_and_hears_the_program_end() {
    if common::refuses_this_process() {
        return;
    }
    let mut run = Replay::start("usb-deploy-and-run-ccc").await;
    connect_usb_and_check_folder(&mut run).await;
    let subscription = run.call("programs/subscribe", json!({"brick": CCC})).await;
    assert_eq!(subscription["state"]["running"], false);
    assert_eq!(subscription["state"]["runSeq"], 0);
    let program = format!("{DIR}/Wait.rbf");
    let deployed = run
        .call(
            "programs/deployAndRun",
            json!({"brick": CCC, "files": [{"remotePath": program, "content": WAIT_RBF}],
                   "runPath": program}),
        )
        .await;
    assert_eq!(deployed["outcome"], "started", "{deployed}");
    assert_eq!(deployed["runSeq"], 1);
    assert_eq!(deployed["uploaded"], json!([program]));
    assert_eq!(deployed["skipped"], json!([]));
    let heard = run
        .notes_of("programs/stateChanged", 2, Duration::from_secs(30))
        .await;
    assert_eq!(
        states(&heard),
        [(1, true, None), (1, false, Some("brick".to_string()))],
        "{heard:?}"
    );
    run.call(
        "subscriptions/cancel",
        json!({"subscriptionId": subscription["subscriptionId"]}),
    )
    .await;
    run.call(
        "files/remove",
        json!({"brick": CCC, "path": DIR, "recursive": true}),
    )
    .await;
    run.call("bricks/disconnect", json!({"brick": CCC})).await;
    run.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn usb_programs_run_stop_and_status_in_matched_replay() {
    if common::refuses_this_process() {
        return;
    }
    // Matched: a program subscription's follower polls the status on a timer, with the bytes a
    // request's own status check sends; on a slow runner it fires more often than when recorded (#12).
    let mut run = Replay::start_as("usb-programs-ccc", false).await;
    programs_run_stop_and_status(&mut run, 0).await;
    let root = run.end().await;
    let runs: Value = serde_json::from_str(
        &std::fs::read_to_string(root.channel_dir("t").join("runs.json")).expect("runs.json"),
    )
    .expect("json");
    assert_eq!(runs["bricks"][CCC_ID], 1, "{runs}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_counts_run_seq_on_from_the_runs_json_the_previous_one_left() {
    if common::refuses_this_process() {
        return;
    }
    let left = format!("{{\"bricks\":{{\"{CCC_ID}\":41,\"001653F00B0B\":7}}}}");
    let mut run = Replay::start_seeded_as("usb-programs-ccc", false, &[("runs.json", left)]).await;
    programs_run_stop_and_status(&mut run, 41).await;
    let root = run.end().await;
    let runs: Value = serde_json::from_str(
        &std::fs::read_to_string(root.channel_dir("t").join("runs.json")).expect("runs.json"),
    )
    .expect("json");
    assert_eq!(
        runs["bricks"],
        json!({CCC_ID: 42, "001653F00B0B": 7}),
        "the next daemon counts on from 42, and other bricks keep theirs"
    );
}

/// The `usb-programs-ccc` scenario: a program written, started, stopped and its state read, on a
/// brick whose last start before this daemon was `before`.
async fn programs_run_stop_and_status(run: &mut Replay, before: u64) {
    connect_usb_and_check_folder(run).await;
    let program = format!("{DIR}/Wait.rbf");
    run.call("files/makeDirectory", json!({"brick": CCC, "path": DIR}))
        .await;
    let written = run
        .call(
            "files/write",
            json!({"brick": CCC, "path": program, "content": WAIT_RBF}),
        )
        .await;
    assert_eq!(written, json!({"bytes": 36}));
    let subscription = run.call("programs/subscribe", json!({"brick": CCC})).await;
    assert_eq!(subscription["state"]["runSeq"], before);
    // A start the daemon did not send itself: how it ended is not known here.
    assert_eq!(
        subscription["state"]["endedBy"],
        Value::Null,
        "{subscription}"
    );
    let started = run
        .call("programs/run", json!({"brick": CCC, "path": program}))
        .await;
    assert_eq!(started["outcome"], "started", "{started}");
    assert_eq!(started["runSeq"], before + 1);
    assert_eq!(started["uploaded"], json!([]));
    let stopped = run.call("programs/stop", json!({"brick": CCC})).await;
    assert_eq!(stopped["running"], false, "{stopped}");
    assert_eq!(stopped["runSeq"], before + 1);
    assert_eq!(stopped["endedBy"], CLIENT);
    let status = run.call("programs/status", json!({"brick": CCC})).await;
    assert_eq!(status, stopped);
    let heard = run
        .notes_of("programs/stateChanged", 2, Duration::from_secs(10))
        .await;
    assert_eq!(
        states(&heard),
        [
            (before + 1, true, None),
            (before + 1, false, Some(CLIENT.to_string()))
        ],
        "{heard:?}"
    );
    run.call(
        "subscriptions/cancel",
        json!({"subscriptionId": subscription["subscriptionId"]}),
    )
    .await;
    run.call(
        "files/remove",
        json!({"brick": CCC, "path": DIR, "recursive": true}),
    )
    .await;
    run.call("bricks/disconnect", json!({"brick": CCC})).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn usb_cut_upload_fails_the_write_and_the_brick_comes_back_in_matched_replay() {
    if common::refuses_this_process() {
        return;
    }
    // Matched: where the cut lands is a race between the second client and the packets in
    // flight, so no replay cuts at the recorded packet.
    let mut run = Replay::start_as("usb-cut-upload-ccc", false).await;
    connect_usb_and_check_folder(&mut run).await;
    run.call("files/makeDirectory", json!({"brick": CCC, "path": DIR}))
        .await;
    let content = repeated(200_000);
    let begun = run.call("transfer/begin", json!({"size": 200_000})).await;
    let handle = begun["handle"].clone();
    let step = 16_384.min(begun["chunkBytes"].as_u64().expect("chunk") as usize);
    for chunk in content.as_bytes().chunks(step) {
        run.call(
            "transfer/write",
            json!({"handle": handle, "data": base64(chunk)}),
        )
        .await;
    }
    let mut other = run.other_client().await;
    let writing = run
        .client
        .send_request(
            "files/write",
            json!({"brick": CCC, "path": format!("{DIR}/big.txt"), "handle": handle}),
        )
        .await;
    // Earlier than the recording's 300 ms: a replay serves each packet as fast as the brick
    // answered it, and a cut after the last recorded packet would fail the write on a missing
    // answer instead, a lost link rather than a sign-out. 100 ms lands inside the 63 recorded
    // packets on a fast host and on one whose timers step in 15 ms.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let cut = other
        .request(
            "bricks/disconnect",
            json!({"brick": CCC, "forEveryone": true}),
        )
        .await
        .expect("answered");
    assert_eq!(cut["result"]["stillHeldBy"], json!([]), "{cut}");
    let failed = run.client.answer_to(writing).await.expect("answered");
    assert!(
        failed.get("error").is_some(),
        "the write must not finish across the cut: {failed}"
    );
    drop(other);

    // A link lost under the write can take the channel with it until discovery lists the brick
    // again; the script waits for that too before it connects.
    run.until_available("usb").await;
    run.call("bricks/connect", json!({"brick": CCC})).await;
    let listing = run
        .call("files/list", json!({"brick": CCC, "path": DIR}))
        .await;
    assert_eq!(
        listing["entries"],
        json!([{"bytes": 64_021, "kind": "file", "md5": "a66ea6a41f58954b5d57831ac21f31de",
                "name": "big.txt"}]),
        "what the recorded cut left on the brick"
    );
    let removed = run
        .call(
            "files/remove",
            json!({"brick": CCC, "path": DIR, "recursive": true}),
        )
        .await;
    assert_eq!(removed["leftBehind"], json!([]));
    run.call("bricks/disconnect", json!({"brick": CCC})).await;
    run.end().await;
}

/// The bytes the follow scenario writes while it follows the file.
const FOLLOW_BYTES: usize = 10_000;

#[tokio::test(flavor = "multi_thread")]
async fn usb_follow_hands_over_every_byte_in_order_and_ends_when_the_file_goes_in_matched_replay() {
    if common::refuses_this_process() {
        return;
    }
    // Matched: how many polls find nothing depends on the host's pace, not on the scenario.
    let mut run = Replay::start_as("usb-follow-bbb", false).await;
    const BBB: &str = "BBB";
    let file = format!("{DIR}/out.txt");
    run.find_named("usb", BBB).await;
    run.call("bricks/connect", json!({"brick": BBB})).await;
    // A path the brick would cut (61 bytes; its folder alone passes) is refused at once, not
    // polled in vain: nothing of it reaches the brick.
    let long = format!("{DIR}/AVeryLongName/{}", "x".repeat(61 - DIR.len() - 15));
    assert_eq!(long.len(), 61);
    let refused = run
        .answer("files/follow", json!({"brick": BBB, "path": long}))
        .await;
    assert_eq!(
        refused["error"]["data"]["code"], "invalid_request",
        "{refused}"
    );
    let exists = run
        .call("files/exists", json!({"brick": BBB, "path": DIR}))
        .await;
    assert_eq!(exists["exists"], false);
    run.call("files/makeDirectory", json!({"brick": BBB, "path": DIR}))
        .await;
    run.call(
        "files/write",
        json!({"brick": BBB, "path": file, "content": ""}),
    )
    .await;
    let follow = run
        .call(
            "files/follow",
            json!({"brick": BBB, "path": file, "fromOffset": 0}),
        )
        .await;
    assert_eq!(
        (follow["offset"].clone(), follow["size"].clone()),
        (json!(0), json!(0))
    );
    let id = follow["subscriptionId"].clone();

    let content = repeated(FOLLOW_BYTES);
    let begun = run
        .call("transfer/begin", json!({"size": FOLLOW_BYTES}))
        .await;
    let handle = begun["handle"].clone();
    run.call(
        "transfer/write",
        json!({"handle": handle, "data": base64(content.as_bytes())}),
    )
    .await;
    run.call(
        "files/write",
        json!({"brick": BBB, "path": file, "handle": handle}),
    )
    .await;

    // Every byte, in order, each files/appended starting where the last one ended.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut followed = Vec::new();
    while followed.len() < FOLLOW_BYTES && Instant::now() < deadline {
        let appended = run
            .notes_of("files/appended", usize::MAX, Duration::from_millis(200))
            .await;
        followed.clear();
        for note in &appended {
            assert_eq!(note["subscriptionId"], id);
            assert_eq!(note["offset"], json!(followed.len()), "{note}");
            followed.extend(
                ev3_contract::base64::decode(note["data"].as_str().unwrap(), "data").unwrap(),
            );
        }
    }
    assert_eq!(
        String::from_utf8_lossy(&followed),
        content,
        "every byte, in order"
    );

    run.call("files/remove", json!({"brick": BBB, "path": file}))
        .await;
    let ended = run
        .notes_of("files/followEnded", 1, Duration::from_secs(15))
        .await;
    assert_eq!(ended, [json!({"subscriptionId": id, "reason": "removed"})]);
    run.call(
        "files/remove",
        json!({"brick": BBB, "path": DIR, "recursive": true}),
    )
    .await;
    run.call("bricks/disconnect", json!({"brick": BBB})).await;
    run.end().await;
}

/// The rows the telemetry scenario asked for.
const TELEMETRY_ROWS: [&str; 3] = [
    "program.user.running",
    "system.battery.voltage",
    "system.battery.level",
];
/// The updates the recorded minute delivered, from 60 reads; the 60th read was in flight at the end.
const TELEMETRY_UPDATES: usize = 59;

#[tokio::test(flavor = "multi_thread")]
async fn usb_telemetry_minute_replays_strictly_at_the_recorded_pace() {
    if common::refuses_this_process() {
        return;
    }
    // The throttle slows a row whose reads take long at the tail. On the recording host it never
    // acted, so every read came at 1000 ms; a replay host's coarser timers (Windows sleeps in
    // steps of about 15 ms) can look slow to it and stretch the minute. Off, the replay keeps the
    // recorded pace.
    let mut run = Replay::start_with_settings(
        "usb-telemetry-minute-ccc",
        true,
        Some(json!({"telemetry.throttle.enabled": false})),
    )
    .await;
    run.find_brick("usb").await;
    run.call("bricks/connect", json!({"brick": CCC})).await;
    let rows = run.call("telemetry/rows", json!({})).await;
    let ids: Vec<&str> = rows["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .filter_map(|r| r["id"].as_str())
        .filter(|id| id.contains("battery") || id.contains("program"))
        .collect();
    assert_eq!(ids, TELEMETRY_ROWS, "the rows the script took");
    let subscription = run
        .call(
            "telemetry/subscribe",
            json!({"brick": CCC, "request": {"rows": TELEMETRY_ROWS, "intervalMs": 1000}}),
        )
        .await;
    for row in TELEMETRY_ROWS {
        assert_eq!(
            subscription["grant"][row],
            json!({"kind": "interval", "ms": 1000})
        );
    }
    assert_eq!(subscription["snapshot"], json!([]));
    let updates = run
        .notes_of(
            "telemetry/update",
            TELEMETRY_UPDATES,
            Duration::from_secs(90),
        )
        .await;
    assert_eq!(updates.len(), TELEMETRY_UPDATES);
    for update in &updates {
        for value in update["values"].as_array().into_iter().flatten() {
            let row = value["rowId"].as_str().unwrap_or("");
            assert!(TELEMETRY_ROWS.contains(&row), "{update}");
            assert_eq!(
                value["effectiveRate"],
                json!({"kind": "interval", "ms": 1000}),
                "{update}"
            );
            if row == "system.battery.voltage" {
                let volts = value["value"].as_f64().expect("volts");
                assert!((7.0..9.0).contains(&volts), "{update}");
            }
        }
    }
    // The read after the last update, in flight when the recorded subscription ended.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    run.call(
        "subscriptions/cancel",
        json!({"subscriptionId": subscription["subscriptionId"]}),
    )
    .await;
    run.call("bricks/disconnect", json!({"brick": CCC})).await;
    run.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_strict_replay_that_stops_short_ends_the_daemon_with_code_1_naming_the_first_call_left() {
    if common::refuses_this_process() {
        return;
    }
    let mut run = Replay::start("usb-info-storage-listing-ccc").await;
    run.find_brick("usb").await;
    run.call("bricks/connect", json!({"brick": CCC})).await;
    // bricks/info, storage, the listing, exists and the disconnect are never asked for.
    let id = run.client.send_request("daemon/exit", json!({})).await;
    let question = run.client.question().await.expect("asked");
    run.client.reply(&question, json!({"answer": "yes"})).await;
    run.client.answer_to(id).await.expect("answered");
    let status = run
        .daemon
        .wait_exit(Duration::from_secs(20))
        .expect("the daemon ends");
    assert_eq!(status.code(), Some(1), "{status}");
    let log =
        std::fs::read_to_string(run.root.channel_dir("t").join("daemon.log")).unwrap_or_default();
    assert!(
        log.contains("Strict replay ended with") && log.contains("recorded calls not made"),
        "{log}"
    );
}
