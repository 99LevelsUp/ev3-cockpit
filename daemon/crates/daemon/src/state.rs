//! What every connection shares: who the daemon is, its key, settings and log, the connected
//! clients, the hold count that keeps it alive without clients, and how it is asked to end.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use ev3_contract::{BuildKind, ClientInfo, ClientKind, DaemonMode, Notification};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::confine::Confinement;
use crate::log::Log;
use crate::rpc::Peer;
use crate::settings::SettingsStore;

/// Who this daemon is, fixed at start.
#[derive(Debug, Clone)]
pub struct Identity {
    pub version: String,
    pub build_kind: BuildKind,
    pub build_id: String,
    pub mode: DaemonMode,
    pub pid: u32,
    pub instance_id: String,
    /// Milliseconds since the Unix epoch.
    pub started_at: u64,
    /// The pipe or socket path.
    pub channel_path: String,
}

/// One client that finished the hello.
pub struct ClientEntry {
    pub id: u64,
    pub info: ClientInfo,
    /// The contract version the client's hello named.
    pub contract_version: u64,
    pub peer: Arc<Peer>,
}

impl ClientEntry {
    pub fn kind(&self) -> ClientKind {
        self.info.kind
    }
}

/// Why the daemon ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    /// No client for the idle time while nothing was held.
    Idle,
    /// A client asked it to end.
    Requested,
    /// The key changed under it.
    KeyChanged,
    /// The operating system asked it to end.
    Signal,
    /// The channel failed.
    ChannelFailed,
}

/// What every connection shares.
pub struct Shared {
    pub identity: Identity,
    pub key: Vec<u8>,
    pub key_file: PathBuf,
    pub log: Log,
    pub settings: Mutex<SettingsStore>,
    pub confinement: Confinement,
    clients: Mutex<Vec<Arc<ClientEntry>>>,
    next_client: AtomicU64,
    /// Open connections, hello or not; watched by the idle timer.
    connections: watch::Sender<usize>,
    /// Bricks held past every client (`ev3 connect`): they keep the daemon alive without clients.
    holds: AtomicUsize,
    /// Writes to bricks in progress, as the runtime reports them.
    writes: AtomicUsize,
    exiting: AtomicBool,
    exit_reason: Mutex<Option<ExitReason>>,
    shutdown: CancellationToken,
    /// The transports the providers serve, set once they are built.
    transports: OnceLock<Vec<String>>,
}

impl Shared {
    pub fn new(
        identity: Identity,
        key: Vec<u8>,
        key_file: PathBuf,
        log: Log,
        settings: SettingsStore,
        confinement: Confinement,
    ) -> Self {
        Self {
            identity,
            key,
            key_file,
            log,
            settings: Mutex::new(settings),
            confinement,
            clients: Mutex::new(Vec::new()),
            next_client: AtomicU64::new(1),
            connections: watch::Sender::new(0),
            holds: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            exiting: AtomicBool::new(false),
            exit_reason: Mutex::new(None),
            shutdown: CancellationToken::new(),
            transports: OnceLock::new(),
        }
    }

    /// Adds a client that finished the hello.
    pub fn add_client(
        &self,
        info: ClientInfo,
        contract_version: u64,
        peer: Arc<Peer>,
    ) -> Arc<ClientEntry> {
        let entry = Arc::new(ClientEntry {
            id: self.next_client.fetch_add(1, Ordering::Relaxed),
            info,
            contract_version,
            peer,
        });
        self.clients
            .lock()
            .expect("clients lock")
            .push(entry.clone());
        entry
    }

    /// Removes a client whose connection closed.
    pub fn remove_client(&self, id: u64) {
        self.clients
            .lock()
            .expect("clients lock")
            .retain(|entry| entry.id != id);
    }

    /// Every client that finished the hello.
    pub fn clients(&self) -> Vec<Arc<ClientEntry>> {
        self.clients.lock().expect("clients lock").clone()
    }

    /// Sends a notification to every client.
    pub fn broadcast(&self, notification: &Notification) {
        let Ok(params) = notification.params() else {
            return;
        };
        for client in self.clients() {
            client.peer.notify(notification.method(), params.clone());
        }
    }

    /// A connection opened; the returned guard counts it until dropped.
    pub fn connection_opened(self: &Arc<Self>) -> ConnectionGuard {
        self.connections.send_modify(|n| *n += 1);
        ConnectionGuard {
            shared: self.clone(),
        }
    }

    /// Watches the number of open connections.
    pub fn watch_connections(&self) -> watch::Receiver<usize> {
        self.connections.subscribe()
    }

    /// Whether anything is held that keeps the daemon alive without clients.
    pub fn holding(&self) -> bool {
        self.holds.load(Ordering::SeqCst) > 0
    }

    /// Sets how many bricks are held past every client, and lets the idle timer look again.
    pub fn set_holds(&self, count: usize) {
        self.holds.store(count, Ordering::SeqCst);
        self.connections.send_modify(|_| {});
    }

    /// A write to a brick started (`true`) or ended (`false`).
    pub fn write_reported(&self, started: bool) {
        if started {
            self.writes.fetch_add(1, Ordering::SeqCst);
        } else {
            let _ = self
                .writes
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
        }
    }

    /// Whether a write to a brick is in progress.
    pub fn writing(&self) -> bool {
        self.writes.load(Ordering::SeqCst) > 0
    }

    /// Records the transports the daemon's providers serve, once they are built.
    pub fn set_transports(&self, transports: Vec<String>) {
        let _ = self.transports.set(transports);
    }

    /// The transports the daemon loaded, for the hello: a client notices a degraded daemon by a
    /// transport missing here. Empty until the providers are built.
    pub fn transports(&self) -> Vec<String> {
        self.transports.get().cloned().unwrap_or_default()
    }

    /// Whether the daemon is about to end.
    pub fn exiting(&self) -> bool {
        self.exiting.load(Ordering::SeqCst)
    }

    /// Marks the daemon as ending: new hellos say `exiting`.
    pub fn mark_exiting(&self) {
        self.exiting.store(true, Ordering::SeqCst);
    }

    /// Ends the daemon; the first reason given is the one it ends with.
    pub fn request_exit(&self, reason: ExitReason) {
        self.mark_exiting();
        let mut current = self.exit_reason.lock().expect("exit lock");
        if current.is_none() {
            *current = Some(reason);
        }
        drop(current);
        self.shutdown.cancel();
    }

    /// Why the daemon ends, once it does.
    pub fn exit_reason(&self) -> Option<ExitReason> {
        *self.exit_reason.lock().expect("exit lock")
    }

    /// Cancelled when the daemon ends.
    pub fn shutdown(&self) -> &CancellationToken {
        &self.shutdown
    }
}

/// Counts one open connection until dropped.
pub struct ConnectionGuard {
    shared: Arc<Shared>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.shared.connections.send_modify(|n| *n -= 1);
    }
}
