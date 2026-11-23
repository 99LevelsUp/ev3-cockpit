//! A client that outlives its daemon, as the TypeScript `CockpitClient` does: for an add-on that
//! runs for a long time (EVƎ C's backend, an MCP server).
//!
//! - When the connection closes (the daemon ended, or another replaced it), the client connects
//!   again by itself, starting the daemon its [`Launch`] names when none runs.
//! - No daemon hands anything to the next. The bricks this client connected without a hold are
//!   connected again on the new daemon, and every program subscription is made again; its reader
//!   gets the fresh state first, then the changes as before.
//! - [`CockpitEvent`] tells a reader what the daemon sends ([`CockpitEvent::Notification`]), that
//!   the client is connected again ([`CockpitEvent::Reconnected`]), or that it could not connect
//!   again ([`CockpitEvent::Lost`]); the next request then tries once more.
//! - A write the daemon was running when it went may or may not have happened: it fails with
//!   `outcome_unknown` and is never sent again, as with [`Client::request`].

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use ev3_contract::{Notification, ProgramState};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use crate::client::{Asker, Client, ClientOptions, Launch};
use crate::connect::DaemonIdentity;
use crate::error::{ClientError, Result};
use crate::events::ProgramStates;
use ev3_channel::paths::Paths;

/// Who connects, owned: what [`ClientOptions`] says, kept for every reconnect.
#[derive(Clone)]
pub struct CockpitOptions {
    pub name: String,
    /// `addon`, `mcp` or `cli`.
    pub kind: &'static str,
    pub version: String,
    /// `release` or `development`.
    pub build_kind: String,
    /// Which daemon is started when none runs; `Launch::Installed` reads install.json again at
    /// every reconnect, so a cockpit installed meanwhile is found.
    pub daemon: Launch,
    pub paths: Paths,
    pub daemon_args: Vec<String>,
    pub asker: Option<Asker>,
    /// Told what the user should know: a development daemon runs, an exit request was refused.
    pub notice: Arc<dyn Fn(&str) + Send + Sync>,
}

/// What a [`Cockpit`] reader hears.
#[derive(Debug, Clone)]
pub enum CockpitEvent {
    /// A notification of the daemon, typed.
    Notification(Notification),
    /// Connected again after the daemon went: the client's own bricks are connected again and its
    /// subscriptions renewed.
    Reconnected(DaemonIdentity),
    /// The daemon went and no daemon could be reached again; the next request tries once more.
    Lost(ClientError),
}

/// A program subscription the cockpit renews: where its states go, and the one on the daemon now.
struct Renewable {
    brick: String,
    sender: mpsc::UnboundedSender<ProgramState>,
    forward: Option<JoinHandle<()>>,
}

struct Inner {
    options: CockpitOptions,
    /// The connection now; replaced at a reconnect. One reconnect at a time.
    current: tokio::sync::Mutex<Option<Arc<Client>>>,
    /// Bricks this client connected without a hold: connected again on a new daemon.
    my_bricks: Mutex<HashSet<String>>,
    renewables: Mutex<HashMap<u64, Renewable>>,
    next_id: AtomicU64,
    events: broadcast::Sender<CockpitEvent>,
    closed: AtomicBool,
}

/// A client of the daemon that connects again by itself; cheap to clone, shared across tasks.
#[derive(Clone)]
pub struct Cockpit {
    inner: Arc<Inner>,
}

impl Cockpit {
    /// Connects, starting the daemon as `options.daemon` says when none runs.
    pub async fn connect(options: CockpitOptions) -> Result<Self> {
        let (events, _) = broadcast::channel(4096);
        let inner = Arc::new(Inner {
            options,
            current: tokio::sync::Mutex::new(None),
            my_bricks: Mutex::new(HashSet::new()),
            renewables: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            events,
            closed: AtomicBool::new(false),
        });
        let client = inner.open().await?;
        *inner.current.lock().await = Some(Arc::clone(&client));
        watch(&inner, &client);
        Ok(Self { inner })
    }

