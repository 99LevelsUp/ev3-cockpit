//! A JSON-RPC 2.0 client over one connection to the daemon, framed as `docs/channel.md` says.
//!
//! - Requests run concurrently; dropping a request's future before its answer sends
//!   `$/cancelRequest`, which the daemon answers with `cancelled`.
//! - A request that wants progress carries `params.__progressToken`; `$/progress` for it goes to
//!   the caller's handler.
//! - Notifications go to every subscriber of [`Endpoint::notifications`], in order.
//! - The daemon's requests (`question/ask`) go to the handler given at creation.
//! - When the connection closes, every request still waiting fails with `daemon_unavailable`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ev3_channel::codec::JsonRpcCodec;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_util::codec::Framed;

use crate::error::{CliError, Result};

/// A connected pipe or socket.
pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

/// Answers a request the daemon sends this client.
pub type RequestHandler =
    Arc<dyn Fn(String, Value) -> Pin<Box<dyn Future<Output = Value> + Send>> + Send + Sync>;

type Answer = std::result::Result<Value, CliError>;
type ProgressHandler = Box<dyn Fn(Value) + Send>;

struct Shared {
    pending: Mutex<HashMap<u64, oneshot::Sender<Answer>>>,
    progress: Mutex<HashMap<String, ProgressHandler>>,
    closed: watch::Sender<bool>,
}

/// One connection to the daemon.
#[derive(Clone)]
pub struct Endpoint {
    out: mpsc::UnboundedSender<Value>,
    shared: Arc<Shared>,
    next_id: Arc<AtomicU64>,
    notifications: broadcast::Sender<(String, Value)>,
    closed: watch::Receiver<bool>,
    /// True once the reader saw the end of the stream.
    read_done: watch::Receiver<bool>,
}

/// Marks the reader finished however its task ends.
struct DoneOnDrop(watch::Sender<bool>);

impl Drop for DoneOnDrop {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

/// How many notifications a slow subscriber may fall behind before it misses some.
const NOTIFICATION_BACKLOG: usize = 4096;

impl Endpoint {
    /// Starts reading and writing `stream` on the current runtime.
    pub fn new(stream: Box<dyn Duplex>, on_request: Option<RequestHandler>) -> Self {
        let (out, mut outgoing) = mpsc::unbounded_channel::<Value>();
        let (closed_tx, closed) = watch::channel(false);
        let (notifications, _) = broadcast::channel(NOTIFICATION_BACKLOG);
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
            closed: closed_tx,
        });
        let (mut sink, mut source) = Framed::new(stream, JsonRpcCodec::default()).split();

        let writer_closed = closed.clone();
        tokio::spawn(async move {
            let stop = until_closed(writer_closed);
            tokio::pin!(stop);
            loop {
                tokio::select! {
                    message = outgoing.recv() => match message {
                        Some(message) => if sink.send(message).await.is_err() { break },
                        None => break,
                    },
                    () = &mut stop => break,
                }
            }
            let _ = sink.close().await;
        });

        let reader_shared = Arc::clone(&shared);
        let reader_out = out.clone();
        let reader_notifications = notifications.clone();
        let (read_done_tx, read_done) = watch::channel(false);
        tokio::spawn(async move {
            let _done = DoneOnDrop(read_done_tx);
            while let Some(Ok(message)) = source.next().await {
                dispatch(
                    message,
                    &reader_shared,
                    &reader_out,
                    &reader_notifications,
                    on_request.as_ref(),
                );
            }
            reader_shared.closed.send_replace(true);
            let waiting: Vec<_> = reader_shared
                .pending
                .lock()
                .expect("pending")
                .drain()
                .collect();
            for (_, answer) in waiting {
                let _ = answer.send(Err(CliError::unavailable(
                    "The connection closed before the answer came.",
                )));
            }
        });

