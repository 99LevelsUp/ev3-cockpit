//! Everything the daemon answers once a client has proved itself: the contract's methods, run on
//! the brick runtime, with holders, write leases, questions for a person, the access mode and the
//! path confinement.
//!
//! One runtime serves every client: every client's stop reaches the same program service, and
//! each client's subscriptions are its own, ended when it goes.

mod bricks;
pub mod encoding;
pub mod errors;
mod files;
mod pairing;
pub mod ports;
mod programs;
pub mod runtime;
mod telemetry;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use ev3_contract::{
    BrickStatus, ContractBrick, ContractChannel, ContractChannelState, ContractError, ErrorCode,
    Notification,
};
use ev3_runtime::{
    ActivityPort, BrickEntry, ChannelState, ProgramService, RepairEvent, Requester, WriteReporter,
};
use ev3_transports::Transport;
use tokio::sync::Notify;
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;

use crate::access::{self, Operation};
use crate::holders::HolderSets;
use crate::leases::{LeaseOwner, Leases};
use crate::questions::Questions;
use crate::resolver::{ResolverBrick, resolve_brick};
use crate::rpc::RequestContext;
use crate::runs::RunSeqs;
use crate::state::{ClientEntry, Shared};

use self::pairing::Pairings;
use self::ports::{DaemonActivity, DaemonConsent};
use self::runtime::{Providers, Runtime};

/// How long a name not heard yet waits for the first discovery round.
const DISCOVERY_WAIT: Duration = Duration::from_secs(8);
/// How often a held brick that has not come back since the daemon started is tried again.
const RECONNECT_RETRY: Duration = Duration::from_secs(3);

/// One subscription of one client.
enum Subscription {
    Telemetry {
        delivery: ev3_runtime::DeliveryHandle,
        claim: String,
    },
    Program(AbortHandle),
    Chain {
        brick_id: String,
    },
    /// A file followed as it grows, on `brick_id`.
    Follow {
        task: AbortHandle,
        brick_id: String,
    },
}

/// One transfer buffer of one client.
struct Handle {
    connection: u64,
    data: Vec<u8>,
    /// Upload: bytes filled; download: bytes handed out.
    offset: usize,
    upload: bool,
}

#[derive(Default)]
struct State {
    /// Connects in progress per brick: a client gone mid-connect must not sign out one another is
    /// making.
    connecting: HashMap<String, usize>,
    /// Bricks a gone client connected; signed out when their last connect ends and nobody holds
    /// them.
    orphaned: HashSet<String>,
    /// Requests working on each brick now. A brick in use is not signed out under its request
    /// when its last holder lets go: it is orphaned, and the last of its requests signs it out
    /// unless somebody holds it by then.
    in_use: HashMap<String, usize>,
    /// Bricks being signed out now: a connect waits for the sign-out to end.
    signing_out: HashSet<String>,
    /// Bricks held across the daemon's start and not connected again yet.
    reconnecting: HashSet<String>,
    handles: HashMap<String, Handle>,
    /// Per connection, by subscription id.
    subscriptions: HashMap<u64, HashMap<String, Subscription>>,
    /// Per connection, the brick whose telemetry it shows in the foreground.
    foreground: HashMap<u64, String>,
    programs: HashMap<String, ProgramService>,
    stopped_by: HashMap<String, String>,
    /// Bricks whose one-sided repair is pairing them now.
    repair_pairings: HashSet<String>,
}

/// What one daemon's surface shares between its clients.
pub struct Surface {
    /// This surface, for what runs after a request: a request's end lets go of its brick.
    me: std::sync::Weak<Surface>,
    pub shared: Arc<Shared>,
    pub questions: Arc<Questions>,
    pub runtime: Runtime,
    pub holders: HolderSets,
    pub leases: Arc<Leases>,
    /// The last `runSeq` of each brick, kept in `runs.json` for the next daemon.
    runs: RunSeqs,
    activity: Arc<dyn ActivityPort>,
    pairings: Pairings,
    state: Mutex<State>,
    /// Wakes the task that tells every client the brick list changed.
    list_changed: Notify,
    /// Wakes whoever waits for a repair's pairing to end.
    repair_settled: Notify,
    /// Wakes the connects waiting for a brick's sign-out to end.
    signed_out: Notify,
    /// Held while the clients' shown bricks are read and sent, so the lists go out in order.
    shows_order: Mutex<()>,
    tasks: Mutex<Vec<AbortHandle>>,
}

