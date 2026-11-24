//! A stand-in agent host for the tests of `ev3 mcp setup` (#16), copied as `claude` and `codex`.
//! It answers `mcp get`, `mcp add` and `mcp remove` as the real one does, keeping its one entry in
//! `$EV3_FAKE_HOST_STATE/<name>.json` and every command line it got in `<name>.log`.

use std::io::Write;
use std::path::PathBuf;

use serde_json::{Value, json};

fn main() {
    let me = std::env::current_exe().expect("exe");
    let name = me
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_owned();
    let state = PathBuf::from(std::env::var_os("EV3_FAKE_HOST_STATE").expect("state folder"));
    let entry_file = state.join(format!("{name}.json"));
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(mut log) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.join(format!("{name}.log")))
    {
        let _ = writeln!(log, "{}", args.join(" "));
    }
    let entry: Option<Value> = std::fs::read_to_string(&entry_file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["mcp", "get", rest @ ..] => {
            let json = rest.contains(&"--json");
            let Some(entry) = entry else {
                eprintln!("No MCP server named \"ev3\" found.");
                std::process::exit(1);
            };
            if json {
                println!(
                    "{}",
                    json!({ "name": "ev3", "transport": { "type": "stdio",
                        "command": entry["command"], "args": entry["args"] } })
                );
            } else {
                let args: Vec<&str> = entry["args"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                println!(
                    "ev3:\n  Scope: User config\n  Type: stdio\n  Command: {}\n  Args: {}\n  Environment:\n",
                    entry["command"].as_str().unwrap_or(""),
                    args.join(" ")
                );
            }
        }
        ["mcp", "add", ..] => {
            let at = words.iter().position(|w| *w == "--").expect("--");
            let command = words[at + 1];
            let rest = &words[at + 2..];
            std::fs::write(
                &entry_file,
                json!({ "command": command, "args": rest }).to_string(),
            )
            .expect("write");
        }
        ["mcp", "remove", ..] => {
            if std::fs::remove_file(&entry_file).is_err() {
                eprintln!("No MCP server named \"ev3\" found.");
                std::process::exit(1);
            }
        }
        _ => std::process::exit(2),
    }
}