        Self {
            out,
            shared,
            next_id: Arc::new(AtomicU64::new(1)),
            notifications,
            closed,
            read_done,
        }
    }

    /// Closes this side and waits, briefly, until the daemon closed its side too and everything it
    /// sent was read. A process that ends with unread data makes the kernel reset the connection,
    /// which the daemon logs as a failure.
    /// A named pipe has no half-close, and no reset either: on Windows this only closes.
    pub async fn shutdown(&self) {
        self.close();
        if cfg!(unix) {
            let done = until_closed(self.read_done.clone());
            let _ = tokio::time::timeout(Duration::from_millis(500), done).await;
        }
    }

    /// Hears every notification from now on.
    pub fn notifications(&self) -> broadcast::Receiver<(String, Value)> {
        self.notifications.subscribe()
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Resolves once the connection is closed, by either side.
    pub fn closed(&self) -> impl Future<Output = ()> + Send + 'static {
        until_closed(self.closed.clone())
    }

    /// Sends a request without waiting for its answer, which is dropped when it comes: for a
    /// clean-up that must happen even when its caller goes away, as when a subscription is
    /// dropped by a cancelled tool call.
    pub fn send_and_forget(&self, method: &str, params: Value) {
        if self.is_closed() {
            return;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let _ = self
            .out
            .send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
    }

    /// Closes the connection; requests still waiting fail.
    pub fn close(&self) {
        self.shared.closed.send_replace(true);
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_with_progress(method, params, None).await
    }

    /// A request whose `$/progress` goes to `on_progress`.
    pub async fn request_with_progress(
        &self,
        method: &str,
        mut params: Value,
        on_progress: Option<ProgressHandler>,
    ) -> Result<Value> {
        if self.is_closed() {
            return Err(CliError::unavailable(
                "The connection to the cockpit daemon is closed.",
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let token = on_progress.map(|handler| {
            let token = format!("p{id}");
            self.shared
                .progress
                .lock()
                .expect("progress")
                .insert(token.clone(), handler);
            token
        });
        if let (Some(token), Some(object)) = (&token, params.as_object_mut()) {
            object.insert("__progressToken".into(), Value::String(token.clone()));
        }
        let (answer_tx, answer_rx) = oneshot::channel();
        self.shared
            .pending
            .lock()
            .expect("pending")
            .insert(id, answer_tx);
        let mut guard = Cancel {
            endpoint: self,
            id,
            token,
            done: false,
        };
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self.out.send(message).is_err() {
            guard.done = true;
            return Err(CliError::unavailable(
                "The connection to the cockpit daemon is closed.",
            ));
        }
        let answer = answer_rx.await.unwrap_or_else(|_| {
            Err(CliError::unavailable(
                "The connection closed before the answer came.",
            ))
        });
        guard.done = true;
        answer
    }
}

/// Resolves once `closed` reads true (or its sender is gone).
async fn until_closed(mut closed: watch::Receiver<bool>) {
    loop {
        if *closed.borrow_and_update() {
            return;
        }
        if closed.changed().await.is_err() {
            return;
        }
    }
}

/// Sends `$/cancelRequest` when a request's future is dropped before its answer came.
struct Cancel<'a> {
    endpoint: &'a Endpoint,
    id: u64,
    token: Option<String>,
    done: bool,
}

impl Drop for Cancel<'_> {
    fn drop(&mut self) {
        if let Some(token) = &self.token {
            self.endpoint
                .shared
                .progress
                .lock()
                .expect("progress")
                .remove(token);
        }
        if self.done {
            return;
        }
        let waiting = self
            .endpoint
            .shared
            .pending
            .lock()
            .expect("pending")
            .remove(&self.id)
            .is_some();
        if waiting {
            let _ = self.endpoint.out.send(json!({
                "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": self.id },
            }));
        }
    }
}

/// Whole numbers the daemon wrote as floats (`3.0`) read as integers, as a JavaScript client reads
/// them, so what `ev3` prints is what the TypeScript clients printed.
fn whole_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            if let Some(f) = number.as_f64()
                && !number.is_i64()
                && !number.is_u64()
                && f.fract() == 0.0
                && f.abs() < 9_007_199_254_740_992.0
            {
                *value = Value::from(f as i64);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(whole_numbers),
        Value::Object(map) => map.values_mut().for_each(whole_numbers),
        _ => {}
    }
}

