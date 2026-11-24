//! `ev3 mcp`: the cockpit's operations as MCP tools for an agent, over stdio.
//!
//! - Standard output carries MCP messages only, one JSON-RPC message per line; anything else goes
//!   to standard error. The server ends when its MCP client closes standard input.
//! - Nothing reaches the daemon until a tool needs a brick: starting the server and listing its
//!   tools neither starts a daemon nor connects remembered bricks.
//! - The server introduces itself to the daemon by the name its MCP client gave (`clientInfo`), as
//!   kind `mcp`, so a person asked about the agent's request reads which agent it is.
//! - No tool can widen the agent's rights: there is no restart and no exit request, and no tool
//!   carries a person's confirmation. Forgetting a brick, clearing its Bluetooth list and access
//!   mode `full` run only after the daemon asked a person, naming this agent.
//! - Local paths are confined to the roots the MCP client declares, or to the working directory
//!   when it declares none, since the daemon reads and writes them for the agent.
//! - A busy brick, an uncertain start and an operation that needs a person come back as tool
//!   results saying what to do next, never as protocol errors. A notice rides in the next result.
//! - When the daemon went, the next tool connects again and connects this agent's bricks again.
//!   When Windows Smart App Control blocks the daemon, every later tool gets the same answer
//!   without the blocked binary being started again.
//!
//! The tools, their descriptions and input schemas are `mcp_tools.json`, taken verbatim from the
//! TypeScript server this replaces.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use ev3_channel::paths::Paths;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};
use tokio::task::AbortHandle;

use crate::error::{CliError, DAEMON_UNAVAILABLE, Failure};
use crate::install;
use crate::output::{js_string, strings};
use crate::telemetry;
use ev3_client::client::{Client, ClientOptions};

/// The tools as the TypeScript server listed them.
const TOOLS_JSON: &str = include_str!("mcp_tools.json");
/// [`TOOLS_JSON`], read once.
static TOOLS: LazyLock<Vec<Value>> =
    LazyLock::new(|| serde_json::from_str(TOOLS_JSON).unwrap_or_default());
/// How this server introduces itself when its MCP client gave no usable name.
pub const MCP_CLIENT_NAME: &str = "EVƎ Cockpit MCP (agent)";
/// The longest client name the daemon's hello accepts.
const MAX_CLIENT_NAME: usize = 200;
/// The protocol versions this server speaks; the first is the newest.
const PROTOCOL_VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
/// How long `read_telemetry` waits for every row to have a value, unless told otherwise.
const DEFAULT_TELEMETRY_WAIT_MS: u64 = 3000;
const DO_NOT_RUN_AGAIN: &str = "Do not run it again; check program_status first.";

/// A name the daemon's hello accepts: the MCP client's own, trimmed and bounded, else the server's.
pub fn client_name_of(name: Option<&str>) -> String {
    let trimmed = name.unwrap_or("").trim();
    if trimmed.is_empty() {
        return MCP_CLIENT_NAME.to_owned();
    }
    trimmed.chars().take(MAX_CLIENT_NAME).collect()
}

struct Server {
    out: mpsc::UnboundedSender<Value>,
    paths: Paths,
    client_name: Mutex<String>,
    roots_capable: Mutex<bool>,
    client: AsyncMutex<Option<Arc<Client>>>,
    /// Bricks this agent connected: connected again on a new daemon.
    my_bricks: Mutex<HashSet<String>>,
    /// The daemon went and `my_bricks` are not yet connected again on its successor.
    rejoin: AtomicBool,
    blocked: Mutex<Option<CliError>>,
    pending_notices: Mutex<Vec<String>>,
    delivered_notices: Mutex<HashSet<String>>,
    /// Answers to this server's own requests to the MCP client (`roots/list`).
    asked: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    next_ask: AtomicU64,
    running: Mutex<HashMap<String, AbortHandle>>,
}

pub async fn serve(paths: Paths) -> u8 {
    let (out, mut outgoing) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = outgoing.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });
    let server = Arc::new(Server {
        out,
        paths,
        client_name: Mutex::new(MCP_CLIENT_NAME.to_owned()),
        roots_capable: Mutex::new(false),
        client: AsyncMutex::new(None),
        my_bricks: Mutex::new(HashSet::new()),
        rejoin: AtomicBool::new(false),
        blocked: Mutex::new(None),
        pending_notices: Mutex::new(Vec::new()),
        delivered_notices: Mutex::new(HashSet::new()),
        asked: Mutex::new(HashMap::new()),
        next_ask: AtomicU64::new(1),
        running: Mutex::new(HashMap::new()),
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => batch
                .into_iter()
                .for_each(|m| Arc::clone(&server).receive(m)),
            Ok(message) => Arc::clone(&server).receive(message),
            Err(error) => server.send(json!({
                "jsonrpc": "2.0", "id": null,
                "error": { "code": -32700, "message": format!("Parse error: {error}") },
            })),
        }
    }
    for (_, task) in server.running.lock().expect("running").drain() {
        task.abort();
    }
    if let Some(client) = server.client.lock().await.take() {
        client.shutdown().await;
    }
    drop(server);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    0
}

impl Server {
    fn send(&self, message: Value) {
        let _ = self.out.send(message);
    }

