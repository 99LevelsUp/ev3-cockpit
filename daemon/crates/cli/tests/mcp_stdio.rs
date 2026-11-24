//! `ev3 mcp` driven over stdio the way an MCP host drives it: newline-delimited JSON-RPC, the
//! host's answers to the server's own requests (`roots/list`), and a replay daemon on a test
//! channel of its own, so nothing touches the user's daemon or hardware.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

mod common;
use common::{daemon_beside_ev3 as daemon_binary, ev3, fixture};

/// A private state home for one test: the platform's state variable points into it.
struct Home(PathBuf);

impl Home {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("ev3-mcp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("home");
        Self(dir)
    }

    fn state_root(&self) -> PathBuf {
        self.0.join("ev3-cockpit").join("native")
    }

    fn apply(&self, command: &mut Command, channel: &str) {
        command
            .env("EV3_COCKPIT_CHANNEL", channel)
            .env("LOCALAPPDATA", &self.0)
            .env("XDG_STATE_HOME", &self.0)
            .env_remove("XDG_RUNTIME_DIR");
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A replay daemon on `channel` in `home`, killed when dropped.
struct Daemon(Child);

impl Daemon {
    fn start(home: &Home, channel: &str, scenario: &str) -> Option<Self> {
        let binary = daemon_binary()?;
        let mut command = Command::new(binary);
        command
            .args(["--channel", channel, "--state-root"])
            .arg(home.state_root())
            .args(["--mode", "replay", "--fixtures"])
            .arg(fixture(scenario))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        home.apply(&mut command, channel);
        let child = command.spawn().expect("the daemon starts");
        // It is serving once its channel record names it. A daemon killed before it leaves its
        // record behind, so the record existing is not enough: until the new one writes its own,
        // a client finds no daemon and would try to start one itself.
        let record = if channel.is_empty() {
            home.state_root().join("channel.json")
        } else {
            home.state_root()
                .join("channels")
                .join(channel)
                .join("channel.json")
        };
        let ours = || {
            std::fs::read_to_string(&record)
                .ok()
                .and_then(|text| ev3_channel::record::parse_record(&text))
                .is_some_and(|r| u64::from(r.pid) == u64::from(child.id()))
        };
        let until = Instant::now() + Duration::from_secs(20);
        while !ours() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ours(), "the replay daemon did not come up");
        Some(Self(child))
    }

    fn kill(mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// `ev3 mcp` with its stdio piped.
struct Mcp {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
}

impl Mcp {
    fn start(home: &Home, channel: &str) -> Self {
        let mut command = Command::new(ev3());
        command
            .arg("mcp")
            .current_dir(&home.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        home.apply(&mut command, channel);
        let mut child = command.spawn().expect("ev3 mcp starts");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            lines,
        }
    }

    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").expect("write");
        self.stdin.flush().expect("flush");
    }

    /// The next message from the server, within `wait`.
    fn next(&self, wait: Duration) -> Value {
        let line = self
            .lines
            .recv_timeout(wait)
            .expect("a message from ev3 mcp");
        serde_json::from_str(&line).expect("one JSON message per line")
    }

    /// The answer to request `id`, answering the server's own requests with `on_request`.
    fn answer(&mut self, id: u64, mut on_request: impl FnMut(&Value) -> Value) -> Value {
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            let left = until.saturating_duration_since(Instant::now());
            let message = self.next(left);
            if message.get("method").is_some() && message.get("id").is_some() {
                let reply = on_request(&message);
                self.send(reply);
                continue;
            }
            if message.get("id") == Some(&json!(id)) {
                return message;
            }
        }
    }

    fn initialize(&mut self, capabilities: Value) {
        self.send(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": capabilities,
                "clientInfo": { "name": "MCP test agent", "version": "1" },
            }}),
        );
        let answer = self.answer(1, |_| Value::Null);
        assert_eq!(answer["result"]["serverInfo"]["name"], "ev3-cockpit");
        self.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    }

    fn call(
        &mut self,
        id: u64,
        tool: &str,
        arguments: Value,
        on_request: impl FnMut(&Value) -> Value,
    ) -> Value {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": tool, "arguments": arguments } }));
        self.answer(id, on_request)["result"].clone()
    }

    fn end(mut self) -> std::process::ExitStatus {
        drop(self.stdin);
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().expect("wait") {
                return status;
            }
            assert!(
                Instant::now() < until,
                "ev3 mcp did not end after its input closed"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn error_code(result: &Value) -> &str {
    result["structuredContent"]["error"]["code"]
        .as_str()
        .unwrap_or("")
}

fn reply(request: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": request["id"], "result": result })
}

#[test]
fn a_host_that_has_roots_but_does_not_answer_for_them_gets_no_local_path() {
    let home = Home::new("roots-fail");
    let mut mcp = Mcp::start(&home, "mcproots");
    mcp.initialize(json!({ "roots": { "listChanged": false } }));
    let write =
        json!({ "brick": "CCC", "path": "/home/root/lms2012/prjs/x.txt", "localPath": "a.txt" });
    std::fs::write(home.0.join("a.txt"), b"x").expect("file");

    // An error answer to roots/list: refused, not the working directory.
    let result = mcp.call(2, "write_file", write.clone(), |request| {
        assert_eq!(request["method"], "roots/list");
        json!({ "jsonrpc": "2.0", "id": request["id"], "error": { "code": -32603, "message": "no roots" } })
    });
    assert_eq!(result["isError"], true, "{result}");
    assert_eq!(error_code(&result), "roots_unavailable", "{result}");

    // An answer that is not a roots list: refused too.
    let result = mcp.call(3, "write_file", write, |request| {
        reply(request, json!({ "something": 1 }))
    });
    assert_eq!(error_code(&result), "roots_unavailable", "{result}");
    assert!(mcp.end().success());
}

#[test]
fn a_path_outside_the_declared_roots_is_refused() {
    let home = Home::new("roots-outside");
    let inside = home.0.join("inside");
    std::fs::create_dir_all(&inside).expect("inside");
    std::fs::write(home.0.join("outside.txt"), b"x").expect("outside");
    let root_uri = file_uri(&std::fs::canonicalize(&inside).expect("canonical"));
    let mut mcp = Mcp::start(&home, "mcpout");
    mcp.initialize(json!({ "roots": {} }));
    let result = mcp.call(2, "write_file",
        json!({ "brick": "CCC", "path": "/home/root/x.txt", "localPath": home.0.join("outside.txt") }),
        |request| reply(request, json!({ "roots": [{ "uri": root_uri, "name": "inside" }] })));
    assert_eq!(error_code(&result), "path_outside_roots", "{result}");
    assert!(mcp.end().success());
}

#[test]
fn an_agent_replaces_a_local_file_only_when_it_asks_to_and_is_told_what_replaces_files() {
    let home = Home::new("replace");
    let channel = "mcpreplace";
    let Some(_daemon) = Daemon::start(&home, channel, "service/usb-info-storage-listing-ccc") else {
        eprintln!("skipped: build ev3-cockpitd first (npm run daemon:build)");
        return;
    };
    let mut mcp = Mcp::start(&home, channel);
    mcp.initialize(json!({}));
    mcp.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }));
    let tools = mcp.answer(2, |_| Value::Null)["result"]["tools"]
        .as_array()
        .cloned()
        .expect("tools");
    let tool = |name: &str| tools.iter().find(|t| t["name"] == name).cloned().expect(name);
    for name in ["write_file", "deploy_and_run"] {
        assert_eq!(tool(name)["annotations"]["destructiveHint"], true, "{name}");
    }
    for name in ["read_file", "move_file"] {
        let t = tool(name);
        assert_eq!(t["inputSchema"]["properties"]["replace"]["default"], false, "{name}");
        assert_eq!(t["annotations"]["destructiveHint"], false, "{name}");
    }

    // The working directory is the agent's folder; the file there is the person's.
    let kept = home.0.join("kept.txt");
    std::fs::write(&kept, b"the person's file").expect("file");
    let result = mcp.call(3, "read_file",
        json!({ "brick": "CCC", "path": "/home/root/lms2012/prjs/x.txt", "localPath": kept }),
        |_| Value::Null);
    assert_eq!(result["isError"], true, "{result}");
    assert_eq!(error_code(&result), "file_exists", "{result}");
    assert!(
        result["structuredContent"]["next"].as_str().unwrap_or("").contains("replace: true"),
        "the agent is told how to replace it: {result}"
    );
    assert_eq!(std::fs::read(&kept).expect("read"), b"the person's file");
    assert!(mcp.end().success());
}