fn dispatch(
    mut message: Value,
    shared: &Arc<Shared>,
    out: &mpsc::UnboundedSender<Value>,
    notifications: &broadcast::Sender<(String, Value)>,
    on_request: Option<&RequestHandler>,
) {
    whole_numbers(&mut message);
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let id = message.get("id").cloned();
    match (method.as_deref(), id) {
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            let Some(answer) = shared.pending.lock().expect("pending").remove(&id) else {
                return;
            };
            let _ = answer.send(match message.get("error") {
                Some(error) => Err(wire_error(error)),
                None => Ok(take(&mut message, "result")),
            });
        }
        (Some(method), Some(id)) => {
            let params = take(&mut message, "params");
            let out = out.clone();
            let handler = on_request.cloned();
            let method = method.to_owned();
            tokio::spawn(async move {
                let reply = match handler {
                    Some(handler) => {
                        json!({ "jsonrpc": "2.0", "id": id, "result": handler(method, params).await })
                    }
                    None => json!({
                        "jsonrpc": "2.0", "id": id,
                        "error": { "code": -32601, "message": format!("{method} is not handled by this client.") },
                    }),
                };
                let _ = out.send(reply);
            });
        }
        (Some("$/progress"), None) => {
            let mut params = take(&mut message, "params");
            let token = params
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if let Some(handler) = shared.progress.lock().expect("progress").get(&token) {
                handler(take(&mut params, "value"));
            }
        }
        (Some(method), None) => {
            let _ = notifications.send((method.to_owned(), take(&mut message, "params")));
        }
        (None, None) => {}
    }
}

/// The member `key` of a message this side owns, moved out rather than copied; `Null` when absent.
fn take(message: &mut Value, key: &str) -> Value {
    message.get_mut(key).map(Value::take).unwrap_or(Value::Null)
}

/// A wire error as this side reads it: the contract code from `data.code`.
fn wire_error(error: &Value) -> CliError {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("The cockpit daemon refused the request.")
        .to_owned();
    match error.get("data") {
        Some(data) if data.get("code").and_then(Value::as_str).is_some() => CliError::Contract {
            code: data["code"].as_str().unwrap_or_default().to_owned(),
            message,
            data: data.clone(),
        },
        _ => CliError::contract("invalid_request", message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wire_error_keeps_its_contract_code_and_extras() {
        let error = wire_error(&json!({
            "code": -32001, "message": "CCC is busy",
            "data": { "code": "brick_busy", "family": "busy", "holder": "VS Code" },
        }));
        assert_eq!(error.code(), Some("brick_busy"));
        assert_eq!(error.json()["holder"], "VS Code");
        assert_eq!(
            wire_error(&json!({ "code": -32600, "message": "bad" })).code(),
            Some("invalid_request")
        );
    }

    #[test]
    fn whole_floats_read_as_integers_and_fractions_stay() {
        let mut value = json!({ "a": 3.0, "b": [7.5, -2.0], "c": "3.0", "d": 4 });
        whole_numbers(&mut value);
        assert_eq!(value.to_string(), r#"{"a":3,"b":[7.5,-2],"c":"3.0","d":4}"#);
    }

    #[tokio::test]
    async fn answers_notifications_and_a_close_reach_the_right_callers() {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let endpoint = Endpoint::new(Box::new(ours), None);
        let mut heard = endpoint.notifications();
        let (mut daemon_sink, mut daemon_source) =
            Framed::new(theirs, JsonRpcCodec::default()).split();
        let call = tokio::spawn({
            let endpoint = endpoint.clone();
            async move { endpoint.request("daemon/status", json!({})).await }
        });
        let request = daemon_source
            .next()
            .await
            .expect("a request")
            .expect("framed");
        assert_eq!(request["method"], "daemon/status");
        daemon_sink
            .send(
                json!({ "jsonrpc": "2.0", "method": "bricks/changed", "params": { "bricks": [] } }),
            )
            .await
            .expect("notify");
        daemon_sink
            .send(json!({ "jsonrpc": "2.0", "id": request["id"], "result": { "pid": 7 } }))
            .await
            .expect("answer");
        assert_eq!(call.await.expect("joined").expect("answer")["pid"], 7);
        assert_eq!(heard.recv().await.expect("heard").0, "bricks/changed");

        let waiting = tokio::spawn({
            let endpoint = endpoint.clone();
            async move { endpoint.request("bricks/list", json!({})).await }
        });
        let _ = daemon_source.next().await;
        drop(daemon_sink);
        drop(daemon_source);
        let error = waiting.await.expect("joined").expect_err("closed");
        assert_eq!(error.code(), Some("daemon_unavailable"));
        assert!(endpoint.is_closed());
    }
}
