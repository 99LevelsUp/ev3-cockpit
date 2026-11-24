//! A client that outlives its daemon, as the TypeScript `CockpitClient` does: for an add-on that
//! runs for a long time (EVƎ C's backend, an MCP server).
//!
//! - When the connection closes (the daemon ended, or another replaced it), the client connects
//!   again by itself, starting the daemon its [`Launch`] names when none runs.
//! - No daemon hands anything to the next. The bricks this client connected without a hold are
//!   connected again on the new daemon, and every program subscription is made again; its reader
//!   gets the fresh state first, then the changes as before. A followed file is followed again
//!   from the offset its bytes reached.
//! - [`CockpitEvent`] tells a reader what the daemon sends ([`CockpitEvent::Notification`]), that
//!   the client is connected again ([`CockpitEvent::Reconnected`]), or that it could not connect
//!   again ([`CockpitEvent::Lost`]); the next request then tries once more.
//! - A write the daemon was running when it went may or may not have happened: it fails with
//!   `outcome_unknown` and is never sent again, as with [`Client::request`].

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use ev3_contract::{FileFollowEndedReason, Notification, ProgramState};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use crate::client::{Asker, Client, ClientOptions, Launch};
use crate::connect::DaemonIdentity;
use crate::error::{ClientError, Result};
use crate::events::{FileEvent, FileFollow, ProgramStates};
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

/// A subscription the cockpit renews: what it is, where what it hears goes, and the task that
/// forwards the one on the daemon now.
struct Renewable {
    brick: String,
    kind: Kind,
    forward: Option<JoinHandle<()>>,
}

/// A followed file's path and the offset its bytes reached.
type FileAt = (String, u64);

enum Kind {
    Program {
        sender: mpsc::UnboundedSender<ProgramState>,
    },
    /// A followed file: followed again from the offset its bytes reached.
    File {
        path: String,
        reached: Arc<AtomicU64>,
        /// The daemon ended it: it is not followed again.
        ended: Arc<AtomicBool>,
        sender: mpsc::UnboundedSender<FileEvent>,
    },
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
                kind: Kind::Program { sender },
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

