//! One client's connection to the daemon: the launch, the hello, the bricks as last heard, and the
//! daemon's questions for a person.
//!
//! `ev3` never reconnects by itself: a command is short, and a restart reconnects on purpose.
//! `ev3 mcp` connects again on the next tool call after its daemon went (see its `mcp.rs`).

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use ev3_channel::paths::Paths;
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::connect::{DaemonIdentity, Identity};
use crate::endpoint::{Endpoint, RequestHandler};
use crate::ensure::{self, Options};
use crate::error::Failure;
use crate::error::{ClientError, DAEMON_UNAVAILABLE, Result};
use crate::launch::{LaunchSpec, installed_launch};

/// Answers a question for a person: the question, and a receiver of withdrawn question ids.
pub type Asker = Arc<
    dyn Fn(Value, broadcast::Receiver<String>) -> Pin<Box<dyn Future<Output = Value> + Send>>
        + Send
        + Sync,
>;

pub struct ClientOptions<'a> {
    /// Shown in the daemon's log, in other clients' `brick_busy` and in questions.
    pub name: String,
    /// `cli`, `mcp` or `addon`; only `cli` may ask a daemon to exit for its own.
    pub kind: &'static str,
    /// This client's version and build kind (`release` or `development`), as its hello says.
    pub version: &'a str,
    pub build_kind: &'a str,
    /// Which daemon this client starts when none runs.
    pub daemon: Launch,
    pub paths: &'a Paths,
    /// More arguments for a daemon this client starts; empty outside tests.
    pub daemon_args: Vec<String>,
    /// Who answers the daemon's questions; without one every answer is `keep` (unanswered).
    pub asker: Option<Asker>,
    pub notice: &'a (dyn Fn(&str) + Sync),
}

/// Which daemon a client starts when none runs.
#[derive(Debug, Clone)]
pub enum Launch {
    /// The daemon this client carries, or why it carries none (`ev3`); a missing one is an error
    /// only when no daemon runs.
    Carried(Result<LaunchSpec>),
    /// The daemon the installed cockpit recorded in `install.json`: what an add-on starts.
    Installed,
    /// None: the client works only with a daemon that runs.
    Nothing,
}

pub struct Client {
    pub endpoint: Endpoint,
    pub daemon: DaemonIdentity,
    /// The bricks as last heard: `None` until a command first looks one up (most never do), then
    /// kept current by `bricks/changed`.
    bricks: Arc<Mutex<Option<Vec<Value>>>>,
}

impl Client {
    /// Connects, starting or replacing the daemon as needed.
    pub async fn connect(options: ClientOptions<'_>) -> Result<Self> {
        let (withdrawn_tx, _) = broadcast::channel::<String>(64);
        let on_request: RequestHandler = {
            let asker = options.asker.clone();
            let withdrawn = withdrawn_tx.clone();
            Arc::new(move |method: String, params: Value| {
                let asker = asker.clone();
                let withdrawn = withdrawn.subscribe();
                Box::pin(async move {
                    match (method.as_str(), asker) {
                        ("question/ask", Some(asker)) => asker(params, withdrawn).await,
                        _ => json!({ "answer": "keep" }),
                    }
                })
            })
        };
        let daemon = match options.daemon {
            Launch::Carried(daemon) => daemon,
            Launch::Installed => installed_launch(&options.paths.dir).ok_or_else(|| {
                ClientError::start(
                    Failure::MissingBinary,
                    "No cockpit daemon runs and EVƎ Cockpit has not recorded one to start: install EVƎ Cockpit, or run its ev3 command once.",
                )
            }),
            Launch::Nothing => Err(ClientError::start(
                Failure::MissingBinary,
                "No cockpit daemon runs, and this client starts none.",
            )),
        };
        // Only `ev3` itself carries a daemon it would replace another with; a missing one is an
        // error only when no daemon runs.
        let carried = daemon.as_ref().ok().cloned();
        let connected = ensure::ensure(&Options {
            identity: Identity {
                name: options.name,
                kind: options.kind.into(),
                version: options.version.into(),
                build_kind: options.build_kind.into(),
            },
            daemon: carried,
            paths: options.paths,
            may_replace: options.kind == "cli",
            daemon_args: options.daemon_args,
            on_request: Some(on_request),
            notice: options.notice,
        })
        .await
        .map_err(|error| match (&error, daemon) {
            // No daemon ran and none could be started: say why this one is missing.
            (ClientError::Start { .. }, Err(missing))
                if error.message().contains("carries none") =>
            {
                missing
            }
            _ => error,
        })?;
        let endpoint = connected.endpoint;
        let bricks = Arc::new(Mutex::new(None));
        let mut heard = endpoint.notifications();
        let listen_bricks = Arc::clone(&bricks);
        tokio::spawn(async move {
            while let Ok((method, params)) = heard.recv().await {
                match method.as_str() {
                    "bricks/changed" => {
                        if let Some(list) = params.get("bricks").and_then(Value::as_array) {
                            *listen_bricks.lock().expect("bricks") = Some(list.clone());
                        }
                    }
                    "question/withdrawn" => {
                        if let Some(id) = params.get("questionId").and_then(Value::as_str) {
                            let _ = withdrawn_tx.send(id.to_owned());
                        }
                    }
                    _ => {}
                }
            }
        });
        Ok(Self {
            endpoint,
            daemon: connected.daemon,
            bricks,
        })
    }