    /// Who the daemon said it is at the last (re)connect.
    pub async fn daemon(&self) -> Option<DaemonIdentity> {
        let current = self.inner.current.lock().await;
        current.as_ref().map(|client| client.daemon.clone())
    }

    /// Everything a reader should hear from now on: the daemon's notifications, reconnects and a
    /// lost daemon.
    pub fn events(&self) -> broadcast::Receiver<CockpitEvent> {
        self.inner.events.subscribe()
    }

    /// An untyped request. A `bricks/connect` without a hold makes the brick one of this client's
    /// own, connected again after a reconnect; a `bricks/disconnect` that is not a hold's release
    /// ends that.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let client = self.inner.client().await?;
        // A brick let go of is named by its name or id; this client remembers ids.
        let released = match (method, params.get("brick").and_then(Value::as_str)) {
            ("bricks/disconnect", Some(reference)) => Some(
                client
                    .brick(reference)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|b| b.get("brickId").and_then(Value::as_str).map(str::to_owned))
                    .unwrap_or_else(|| reference.to_owned()),
            ),
            _ => None,
        };
        let result = client.request(method, params.clone()).await?;
        self.inner
            .remember(method, &params, &result, released.as_deref());
        Ok(result)
    }

    /// A typed request (see [`Client::call`]).
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

    /// The bricks as last heard, typed (see [`Client::bricks`]).
    pub async fn bricks(&self) -> Result<Vec<ev3_contract::ContractBrick>> {
        self.inner.client().await?.bricks().await
    }

    /// Follows `brick`'s program across reconnects: [`CockpitPrograms::state`] now, then every
    /// change in order; after a reconnect the fresh state comes first. Dropping it cancels it.
    pub async fn subscribe_programs(&self, brick: &str) -> Result<CockpitPrograms> {
        let client = self.inner.client().await?;
        let states = client.subscribe_programs(brick).await?;
        let state = states.state.clone();
        let (sender, receiver) = mpsc::unbounded_channel();
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let forward = forward(states, sender.clone());
        self.inner.renewables.lock().expect("renewables").insert(
            id,
            Renewable {
                brick: brick.to_owned(),
                sender,
                forward: Some(forward),
            },
        );
        Ok(CockpitPrograms {
            state,
            receiver,
            id,
            inner: Arc::downgrade(&self.inner),
        })
    }

    /// Closes the connection; no reconnect follows, and subscriptions end.
    pub async fn shutdown(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        let renewables: Vec<Renewable> = self
            .inner
            .renewables
            .lock()
            .expect("renewables")
            .drain()
            .map(|(_, renewable)| renewable)
            .collect();
        for renewable in renewables {
            if let Some(forward) = renewable.forward {
                forward.abort();
            }
        }
        if let Some(client) = self.inner.current.lock().await.take() {
            client.shutdown().await;
        }
    }
}

/// A program subscription of a [`Cockpit`], renewed after every reconnect.
pub struct CockpitPrograms {
    /// The state when the subscription was made.
    pub state: ProgramState,
    receiver: mpsc::UnboundedReceiver<ProgramState>,
    id: u64,
    inner: Weak<Inner>,
}

impl CockpitPrograms {
    /// The next state: every change in order, and after a reconnect the fresh state first; `None`
    /// once the cockpit was shut down.
    pub async fn next(&mut self) -> Option<ProgramState> {
        self.receiver.recv().await
    }
}

impl Drop for CockpitPrograms {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade()
            && let Some(renewable) = inner
                .renewables
                .lock()
                .expect("renewables")
                .remove(&self.id)
            && let Some(forward) = renewable.forward
        {
            // The connection's subscription goes with its task, which cancels it on the daemon.
            forward.abort();
        }
    }
}

/// Hands every change of `states` to `sender`; ends with the connection or the reader. Dropping
/// `states` when the task ends cancels the subscription on the daemon.
fn forward(
    mut states: ProgramStates,
    sender: mpsc::UnboundedSender<ProgramState>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(state) = states.next().await {
            if sender.send(state).is_err() {
                return;
            }
        }
    })
}

