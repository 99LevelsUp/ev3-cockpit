//! A stand-in add-on for the tests of `ev3 mcp`'s add-on tools (#2): an MCP server over stdio,
//! started as `ev3-<name> mcp`. What it does depends on the name it was copied to:
//!
//! - `ev3-fake`: says it speaks the cockpit's contract, and offers `echo` (its arguments and the
//!   `clientInfo` it was given), `roots` (asks `roots/list` in the middle of the call), `slow`
//!   (progress every 100 ms until cancelled; the cancellation is written to `$EV3_FAKE_OUT`) and
//!   `crash` (ends the process during the call);
//! - `ev3-old`: says it speaks cockpit contract 2;
//! - `ev3-mute`: never answers;
//! - `ev3-list`: as `ev3-fake`, so its tool `bricks` is offered as `list_bricks`, a name the
//!   cockpit's own tool has.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

type Out = Arc<Mutex<std::io::Stdout>>;

fn send(out: &Out, message: &Value) {
    let mut out = out.lock().expect("out");
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

fn text(t: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": t }] })
}

fn main() {
    let me = std::env::current_exe().expect("exe");
    let stem = me
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_owned();
    let contract = if stem == "ev3-old" {
        2
    } else {
        u64::from(ev3_contract::CONTRACT_VERSION)
    };
    let out: Out = Arc::new(Mutex::new(std::io::stdout()));
    let answers: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>> = Arc::default();
    let cancelled: Arc<Mutex<HashSet<String>>> = Arc::default();
    let mut client_info = Value::Null;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if stem == "ev3-mute" {
            continue;
        }
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (method, id) {
            ("", Some(id)) => {
                if let Some(tx) = answers.lock().expect("answers").remove(&id.to_string()) {
                    let _ = tx.send(message.get("result").cloned().unwrap_or(Value::Null));
                }
            }
            ("initialize", Some(id)) => {
                client_info = params.get("clientInfo").cloned().unwrap_or(Value::Null);
                send(
                    &out,
                    &json!({ "jsonrpc": "2.0", "id": id, "result": {
                        "protocolVersion": params["protocolVersion"],
                        "capabilities": { "tools": {}, "experimental": { "ev3-cockpit": { "contract": contract } } },
                        "serverInfo": { "name": stem, "version": "0.0.1" },
                    }}),
                );
            }
            ("tools/list", Some(id)) => {
                let schema = json!({ "type": "object", "properties": {} });
                send(
                    &out,
                    &json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [
                        { "name": "echo", "description": "Echo.", "inputSchema": schema,
                          "annotations": { "readOnlyHint": false, "destructiveHint": true } },
                        { "name": "roots", "description": "Roots.", "inputSchema": schema },
                        { "name": "slow", "description": "Slow.", "inputSchema": schema },
                        { "name": "crash", "description": "Crash.", "inputSchema": schema },
                        { "name": "bricks", "description": "As ev3-list, a name the cockpit has.", "inputSchema": schema },
                    ]}}),
                );
            }
            ("tools/call", Some(id)) => {
                let tool = params["name"].as_str().unwrap_or("").to_owned();
                let (out, answers, cancelled, client_info) = (
                    out.clone(),
                    answers.clone(),
                    cancelled.clone(),
                    client_info.clone(),
                );
                std::thread::spawn(move || {
                    call(
                        &tool,
                        &id,
                        &params,
                        &out,
                        &answers,
                        &cancelled,
                        &client_info,
                    );
                });
            }
            ("notifications/cancelled", None) => {
                let request = params["requestId"].to_string();
                cancelled.lock().expect("cancelled").insert(request.clone());
                if let Some(dir) = std::env::var_os("EV3_FAKE_OUT") {
                    let _ =
                        std::fs::write(std::path::Path::new(&dir).join("cancelled.txt"), request);
                }
            }
            (_, Some(id)) => send(
                &out,
                &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "no" } }),
            ),
            _ => {}
        }
    }
}

fn call(
    tool: &str,
    id: &Value,
    params: &Value,
    out: &Out,
    answers: &Mutex<HashMap<String, mpsc::Sender<Value>>>,
    cancelled: &Mutex<HashSet<String>>,
    client_info: &Value,
) {
    let result = match tool {
        "echo" => text(
            &json!({ "arguments": params["arguments"], "clientInfo": client_info }).to_string(),
        ),
        "roots" => {
            let (tx, rx) = mpsc::channel();
            let ask = json!("fake-roots-1");
            answers.lock().expect("answers").insert(ask.to_string(), tx);
            send(
                out,
                &json!({ "jsonrpc": "2.0", "id": ask, "method": "roots/list", "params": {} }),
            );
            let roots = rx
                .recv_timeout(Duration::from_secs(10))
                .unwrap_or(Value::Null);
            text(&roots.to_string())
        }
        "slow" => {
            let token = params["_meta"]["progressToken"].clone();
            let me = id.to_string();
            for step in 0..300 {
                if cancelled.lock().expect("cancelled").contains(&me) {
                    return;
                }
                if !token.is_null() {
                    send(
                        out,
                        &json!({ "jsonrpc": "2.0", "method": "notifications/progress",
                                 "params": { "progressToken": token, "progress": step } }),
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            text("done")
        }
        "crash" => std::process::exit(3),
        _ => text("unknown"),
    };
    send(
        out,
        &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    );
}