    /// A request. A write cut off by the daemon going may or may not have happened; it is never
    /// retried, and says so.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let result = self.endpoint.request(method, params).await;
        leased_outcome(method, result)
    }

    /// The daemon's notifications to this client from now on, typed (see [`Events`]).
    pub fn events(&self) -> crate::Events {
        crate::Events::new(&self.endpoint)
    }

    /// Follows `brick`'s program: the state now, then every change in order (see
    /// [`crate::ProgramStates`]). Dropping it cancels the subscription.
    pub async fn subscribe_programs(&self, brick: &str) -> Result<crate::ProgramStates> {
        crate::ProgramStates::subscribe(&self.endpoint, brick).await
    }

    /// Follows `path` on `brick` as it grows, from `from_offset` (0 when `None`): every growth in
    /// order (see [`crate::FileFollow`]). Dropping it cancels the follow.
    pub async fn follow_file(
        &self,
        brick: &str,
        path: &str,
        from_offset: Option<u64>,
    ) -> Result<crate::FileFollow> {
        crate::FileFollow::follow(&self.endpoint, brick, path, from_offset).await
    }

    /// A typed request: `client.call::<method::BricksList>(params)`. The answer is decoded into the
    /// method's result type; one that does not decode is an `internal` error naming the method.
    pub async fn call<M: ev3_contract::Method>(&self, params: M::Params) -> Result<M::Result> {
        let params = serde_json::to_value(&params).map_err(|error| {
            ClientError::contract(
                "invalid_request",
                format!("The parameters of {} do not encode ({error}).", M::NAME),
            )
        })?;
        let answer = self.request(M::NAME, params).await?;
        serde_json::from_value(answer).map_err(|error| {
            ClientError::contract(
                "internal",
                format!(
                    "The daemon's answer to {} does not decode ({error}).",
                    M::NAME
                ),
            )
        })
    }

    /// A request whose progress goes to `on_progress`.
    pub async fn request_with_progress(
        &self,
        method: &str,
        params: Value,
        on_progress: Box<dyn Fn(Value) + Send>,
    ) -> Result<Value> {
        let result = self
            .endpoint
            .request_with_progress(method, params, Some(on_progress))
            .await;
        leased_outcome(method, result)
    }

    /// Asks for the brick list the first time anything needs it; from then on `bricks/changed`
    /// keeps it current.
    async fn known_bricks(&self) -> Result<()> {
        if self.bricks.lock().expect("bricks").is_none() {
            let list = self.request("bricks/list", json!({})).await?;
            let list = list
                .get("bricks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            // A bricks/changed heard meanwhile is newer than this answer: it stays.
            self.bricks.lock().expect("bricks").get_or_insert(list);
        }
        Ok(())
    }

    /// The bricks as last heard, typed: asked for once, then kept current by `bricks/changed`, so
    /// a client that reads them often costs the daemon one request.
    pub async fn bricks(&self) -> Result<Vec<ev3_contract::ContractBrick>> {
        self.known_bricks().await?;
        let bricks = self.bricks.lock().expect("bricks");
        Ok(bricks
            .iter()
            .flatten()
            .filter_map(|brick| serde_json::from_value(brick.clone()).ok())
            .collect())
    }

    /// A brick as last heard, by its id or its name; the list is asked for the first time a
    /// command looks a brick up.
    pub async fn brick(&self, reference: &str) -> Result<Option<Value>> {
        self.known_bricks().await?;
        let bricks = self.bricks.lock().expect("bricks");
        Ok(find_brick(bricks.as_deref().unwrap_or_default(), reference).cloned())
    }
    /// Makes sure the daemon knows the brick `reference` names: when it does not yet (a brick
    /// never paired, or one this computer forgot), looks for Bluetooth bricks and waits up to
    /// `wait` for it to be heard. Answers whether it is known now.
    pub async fn find_by_inquiry(
        &self,
        reference: &str,
        wait: std::time::Duration,
    ) -> Result<bool> {
        if self.brick(reference).await?.is_some() {
            return Ok(true);
        }
        let mut heard = self.endpoint.notifications();
        self.request("bricks/inquiry", json!({})).await?;
        let found = tokio::time::timeout(wait, async {
            loop {
                if self.brick(reference).await.ok().flatten().is_some() {
                    return true;
                }
                match heard.recv().await {
                    Ok((method, params)) if method == "bricks/changed" => {
                        let list = params
                            .get("bricks")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        if find_brick(&list, reference).is_some() {
                            return true;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return false,
                    _ => {}
                }
            }
        })
        .await;
        Ok(found.unwrap_or(false) || self.brick(reference).await?.is_some())
    }

    /// Closes the connection the way the daemon expects: everything it sent is read first.
    pub async fn shutdown(&self) {
        self.endpoint.shutdown().await;
    }
}

/// The brick of `bricks` that `reference` names: by its id, else by its name in any case.
fn find_brick<'a>(bricks: &'a [Value], reference: &str) -> Option<&'a Value> {
    let wanted = reference.trim().to_lowercase();
    bricks
        .iter()
        .find(|b| b.get("brickId").and_then(Value::as_str) == Some(reference))
        .or_else(|| {
            bricks.iter().find(|b| {
                b.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.trim().to_lowercase() == wanted)
            })
        })
}

