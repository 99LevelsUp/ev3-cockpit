//! `ev3 mcp setup` against stand-in agent hosts (`examples/mcp-host-fake.rs`) on a PATH of the
//! test's own, so no real Claude Code or Codex configuration is read or changed.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

mod common;
use common::ev3;

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("ev3-setup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["bin", "state", "home"] {
            std::fs::create_dir_all(dir.join(sub)).expect("dirs");
        }
        Self(dir)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `ev3 mcp setup <flags> --json` with only `dir/bin` on PATH; its answer and exit code.
fn setup(dir: &Path, flags: &[&str]) -> (Value, i32) {
    let output = Command::new(ev3())
        .args(["mcp", "setup"])
        .args(flags)
        .arg("--json")
        .env("PATH", dir.join("bin"))
        .env("EV3_FAKE_HOST_STATE", dir.join("state"))
        .env("EV3_COCKPIT_CHANNEL", "mcpsetup")
        .env("LOCALAPPDATA", dir.join("home"))
        .env("XDG_STATE_HOME", dir.join("home"))
        .output()
        .expect("ev3 runs");
    let value = serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "JSON from ev3 mcp setup: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    (value, output.status.code().unwrap_or(-1))
}

/// The result `ev3 mcp setup` gave for each host, as (Claude Code, Codex).
fn results(answer: &Value) -> (String, String) {
    let of = |host: &str| {
        answer["hosts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|h| h["host"] == host)
            .and_then(|h| h["result"].as_str())
            .unwrap_or("")
            .to_owned()
    };
    (of("Claude Code"), of("Codex"))
}

fn entry(dir: &Path, host: &str) -> Option<Value> {
    std::fs::read_to_string(dir.join("state").join(format!("{host}.json")))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
}

#[test]
fn setup_registers_this_ev3_in_each_host_once_leaves_another_entry_and_removes_its_own() {
    let host = ev3()
        .parent()
        .expect("folder")
        .join("examples")
        .join(format!("mcp-host-fake{}", std::env::consts::EXE_SUFFIX));
    assert!(
        host.is_file(),
        "examples/mcp-host-fake is built: cargo test -p ev3-cli builds it ({})",
        host.display()
    );
    let dir = Dir::new("hosts");

    // No host installed: nothing to do, and that is no failure.
    let (answer, code) = setup(&dir.0, &[]);
    assert_eq!(code, 0, "{answer}");
    assert_eq!(
        results(&answer),
        ("notInstalled".into(), "notInstalled".into())
    );

    for name in ["claude", "codex"] {
        let copy = dir
            .0
            .join("bin")
            .join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        std::fs::copy(&host, copy).expect("copy");
    }
    let (answer, code) = setup(&dir.0, &[]);
    assert_eq!(code, 0, "{answer}");
    assert_eq!(results(&answer), ("added".into(), "added".into()));
    let command = answer["command"].as_str().expect("command").to_owned();
    for name in ["claude", "codex"] {
        let registered = entry(&dir.0, name).expect("registered");
        assert_eq!(registered["command"], command.as_str(), "{name}");
        assert_eq!(registered["args"], serde_json::json!(["mcp"]), "{name}");
    }
    // The command is this ev3 itself, by its absolute path, not a launcher.
    let ours = std::fs::canonicalize(ev3()).expect("ev3");
    assert_eq!(
        std::fs::canonicalize(&command).expect("registered path"),
        ours
    );
    let claude_log =
        std::fs::read_to_string(dir.0.join("state").join("claude.log")).expect("claude log");
    assert!(
        claude_log.contains("mcp add --scope user ev3 --"),
        "Claude Code for the user: {claude_log}"
    );

    let (answer, _) = setup(&dir.0, &[]);
    assert_eq!(results(&answer), ("already".into(), "already".into()));

    // Another program registered as ev3 is not replaced unless asked.
    let other = r#"{"command":"other-ev3","args":["serve"]}"#;
    std::fs::write(dir.0.join("state").join("codex.json"), other).expect("other");
    let (answer, code) = setup(&dir.0, &[]);
    assert_eq!(code, 0, "{answer}");
    assert_eq!(results(&answer), ("already".into(), "leftAsItIs".into()));
    assert_eq!(
        entry(&dir.0, "codex").expect("kept")["command"],
        "other-ev3"
    );
    let (answer, _) = setup(&dir.0, &["--replace"]);
    assert_eq!(results(&answer).1, "replaced");
    assert_eq!(
        entry(&dir.0, "codex").expect("ours")["command"],
        command.as_str()
    );

    let (answer, code) = setup(&dir.0, &["--remove"]);
    assert_eq!(code, 0, "{answer}");
    assert_eq!(results(&answer), ("removed".into(), "removed".into()));
    assert!(entry(&dir.0, "claude").is_none() && entry(&dir.0, "codex").is_none());
    let (answer, _) = setup(&dir.0, &["--remove"]);
    assert_eq!(
        results(&answer),
        ("notRegistered".into(), "notRegistered".into())
    );
}
