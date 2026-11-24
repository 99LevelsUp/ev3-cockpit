//! The tools of installed add-ons in `ev3 mcp` (#2): one MCP server for the cockpit and its
//! add-ons, so an agent host needs one entry.
//!
//! - An add-on is every `ev3-<name>` on PATH that `ev3 <name>` would run (see [`crate::addons`]).
//!   `ev3 mcp` starts `ev3-<name> mcp` once, at its own `initialize`, as a child speaking MCP over
//!   stdio, and keeps it for the calls. The child's `tools/list` is the add-on's manifest.
//! - Its tools are offered as `<name>_<tool>` (a dash in the name becomes `_`), with their
//!   descriptions, schemas and annotations as the add-on gave them. A name the cockpit's own tools
//!   already use stays the cockpit's.
//! - A call is forwarded with an id of this server's own; the answer goes back under the agent's
//!   id. `notifications/cancelled` reaches the child with its id, `notifications/progress` and
//!   `notifications/message` from the child reach the agent as they are (a progress token is the
//!   agent's own). The child's `roots/list` is answered with the agent's roots, so the add-on
//!   confines its paths as the cockpit does; it keeps its own check, so a proxy that erred could
//!   not widen access. Any other request of the child is refused.
//! - The child gets the agent's `clientInfo`, so the daemon names the real agent to a person.
//! - An add-on that does not start, does not answer within [`START_WAIT`], or says it speaks
//!   another cockpit contract (`capabilities.experimental["ev3-cockpit"].contract`) loses only its
//!   own tools, with a notice. One that ends during a call answers that call with an error result;
//!   the next call starts it again.
//! - Standard output carries only the agent's protocol: a child's standard error goes to this
//!   server's standard error.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

use crate::addons::AddonLaunch;
use crate::output::js_string;

/// How long an add-on has to answer `initialize` and `tools/list` together.
pub const START_WAIT: Duration = Duration::from_secs(5);

/// Asks the agent for its roots; `None` when it did not answer with any.
pub type AskRoots =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Option<Value>> + Send>> + Send + Sync>;

/// What a child needs from the agent's side of `ev3 mcp`.
#[derive(Clone)]
pub struct AgentSide {
    /// Messages to the agent.
    pub out: mpsc::UnboundedSender<Value>,
    /// The agent's roots, when the agent declared it has some.
    pub roots: Option<AskRoots>,
    /// The agent's `clientInfo`, handed to the child as its own.
    pub client_info: Value,
    pub protocol_version: String,
}

/// One add-on's MCP server, started again when it ended.
pub struct Addon {
    pub name: String,
    launch: AddonLaunch,
    agent: AgentSide,
    /// Its tools as the agent sees them, from its first start.
    pub tools: Vec<Value>,
    running: AsyncMutex<Option<Arc<Running>>>,
    next_id: Arc<AtomicU64>,
}

/// A started child.
struct Running {
    to_child: mpsc::UnboundedSender<Value>,
    alive: AtomicBool,
    /// This server's own requests (`initialize`, `tools/list`) waiting for their answers.
    asked: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    /// Forwarded calls: the child's id to the agent's id.
    calls: Mutex<HashMap<String, Value>>,
    child: Mutex<Option<Child>>,
}

/// The prefix of an add-on's tools: its name, a dash as `_`, then `_`.
pub fn prefix_of(name: &str) -> String {
    format!("{}_", name.replace('-', "_"))
}

/// Starts every add-on in `launches` at once and keeps those that answered. `notice` hears why one
/// was left out.
pub async fn start_all(
    launches: Vec<(String, AddonLaunch)>,
    agent: &AgentSide,
    notice: &(dyn Fn(String) + Sync),
) -> Vec<Arc<Addon>> {
    let starts = launches.into_iter().map(|(name, launch)| {
        let agent = agent.clone();
        async move {
            let result = Addon::start(name.clone(), launch, agent).await;
            (name, result)
        }
    });
    let mut addons = Vec::new();
    for (name, result) in futures_util::future::join_all(starts).await {
        match result {
            Ok(addon) => addons.push(Arc::new(addon)),
            Err(why) => notice(format!(
                "The tools of the add-on ev3-{name} are not offered: {why}"
            )),
        }
    }
    addons
}

impl Addon {
    async fn start(name: String, launch: AddonLaunch, agent: AgentSide) -> Result<Self, String> {
        let next_id = Arc::new(AtomicU64::new(1));
        let (running, tools) = spawn(&name, &launch, &agent, &next_id).await?;
        let prefix = prefix_of(&name);
        let tools = tools
            .into_iter()
            .filter_map(|mut tool| {
                let original = tool.get("name")?.as_str()?.to_owned();
                tool["name"] = json!(format!("{prefix}{original}"));
                Some(tool)
            })
            .collect();
        Ok(Self {
            name,
            launch,
            agent,
            tools,
            running: AsyncMutex::new(Some(running)),
            next_id,
        })
    }