    fn receive(self: Arc<Self>, message: Value) {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let id = message.get("id").cloned();
        match (method, id) {
            (None, Some(id)) => {
                let key = js_string(&id);
                if let Some(answer) = self.asked.lock().expect("asked").remove(&key) {
                    // An error answer is no answer: Null, which every asker reads as a failure.
                    let result = match message.get("error") {
                        Some(_) => Value::Null,
                        None => message.get("result").cloned().unwrap_or(Value::Null),
                    };
                    let _ = answer.send(result);
                }
            }
            (Some(method), Some(id)) => {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                match method.as_str() {
                    "initialize" => {
                        let result = self.initialize(&params);
                        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
                    }
                    "ping" => self.send(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
                    "tools/list" => {
                        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": *TOOLS } }));
                    }
                    "tools/call" => {
                        let key = js_string(&id);
                        let server = Arc::clone(&self);
                        let task_key = key.clone();
                        let task = tokio::spawn(async move {
                            let reply = match server.call(&params).await {
                                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                                Err((code, message)) => json!({
                                    "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message },
                                }),
                            };
                            server.running.lock().expect("running").remove(&task_key);
                            server.send(reply);
                        });
                        self.running.lock().expect("running").insert(key, task.abort_handle());
                    }
                    other => self.send(json!({
                        "jsonrpc": "2.0", "id": id,
                        "error": { "code": -32601, "message": format!("Method not found: {other}") },
                    })),
                }
            }
            (Some(method), None) => {
                if method == "notifications/cancelled" {
                    let id = message
                        .get("params")
                        .and_then(|p| p.get("requestId"))
                        .map(js_string);
                    if let Some(task) =
                        id.and_then(|id| self.running.lock().expect("running").remove(&id))
                    {
                        // A cancelled request gets no answer; its daemon request is cancelled with it.
                        task.abort();
                    }
                }
            }
            (None, None) => {}
        }
    }

    fn initialize(&self, params: &Value) -> Value {
        let name = params
            .get("clientInfo")
            .and_then(|c| c.get("name"))
            .and_then(Value::as_str);
        *self.client_name.lock().expect("name") = client_name_of(name);
        *self.roots_capable.lock().expect("roots") = params
            .get("capabilities")
            .and_then(|c| c.get("roots"))
            .is_some();
        let asked = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or("");
        let version = if PROTOCOL_VERSIONS.contains(&asked) {
            asked
        } else {
            PROTOCOL_VERSIONS[0]
        };
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": true } },
            "serverInfo": { "name": "ev3-cockpit", "version": install::VERSION },
        })
    }

    /// Sends a request to the MCP client and waits for its answer.
    async fn ask(&self, method: &str, params: Value) -> Option<Value> {
        let id = format!("ev3-{}", self.next_ask.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.asked.lock().expect("asked").insert(id.clone(), tx);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let answer = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .ok()?
            .ok();
        self.asked.lock().expect("asked").remove(&id);
        answer
    }

    // --- the daemon connection ------------------------------------------------------------

    async fn client(&self) -> Result<Arc<Client>, CliError> {
        if let Some(blocked) = self.blocked.lock().expect("blocked").clone() {
            return Err(blocked);
        }
        let mut slot = self.client.lock().await;
        let client = match slot.as_ref().filter(|c| !c.endpoint.is_closed()) {
            Some(client) => Arc::clone(client),
            None => {
                if slot.take().is_some() {
                    // The daemon went: this agent's bricks are connected again on the next one,
                    // however many attempts reaching it takes.
                    self.rejoin.store(true, Ordering::SeqCst);
                }
                let client = self.connect().await?;
                *slot = Some(Arc::clone(&client));
                client
            }
        };
        if self.rejoin.load(Ordering::SeqCst) {
            // No daemon hands anything to the next. The flag is cleared only once every brick was
            // asked for, so a call cancelled midway leaves it for the next call to finish.
            let bricks: Vec<String> = self
                .my_bricks
                .lock()
                .expect("bricks")
                .iter()
                .cloned()
                .collect();
            for brick in bricks {
                let _ = client
                    .request("bricks/connect", json!({ "brick": brick, "reuse": true }))
                    .await;
            }
            self.rejoin.store(false, Ordering::SeqCst);
        }
        Ok(client)
    }

    /// A new connection to the daemon, starting it when none runs.
    async fn connect(&self) -> Result<Arc<Client>, CliError> {
        let notices: Mutex<Vec<String>> = Mutex::new(Vec::new());
        let notice = |text: &str| notices.lock().expect("notices").push(text.to_owned());
        let name = self.client_name.lock().expect("name").clone();
        let connected = Client::connect(ClientOptions {
            name,
            kind: "mcp",
            version: install::VERSION,
            build_kind: install::BUILD_KIND,
            daemon: ev3_client::Launch::Carried(install::daemon()),
            paths: &self.paths,
            daemon_args: Vec::new(),
            asker: None,
            notice: &notice,
        })
        .await
        .map_err(CliError::from);
        for text in notices.into_inner().expect("notices") {
            self.notice(text);
        }
        match connected {
            Ok(client) => Ok(Arc::new(client)),
            Err(error) => {
                if matches!(
                    error,
                    CliError::Start {
                        failure: Failure::SmartAppControl,
                        ..
                    }
                ) {
                    *self.blocked.lock().expect("blocked") = Some(error.clone());
                }
                Err(error)
            }
        }
    }

    fn notice(&self, text: String) {
        let mut pending = self.pending_notices.lock().expect("notices");
        if self
            .delivered_notices
            .lock()
            .expect("delivered")
            .contains(&text)
            || pending.contains(&text)
        {
            return;
        }
        pending.push(text);
    }

    /// Adds the notices not yet shown to a tool result.
    fn with_notices(&self, mut result: Value) -> Value {
        let notices: Vec<String> = self
            .pending_notices
            .lock()
            .expect("notices")
            .drain(..)
            .collect();
        if notices.is_empty() {
            return result;
        }
        let mut delivered = self.delivered_notices.lock().expect("delivered");
        for text in &notices {
            delivered.insert(text.clone());
            if let Some(content) = result.get_mut("content").and_then(Value::as_array_mut) {
                content.push(json!({ "type": "text", "text": format!("Notice: {text}") }));
            }
        }
        if let Some(object) = result.as_object_mut() {
            let structured = object
                .entry("structuredContent")
                .or_insert_with(|| json!({}));
            if let Some(structured) = structured.as_object_mut() {
                structured.insert("notices".into(), json!(notices));
            }
        }
        result
    }

    // --- local paths ----------------------------------------------------------------------

    /// The roots local paths must stay in: the client's declared roots, or the working directory
    /// when the client has no roots or declares an empty list. A client that has roots but does
    /// not answer for them, answers with an error or answers something else gets no local path at
    /// all: the working directory may be wider than what its host allows.
    async fn roots(&self) -> Result<Vec<PathBuf>, String> {
        let cwd = || {
            std::env::current_dir()
                .ok()
                .and_then(|d| canonical(&d))
                .into_iter()
                .collect()
        };
        if !*self.roots_capable.lock().expect("roots") {
            return Ok(cwd());
        }
        let answer = self.ask("roots/list", json!({})).await;
        let Some(roots) = answer
            .as_ref()
            .and_then(|a| a.get("roots"))
            .and_then(Value::as_array)
        else {
            return Err(
                "The agent host did not say which folders this agent may use, so no local file is read or written."
                    .into(),
            );
        };
        if roots.is_empty() {
            return Ok(cwd());
        }
        Ok(roots
            .iter()
            .filter_map(|r| r.get("uri").and_then(Value::as_str))
            .filter_map(file_uri_to_path)
            .filter_map(|p| canonical(&p))
            .collect())
    }

    // --- the tools ------------------------------------------------------------------------

    async fn call(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let Some(tool) = TOOLS
            .iter()
            .find(|t| t.get("name").and_then(Value::as_str) == Some(name))
        else {
            return Err((-32602, format!("Tool {name} not found")));
        };
        if let Err(problem) = validate(&tool["inputSchema"], &args, "") {
            return Ok(json!({
                "content": [{ "type": "text", "text": format!("Input validation error: Invalid arguments for tool {name}: {problem}") }],
                "isError": true,
            }));
        }
        let progress = params
            .get("_meta")
            .and_then(|m| m.get("progressToken"))
            .cloned();
        let result = match self.tool(name, &args, progress).await {
            Ok(result) => result,
            Err(error) => error_result(&error),
        };
        Ok(self.with_notices(result))
    }

    async fn local(&self, given: &[(&str, bool)]) -> Result<Vec<PathBuf>, Value> {
        let roots = match self.roots().await {
            Ok(roots) => roots,
            Err(reason) => {
                return Err(refusal(
                    "roots_unavailable",
                    &reason,
                    Some(
                        "Try again; if it keeps failing, the user can check the agent host's workspace folders.",
                    ),
                    json!({}),
                ));
            }
        };
        let cwd = std::env::current_dir().unwrap_or_default();
        let mut resolved = Vec::new();
        for (path, must_exist) in given {
            match confine_local_path(path, &roots, &cwd, *must_exist) {
                Ok(path) => resolved.push(path),
                Err(reason) => {
                    let roots: Vec<String> =
                        roots.iter().map(|r| r.display().to_string()).collect();
                    return Err(refusal(
                        "path_outside_roots",
                        &reason,
                        Some("Use a path inside the folders this agent host lets you work in."),
                        json!({ "localPath": path, "roots": roots }),
                    ));
                }
            }
        }
        Ok(resolved)
    }

    async fn tool(
        &self,
        name: &str,
        args: &Value,
        progress: Option<Value>,
    ) -> Result<Value, CliError> {
        let s = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        let brick = s("brick");
        let flag = |key: &str| args.get(key).and_then(Value::as_bool) == Some(true);
        match name {
            "list_bricks" => {
                let result = self
                    .client()
                    .await?
                    .request("bricks/list", json!({ "waitForDiscovery": true }))
                    .await?;
                let bricks = result.get("bricks").cloned().unwrap_or(json!([]));
                let lines: Vec<String> = bricks
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|b| {
                        let state = if b["reconnecting"] == true {
                            "reconnecting after a daemon restart"
                        } else if b["connected"] == true {
                            "connected"
                        } else {
                            "not connected"
                        };
                        let holders: Vec<String> = b["holders"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(crate::commands::holder_name)
                            .collect();
                        let links: Vec<&str> = b["channels"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|c| c["transport"].as_str())
                            .collect();
                        format!(
                            "{} ({}): {state}, {}{}",
                            js_string(&b["name"]),
                            js_string(&b["brickId"]),
                            if links.is_empty() {
                                "no channel".to_owned()
                            } else {
                                links.join("+")
                            },
                            if holders.is_empty() {
                                String::new()
                            } else {
                                format!(", held by {}", holders.join(", "))
                            },
                        )
                    })
                    .collect();
                let text = if lines.is_empty() {
                    "No bricks found.".to_owned()
                } else {
                    lines.join("\n")
                };
                Ok(plain(&text, json!({ "bricks": bricks })))
            }
            "connect_brick" => {
                let connected = self
                    .client()
                    .await?
                    .request("bricks/connect", json!({ "brick": brick }))
                    .await?;
                if let Some(id) = connected.get("brickId").and_then(Value::as_str) {
                    self.my_bricks.lock().expect("bricks").insert(id.to_owned());
                }
                let text = format!(
                    "Connected {} ({}).",
                    js_string(&connected["name"]),
                    js_string(&connected["brickId"])
                );
                Ok(plain(&text, json!({ "brick": connected })))
            }
            "disconnect_brick" => {
                let client = self.client().await?;
                let result = client
                    .request("bricks/disconnect", json!({ "brick": brick }))
                    .await?;
                if let Some(known) = client.brick(&brick).await.ok().flatten()
                    && let Some(id) = known.get("brickId").and_then(Value::as_str)
                {
                    self.my_bricks.lock().expect("bricks").remove(id);
                }
                self.my_bricks.lock().expect("bricks").remove(&brick);
                let still: Vec<String> = strings(&result, "stillHeldBy");
                let text = if still.is_empty() {
                    "Disconnected.".to_owned()
                } else {
                    format!(
                        "Dropped this agent's hold; still held by {}.",
                        still.join(", ")
                    )
                };
                Ok(plain(&text, result))
            }
            "brick_info" => {
                let info = self
                    .client()
                    .await?
                    .request("bricks/info", json!({ "brick": brick }))
                    .await?;
                let firmware = info
                    .get("firmwareVersion")
                    .and_then(Value::as_str)
                    .filter(|f| !f.is_empty());
                let text = format!(
                    "{} ({}){}",
                    js_string(&info["name"]),
                    js_string(&info["brickId"]),
                    firmware
                        .map(|f| format!(", firmware {f}"))
                        .unwrap_or_default()
                );
                Ok(plain(&text, info))
            }
            "brick_storage" => {
                let storage = self
                    .client()
                    .await?
                    .request("bricks/storage", json!({ "brick": brick }))
                    .await?;
                let text = format!(
                    "{} KB free of {} KB.",
                    js_string(&storage["freeKb"]),
                    js_string(&storage["totalKb"])
                );
                Ok(plain(&text, storage))
            }
            "list_files" => {
                let result = self
                    .client()
                    .await?
                    .request("files/list", json!({ "brick": brick, "path": s("path") }))
                    .await?;
                let entries = result.get("entries").cloned().unwrap_or(json!([]));
                let lines: Vec<String> = entries
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|e| {
                        let name = js_string(&e["name"]);
                        format!(
                            "{}{}",
                            if e["kind"] == "directory" {
                                format!("{name}/")
                            } else {
                                name
                            },
                            e.get("bytes")
                                .map(|b| format!(" ({} B)", js_string(b)))
                                .unwrap_or_default()
                        )
                    })
                    .collect();
                let text = if lines.is_empty() {
                    "The folder is empty.".to_owned()
                } else {
                    lines.join("\n")
                };
                Ok(plain(&text, json!({ "entries": entries })))
            }
            "read_file" => {
                let target = match self.local(&[(&s("localPath"), false)]).await {
                    Ok(mut paths) => paths.remove(0),
                    Err(refused) => return Ok(refused),
                };
                let result = self
                    .transfer(
                        "files/read",
                        json!({ "brick": brick, "path": s("path"), "toLocalPath": target, "replace": flag("replace") }),
                        progress,
                    )
                    .await?;
                let bytes = result.get("bytes").cloned().unwrap_or(json!(0));
                Ok(plain(
                    &format!("Saved {} bytes to {}.", js_string(&bytes), target.display()),
                    json!({ "bytes": bytes, "localPath": target }),
                ))
            }
            "write_file" => {
                let source = match self.local(&[(&s("localPath"), true)]).await {
                    Ok(mut paths) => paths.remove(0),
                    Err(refused) => return Ok(refused),
                };
                let path = s("path");
                let result = self
                    .transfer(
                        "files/write",
                        json!({ "brick": brick, "path": path, "fromLocalPath": source, "replace": args.get("replace").and_then(Value::as_bool) != Some(false) }),
                        progress,
                    )
                    .await?;
                let bytes = result.get("bytes").cloned().unwrap_or(json!(0));
                Ok(plain(
                    &format!("Wrote {} bytes to {path}.", js_string(&bytes)),
                    json!({ "bytes": bytes, "path": path }),
                ))
            }
            "remove_file" => {
                let target = s("path");
                let mut params = json!({ "brick": brick, "path": target });
                if flag("recursive") {
                    params["recursive"] = json!(true);
                }
                let report = self.client().await?.request("files/remove", params).await?;
                Ok(plain(&removed_text(&target, &report), report))
            }
            "remove_paths" => {
                let paths = args.get("paths").cloned().unwrap_or(json!([]));
                let count = paths.as_array().map_or(0, Vec::len);
                let mut params = json!({ "brick": brick, "paths": paths });
                if flag("recursive") {
                    params["recursive"] = json!(true);
                }
                let report = self
                    .client()
                    .await?
                    .request("files/removePaths", params)
                    .await?;
                Ok(plain(
                    &removed_text(&format!("{count} path(s)"), &report),
                    report,
                ))
            }
            "make_directory" => {
                let folder = s("path");
                self.client()
                    .await?
                    .request(
                        "files/makeDirectory",
                        json!({ "brick": brick, "path": folder }),
                    )
                    .await?;
                Ok(plain(
                    &format!("Created {folder}."),
                    json!({ "path": folder }),
                ))
            }
            "move_file" => {
                let (from, to) = (s("from"), s("to"));
                self.client()
                    .await?
                    .request(
                        "files/move",
                        json!({ "brick": brick, "from": from, "to": to, "replace": flag("replace") }),
                    )
                    .await?;
                Ok(plain(
                    &format!("Moved {from} to {to}."),
                    json!({ "from": from, "to": to }),
                ))
            }
            "deploy_and_run" => {
                let files = args
                    .get("files")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let given: Vec<String> = files.iter().map(|f| js_string(&f["localPath"])).collect();
                let wanted: Vec<(&str, bool)> = given.iter().map(|g| (g.as_str(), true)).collect();
                let sources = match self.local(&wanted).await {
                    Ok(paths) => paths,
                    Err(refused) => return Ok(refused),
                };
                let files: Vec<Value> = files
                    .iter()
                    .zip(sources)
                    .map(|(f, source)| {
                        let mut file =
                            json!({ "remotePath": f["remotePath"], "localPath": source });
                        if f["skipIfSameMd5"] == true {
                            file["skipIfSameMd5"] = json!(true);
                        }
                        file
                    })
                    .collect();
                let result = self
                    .transfer(
                        "programs/deployAndRun",
                        json!({ "brick": brick, "runPath": s("runPath"), "files": files }),
                        progress,
                    )
                    .await?;
                Ok(start_result(result))
            }
            "run_program" => {
                let mut params = json!({ "brick": brick, "path": s("path") });
                if flag("replace") {
                    params["replace"] = json!(true);
                }
                Ok(start_result(
                    self.client().await?.request("programs/run", params).await?,
                ))
            }
            "stop_program" | "emergency_stop" => {
                let method = if name == "stop_program" {
                    "programs/stop"
                } else {
                    "programs/emergencyStop"
                };
                let state = self
                    .client()
                    .await?
                    .request(method, json!({ "brick": brick }))
                    .await?;
                let text = match (state["running"] == true, name) {
                    (false, _) => "Stopped.",
                    (true, "stop_program") => "Asked to stop; the program still runs.",
                    (true, _) => "Emergency stop sent; the program still runs.",
                };
                Ok(plain(text, state))
            }
            "program_status" => {
                let mut params = json!({ "brick": brick });
                if let Some(wait) = args
                    .get("waitMs")
                    .and_then(Value::as_u64)
                    .filter(|w| *w > 0)
                {
                    params["waitMs"] = json!(wait);
                }
                let state = self
                    .client()
                    .await?
                    .request("programs/status", params)
                    .await?;
                let by = state
                    .get("stoppedBy")
                    .and_then(Value::as_str)
                    .filter(|b| !b.is_empty());
                let text = format!(
                    "{} (last start number {}){}.",
                    if state["running"] == true {
                        "A program runs"
                    } else {
                        "No program runs"
                    },
                    js_string(&state["runSeq"]),
                    by.map(|b| format!("; stopped by {b}")).unwrap_or_default()
                );
                Ok(plain(&text, state))
            }
            "list_telemetry_rows" => {
                let result = self
                    .client()
                    .await?
                    .request("telemetry/rows", json!({}))
                    .await?;
                let rows = result.get("rows").cloned().unwrap_or(json!([]));
                let lines: Vec<String> = rows
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(telemetry::row_line)
                    .collect();
                Ok(plain(&lines.join("\n"), json!({ "rows": rows })))
            }
            "read_telemetry" => {
                let rows: Vec<String> = args
                    .get("rows")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
                let wait = args
                    .get("waitMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(DEFAULT_TELEMETRY_WAIT_MS);
                let client = self.client().await?;
                let reading = telemetry::read_once(
                    &client.endpoint,
                    &brick,
                    &rows,
                    Duration::from_millis(wait),
                )
                .await?;
                let mut lines: Vec<String> = reading["values"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(telemetry::value_line)
                    .collect();
                let missing: Vec<String> = strings(&reading, "missing");
                if !missing.is_empty() {
                    lines.push(format!("No value yet for {}.", missing.join(", ")));
                }
                let text = if lines.is_empty() {
                    "No telemetry values.".to_owned()
                } else {
                    lines.join("\n")
                };
                Ok(plain(&text, reading))
            }
            "pair" => {
                let client = self.client().await?;
                // A brick never paired, or forgotten here, is heard only by a Bluetooth inquiry.
                if !client
                    .find_by_inquiry(&brick, crate::commands::INQUIRY_WAIT)
                    .await?
                {
                    return Err(crate::commands::not_heard(&brick));
                }
                let mut result = client
                    .request("bricks/pair", json!({ "brick": brick }))
                    .await?;
                let outcome = js_string(&result["outcome"]);
                let text = match outcome.as_str() {
                    "paired" => "Paired.".to_owned(),
                    "cancelled" => "The pairing was cancelled.".to_owned(),
                    _ => match result.get("message").and_then(Value::as_str) {
                        Some(message) => format!("Not paired: {message}"),
                        None => "Not paired.".to_owned(),
                    },
                };
                result["paired"] = json!(outcome == "paired");
                Ok(plain(&text, result))
            }
            "forget" => {
                let result = self
                    .client()
                    .await?
                    .request("bricks/forget", json!({ "brick": brick }))
                    .await?;
                let lines: Vec<String> = strings(&result, "lines");
                let text = if result["forgotten"] == true {
                    format!("Forgotten.\n{}", lines.join("\n"))
                } else {
                    "Not forgotten.".to_owned()
                };
                Ok(plain(&text, result))
            }
            "clear_bluetooth_list" => {
                let result = self
                    .client()
                    .await?
                    .request("bricks/clearBluetoothList", json!({ "brick": brick }))
                    .await?;
                let removed = result["removed"].as_array().map_or(0, Vec::len);
                let kept: Vec<String> = strings(&result, "kept");
                let text = format!(
                    "Removed {removed} entr{}{}.",
                    if removed == 1 { "y" } else { "ies" },
                    if kept.is_empty() {
                        String::new()
                    } else {
                        format!("; kept {}", kept.join(", "))
                    }
                );
                Ok(plain(&text, result))
            }
            "get_settings" => {
                let result = self
                    .client()
                    .await?
                    .request("settings/list", json!({}))
                    .await?;
                let settings: Vec<Value> = result["settings"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|s| {
                        let mut flat = s["spec"].clone();
                        flat["value"] = s["value"].clone();
                        flat
                    })
                    .collect();
                let lines: Vec<String> = settings
                    .iter()
                    .map(|s| {
                        format!(
                            "{} = {}{}",
                            js_string(&s["key"]),
                            s["value"],
                            if s["dangerous"] == true {
                                " (changes only on the user's yes)"
                            } else {
                                ""
                            }
                        )
                    })
                    .collect();
                Ok(plain(&lines.join("\n"), json!({ "settings": settings })))
            }
            "set_setting" => {
                let setting = self.client().await?
                    .request("settings/set", json!({ "key": s("key"), "value": args.get("value").cloned().unwrap_or(Value::Null) }))
                    .await?;
                let key = js_string(&setting["spec"]["key"]);
                Ok(plain(
                    &format!("{key} = {}.", setting["value"]),
                    json!({ "key": key, "value": setting["value"] }),
                ))
            }
            other => Err(CliError::Other(format!("Tool {other} not found"))),
        }
    }

    /// A transfer, with its progress sent to the MCP client when it asked for it.
    async fn transfer(
        &self,
        method: &str,
        params: Value,
        progress: Option<Value>,
    ) -> Result<Value, CliError> {
        let client = self.client().await?;
        let Some(token) = progress else {
            return Ok(client.request(method, params).await?);
        };
        let out = self.out.clone();
        client
            .request_with_progress(method, params, Box::new(move |value: Value| {
                let Some(transferred) = value.get("transferred").and_then(Value::as_f64) else { return };
                let mut params = json!({ "progressToken": token, "progress": transferred });
                if let Some(total) = value.get("total").and_then(Value::as_f64) {
                    params["total"] = json!(total);
                }
                let _ = out.send(json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": params }));
            }))
            .await
            .map_err(CliError::from)
    }
}

// --- results --------------------------------------------------------------------------------

fn plain(text: &str, data: Value) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "structuredContent": data })
}

