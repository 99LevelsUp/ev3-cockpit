//! One connection: the hello, then JSON-RPC 2.0 requests dispatched concurrently through the
//! contract's method table, `$/cancelRequest` and `$/progress`, notifications, and requests the
//! daemon sends to the client (`question/ask`).
//!
//! Until a client has proved it holds the user's key, the daemon answers nothing but the hello:
//! any other message, a malformed hello, a wrong proof or silence for 10 s closes the connection.
//! Progress follows the client library's convention: a request that wants progress carries a
//! token in `params.__progressToken`, and the daemon sends `$/progress` with `{token, value}`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ev3_contract::hello::{client_proof, daemon_proof};
use ev3_contract::{
    BuildKind, CONTRACT_VERSION, ClientInfo, ClientKind, ContractError, ErrorCode, HELLO_FINISH,
    HELLO_START, HelloAccepted, HelloChallenge, HelloFinish, HelloStart,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::codec::{FramedRead, FramedWrite};
use tokio_util::sync::CancellationToken;

use crate::channel::Duplex;
use crate::codec::JsonRpcCodec;
use crate::methods::Daemon;
use crate::state::{ClientEntry, Shared};

/// How long a client has to finish the hello.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// The parameter a progress-reporting request carries its token in.
pub const PROGRESS_TOKEN: &str = "__progressToken";

type Reply = Result<Value, Value>;

/// How many messages may wait for a client that does not read them before the daemon closes its
/// connection: a stalled client must not hold the daemon's memory with every update it misses.
pub const MAX_BACKLOG: usize = 4096;
/// How long one message may take to reach a client before the daemon closes its connection.
pub const WRITE_STALL: Duration = Duration::from_secs(30);

/// The daemon's side of one connection, for sending.
pub struct Peer {
    out: mpsc::UnboundedSender<Value>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
    closed: CancellationToken,
    /// Messages queued and not yet written; the writer takes one off for each it wrote.
    backlog: Arc<AtomicUsize>,
}

/// Forgets a request to the client whose wait was dropped, so a question that timed out leaves
/// no entry behind.
struct PendingGuard<'a> {
    peer: &'a Peer,
    id: u64,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.peer
            .pending
            .lock()
            .expect("pending lock")
            .remove(&self.id);
    }
}

impl Peer {
    pub(crate) fn new(out: mpsc::UnboundedSender<Value>, closed: CancellationToken) -> Self {
        Self {
            out,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed,
            backlog: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Queues a message for the client. A client that let [`MAX_BACKLOG`] messages pile up has
    /// stopped reading: its connection is closed instead.
    fn send(&self, message: Value) {
        if self.closed.is_cancelled() {
            return;
        }
        if self.backlog.fetch_add(1, Ordering::SeqCst) >= MAX_BACKLOG {
            self.closed.cancel();
            return;
        }
        let _ = self.out.send(message);
    }

    /// Sends a notification.
    pub fn notify(&self, method: &str, params: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    /// Sends a request to the client and waits for its answer; the connection closing ends the
    /// wait with `daemon_unavailable`. An error answer comes back as its JSON-RPC error object.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, ContractError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending lock").insert(id, tx);
        let _pending = PendingGuard { peer: self, id };
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let gone = || {
            ContractError::new(
                ErrorCode::DaemonUnavailable,
                "The client left before it answered.",
            )
        };
        tokio::select! {
            reply = rx => match reply {
                Ok(Ok(result)) => Ok(result),
                Ok(Err(error)) => Err(ContractError::new(
                    ErrorCode::Internal,
                    format!("The client answered {method} with an error: {error}"),
                )),
                Err(_) => Err(gone()),
            },
            () = self.closed.cancelled() => Err(gone()),
        }
    }

    /// Whether the connection has closed.
    pub fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    /// How many requests to the client wait for their answer.
    pub fn waiting(&self) -> usize {
        self.pending.lock().expect("pending lock").len()
    }

    pub(crate) fn settle(&self, id: &Value, reply: Reply) {
        let Some(id) = id.as_u64() else {
            return;
        };
        if let Some(tx) = self.pending.lock().expect("pending lock").remove(&id) {
            let _ = tx.send(reply);
        }
    }

    fn respond(&self, id: Value, outcome: Result<Value, ContractError>) {
        let message = match outcome {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error_object(&error)}),
        };
        self.send(message);
    }
}