/// The requester a request is made for.
pub fn requester_of(client: &ClientEntry) -> Requester {
    Requester {
        name: client.info.name.clone(),
        kind: client.kind(),
        connection: Some(client.id),
    }
}

fn new_id() -> String {
    crate::hex(&crate::random_bytes::<6>())
}

impl Surface {
    /// Builds the runtime on `providers` and starts serving it; the bricks `held` names (from the
    /// previous daemon's `held.json`) are held again and connected as they show up, and each
    /// brick's `runSeq` counts on from the previous daemon's `runs.json`.
    pub fn start(
        shared: Arc<Shared>,
        questions: Arc<Questions>,
        providers: Providers,
        state_dir: &std::path::Path,
        held: Vec<String>,
    ) -> Result<Arc<Self>, String> {
        let consent = Arc::new(DaemonConsent {
            shared: shared.clone(),
            questions: questions.clone(),
        });
        let runtime = Runtime::start(providers, &shared, consent, &state_dir.join("ledger.json"))?;
        let runs = RunSeqs::open(Some(state_dir.join("runs.json")), |warning| {
            shared.log.warn(&warning);
        });
        let surface = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            runs,
            activity: Arc::new(DaemonActivity {
                shared: shared.clone(),
            }),
            shared,
            questions,
            runtime,
            holders: HolderSets::new(Some(state_dir.join("held.json"))),
            leases: Leases::new(),
            pairings: Pairings::default(),
            state: Mutex::new(State::default()),
            list_changed: Notify::new(),
            repair_settled: Notify::new(),
            signed_out: Notify::new(),
            shows_order: Mutex::new(()),
            tasks: Mutex::new(Vec::new()),
        });
        surface.follow_runtime();
        surface.hold_again(held);
        Ok(surface)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("surface lock")
    }

    fn keep_task(&self, task: AbortHandle) {
        self.tasks.lock().expect("tasks lock").push(task);
    }

    // ── Notifications ───────────────────────────────────────────────

    /// Tells every client the brick list changed, once for changes close together.
    pub fn bricks_changed(&self) {
        self.list_changed.notify_one();
    }

    fn holders_changed(&self) {
        self.shared.set_holds(self.holders.holds().len());
        self.bricks_changed();
    }

    /// Forwards the runtime's events as notifications.
    fn follow_runtime(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        self.keep_task(
            tokio::spawn(async move {
                loop {
                    let Some(surface) = weak.upgrade() else {
                        return;
                    };
                    // Held while waiting: the task ends with the surface's shutdown.
                    surface.list_changed.notified().await;
                    tokio::task::yield_now().await;
                    let bricks = surface.bricks();
                    surface.shared.broadcast(&Notification::BricksChanged(
                        ev3_contract::BrickList { bricks },
                    ));
                }
            })
            .abort_handle(),
        );

        let mut list = self.runtime.list.subscribe();
        let weak = Arc::downgrade(self);
        self.keep_task(
            tokio::spawn(async move {
                loop {
                    let event = list.recv().await;
                    let Some(surface) = weak.upgrade() else {
                        return;
                    };
                    match event {
                        Ok(ev3_runtime::PresenceEvent::ScanFailed { .. }) => {}
                        Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            surface.bricks_changed();
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
            })
            .abort_handle(),
        );

        let mut bricks = self.runtime.bricks.subscribe();
        let weak = Arc::downgrade(self);
        self.keep_task(
            tokio::spawn(async move {
                loop {
                    let event = bricks.recv().await;
                    let Some(surface) = weak.upgrade() else {
                        return;
                    };
                    match event {
                        Ok(ev3_runtime::BrickEvent::RouteChanged {
                            brick_id,
                            previous,
                            current,
                        }) => {
                            if current.is_some() {
                                surface.lock().reconnecting.remove(&brick_id);
                            }
                            if current.is_some() && previous.is_none() {
                                surface.shared.broadcast(&Notification::BricksReconnected(
                                    ev3_contract::BrickIdPayload { brick_id },
                                ));
                            }
                            surface.bricks_changed();
                        }
                        Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            surface.bricks_changed();
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
            })
            .abort_handle(),
        );

        let mut repairs = self.runtime.check.subscribe();
        let weak = Arc::downgrade(self);
        self.keep_task(
            tokio::spawn(async move {
                loop {
                    let event = repairs.recv().await;
                    let Some(surface) = weak.upgrade() else {
                        return;
                    };
                    match event {
                        Ok(RepairEvent::PairingStarted { brick_id }) => {
                            surface.lock().repair_pairings.insert(brick_id.clone());
                            surface
                                .shared
                                .broadcast(&Notification::BricksPairingStarted(
                                    ev3_contract::BrickIdPayload { brick_id },
                                ));
                        }
                        Ok(RepairEvent::PairingDone { brick_id, outcome }) => {
                            surface.lock().repair_pairings.remove(&brick_id);
                            surface.repair_settled.notify_waiters();
                            surface.shared.broadcast(&Notification::BricksPairingDone(
                                pairing::result_of(&brick_id, &outcome),
                            ));
                            surface.bricks_changed();
                        }
                        Ok(RepairEvent::Repaired(repair)) => {
                            let found = match repair.found {
                                ev3_runtime::OneSidedFound::ComputerOnly => "this computer only",
                                ev3_runtime::OneSidedFound::BrickOnly => "the brick only",
                            };
                            surface
                                .shared
                                .broadcast(&Notification::BricksOneSidedRepair(
                                    ev3_contract::OneSidedRepairNotice {
                                        brick_id: repair.brick_id.clone(),
                                        message: format!("Found paired on {found}; repaired."),
                                        repair: repair.to_contract(),
                                    },
                                ));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
            })
            .abort_handle(),
        );

        telemetry::follow_chains(self);
    }

    // ── Bricks as the contract shows them ───────────────────────────

    fn to_brick(&self, entry: &BrickEntry) -> ContractBrick {
        let reconnecting = self.lock().reconnecting.contains(&entry.brick_id);
        ContractBrick {
            brick_id: entry.brick_id.clone(),
            name: entry.name.value.clone(),
            name_confirmed: entry.name.confirmed,
            connected: self.runtime.bricks.is_signed_in(&entry.brick_id),
            paired: entry.paired,
            channels: entry
                .channels
                .iter()
                .filter_map(|channel| {
                    let transport = match channel.transport {
                        Transport::Usb => ev3_contract::Transport::Usb,
                        Transport::Bt => ev3_contract::Transport::Bt,
                        Transport::Tcp => ev3_contract::Transport::Tcp,
                        _ => return None,
                    };
                    let state = match channel.state {
                        ChannelState::Absent => return None,
                        ChannelState::Available => ContractChannelState::Available,
                        ChannelState::Connected => ContractChannelState::Connected,
                        ChannelState::Lost => ContractChannelState::Lost,
                    };
                    Some(ContractChannel { state, transport })
                })
                .collect(),
            holders: self.holders.holders_of(&entry.brick_id),
            reconnecting: reconnecting.then_some(true),
        }
    }

    pub fn bricks(&self) -> Vec<ContractBrick> {
        self.runtime
            .list
            .list()
            .iter()
            .map(|entry| self.to_brick(entry))
            .collect()
    }

    /// Holders and the write lease of every held brick, for `daemon/status`.
    pub fn brick_status(&self) -> Vec<BrickStatus> {
        let leased = self.leases.snapshot();
        let reconnecting = self.lock().reconnecting.clone();
        self.holders
            .held_bricks()
            .into_iter()
            .map(|brick_id| BrickStatus {
                name: self
                    .runtime
                    .list
                    .brick(&brick_id)
                    .map_or_else(|| brick_id.clone(), |entry| entry.name.value),
                holders: self.holders.holders_of(&brick_id),
                lease_holder: leased.get(&brick_id).cloned(),
                reconnecting: reconnecting.contains(&brick_id).then_some(true),
                brick_id,
            })
            .collect()
    }

    /// The write in progress, named for a person, or `None`: a leased operation (files, programs,
    /// a forget or a clear of a Bluetooth list), a pairing, or a write the runtime reports.
    pub fn write_in_progress(&self) -> Option<String> {
        if let Some((brick_id, holder)) = self.leases.snapshot().into_iter().next() {
            let name = self
                .runtime
                .list
                .brick(&brick_id)
                .map_or(brick_id, |entry| entry.name.value);
            return Some(format!("{holder}'s write to {name}"));
        }
        if self.pairings.any() || !self.lock().repair_pairings.is_empty() {
            return Some("a Bluetooth pairing".into());
        }
        self.shared
            .writing()
            .then(|| "a write to a brick".to_owned())
    }

    // ── What every brick method starts with ─────────────────────────

    /// The brick a request names.
    pub async fn brick_of(
        &self,
        cx: &RequestContext,
        wanted: Option<&str>,
    ) -> Result<String, ContractError> {
        let bricks = || {
            self.runtime
                .list
                .list()
                .into_iter()
                .map(|entry| ResolverBrick {
                    connected: self.runtime.bricks.is_signed_in(&entry.brick_id),
                    brick_id: entry.brick_id,
                    name: entry.name.value,
                })
                .collect()
        };
        let brick_id = resolve_brick(
            bricks,
            || self.runtime.discovery_settled(DISCOVERY_WAIT),
            wanted,
            cx.client.kind(),
        )
        .await?;
        // In use until the request ends, whoever holds the brick meanwhile (#9).
        *self.lock().in_use.entry(brick_id.clone()).or_default() += 1;
        let (me, brick) = (self.me.clone(), brick_id.clone());
        cx.after_reply(move || {
            if let Some(surface) = me.upgrade() {
                surface.request_ended(&brick);
            }
        });
        Ok(brick_id)
    }

    /// Whether a brick may be signed out now: no connect of it and no request beyond `own` (the
    /// request asking, if it is one of the brick's) is working on it.
    fn idle(state: &State, brick_id: &str, own: usize) -> bool {
        !state.connecting.contains_key(brick_id)
            && state.in_use.get(brick_id).copied().unwrap_or(0) <= own
    }

    /// A request on `brick_id` ended: the last one signs out a brick orphaned meanwhile, unless
    /// somebody holds it now.
    fn request_ended(self: &Arc<Self>, brick_id: &str) {
        let release = {
            let mut state = self.lock();
            match state.in_use.get_mut(brick_id) {
                Some(count) if *count > 1 => *count -= 1,
                _ => {
                    state.in_use.remove(brick_id);
                }
            }
            Self::idle(&state, brick_id, 0) && state.orphaned.remove(brick_id)
        };
        if release {
            let (surface, brick) = (self.clone(), brick_id.to_owned());
            tokio::spawn(async move {
                if surface.sign_out_unused(&brick, 0).await {
                    surface.shared.log.info(&format!(
                        "Released {brick}: its last request ended and nobody holds it."
                    ));
                    surface.bricks_changed();
                }
            });
        }
    }

    /// Signs `brick_id` out unless, checked now under the lock, somebody holds it or a connect or
    /// a request (beyond the caller's `own`) works on it; one that works on it is orphaned, for
    /// the last of them to sign out. Whether it signed out.
    ///
    /// Decided and marked under one lock: a release decided a moment ago (a client that left)
    /// does not sign out a brick another client has started to use since, and a connect that
    /// comes while the sign-out runs waits for it ([`Self::signing_out_ended`]) and then signs the
    /// brick in afresh, rather than taking a brick that is going (#11).
    async fn sign_out_unused(self: &Arc<Self>, brick_id: &str, own: usize) -> bool {
        {
            let mut state = self.lock();
            if self.holders.is_held(brick_id) {
                return false;
            }
            if !Self::idle(&state, brick_id, own) {
                state.orphaned.insert(brick_id.to_owned());
                return false;
            }
            state.signing_out.insert(brick_id.to_owned());
        }
        self.sign_out_marked(brick_id).await;
        true
    }

    /// Signs out a brick, marked as signing out meanwhile, then lets the connects waiting for it
    /// go on.
    async fn sign_out_marked(&self, brick_id: &str) {
        self.lock().signing_out.insert(brick_id.to_owned());
        self.runtime.bricks.sign_out(brick_id).await;
        self.lock().signing_out.remove(brick_id);
        self.signed_out.notify_waiters();
    }

    /// Waits while `brick_id` is being signed out.
    async fn signing_out_ended(&self, brick_id: &str) {
        loop {
            let ended = self.signed_out.notified();
            tokio::pin!(ended);
            ended.as_mut().enable();
            if !self.lock().signing_out.contains(brick_id) {
                return;
            }
            ended.await;
        }
    }

    /// Runs `work` under the brick's write lease for exactly its length.
    pub async fn leased<T, F>(
        &self,
        cx: &RequestContext,
        brick_id: &str,
        work: impl FnOnce(CancellationToken) -> F,
    ) -> Result<T, ContractError>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, ContractError>> + Send + 'static,
    {
        self.leases
            .run(
                brick_id,
                LeaseOwner {
                    connection: cx.client.id,
                    name: cx.client.info.name.clone(),
                },
                &cx.cancel,
                work,
            )
            .await
    }

    /// Refuses with `access_denied` when the access mode does not allow it.
    pub fn allowed(&self, operation: Operation, path: Option<&str>) -> Result<(), ContractError> {
        let mode = self
            .shared
            .settings
            .lock()
            .expect("settings lock")
            .access_mode();
        access::check(mode, operation, path)
    }

    /// The write reporter for a request of `client`.
    pub fn writes(&self, client: &ClientEntry) -> WriteReporter {
        WriteReporter {
            port: self.activity.clone(),
            requester: requester_of(client),
        }
    }

    /// A local path a client named, confined: refused when it resolves into the cockpit's own
    /// directories, whoever the client is. Checked before anything else about the request.
    pub fn local_path(&self, path: &str, field: &str) -> Result<PathBuf, ContractError> {
        let named = std::path::Path::new(path);
        if !named.is_absolute() {
            return Err(ContractError::new(
                ErrorCode::InvalidRequest,
                format!("{field} must be an absolute path, not {path}."),
            ));
        }
        self.shared.confinement.check(named)
    }

    /// Reads a local file a client named, at the path [`Self::local_path`] confined, checking
    /// the opened file's own path again before reading.
    pub fn read_local(&self, named: &str, resolved: &Path) -> Result<Vec<u8>, ContractError> {
        self.shared.confinement.read(Path::new(named), resolved)
    }

    /// Writes a local file a client named, at the path [`Self::local_path`] confined, checking
    /// the opened file's own path again before anything is written. A file already there is
    /// refused with `file_exists` unless `replace`.
    pub fn write_local(
        &self,
        named: &str,
        resolved: &Path,
        data: &[u8],
        replace: bool,
    ) -> Result<(), ContractError> {
        self.shared
            .confinement
            .write_file(Path::new(named), resolved, data, replace)
    }

    // ── Holds across the daemon's start ─────────────────────────────

    /// Holds `bricks` again and connects each as it shows up, retrying until it is back or nobody
    /// holds it.
    fn hold_again(self: &Arc<Self>, bricks: Vec<String>) {
        if bricks.is_empty() {
            return;
        }
        for brick in &bricks {
            if let Err(error) = self.holders.add(brick, crate::holders::Holder::Hold) {
                self.shared.log.warn(&error);
            }
            self.lock().reconnecting.insert(brick.clone());
        }
        self.holders_changed();
        let weak = Arc::downgrade(self);
        self.keep_task(
            tokio::spawn(async move {
                if let Some(surface) = weak.upgrade() {
                    surface.runtime.discovery_settled(DISCOVERY_WAIT).await;
                }
                loop {
                    let Some(surface) = weak.upgrade() else {
                        return;
                    };
                    let waiting: Vec<String> =
                        surface.lock().reconnecting.iter().cloned().collect();
                    if waiting.is_empty() {
                        return;
                    }
                    for brick in waiting {
                        let bricks = &surface.runtime.bricks;
                        if !surface.holders.is_held(&brick) || bricks.is_signed_in(&brick) {
                            surface.lock().reconnecting.remove(&brick);
                            surface.bricks_changed();
                            continue;
                        }
                        surface.runtime.check.connect_requested(&brick);
                        if bricks.sign_in(&brick).await.is_ok() {
                            surface.lock().reconnecting.remove(&brick);
                            surface.bricks_changed();
                            surface
                                .shared
                                .log
                                .info(&format!("Connected {brick} again: it was held."));
                        }
                    }
                    drop(surface);
                    tokio::time::sleep(RECONNECT_RETRY).await;
                }
            })
            .abort_handle(),
        );
    }

    /// A setting changed: telemetry takes its settings again.
    pub fn settings_changed(&self) {
        let (stale, throttle, preset) = {
            let settings = self.shared.settings.lock().expect("settings lock");
            (
                runtime::stale_settings(&settings),
                runtime::throttle_settings(&settings),
                runtime::program_preset(&settings),
            )
        };
        let telemetry = &self.runtime.telemetry;
        for outcome in [
            telemetry.configure_throttle(throttle),
            telemetry.configure_program_preset(preset),
            self.runtime.read_model.configure(stale),
        ] {
            if let Err(error) = outcome {
                self.shared.log.warn(&error.to_string());
            }
        }
    }

    // ── A client's end ──────────────────────────────────────────────

    /// A client's connection closed: its subscriptions, buffers, foreground, leases, remembered
    /// answers and holds go; bricks it held alone are signed out.
    pub fn client_left(self: &Arc<Self>, client: &ClientEntry) {
        let connection = client.id;
        let (subscriptions, foreground_changed) = {
            let mut state = self.lock();
            state.handles.retain(|_, h| h.connection != connection);
            let subscriptions = state.subscriptions.remove(&connection).unwrap_or_default();
            let foreground_changed = state.foreground.remove(&connection).is_some();
            (subscriptions, foreground_changed)
        };
        for (_, subscription) in subscriptions {
            self.end_subscription(subscription);
        }
        if foreground_changed {
            self.apply_foreground();
            // The client is out of the list already: the others hear it shows nothing any more.
            self.shows_changed();
        }
        self.leases.client_left(connection);
        self.questions.client_left(connection);
        // Under the surface's lock, as a connect adds its holder: a brick being connected now, or
        // that a request of another client is working on, is left to the end of the last of them,
        // which signs it out unless somebody holds it by then.
        let released: Vec<String> = {
            let mut state = self.lock();
            self.holders
                .client_left(connection)
                .into_iter()
                .filter(|brick| {
                    if !Self::idle(&state, brick, 0) {
                        state.orphaned.insert(brick.clone());
                        false
                    } else {
                        true
                    }
                })
                .collect()
        };
        self.holders_changed();
        if !released.is_empty() {
            let surface = self.clone();
            let name = client.info.name.clone();
            tokio::spawn(async move {
                for brick in released {
                    // Checked again: another client may have started to use it since.
                    if surface.sign_out_unused(&brick, 0).await {
                        surface.shared.log.write(
                            crate::log::Level::Info,
                            Some(&name),
                            &format!("Released {brick}: nobody else holds it."),
                        );
                    }
                }
                surface.bricks_changed();
            });
        }
    }

    fn end_subscription(&self, subscription: Subscription) {
        match subscription {
            Subscription::Telemetry { delivery, claim } => {
                if delivery.close() {
                    self.runtime.telemetry.release(&claim);
                }
            }
            Subscription::Program(task) | Subscription::Follow { task, .. } => task.abort(),
            Subscription::Chain { .. } => {}
        }
    }

    /// Keeps a subscription of `connection`; returns its id.
    fn subscribe(&self, connection: u64, subscription: Subscription) -> String {
        let id = new_id();
        self.lock()
            .subscriptions
            .entry(connection)
            .or_default()
            .insert(id.clone(), subscription);
        id
    }

    /// Ends a subscription by its id; an id this connection does not have is ignored.
    pub fn cancel_subscription(&self, connection: u64, id: &str) {
        let removed = self
            .lock()
            .subscriptions
            .get_mut(&connection)
            .and_then(|subs| subs.remove(id));
        if let Some(subscription) = removed {
            self.end_subscription(subscription);
        }
    }

    /// Releases every brick and device, at the daemon's end.
    pub async fn shutdown(&self) {
        for task in self.tasks.lock().expect("tasks lock").drain(..) {
            task.abort();
        }
        self.leases.cancel_all();
        let programs: Vec<ProgramService> = self.lock().programs.drain().map(|(_, p)| p).collect();
        for program in programs {
            program.dispose();
        }
        self.runtime.shutdown().await;
    }
}