    /// Whether `tool`, as the agent named it, is one of this add-on's.
    pub fn offers(&self, tool: &str) -> bool {
        self.tools
            .iter()
            .any(|t| t.get("name").and_then(Value::as_str) == Some(tool))
    }

    /// Forwards the agent's `tools/call` with id `agent_id`; the answer reaches the agent by
    /// itself. Returns the id the child knows the call by, for a cancellation.
    pub async fn forward(&self, agent_id: Value, mut params: Value) -> Option<String> {
        let running = match self.running().await {
            Ok(running) => running,
            Err(why) => {
                let _ = self.agent.out.send(json!({
                    "jsonrpc": "2.0", "id": agent_id,
                    "result": error_result(&format!(
                        "The add-on ev3-{} could not be started again: {why}", self.name
                    )),
                }));
                return None;
            }
        };
        let prefix = prefix_of(&self.name);
        if let Some(name) = params.get("name").and_then(Value::as_str)
            && let Some(original) = name.strip_prefix(&prefix)
        {
            params["name"] = json!(original);
        }
        let id = format!("ev3-mcp-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        running
            .calls
            .lock()
            .expect("calls")
            .insert(id.clone(), agent_id.clone());
        if !running.alive.load(Ordering::SeqCst)
            && running.calls.lock().expect("calls").remove(&id).is_some()
        {
            // It ended after it was found running and before the call was noted.
            let _ = self.agent.out.send(json!({
                "jsonrpc": "2.0", "id": agent_id,
                "result": error_result(&format!(
                    "The add-on ev3-{} ended before the call reached it. Try again.", self.name
                )),
            }));
            return None;
        }
        let _ = running.to_child.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params,
        }));
        Some(id)
    }

    /// Passes the agent's cancellation of a forwarded call on; its late answer is dropped.
    pub async fn cancel(&self, child_id: &str, reason: Option<Value>) {
        let Some(running) = self.running.lock().await.clone() else {
            return;
        };
        if running
            .calls
            .lock()
            .expect("calls")
            .remove(child_id)
            .is_none()
        {
            return;
        }
        let mut params = json!({ "requestId": child_id });
        if let Some(reason) = reason {
            params["reason"] = reason;
        }
        let _ = running.to_child.send(json!({
            "jsonrpc": "2.0", "method": "notifications/cancelled", "params": params,
        }));
    }

    /// Ends the child.
    pub async fn stop(&self) {
        if let Some(running) = self.running.lock().await.take() {
            running.kill();
        }
    }

    /// The running child, started again when it ended.
    async fn running(&self) -> Result<Arc<Running>, String> {
        let mut slot = self.running.lock().await;
        if let Some(running) = slot.as_ref().filter(|r| r.alive.load(Ordering::SeqCst)) {
            return Ok(Arc::clone(running));
        }
        let (running, _) = spawn(&self.name, &self.launch, &self.agent, &self.next_id).await?;
        *slot = Some(Arc::clone(&running));
        Ok(running)
    }
}

impl Running {
    fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().expect("child").take() {
            let _ = child.start_kill();
        }
    }

    /// Sends one of this server's own requests and waits for the answer; `None` for an error answer
    /// or none within `wait`.
    async fn ask(
        &self,
        next_id: &AtomicU64,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Option<Value> {
        let id = format!("ev3-mcp-{}", next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.asked.lock().expect("asked").insert(id.clone(), tx);
        let _ = self.to_child.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        }));
        let answer = tokio::time::timeout(wait, rx).await.ok()?.ok();
        self.asked.lock().expect("asked").remove(&id);
        answer.filter(|a| !a.is_null())
    }
}