/// Passes `client`'s notifications on, and connects again when its connection closes.
fn watch(inner: &Arc<Inner>, client: &Arc<Client>) {
    let mut events = client.events();
    let weak = Arc::downgrade(inner);
    tokio::spawn(async move {
        while let Some(notification) = events.next().await {
            let Some(inner) = weak.upgrade() else { return };
            let _ = inner.events.send(CockpitEvent::Notification(notification));
        }
        // The connection closed.
        let Some(inner) = weak.upgrade() else { return };
        if inner.closed.load(Ordering::SeqCst) {
            return;
        }
        if let Err(error) = inner.client().await {
            let _ = inner.events.send(CockpitEvent::Lost(error));
        }
    });
}

impl Inner {
    /// A new connection, with the options kept for every reconnect.
    async fn open(&self) -> Result<Arc<Client>> {
        let options = &self.options;
        let notice = Arc::clone(&options.notice);
        let tell = move |text: &str| notice(text);
        let client = Client::connect(ClientOptions {
            name: options.name.clone(),
            kind: options.kind,
            version: &options.version,
            build_kind: &options.build_kind,
            daemon: options.daemon.clone(),
            paths: &options.paths,
            daemon_args: options.daemon_args.clone(),
            asker: options.asker.clone(),
            notice: &tell,
        })
        .await?;
        Ok(Arc::new(client))
    }

    /// The connection, connected again first when the last one closed: the client's own bricks are
    /// connected again and its subscriptions renewed before any request goes out.
    async fn client(self: &Arc<Self>) -> Result<Arc<Client>> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ClientError::unavailable(
                "This client was shut down; connect a new one.",
            ));
        }
        let mut current = self.current.lock().await;
        if let Some(client) = current.as_ref().filter(|c| !c.endpoint.is_closed()) {
            return Ok(Arc::clone(client));
        }
        let client = self.open().await?;
        // Under the lock: a request waiting for the connection goes out after the rejoin.
        self.rejoin(&client).await;
        *current = Some(Arc::clone(&client));
        drop(current);
        watch(self, &client);
        let _ = self
            .events
            .send(CockpitEvent::Reconnected(client.daemon.clone()));
        Ok(client)
    }

    /// Connects this client's own bricks again and renews every program subscription on `client`.
    async fn rejoin(&self, client: &Arc<Client>) {
        let bricks: Vec<String> = self
            .my_bricks
            .lock()
            .expect("bricks")
            .iter()
            .cloned()
            .collect();
        for brick in bricks {
            let _ = client
                .request("bricks/connect", json!({ "brick": brick }))
                .await;
        }
        let wanted: Vec<(u64, String)> = self
            .renewables
            .lock()
            .expect("renewables")
            .iter()
            .map(|(id, renewable)| (*id, renewable.brick.clone()))
            .collect();
        for (id, brick) in wanted {
            // A brick not back yet keeps its subscription unrenewed; the reader hears nothing new.
            let Ok(states) = client.subscribe_programs(&brick).await else {
                continue;
            };
            let mut renewables = self.renewables.lock().expect("renewables");
            let Some(renewable) = renewables.get_mut(&id) else {
                continue; // dropped meanwhile: `states` goes and cancels itself
            };
            let _ = renewable.sender.send(states.state.clone());
            if let Some(old) = renewable.forward.take() {
                old.abort();
            }
            renewable.forward = Some(forward(states, renewable.sender.clone()));
        }
    }

    /// Notes a brick this client connected or let go of, for the rejoin after a reconnect.
    fn remember(&self, method: &str, params: &Value, result: &Value, released: Option<&str>) {
        let mut mine = self.my_bricks.lock().expect("bricks");
        match method {
            "bricks/connect" if params.get("hold") != Some(&Value::Bool(true)) => {
                if let Some(id) = result.get("brickId").and_then(Value::as_str) {
                    mine.insert(id.to_owned());
                }
            }
            "bricks/disconnect" if params.get("releaseHold") != Some(&Value::Bool(true)) => {
                match released {
                    Some(brick) => {
                        mine.remove(brick);
                    }
                    None => mine.clear(),
                }
            }
            _ => {}
        }
    }
}
