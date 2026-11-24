//! `ev3` as a person or a script runs it: its own process, stdin not a terminal, against a replay
//! daemon on a test channel of its own, so nothing touches the user's daemon or hardware. The
//! cases check what a script relies on: the exit code, the `--json` shapes, and that what needs a
//! person's yes is refused without one and changes nothing.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use ev3_channel::paths::Paths;
use serde_json::{Value, json};

mod common;
use common::{ev3, fixture};

fn daemon_name() -> &'static str {
    if cfg!(windows) {
        "ev3-cockpitd.exe"
    } else {
        "ev3-cockpitd"
    }
}

fn sha256(file: &Path) -> String {
    use sha2::Digest as _;
    let bytes = std::fs::read(file).expect("daemon binary");
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn write_manifest(dir: &Path, sha: &str) {
    let manifest = json!({
        "binary": daemon_name(), "sha256": sha,
        "version": env!("EV3_COCKPIT_VERSION"), "buildKind": "development",
    });
    // Tests run in parallel: write beside, then rename, so no reader sees half a file.
    let file = dir.join("ev3-cockpitd.manifest.json");
    static WRITES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let part = dir.join(format!(
        "ev3-cockpitd.manifest.{}-{n}.part",
        std::process::id()
    ));
    std::fs::write(&part, format!("{manifest:#}\n")).expect("manifest");
    std::fs::rename(&part, &file).expect("manifest in place");
}

/// The daemon cargo built beside `ev3`, with a manifest that matches it now; `None` when it was
/// not built or would not run for this process (see `common::daemon_beside_ev3`).
fn daemon_binary() -> Option<PathBuf> {
    let Some(daemon) = common::daemon_beside_ev3() else {
        eprintln!("skipped: build ev3-cockpitd first (npm run daemon:build)");
        return None;
    };
    write_manifest(daemon.parent()?, &sha256(&daemon));
    Some(daemon)
}

/// A private state home for one test: the platform's state variable points into it.
struct Home {
    dir: PathBuf,
    channel: String,
}

impl Home {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("ev3-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("home");
        Self {
            dir,
            channel: format!("cli{}", name.replace('-', "")),
        }
    }

    fn state_root(&self) -> PathBuf {
        self.dir.join("ev3-cockpit").join("native")
    }

    fn paths(&self) -> Paths {
        Paths::new(&self.state_root(), Some(&self.channel))
    }

    fn apply(&self, command: &mut Command) {
        command
            .env("EV3_COCKPIT_CHANNEL", &self.channel)
            .env("LOCALAPPDATA", &self.dir)
            .env("XDG_STATE_HOME", &self.dir)
            .env_remove("XDG_RUNTIME_DIR");
    }

    /// `program args...`, run to its end with stdin closed.
    fn run_with(&self, program: &Path, args: &[&str]) -> Run {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(&self.dir)
            .stdin(Stdio::null());
        self.apply(&mut command);
        let output = command.output().expect("ev3 runs");
        Run {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    fn ev3(&self, args: &[&str]) -> Run {
        self.run_with(&ev3(), args)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Run {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Run {
    fn json(&self) -> Value {
        serde_json::from_str(&self.stdout).unwrap_or_else(|_| {
            panic!(
                "not JSON (exit {:?}): {}{}",
                self.code, self.stdout, self.stderr
            )
        })
    }

    fn error(&self) -> Value {
        self.json()["error"].clone()
    }

    fn expect(&self, code: i32) -> &Self {
        assert_eq!(
            self.code,
            Some(code),
            "stdout: {}\nstderr: {}",
            self.stdout,
            self.stderr
        );
        self
    }
}

/// A replay daemon on the home's channel, killed when dropped.
struct Daemon(Child);

impl Daemon {
    fn start(home: &Home, scenario: &str) -> Option<Self> {
        let binary = daemon_binary()?;
        let mut command = Command::new(binary);
        command
            .args(["--channel", &home.channel, "--state-root"])
            .arg(home.state_root())
            .args(["--mode", "replay", "--fixtures"])
            .arg(fixture(scenario))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        home.apply(&mut command);
        let child = command.spawn().expect("the daemon starts");
        let record = home.paths().record;
        let until = Instant::now() + Duration::from_secs(20);
        while !record.exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(record.exists(), "the replay daemon did not come up");
        Some(Self(child))
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn names(bricks: &Value) -> Vec<String> {
    bricks
        .as_array()
        .expect("an array of bricks")
        .iter()
        .map(|b| b["name"].as_str().unwrap_or("").to_owned())
        .collect()
}

#[test]
fn a_hold_lasts_past_ev3_connect_shows_in_status_and_ends_with_disconnect() {
    let home = Home::new("hold");
    let Some(_daemon) = Daemon::start(&home, "link/usb-connect-commands-aaa") else {
        return;
    };

    let list = home.ev3(&["--json", "list"]);
    let bricks = list.expect(0).json();
    assert_eq!(names(&bricks), ["AAA"]);
    assert!(
        bricks[0]["channels"].is_array() && bricks[0]["holders"].is_array(),
        "{bricks}"
    );

    let connect = home.ev3(&["--json", "connect", "AAA"]);
    assert_eq!(connect.expect(0).json()["name"], "AAA");
    // A second process sees the hold: ev3 connect ended, the brick stays held.
    let status = home.ev3(&["--json", "status"]).expect(0).json();
    assert_eq!(status["mode"], "replay");
    let held = status["bricks"]
        .as_array()
        .expect("bricks")
        .iter()
        .find(|b| b["name"] == "AAA")
        .cloned();
    assert_eq!(
        held.expect("AAA is held")["holders"],
        json!([{ "kind": "hold" }]),
        "{status}"
    );
    let human = home.ev3(&["status"]);
    let line = human
        .stdout
        .lines()
        .find(|l| l.contains("AAA"))
        .unwrap_or("");
    assert!(line.contains("held by ev3 connect"), "{}", human.stdout);

    home.ev3(&["--json", "disconnect", "AAA"]).expect(0);
    let after = home.ev3(&["--json", "status"]).expect(0).json();
    assert!(
        !after["bricks"]
            .as_array()
            .expect("bricks")
            .iter()
            .any(|b| b["name"] == "AAA"),
        "{after}"
    );
}

#[test]
fn a_command_holds_a_connected_brick_as_it_is_without_connecting_it_again() {
    let home = Home::new("asis");
    let Some(_daemon) = Daemon::start(&home, "service/usb-info-storage-listing-ccc") else {
        return;
    };
    home.ev3(&["--json", "connect", "CCC"]).expect(0);
    // The one connected brick when none is named, then the brick by its name.
    assert_eq!(
        home.ev3(&["--json", "info"]).expect(0).json()["name"],
        "CCC"
    );
    home.ev3(&["--json", "storage", "CCC"]).expect(0);
    // Connecting a connected brick again makes the daemon join every channel it has not
    // connected and wait for them; the log says who connected a brick.
    let log = std::fs::read_to_string(home.paths().log).expect("the daemon's log");
    let again: Vec<&str> = log
        .lines()
        .filter(|l| {
            (l.contains("[ev3 info") || l.contains("[ev3 storage")) && l.contains("] Connected 0")
        })
        .collect();
    assert!(
        again.is_empty(),
        "a command connected the brick again: {again:?}"
    );
    // Each holds it while it works, as it is (#9): a brick used without being held is signed out
    // under the command when its last holder lets go.
    for command in ["[ev3 info", "[ev3 storage"] {
        assert!(
            log.lines()
                .any(|l| l.contains(command) && l.contains("] Holding 0")),
            "{command} did not hold the brick: {log}"
        );
    }
    home.ev3(&["--json", "disconnect", "CCC"]).expect(0);
}
#[test]
fn settings_are_named_by_either_spelling_and_a_wrong_key_or_value_is_a_usage_error() {
    let home = Home::new("config");
    let Some(_daemon) = Daemon::start(&home, "link/usb-connect-commands-aaa") else {
        return;
    };

    let specs: Vec<Value> =
        serde_json::from_str(ev3_contract::SETTING_SPECS_JSON).expect("setting specs");
    for spec in &specs {
        let key = spec["cliKey"].as_str().expect("cliKey");
        let value = match &spec["default"] {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let set = home.ev3(&["--json", "config", "set", key, &value]);
        assert_eq!(
            set.code,
            Some(0),
            "{key} = {value}: {}{}",
            set.stdout,
            set.stderr
        );
    }
    // The contract key reads the same setting as the CLI key.
    let by_cli = home
        .ev3(&["--json", "config", "get", "access-mode"])
        .expect(0)
        .json();
    let by_key = home
        .ev3(&["--json", "config", "get", "accessMode"])
        .expect(0)
        .json();
    assert_eq!(by_cli, by_key);
    assert_eq!(by_cli["value"], "safe");

    for unknown in ["access_mode", "mock", "nope", "telemetry"] {
        let set = home.ev3(&["--json", "config", "set", unknown, "1"]);
        assert_eq!(set.expect(2).error()["code"], "usage", "{unknown}");
    }
    let integer = specs
        .iter()
        .find(|s| s["type"] == "integer")
        .expect("an integer setting");
    let key = integer["cliKey"].as_str().expect("cliKey");
    home.ev3(&["config", "set", key, "2.5"]).expect(2);
    home.ev3(&["config", "set", "access-mode", "wide"])
        .expect(2);
}

#[test]
fn what_needs_a_persons_yes_is_refused_without_a_terminal_names_the_command_and_changes_nothing() {
    let home = Home::new("person");
    let Some(_daemon) = Daemon::start(&home, "link/usb-connect-commands-aaa") else {
        return;
    };

    let set = home.ev3(&["--json", "config", "set", "access-mode", "full"]);
    let error = set.expect(5).error();
    assert_eq!(error["code"], "needs_person");
    assert_eq!(error["command"], "ev3 config set access-mode full");
    assert_eq!(
        home.ev3(&["--json", "config", "get", "access-mode"])
            .expect(0)
            .json()["value"],
        "safe"
    );

    let pid = home.ev3(&["--json", "status"]).expect(0).json()["pid"].clone();
    let restart = home.ev3(&["--json", "daemon", "restart"]);
    assert_eq!(restart.expect(5).error()["command"], "ev3 daemon restart");
    assert_eq!(
        home.ev3(&["--json", "status"]).expect(0).json()["pid"],
        pid,
        "the daemon was not restarted"
    );

    let forget = home.ev3(&["--json", "forget", "AAA"]);
    assert_eq!(forget.expect(5).error()["command"], "ev3 forget AAA");
    assert_eq!(
        names(&home.ev3(&["--json", "list"]).expect(0).json()),
        ["AAA"],
        "AAA was not forgotten"
    );

    // The human form says the same and names the command to run.
    let human = home.ev3(&["forget", "AAA"]);
    human.expect(5);
    assert!(human.stderr.contains("ev3 forget AAA"), "{}", human.stderr);
}

#[test]
fn the_daemon_log_path_needs_no_daemon_and_dropped_flags_are_usage_errors() {
    let home = Home::new("nodaemon");
    // No daemon runs, and none is started: the record never appears.
    let log = home.ev3(&["--json", "daemon", "log"]);
    assert_eq!(
        PathBuf::from(log.expect(0).json()["logPath"].as_str().expect("path")),
        home.paths().log
    );
    for args in [
        &["--channel", "dev", "list"][..],
        &[
            "config",
            "set",
            "access-mode",
            "full",
            "--confirmed-by-person",
        ],
        &["list", "--mock"],
        &["ls", "--recursive"],
    ] {
        let run = home.ev3(args);
        assert_eq!(run.code, Some(2), "{args:?}: {}", run.stderr);
    }
    assert!(!home.paths().record.exists(), "no daemon was started");
}

#[test]
fn help_into_a_pipe_nobody_reads_ends_quietly() {
    // `ev3 help | head -1`: the reader is gone before ev3 writes; that is no failure of ev3.
    let mut child = Command::new(ev3())
        .arg("help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("ev3 runs");
    drop(child.stdout.take());
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .expect("stderr")
        .read_to_string(&mut stderr)
        .expect("read");
    let status = child.wait().expect("ev3 ends");
    assert_eq!(status.code(), Some(0), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
}

#[test]
fn telemetry_names_its_rows_reads_the_ones_named_and_list_takes_nothing_else() {
    let home = Home::new("telemetry");
    let Some(_daemon) = Daemon::start(&home, "service/usb-telemetry-minute-ccc") else {
        return;
    };

    let rows = home
        .ev3(&["--json", "telemetry", "--list"])
        .expect(0)
        .json();
    let ids: Vec<&str> = rows
        .as_array()
        .expect("rows")
        .iter()
        .filter_map(|r| r["id"].as_str())
        .collect();
    assert!(!ids.is_empty(), "{rows}");
    let row = ids
        .iter()
        .find(|id| id.contains("battery"))
        .copied()
        .unwrap_or(ids[0]);

    let reading = home
        .ev3(&["--json", "telemetry", row, "--brick", "CCC"])
        .expect(0)
        .json();
    let mut named: Vec<String> = reading["values"]
        .as_array()
        .expect("values")
        .iter()
        .filter_map(|v| {
            v["row"]
                .as_str()
                .or_else(|| v["id"].as_str())
                .map(str::to_owned)
        })
        .collect();
    named.extend(
        reading["missing"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m.as_str().map(str::to_owned)),
    );
    assert_eq!(named, [row], "only the named row is read: {reading}");

    home.ev3(&["telemetry", "--list", row]).expect(2);
    home.ev3(&["telemetry", "--list", "--watch"]).expect(2);
}

// --- a second client that writes to the brick ---------------------------------------------------

/// A client of the daemon's own, as another program connects: the hello, then requests. Reads and
/// writes on one thread, so a synchronous pipe never blocks a write behind a pending read.
struct RawClient {
    reader: BufReader<Box<dyn Read>>,
    writer: Box<dyn Write>,
    next_id: u64,
}

impl RawClient {
    fn connect(home: &Home, name: &str) -> Self {
        let paths = home.paths();
        let text = std::fs::read_to_string(&paths.record).expect("channel record");
        let record = ev3_channel::record::parse_record(&text).expect("a valid record");
        let (reader, writer): (Box<dyn Read>, Box<dyn Write>) = {
            #[cfg(windows)]
            {
                let pipe = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&record.path)
                    .expect("pipe");
                (Box::new(pipe.try_clone().expect("clone")), Box::new(pipe))
            }
            #[cfg(unix)]
            {
                let socket = std::os::unix::net::UnixStream::connect(&record.path).expect("socket");
                (
                    Box::new(socket.try_clone().expect("clone")),
                    Box::new(socket),
                )
            }
        };
        let mut client = Self {
            reader: BufReader::new(reader),
            writer,
            next_id: 1,
        };
        let key = ev3_channel::key::read_key(&paths.key)
            .map_err(|e| e.0)
            .expect("key");
        let nonce = "0123456789abcdef0123456789abcdef";
        let challenge = client.request(ev3_contract::HELLO_START, json!({
            "clientNonce": nonce, "clientName": name, "clientKind": "vscode",
            "version": env!("EV3_COCKPIT_VERSION"), "contractVersion": ev3_contract::CONTRACT_VERSION,
            "buildKind": "development",
        }));
        let daemon_nonce = challenge["result"]["daemonNonce"]
            .as_str()
            .expect("daemon nonce")
            .to_owned();
        let proof = ev3_contract::hello::client_proof(&key, nonce, &daemon_nonce);
        let accepted = client.request(ev3_contract::HELLO_FINISH, json!({ "clientProof": proof }));
        assert!(accepted.get("result").is_some(), "{accepted}");
        client
    }

    fn send(&mut self, message: &Value) {
        let body = message.to_string();
        write!(self.writer, "Content-Length: {}\r\n\r\n{body}", body.len()).expect("write");
        self.writer.flush().expect("flush");
    }

    fn receive(&mut self) -> Value {
        let mut length = None;
        loop {
            let mut line = String::new();
            assert!(
                self.reader.read_line(&mut line).expect("header") > 0,
                "the daemon closed"
            );
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some(value) = line.strip_prefix("Content-Length:") {
                length = Some(value.trim().parse::<usize>().expect("length"));
            }
        }
        let mut body = vec![0u8; length.expect("Content-Length")];
        self.reader.read_exact(&mut body).expect("body");
        serde_json::from_slice(&body).expect("JSON")
    }

    /// Sends request `method` and answers its id.
    fn start(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        id
    }

    /// The daemon's next message that `pick` accepts; everything else is passed over.
    fn until(&mut self, pick: impl Fn(&Value) -> bool) -> Value {
        loop {
            let message = self.receive();
            if pick(&message) {
                return message;
            }
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.start(method, params);
        self.until(|m| m.get("method").is_none() && m["id"] == json!(id))
    }
}

#[test]
fn a_brick_another_client_writes_to_is_busy_exit_3_naming_the_holder() {
    let home = Home::new("busy");
    let Some(_daemon) = Daemon::start(&home, "link/usb-connect-commands-aaa") else {
        return;
    };

    let mut holder = RawClient::connect(&home, "lease holder");
    // The holder connects AAA first: the recording holds one connect, so the command's own connect
    // finds it connected.
    let connected = holder.request("bricks/connect", json!({ "brick": "AAA" }));
    assert!(connected.get("result").is_some(), "{connected}");
    // A forget holds the brick's write lease while it waits for the person's answer.
    let forget = holder.start("bricks/forget", json!({ "brick": "AAA" }));
    let question = holder.until(|m| m["method"] == "question/ask" && m.get("id").is_some());

    let mkdir = home.ev3(&[
        "--json",
        "mkdir",
        "/home/root/lms2012/prjs/new",
        "--brick",
        "AAA",
    ]);
    let error = mkdir.expect(3).error();
    assert_eq!(error["code"], "brick_busy");
    assert_eq!(error["holder"], "lease holder");

    holder.send(&json!({ "jsonrpc": "2.0", "id": question["id"], "result": { "answer": "no" } }));
    let refused = holder.until(|m| m.get("method").is_none() && m["id"] == json!(forget));
    assert!(
        refused.get("error").is_some(),
        "a no is not a forget: {refused}"
    );
}

// --- a daemon that cannot start ------------------------------------------------------------------

/// `ev3` copied into a folder of its own, with `daemon` beside it when given: what it carries is
/// what the test put there.
fn installation(home: &Home, daemon: Option<&Path>) -> PathBuf {
    let dir = home.dir.join("install");
    std::fs::create_dir_all(&dir).expect("install dir");
    let copy = dir.join(ev3().file_name().expect("name"));
    std::fs::copy(ev3(), &copy).expect("ev3 copy");
    if let Some(daemon) = daemon {
        std::fs::copy(daemon, dir.join(daemon_name())).expect("daemon copy");
    }
    copy
}

#[test]
fn a_daemon_that_does_not_match_its_sha256_is_not_started_exit_8() {
    let home = Home::new("shamismatch");
    let Some(daemon) = daemon_binary() else {
        return;
    };
    let ev3 = installation(&home, Some(&daemon));
    write_manifest(ev3.parent().expect("dir"), &"0".repeat(64));

    let run = home.run_with(&ev3, &["--json", "list"]);
    let error = run.expect(8).error();
    assert_eq!(error["code"], "daemon_unavailable");
    assert_eq!(error["failure"], "sha_mismatch");
    assert!(!home.paths().record.exists(), "no daemon was started");
}

#[test]
fn with_no_daemon_to_start_ev3_exits_8_and_says_how_to_build_it() {
    let home = Home::new("missing");
    let ev3 = installation(&home, None);

    let human = home.run_with(&ev3, &["list"]);
    human.expect(8);
    assert!(
        human.stderr.contains("npm run daemon:build"),
        "{}",
        human.stderr
    );
    let run = home.run_with(&ev3, &["--json", "list"]);
    assert_eq!(run.expect(8).error()["failure"], "missing_binary");
}