/// Starts `ev3-<name> mcp`, introduces it and reads its tools.
async fn spawn(
    name: &str,
    launch: &AddonLaunch,
    agent: &AgentSide,
    next_id: &AtomicU64,
) -> Result<(Arc<Running>, Vec<Value>), String> {
    let mut child = Command::new(&launch.command)
        .args(&launch.args)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("{} could not start: {error}", launch.found.display()))?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.start_kill();
        return Err("its standard input and output could not be opened".into());
    };
    let (to_child, mut outgoing) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
    });
    let running = Arc::new(Running {
        to_child,
        alive: AtomicBool::new(true),
        asked: Mutex::new(HashMap::new()),
        calls: Mutex::new(HashMap::new()),
        child: Mutex::new(Some(child)),
    });
    tokio::spawn(read(
        name.to_owned(),
        Arc::clone(&running),
        agent.clone(),
        BufReader::new(stdout),
    ));

    let handshake = async {
        let mut capabilities = json!({});
        if agent.roots.is_some() {
            capabilities["roots"] = json!({ "listChanged": false });
        }
        let init = running
            .ask(
                next_id,
                "initialize",
                json!({
                    "protocolVersion": agent.protocol_version,
                    "capabilities": capabilities,
                    "clientInfo": agent.client_info,
                }),
                START_WAIT,
            )
            .await
            .ok_or("it did not answer initialize")?;
        let contract = init
            .get("capabilities")
            .and_then(|c| c.get("experimental"))
            .and_then(|e| e.get("ev3-cockpit"))
            .and_then(|c| c.get("contract"))
            .and_then(Value::as_u64);
        let ours = u64::from(ev3_contract::CONTRACT_VERSION);
        if let Some(theirs) = contract.filter(|c| *c != ours) {
            return Err(format!(
                "it speaks cockpit contract {theirs} and this cockpit speaks {ours}; update the older of the two"
            ));
        }
        let _ = running.to_child.send(json!({
            "jsonrpc": "2.0", "method": "notifications/initialized",
        }));
        let listed = running
            .ask(next_id, "tools/list", json!({}), START_WAIT)
            .await
            .ok_or("it did not answer tools/list")?;
        Ok::<_, String>(
            listed
                .get("tools")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        )
    };
    match tokio::time::timeout(START_WAIT, handshake).await {
        Ok(Ok(tools)) => Ok((running, tools)),
        Ok(Err(why)) => {
            running.kill();
            Err(why)
        }
        Err(_) => {
            running.kill();
            Err(format!(
                "it did not answer within {} s",
                START_WAIT.as_secs()
            ))
        }
    }
}

/// Reads the child's messages until it ends.
async fn read(
    name: String,
    running: Arc<Running>,
    agent: AgentSide,
    stdout: BufReader<tokio::process::ChildStdout>,
) {
    let mut lines = stdout.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            eprintln!(
                "ev3 mcp: the add-on ev3-{name} wrote a line that is not JSON; it is ignored."
            );
            continue;
        };
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned();
        match (method, id) {
            (None, Some(id)) => {
                let key = js_string(&id);
                if let Some(answer) = running.asked.lock().expect("asked").remove(&key) {
                    let result = match message.get("error") {
                        Some(_) => Value::Null,
                        None => message.get("result").cloned().unwrap_or(Value::Null),
                    };
                    let _ = answer.send(result);
                    continue;
                }
                let Some(agent_id) = running.calls.lock().expect("calls").remove(&key) else {
                    // A cancelled call's late answer, or an id this server never used.
                    continue;
                };
                let mut reply = json!({ "jsonrpc": "2.0", "id": agent_id });
                match (message.get("result"), message.get("error")) {
                    (Some(result), _) => reply["result"] = result.clone(),
                    (None, Some(error)) => reply["error"] = error.clone(),
                    (None, None) => reply["result"] = json!({}),
                }
                let _ = agent.out.send(reply);
            }
            (Some(method), Some(id)) => {
                let to_child = running.to_child.clone();
                let roots = agent.roots.clone();
                let method = method.to_owned();
                tokio::spawn(async move {
                    let reply = match (method.as_str(), roots) {
                        ("roots/list", Some(ask)) => match ask().await {
                            Some(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            None => json!({ "jsonrpc": "2.0", "id": id, "error": {
                                "code": -32603, "message": "The agent host did not say which folders the agent may use.",
                            }}),
                        },
                        ("ping", _) => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                        (other, _) => json!({ "jsonrpc": "2.0", "id": id, "error": {
                            "code": -32601, "message": format!("ev3 mcp does not pass {other} on to the agent."),
                        }}),
                    };
                    let _ = to_child.send(reply);
                });
            }
            (Some("notifications/progress" | "notifications/message"), None) => {
                let _ = agent.out.send(message);
            }
            _ => {}
        }
    }
    running.alive.store(false, Ordering::SeqCst);
    let pending: Vec<Value> = running
        .calls
        .lock()
        .expect("calls")
        .drain()
        .map(|(_, agent_id)| agent_id)
        .collect();
    for agent_id in pending {
        let _ = agent.out.send(json!({
            "jsonrpc": "2.0", "id": agent_id,
            "result": error_result(&format!(
                "The add-on ev3-{name} ended during this call, so whether it took effect is unknown. The next call starts it again."
            )),
        }));
    }
    running.asked.lock().expect("asked").clear();
}

/// A tool result that says something went wrong.
fn error_result(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}