/// A tool result for something that did not happen, saying why and what to do instead.
fn refusal(code: &str, message: &str, next: Option<&str>, extra: Value) -> Value {
    let mut error = json!({ "code": code, "message": message });
    if let (Some(error), Some(extra)) = (error.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            error.insert(key.clone(), value.clone());
        }
    }
    let mut structured = json!({ "error": error });
    let text = match next {
        Some(next) => {
            structured["next"] = json!(next);
            format!("{message}\n{next}")
        }
        None => message.to_owned(),
    };
    json!({ "content": [{ "type": "text", "text": text }], "structuredContent": structured, "isError": true })
}

/// A daemon error as a tool result: who holds a busy brick, the command a person must run.
pub fn error_result(error: &CliError) -> Value {
    let (code, data) = match error {
        CliError::Contract { code, data, .. } => (code.clone(), data.clone()),
        CliError::Start { .. } => (DAEMON_UNAVAILABLE.to_owned(), json!({})),
        _ => return refusal("internal", error.message(), None, json!({})),
    };
    let get = |key: &str| data.get(key).filter(|v| !v.is_null()).cloned();
    let mut extra = serde_json::Map::new();
    if let CliError::Start { failure, .. } = error {
        extra.insert("failure".into(), json!(failure.as_str()));
    }
    for key in ["holder", "command", "candidates"] {
        if let Some(value) = get(key).filter(|v| v.as_array().is_none_or(|a| !a.is_empty())) {
            extra.insert(key.into(), value);
        }
    }
    let holder = get("holder").map(|h| js_string(&h));
    let command = get("command").map(|c| js_string(&c));
    let next: Option<String> = match code.as_str() {
        "brick_busy" => Some(format!("{} is working with the brick now. Try again once it has finished.", holder.unwrap_or_else(|| "Another client".into()))),
        "needs_person" => Some(match command {
            Some(c) => format!("Only the user can do this. Ask them to run: {c}"),
            None => "Only the user can do this, in a terminal or in VS Code.".into(),
        }),
        "cancelled" => Some("It did not happen: the user said no, or it was cancelled. Do not try again unless the user asks.".into()),
        "outcome_unknown" => Some(format!("Whether it took effect is unknown. {DO_NOT_RUN_AGAIN}")),
        "brick_ambiguous" => Some(match get("candidates").and_then(|c| c.as_array().cloned()).filter(|c| !c.is_empty()) {
            Some(c) => format!(
                "Name the brick by its id: {}.",
                c.iter().map(|b| format!("{} ({})", js_string(&b["brickId"]), js_string(&b["name"]))).collect::<Vec<_>>().join(", ")
            ),
            None => "Name the brick by its id.".into(),
        }),
        "file_exists" => Some("Nothing was replaced. Choose another name, or call the tool again with replace: true if the user wants that file replaced.".into()),
        "not_connected" => Some("If the brick is not connected, connect it with connect_brick.".into()),
        "brick_not_found" => Some("Check the name with list_bricks. A brick never paired needs pair, with the brick on and its Bluetooth and visibility on.".into()),
        "access_denied" => Some(match command {
            Some(c) => format!("Safe mode refuses this. Only the user can switch on full mode. Ask them to run: {c}"),
            None => "The cockpit does not allow this for an agent.".into(),
        }),
        DAEMON_UNAVAILABLE => Some(match error {
            CliError::Start { failure, .. } => start_failure_next(*failure).into(),
            _ => "The cockpit daemon is not reachable. The user can check it with ev3 daemon status.".into(),
        }),
        _ => None,
    };
    refusal(
        &code,
        error.message(),
        next.as_deref(),
        Value::Object(extra),
    )
}