/// `file:` URI of an absolute local path, as an MCP host sends it.
fn file_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_start_matches("//?/");
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    }
}

#[test]
fn tools_answer_against_a_replay_and_the_agents_brick_comes_back_after_the_daemon_went() {
    let home = Home::new("replay");
    let channel = "mcpreplay";
    let Some(daemon) = Daemon::start(&home, channel, "service/usb-info-storage-listing-ccc") else {
        eprintln!("skipped: build ev3-cockpitd first (npm run daemon:build)");
        return;
    };
    let mut mcp = Mcp::start(&home, channel);
    mcp.initialize(json!({}));

    mcp.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }));
    let tools = mcp.answer(2, |_| Value::Null)["result"]["tools"]
        .as_array()
        .cloned()
        .expect("tools");
    assert_eq!(tools.len(), 24);
    assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));

    let connected = mcp.call(3, "connect_brick", json!({ "brick": "CCC" }), |_| {
        Value::Null
    });
    assert_eq!(
        connected["structuredContent"]["brick"]["name"], "CCC",
        "{connected}"
    );
    let holders = |result: &Value| -> Vec<String> {
        result["structuredContent"]["bricks"][0]["holders"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|h| h["client"].as_str().map(str::to_owned))
            .collect()
    };
    let listed = mcp.call(4, "list_bricks", json!({}), |_| Value::Null);
    assert_eq!(holders(&listed), vec!["MCP test agent"], "{listed}");

    // The daemon goes; a new one comes. No daemon hands anything to the next: the agent's brick is
    // connected again on the first tool call that reaches the new daemon.
    daemon.kill();
    std::thread::sleep(Duration::from_millis(500));
    let _daemon =
        Daemon::start(&home, channel, "service/usb-info-storage-listing-ccc").expect("again");
    let listed = mcp.call(5, "list_bricks", json!({}), |_| Value::Null);
    assert_eq!(holders(&listed), vec!["MCP test agent"], "{listed}");
    assert!(mcp.end().success());
}