/// A peer with no connection behind it: what it sends arrives on the receiver, and an answer to
/// one of its requests is given with [`Peer::answer`]. Cancelling the token closes it.
pub fn detached_peer() -> (Arc<Peer>, mpsc::UnboundedReceiver<Value>, CancellationToken) {
    let (tx, rx) = mpsc::unbounded_channel();
    let closed = CancellationToken::new();
    (Arc::new(Peer::new(tx, closed.clone())), rx, closed)
}

impl Peer {
    /// Answers the request `id` this peer sent, as the client would.
    pub fn answer(&self, id: &Value, result: Value) {
        self.settle(id, Ok(result));
    }
}

/// A contract error as a JSON-RPC error object: the family's number, the message, the data.
pub fn error_object(error: &ContractError) -> Value {
    json!({
        "code": error.number(),
        "message": error.message,
        "data": serde_json::to_value(&error.data).unwrap_or(Value::Null),
    })
}

/// What a method gets besides its parameters.
pub struct RequestContext {
    pub client: Arc<ClientEntry>,
    /// Cancelled when the client cancels the request, the connection closes or the daemon ends.
    pub cancel: CancellationToken,
    progress: Option<Value>,
    after_reply: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl RequestContext {
    /// A context for a request of `client`, cancelled through `cancel`, without progress.
    pub fn new(client: Arc<ClientEntry>, cancel: CancellationToken) -> Self {
        Self {
            client,
            cancel,
            progress: None,
            after_reply: Mutex::new(Vec::new()),
        }
    }

    /// Reports progress, when the client asked for it.
    pub fn progress(&self, value: Value) {
        if let Some(token) = &self.progress {
            self.client
                .peer
                .notify("$/progress", json!({"token": token, "value": value}));
        }
    }

    /// Runs `action` once the answer to this request is queued for the client.
    pub fn after_reply(&self, action: impl FnOnce() + Send + 'static) {
        self.after_reply
            .lock()
            .expect("after-reply lock")
            .push(Box::new(action));
    }
}

/// Lowercase hex of at least 32 digits.
fn is_nonce(text: &str) -> bool {
    text.len() >= 32 && text.len() <= 256 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Compares two strings in time that does not depend on where they differ.
fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A request's id and params, if `message` is a request for `method`.
fn request_for(message: &Value, method: &str) -> Option<(Value, Value)> {
    let id = message.get("id")?.clone();
    (message.get("method")?.as_str()? == method)
        .then(|| (id, message.get("params").cloned().unwrap_or(Value::Null)))
}

/// Serves one connection until it closes or the daemon ends.
pub async fn serve(stream: Box<dyn Duplex>, shared: Arc<Shared>, daemon: Arc<Daemon>) {
    let _guard = shared.connection_opened();
    let (reader, writer) = tokio::io::split(stream);
    let mut reader = FramedRead::new(reader, JsonRpcCodec::default());
    let (out_tx, out_rx) = mpsc::unbounded_channel::<Value>();
    let closed = CancellationToken::new();
    let peer = Arc::new(Peer::new(out_tx, closed.clone()));
    let writer_task = tokio::spawn(write_loop(
        writer,
        out_rx,
        closed.clone(),
        peer.backlog.clone(),
        WRITE_STALL,
    ));
    let hello = tokio::time::timeout(HELLO_TIMEOUT, hello(&mut reader, &peer, &shared));
    let accepted = tokio::select! {
        outcome = hello => outcome.ok().flatten(),
        () = shared.shutdown().cancelled() => None,
    };
    let Some((info, contract_version)) = accepted else {
        closed.cancel();
        drop(peer);
        let _ = writer_task.await;
        return;
    };
    let client = shared.add_client(info, contract_version, peer.clone());
    shared.log.write(
        crate::log::Level::Info,
        Some(&client.info.name),
        &format!(
            "Connected: {} {} ({}).",
            client.info.kind, client.info.version, client.info.build_kind
        ),
    );
    if let Some(mismatch) = crate::lifecycle::contract_mismatch(contract_version) {
        shared
            .log
            .write(crate::log::Level::Warn, Some(&client.info.name), &mismatch);
    }

    let in_flight: Arc<Mutex<HashMap<String, CancellationToken>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let requests = tokio_util::task::TaskTracker::new();
    let mut ended_by_daemon = false;
    loop {
        let message = tokio::select! {
            message = reader.next() => message,
            () = shared.shutdown().cancelled() => {
                ended_by_daemon = true;
                break;
            }
            () = closed.cancelled() => break,
        };
        let message = match message {
            Some(Ok(message)) => message,
            Some(Err(error)) => {
                shared.log.write(
                    crate::log::Level::Warn,
                    Some(&client.info.name),
                    &format!("Connection closed: {error}."),
                );
                break;
            }
            None => break,
        };
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned();
        match (method, id) {
            (Some(method), Some(id)) => {
                let method = method.to_string();
                let mut params = message.get("params").cloned().unwrap_or(Value::Null);
                let progress = params
                    .as_object_mut()
                    .and_then(|object| object.remove(PROGRESS_TOKEN));
                let cancel = closed.child_token();
                let key = id.to_string();
                in_flight
                    .lock()
                    .expect("in-flight lock")
                    .insert(key.clone(), cancel.clone());
                let cx = RequestContext {
                    client: client.clone(),
                    cancel: cancel.clone(),
                    progress,
                    after_reply: Mutex::new(Vec::new()),
                };
                let daemon = daemon.clone();
                let in_flight = in_flight.clone();
                let shutdown = shared.shutdown().clone();
                requests.spawn(async move {
                    let refusal =
                        crate::lifecycle::contract_refusal(cx.client.contract_version, &method);
                    let outcome = match refusal {
                        Some(refusal) => Err(refusal),
                        None => tokio::select! {
                            outcome = ev3_contract::dispatch(&*daemon, &cx, cx.client.kind(), &method, params) => outcome,
                            () = cancel.cancelled() => Err(cancelled(&method)),
                            () = shutdown.cancelled() => Err(cancelled(&method)),
                        },
                    };
                    in_flight.lock().expect("in-flight lock").remove(&key);
                    cx.client.peer.respond(id, outcome);
                    let actions = std::mem::take(&mut *cx.after_reply.lock().expect("after-reply lock"));
                    for action in actions {
                        action();
                    }
                });
            }
            (Some("$/cancelRequest"), None) => {
                if let Some(id) = message.get("params").and_then(|p| p.get("id")) {
                    let token = in_flight
                        .lock()
                        .expect("in-flight lock")
                        .get(&id.to_string())
                        .cloned();
                    if let Some(token) = token {
                        token.cancel();
                    }
                }
            }
            // Progress on a request the daemon sent, and any notification it does not take.
            (Some(_), None) => {}
            (None, Some(id)) => {
                if let Some(result) = message.get("result") {
                    client.peer.settle(&id, Ok(result.clone()));
                } else if let Some(error) = message.get("error") {
                    client.peer.settle(&id, Err(error.clone()));
                }
            }
            (None, None) => {}
        }
    }

    // Requests still running are cancelled and answered; then the writer drains and ends.
    for token in in_flight.lock().expect("in-flight lock").values() {
        token.cancel();
    }
    requests.close();
    let _ = tokio::time::timeout(Duration::from_secs(1), requests.wait()).await;
    shared.remove_client(client.id);
    daemon.client_left(&client);
    shared.log.write(
        crate::log::Level::Info,
        Some(&client.info.name),
        "Disconnected.",
    );
    drop(client);
    drop(peer);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer_task).await;
    if ended_by_daemon {
        // The answers are written; a client that handles incoming messages on a later tick
        // than the stream's end would still lose them if the daemon closed at once. It gets a
        // moment to read them and close first.
        let _ = tokio::time::timeout(LINGER, async {
            while let Some(Ok(_)) = reader.next().await {}
        })
        .await;
    }
    closed.cancel();
}

/// Writes what is queued for one client until every sender is gone or `closed` is cancelled. A
/// write that does not finish within `stall`, or a closing connection, ends it even in the middle of
/// a message, so a client that stopped reading never holds the writer; a broken stream ends it too.
/// Ending it closes the connection.
async fn write_loop<W>(
    writer: W,
    mut out: mpsc::UnboundedReceiver<Value>,
    closed: CancellationToken,
    backlog: Arc<AtomicUsize>,
    stall: Duration,
) where
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut sink = FramedWrite::new(writer, JsonRpcCodec::default());
    loop {
        let message = tokio::select! {
            message = out.recv() => message,
            () = closed.cancelled() => None,
        };
        let Some(message) = message else { break };
        let written = tokio::select! {
            written = tokio::time::timeout(stall, sink.send(message)) => matches!(written, Ok(Ok(()))),
            () = closed.cancelled() => false,
        };
        if !written {
            break;
        }
        backlog.fetch_sub(1, Ordering::SeqCst);
    }
    closed.cancel();
}