/// What to do about a daemon that could not be started, by why.
fn start_failure_next(failure: Failure) -> &'static str {
    match failure {
        Failure::SmartAppControl => {
            "The cockpit cannot run on this computer while Windows Smart App Control is on. Tell the user; trying again does not help."
        }
        Failure::MissingBinary | Failure::ShaMismatch | Failure::NotPrivate => {
            "This installation of EVƎ Cockpit cannot start its daemon safely. Ask the user to reinstall it, or to rebuild it with npm run daemon:build when it runs from the repository."
        }
        Failure::ContractMismatch => {
            "The running cockpit daemon and this server do not speak the same contract. Ask the user to update the older of the two."
        }
        _ => "The cockpit daemon could not be started. The user can read why with ev3 daemon log.",
    }
}

/// How a start ended, with what to do when it is not known whether the program runs.
fn start_result(mut result: Value) -> Value {
    let uploaded = result["uploaded"].as_array().map_or(0, Vec::len);
    let skipped = result["skipped"].as_array().map_or(0, Vec::len);
    let files = if uploaded + skipped > 0 {
        format!(" Uploaded {uploaded} file(s), skipped {skipped} the brick already had.")
    } else {
        String::new()
    };
    match result["outcome"].as_str() {
        Some("started") => {
            let text = format!(
                "Started (start number {}).{files}",
                js_string(&result["runSeq"])
            );
            plain(&text, result)
        }
        Some("not_seen_running") => {
            result["next"] = json!("Check program_status.");
            plain(
                &format!(
                    "The brick took the start, but the program was not seen running; it may have ended at once.{files} Check program_status."
                ),
                result,
            )
        }
        _ => {
            result["next"] = json!(DO_NOT_RUN_AGAIN);
            plain(
                &format!(
                    "The reply to the start was lost: the program may or may not be running.{files} {DO_NOT_RUN_AGAIN}"
                ),
                result,
            )
        }
    }
}