fn leased_outcome(method: &str, result: Result<Value>) -> Result<Value> {
    match result {
        Err(error)
            if error.code() == Some(DAEMON_UNAVAILABLE)
                && ev3_contract::method_info(method).is_some_and(|m| m.leased) =>
        {
            Err(ClientError::contract(
                "outcome_unknown",
                format!(
                    "The cockpit daemon went while {method} ran, so whether it finished is not known. It was not retried."
                ),
            ))
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_brick_is_found_by_its_id_or_its_name_in_any_case() {
        let bricks = vec![
            json!({ "brickId": "usb:1", "name": "AAA" }),
            json!({ "brickId": "bt:2", "name": " Bbb " }),
        ];
        assert_eq!(find_brick(&bricks, "usb:1").expect("id")["name"], "AAA");
        assert_eq!(
            find_brick(&bricks, "aaa").expect("name")["brickId"],
            "usb:1"
        );
        assert_eq!(
            find_brick(&bricks, "BBB").expect("trimmed")["brickId"],
            "bt:2"
        );
        assert!(find_brick(&bricks, "CCC").is_none());
    }

    #[test]
    fn a_leased_write_cut_off_is_reported_as_unknown() {
        let cut = || Err(ClientError::unavailable("gone"));
        assert_eq!(
            leased_outcome("files/write", cut())
                .expect_err("cut")
                .code(),
            Some("outcome_unknown")
        );
        assert_eq!(
            leased_outcome("bricks/list", cut())
                .expect_err("cut")
                .code(),
            Some("daemon_unavailable")
        );
    }
}