/// How long the daemon waits for a client to close first when the daemon ends the connection.
const LINGER: Duration = Duration::from_millis(250);

fn cancelled(method: &str) -> ContractError {
    ContractError::new(ErrorCode::Cancelled, format!("{method} was cancelled."))
}

/// Runs the hello; the client's identity and contract version once it proved it holds the key,
/// `None` when the connection must close. A client on another contract version finishes the hello
/// like any other: it reads the daemon's version and decides itself.
async fn hello<R>(
    reader: &mut FramedRead<R, JsonRpcCodec>,
    peer: &Peer,
    shared: &Shared,
) -> Option<(ClientInfo, u64)>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let first = reader.next().await?.ok()?;
    let (id, params) = request_for(&first, HELLO_START)?;
    let start: HelloStart = serde_json::from_value(params).ok()?;
    let name_len = start.client_name.chars().count();
    if !is_nonce(&start.client_nonce) || name_len == 0 || name_len > 200 {
        return None;
    }
    let daemon_nonce = crate::hex(&crate::random_bytes::<32>());
    let challenge = HelloChallenge {
        daemon_proof: daemon_proof(&shared.key, &start.client_nonce, &daemon_nonce),
        daemon_nonce: daemon_nonce.clone(),
    };
    peer.respond(id, Ok(serde_json::to_value(challenge).ok()?));

    let second = reader.next().await?.ok()?;
    let (id, params) = request_for(&second, HELLO_FINISH)?;
    let finish: HelloFinish = serde_json::from_value(params).ok()?;
    let expected = client_proof(&shared.key, &start.client_nonce, &daemon_nonce);
    if !same_secret(&expected, &finish.client_proof) {
        shared.log.warn(&format!(
            "A client calling itself {:?} could not prove it holds the key; connection closed.",
            start.client_name
        ));
        return None;
    }
    let identity = &shared.identity;
    let accepted = HelloAccepted {
        version: identity.version.clone(),
        contract_version: std::num::NonZeroU64::new(u64::from(CONTRACT_VERSION))
            .expect("the contract version is at least 1"),
        build_kind: identity.build_kind.to_string(),
        build_id: identity.build_id.clone(),
        mode: identity.mode.to_string(),
        pid: u64::from(identity.pid),
        instance_id: identity.instance_id.clone(),
        state: Some(
            if shared.exiting() {
                "exiting"
            } else {
                "serving"
            }
            .into(),
        ),
        transports: shared.transports(),
    };
    peer.respond(id, Ok(serde_json::to_value(accepted).ok()?));
    Some((
        ClientInfo {
            name: String::from(start.client_name),
            kind: ClientKind::read_open(&start.client_kind),
            version: start.version,
            build_kind: BuildKind::read_open(&start.build_kind),
        },
        start.contract_version.get(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_compare_equal_only_when_equal() {
        assert!(same_secret("abcd", "abcd"));
        assert!(!same_secret("abcd", "abce"));
        assert!(!same_secret("abcd", "abc"));
    }

    #[test]
    fn a_nonce_is_hex_of_at_least_32_digits() {
        assert!(is_nonce(&"0a".repeat(16)));
        assert!(!is_nonce(&"0a".repeat(15)));
        assert!(!is_nonce(&"zz".repeat(16)));
    }

    #[test]
    fn the_schema_states_the_hello_limits_the_daemon_enforces() {
        let start = |nonce: String, name: String| {
            serde_json::from_value::<HelloStart>(serde_json::json!({
                "clientNonce": nonce,
                "clientName": name,
                "clientKind": "cli",
                "version": "1.0.0",
                "contractVersion": 1,
                "buildKind": "release",
            }))
        };
        let nonce = "0a".repeat(16);
        assert!(start(nonce.clone(), "ev3 (terminal)".into()).is_ok());
        assert!(
            start("0a".repeat(15), "x".into()).is_err(),
            "nonce too short"
        );
        assert!(
            start("0".repeat(257), "x".into()).is_err(),
            "nonce too long"
        );
        assert!(start(nonce.clone(), String::new()).is_err(), "empty name");
        assert!(
            start(nonce.clone(), "Ǝ".repeat(200)).is_ok(),
            "200 characters"
        );
        assert!(start(nonce, "x".repeat(201)).is_err(), "name too long");
    }

    #[test]
    fn an_error_object_carries_the_family_number_and_the_data() {
        let error = ContractError::new(ErrorCode::NoProvider, "no transport");
        let object = error_object(&error);
        assert_eq!(object["code"], 1000);
        assert_eq!(object["message"], "no transport");
        assert_eq!(object["data"]["code"], "no_provider");
        assert_eq!(object["data"]["family"], "brick");
    }

    #[test]
    fn a_client_that_lets_the_backlog_pile_up_has_its_connection_closed() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        let peer = Peer::new(tx, closed.clone());
        for _ in 0..MAX_BACKLOG {
            peer.notify("telemetry/update", json!({}));
        }
        assert!(
            !closed.is_cancelled(),
            "a full backlog alone is still served"
        );
        peer.notify("telemetry/update", json!({}));
        assert!(closed.is_cancelled(), "one more closes the connection");
    }

    #[tokio::test]
    async fn the_writer_lets_go_of_a_client_that_stopped_reading() {
        // A pipe of 64 bytes the client never reads: the first large message blocks the write.
        let (writer, _client_never_reads) = tokio::io::duplex(64);
        let (tx, rx) = mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        let backlog = Arc::new(AtomicUsize::new(1));
        tx.send(json!({"big": "x".repeat(10_000)})).expect("queued");
        let writing = tokio::spawn(write_loop(
            writer,
            rx,
            closed.clone(),
            backlog,
            Duration::from_secs(3600),
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!writing.is_finished(), "the write is blocked");
        closed.cancel();
        tokio::time::timeout(Duration::from_secs(2), writing)
            .await
            .expect("closing the connection ends a blocked write")
            .expect("task");

        // A write that stalls longer than allowed ends the writer and closes the connection.
        let (writer, _client_never_reads) = tokio::io::duplex(64);
        let (tx, rx) = mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        tx.send(json!({"big": "x".repeat(10_000)})).expect("queued");
        tokio::time::timeout(
            Duration::from_secs(2),
            write_loop(
                writer,
                rx,
                closed.clone(),
                Arc::new(AtomicUsize::new(1)),
                Duration::from_millis(50),
            ),
        )
        .await
        .expect("a stalled write ends the writer");
        assert!(closed.is_cancelled());
    }

    #[tokio::test]
    async fn a_request_to_the_client_gets_its_answer_or_ends_when_the_connection_closes() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        let peer = Arc::new(Peer::new(tx, closed.clone()));

        let asking = tokio::spawn({
            let peer = peer.clone();
            async move {
                peer.request("question/ask", json!({"kind": "restart"}))
                    .await
            }
        });
        let sent = rx.recv().await.expect("the request went out");
        assert_eq!(sent["method"], "question/ask");
        peer.settle(&sent["id"], Ok(json!({"answer": "yes"})));
        let answer = asking.await.expect("task").expect("answered");
        assert_eq!(answer, json!({"answer": "yes"}));

        let waiting = tokio::spawn({
            let peer = peer.clone();
            async move { peer.request("question/ask", json!({})).await }
        });
        rx.recv().await.expect("the second request went out");
        closed.cancel();
        let error = waiting.await.expect("task").expect_err("the client left");
        assert_eq!(error.data.code, ErrorCode::DaemonUnavailable);
    }
}