fn removed_text(what: &str, report: &Value) -> String {
    let left: Vec<String> = strings(report, "leftBehind");
    if left.is_empty() {
        format!("Removed {what}.")
    } else {
        format!("Removed {what}, except: {}.", left.join(", "))
    }
}

// --- arguments ------------------------------------------------------------------------------

/// Checks `value` against the parts of JSON Schema the tool schemas use; the first problem found.
fn validate(schema: &Value, value: &Value, at: &str) -> Result<(), String> {
    let place = if at.is_empty() {
        "the arguments".to_owned()
    } else {
        at.to_owned()
    };
    if let Some(any) = schema.get("anyOf").and_then(Value::as_array) {
        return if any.iter().any(|s| validate(s, value, at).is_ok()) {
            Ok(())
        } else {
            Err(format!("{place} has an invalid type"))
        };
    }
    let ok = match schema.get("type").and_then(Value::as_str) {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("number") => value.is_number(),
        Some("integer") => value.as_f64().is_some_and(|n| n.fract() == 0.0),
        _ => true,
    };
    if !ok {
        return Err(format!(
            "{place} must be a {}",
            schema["type"].as_str().unwrap_or("value")
        ));
    }
    if let Some(text) = value.as_str()
        && let Some(min) = schema.get("minLength").and_then(Value::as_u64)
        && (text.chars().count() as u64) < min
    {
        return Err(format!("{place} is too short"));
    }
    if let Some(number) = value.as_f64() {
        if schema
            .get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|m| number < m)
        {
            return Err(format!("{place} is too small"));
        }
        if schema
            .get("maximum")
            .and_then(Value::as_f64)
            .is_some_and(|m| number > m)
        {
            return Err(format!("{place} is too large"));
        }
    }
    if let Some(items) = value.as_array() {
        if schema
            .get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|m| (items.len() as u64) < m)
        {
            return Err(format!("{place} has too few items"));
        }
        if let Some(item) = schema.get("items") {
            for (i, element) in items.iter().enumerate() {
                validate(item, element, &format!("{place}[{i}]"))?;
            }
        }
    }
    if let Some(object) = value.as_object() {
        for key in schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !object.contains_key(key) {
                return Err(format!(
                    "{} is required",
                    if at.is_empty() {
                        key.to_owned()
                    } else {
                        format!("{at}.{key}")
                    }
                ));
            }
        }
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            for (key, element) in object {
                if let Some(property) = properties.get(key) {
                    let path = if at.is_empty() {
                        key.clone()
                    } else {
                        format!("{at}.{key}")
                    };
                    validate(property, element, &path)?;
                }
            }
        }
    }
    Ok(())
}