    /// Follows `path` on `brick` as it grows, across reconnects: every growth in order; after a
    /// reconnect the follow is made again from the offset its bytes reached, so nothing is handed
    /// over twice or skipped. A file gone meanwhile ends it with [`FileEvent::Ended`]. Dropping it
    /// cancels it.
    pub async fn follow_file(
        &self,
        brick: &str,
        path: &str,
        from_offset: Option<u64>,
    ) -> Result<CockpitFile> {
        let client = self.inner.client().await?;
        let follow = client.follow_file(brick, path, from_offset).await?;
        let (offset, size) = (follow.offset, follow.size);
        let (sender, receiver) = mpsc::unbounded_channel();
        let reached = Arc::new(AtomicU64::new(follow.reached()));
        let ended = Arc::new(AtomicBool::new(false));
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let forward = forward_file(follow, sender.clone(), &reached, &ended);
        self.inner.renewables.lock().expect("renewables").insert(
            id,
            Renewable {
                brick: brick.to_owned(),
                kind: Kind::File {
                    path: path.to_owned(),
                    reached,
                    ended,
                    sender,
                },
                forward: Some(forward),
            },
        );
        Ok(CockpitFile {
            offset,
            size,
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
        forget(&self.inner, self.id);
    }
}

/// A followed file of a [`Cockpit`], followed again after every reconnect.
pub struct CockpitFile {
    /// Where the follow started.
    pub offset: u64,
    /// The file's size when the follow started.
    pub size: u64,
    receiver: mpsc::UnboundedReceiver<FileEvent>,
    id: u64,
    inner: Weak<Inner>,
}

impl CockpitFile {
    /// The next growth, in order across reconnects, or the follow's end; `None` once the cockpit
    /// was shut down or after the end.
    pub async fn next(&mut self) -> Option<FileEvent> {
        self.receiver.recv().await
    }
}

impl Drop for CockpitFile {
    fn drop(&mut self) {
        forget(&self.inner, self.id);
    }
}

/// Stops renewing subscription `id`; its connection's subscription goes with its task, which
/// cancels it on the daemon.
fn forget(inner: &Weak<Inner>, id: u64) {
    if let Some(inner) = inner.upgrade()
        && let Some(renewable) = inner.renewables.lock().expect("renewables").remove(&id)
        && let Some(forward) = renewable.forward
    {
        forward.abort();
    }
}

/// Hands every growth of `follow` to `sender`, noting the offset reached; ends with the
/// connection, the reader or the follow's end, which is noted too.
fn forward_file(
    mut follow: FileFollow,
    sender: mpsc::UnboundedSender<FileEvent>,
    reached: &Arc<AtomicU64>,
    ended: &Arc<AtomicBool>,
) -> JoinHandle<()> {
    let (reached, ended) = (Arc::clone(reached), Arc::clone(ended));
    tokio::spawn(async move {
        while let Some(event) = follow.next().await {
            let last = matches!(event, FileEvent::Ended(_));
            if last {
                ended.store(true, Ordering::SeqCst);
            } else {
                reached.store(follow.reached(), Ordering::SeqCst);
            }
            if sender.send(event).is_err() || last {
                return;
            }
        }
    })
}

/// Dropping the last clone of a [`Cockpit`] closes it as [`Cockpit::shutdown`] does, without
/// waiting: the connection closes, so the daemon releases what this client held, no reconnect
/// follows, and every subscription ends.
impl Drop for Inner {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        for (_, renewable) in self.renewables.lock().expect("renewables").drain() {
            if let Some(forward) = renewable.forward {
                forward.abort();
            }
        }
        if let Ok(current) = self.current.try_lock()
            && let Some(client) = current.as_ref()
        {
            client.endpoint.close();
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
        // The connection closed: connect again, and keep trying while no daemon can be reached, so
        // a reader waiting for a program's end needs no request of its own to bring it back. Lost
        // is told once per outage; the pause grows to RETRY_MAX.
        let mut pause = RETRY_FIRST;
        let mut told = false;
        loop {
            let Some(inner) = weak.upgrade() else { return };
            if inner.closed.load(Ordering::SeqCst) {
                return;
            }
            match inner.client().await {
                // `client` watches the new connection itself.
                Ok(_) => return,
                Err(error) => {
                    if !told {
                        let _ = inner.events.send(CockpitEvent::Lost(error));
                        told = true;
                    }
                }
            }
            drop(inner);
            tokio::time::sleep(pause).await;
            pause = (pause * 2).min(RETRY_MAX);
        }
    });
}

/// The first pause before connecting again after no daemon could be reached, and the longest.
const RETRY_FIRST: std::time::Duration = std::time::Duration::from_secs(1);
const RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(30);

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
        // What to renew, read once: a program by its brick, a file by its brick, path and reach.
        let wanted: Vec<(u64, String, Option<FileAt>)> = self
            .renewables
            .lock()
            .expect("renewables")
            .iter()
            .filter_map(|(id, renewable)| {
                let file = match &renewable.kind {
                    Kind::Program { .. } => None,
                    Kind::File { ended, .. } if ended.load(Ordering::SeqCst) => return None,
                    Kind::File { path, reached, .. } => {
                        Some((path.clone(), reached.load(Ordering::SeqCst)))
                    }
                };
                Some((*id, renewable.brick.clone(), file))
            })
            .collect();
        for (id, brick, file) in wanted {
            match file {
                None => self.renew_program(client, id, &brick).await,
                Some((path, reached)) => self.renew_file(client, id, &brick, &path, reached).await,
            }
        }
    }

    async fn renew_program(&self, client: &Arc<Client>, id: u64, brick: &str) {
        // A brick not back yet keeps its subscription unrenewed; the reader hears nothing new.
        let Ok(states) = client.subscribe_programs(brick).await else {
            return;
        };
        let mut renewables = self.renewables.lock().expect("renewables");
        let Some(renewable) = renewables.get_mut(&id) else {
            return; // dropped meanwhile: `states` goes and cancels itself
        };
        let Kind::Program { sender } = &renewable.kind else {
            return;
        };
        let _ = sender.send(states.state.clone());
        let sender = sender.clone();
        if let Some(old) = renewable.forward.take() {
            old.abort();
        }
        renewable.forward = Some(forward(states, sender));
    }

    /// Follows a file again from the offset it reached. A file gone meanwhile ends the follow; a
    /// brick not back yet keeps it unrenewed.
    async fn renew_file(
        &self,
        client: &Arc<Client>,
        id: u64,
        brick: &str,
        path: &str,
        reached: u64,
    ) {
        let follow = client.follow_file(brick, path, Some(reached)).await;
        let mut renewables = self.renewables.lock().expect("renewables");
        let Some(renewable) = renewables.get_mut(&id) else {
            return; // dropped meanwhile: `follow` goes and cancels itself
        };
        let Kind::File {
            reached,
            ended,
            sender,
            ..
        } = &renewable.kind
        else {
            return;
        };
        match follow {
            Ok(follow) => {
                if let Some(old) = renewable.forward.take() {
                    old.abort();
                }
                renewable.forward = Some(forward_file(follow, sender.clone(), reached, ended));
            }
            Err(error) if error.code() == Some("file_not_found") => {
                ended.store(true, Ordering::SeqCst);
                let _ = sender.send(FileEvent::Ended(FileFollowEndedReason::Removed));
            }
            Err(_) => {}
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