// --- confinement ----------------------------------------------------------------------------

/// A canonical path without Windows' verbatim prefix, so the daemon sees an ordinary path.
fn canonical(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok().map(|p| plain_path(&p))
}

fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// The path a `file:` URI names, or `None` for another scheme.
fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let mut bytes = Vec::with_capacity(rest.len());
    let raw = rest.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%'
            && i + 2 < raw.len()
            && let Ok(hex) = std::str::from_utf8(&raw[i + 1..i + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            bytes.push(byte);
            i += 3;
            continue;
        }
        bytes.push(raw[i]);
        i += 1;
    }
    let decoded = String::from_utf8(bytes).ok()?;
    // `file:///C:/x` on Windows, `file:///home/x` elsewhere; a host part other than empty or
    // `localhost` is a share the agent's host names, which is not followed.
    let path = decoded.strip_prefix("localhost").unwrap_or(&decoded);
    if !path.starts_with('/') {
        return None;
    }
    if cfg!(windows) {
        let trimmed = path.trim_start_matches('/');
        if trimmed.as_bytes().get(1) == Some(&b':') {
            return Some(PathBuf::from(trimmed.replace('/', "\\")));
        }
        return None;
    }
    Some(PathBuf::from(path))
}

/// A local path, made absolute and with every link resolved, accepted only inside one of the
/// roots. A file that does not exist yet is resolved through its folder.
pub fn confine_local_path(
    given: &str,
    roots: &[PathBuf],
    cwd: &Path,
    must_exist: bool,
) -> Result<PathBuf, String> {
    let absolute = cwd.join(given);
    let real = match std::fs::canonicalize(&absolute) {
        Ok(real) => plain_path(&real),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(format!(
                "{} cannot be resolved: {error}",
                absolute.display()
            ));
        }
        Err(_) => {
            if must_exist {
                return Err(format!("{} does not exist.", absolute.display()));
            }
            // A name that is there but does not resolve is a link to nowhere: writing to it would
            // follow the link wherever it points.
            if std::fs::symlink_metadata(&absolute).is_ok() {
                return Err(format!(
                    "{} is a link to something that does not exist.",
                    absolute.display()
                ));
            }
            let (Some(parent), Some(name)) = (absolute.parent(), absolute.file_name()) else {
                return Err(format!("{} cannot be resolved.", absolute.display()));
            };
            match canonical(parent) {
                Some(folder) => folder.join(name),
                None => return Err(format!("The folder {} does not exist.", parent.display())),
            }
        }
    };
    let fold = |p: &Path| {
        let text = p.to_string_lossy().into_owned();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    let inside = roots.iter().any(|root| {
        let (root, path) = (fold(root), fold(&real));
        let root = root.trim_end_matches(std::path::MAIN_SEPARATOR);
        path == root || path.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
    });
    if inside {
        Ok(real)
    } else {
        let list: Vec<String> = roots.iter().map(|r| r.display().to_string()).collect();
        Err(format!(
            "{} is outside the folders this agent may use ({}).",
            absolute.display(),
            list.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_list_is_the_typescript_servers() {
        // Read as the server reads it: a list that did not parse would be empty.
        let tools = &*TOOLS;
        assert_eq!(tools.len(), 24);
        for name in [
            "list_bricks",
            "deploy_and_run",
            "read_telemetry",
            "set_setting",
        ] {
            assert!(tools.iter().any(|t| t["name"] == name), "{name}");
        }
        assert!(
            !tools.iter().any(|t| t["name"] == "restart_daemon"),
            "no tool asks the daemon to exit"
        );
    }

    #[test]
    fn arguments_are_checked_against_the_tools_schema() {
        let tools: Vec<Value> = serde_json::from_str(TOOLS_JSON).expect("tools");
        let schema = |name: &str| {
            tools.iter().find(|t| t["name"] == name).expect(name)["inputSchema"].clone()
        };
        assert!(validate(&schema("brick_info"), &json!({ "brick": "CCC" }), "").is_ok());
        assert!(validate(&schema("brick_info"), &json!({}), "").is_err());
        assert!(validate(&schema("brick_info"), &json!({ "brick": "" }), "").is_err());
        assert!(
            validate(
                &schema("program_status"),
                &json!({ "brick": "A", "waitMs": 99_999 }),
                ""
            )
            .is_err()
        );
        assert!(
            validate(
                &schema("set_setting"),
                &json!({ "key": "k", "value": true }),
                ""
            )
            .is_ok()
        );
        assert!(
            validate(
                &schema("deploy_and_run"),
                &json!({ "brick": "A", "runPath": "/p", "files": [{ "localPath": "x" }] }),
                ""
            )
            .is_err()
        );
    }

    #[test]
    fn a_name_is_the_clients_own_bounded_or_the_servers() {
        assert_eq!(client_name_of(Some("  Claude Code ")), "Claude Code");
        assert_eq!(client_name_of(Some(" ")), MCP_CLIENT_NAME);
        assert_eq!(client_name_of(None), MCP_CLIENT_NAME);
        assert_eq!(
            client_name_of(Some(&"é".repeat(300))).chars().count(),
            MAX_CLIENT_NAME
        );
    }

    #[test]
    fn a_busy_brick_says_who_holds_it_and_what_to_do() {
        let busy = CliError::Contract {
            code: "brick_busy".into(),
            message: "CCC is busy".into(),
            data: json!({ "code": "brick_busy", "holder": "VS Code" }),
        };
        let result = error_result(&busy);
        assert_eq!(result["isError"], true);
        assert_eq!(result["structuredContent"]["error"]["holder"], "VS Code");
        assert!(
            result["structuredContent"]["next"]
                .as_str()
                .expect("next")
                .starts_with("VS Code is working")
        );
        let blocked = error_result(&CliError::start(Failure::SmartAppControl, "blocked"));
        assert_eq!(
            blocked["structuredContent"]["error"]["failure"],
            "smart_app_control"
        );
    }

    #[test]
    fn local_paths_stay_inside_the_roots() {
        let root = canonical(&std::env::temp_dir())
            .expect("temp")
            .join(format!(
                "ev3-mcp-{}",
                ev3_channel::hex(&ev3_channel::random_bytes::<6>())
            ));
        std::fs::create_dir_all(root.join("inside")).expect("dirs");
        std::fs::write(root.join("inside").join("a.rbf"), b"x").expect("file");
        let roots = vec![canonical(&root.join("inside")).expect("root")];
        let cwd = root.join("inside");
        assert!(confine_local_path("a.rbf", &roots, &cwd, true).is_ok());
        assert!(confine_local_path("new.rbf", &roots, &cwd, false).is_ok());
        assert!(confine_local_path("missing.rbf", &roots, &cwd, true).is_err());
        assert!(confine_local_path("../outside.rbf", &roots, &cwd, false).is_err());
        assert!(confine_local_path("nofolder/x", &roots, &cwd, false).is_err());
        std::fs::remove_dir_all(root).expect("clean");
    }

    #[test]
    fn a_file_uri_names_a_local_path() {
        if cfg!(windows) {
            assert_eq!(
                file_uri_to_path("file:///C:/Users/x%20y"),
                Some(PathBuf::from(r"C:\Users\x y"))
            );
            assert_eq!(file_uri_to_path("file://server/share"), None);
        } else {
            assert_eq!(
                file_uri_to_path("file:///home/x%20y"),
                Some(PathBuf::from("/home/x y"))
            );
        }
        assert_eq!(file_uri_to_path("https://example.com/"), None);
    }
}
