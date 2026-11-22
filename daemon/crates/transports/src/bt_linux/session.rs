//! BlueZ of the moment: one system-bus connection, BlueZ's owner tracked, its objects kept.
//!
//! BlueZ's unique bus name is tracked with `GetNameOwner` and `NameOwnerChanged`. The object
//! cache and the pairing agent take signals and calls from that name only, and from nobody while
//! it is unknown. When BlueZ goes (a daemon restart) the cache is dropped at once; when it comes
//! back a fresh snapshot is read. When the bus itself closes, it is opened again after 1 s, 2 s,
//! 4 s ... up to 30 s apart.
//!
//! One task owns the connection and handles its signals in order, so signals that arrive while a
//! snapshot is being read wait in the channel and are applied over it afterwards: a newer change
//! is never overwritten by the older snapshot.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::access::{AccessQuestion, Activity, CheckAgain, manual_group_command};
use super::bluez::{
    BLUEZ, BluezBus, BluezConnector, BluezError, BluezObjects, BluezSignal, BusSignal, DBUS_NAME,
};

/// The first reconnect after the bus closed under us; doubled each failed try, up to
/// [`RECONNECT_MAX`].
pub const RECONNECT_FIRST: Duration = Duration::from_secs(1);
pub const RECONNECT_MAX: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Shared {
    bus: Option<Arc<dyn BluezBus>>,
    owner: Option<String>,
}

/// The BlueZ connection, its owner and its objects.
pub struct BluezSession {
    connector: Arc<dyn BluezConnector>,
    objects: Arc<BluezObjects>,
    activity: Arc<dyn Activity>,
    access: Option<Arc<AccessQuestion>>,
    user: String,
    reconnect_first: Duration,
    shared: Mutex<Shared>,
    task: Mutex<Option<JoinHandle<()>>>,
    disposed: AtomicBool,
    myself: Weak<BluezSession>,
}

impl std::fmt::Debug for BluezSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BluezSession")
            .field("ready", &self.objects.is_ready())
            .finish_non_exhaustive()
    }
}

/// How serving one connection ended.
enum Served {
    /// The connection closed: open another.
    Closed,
    /// Something refused and nothing more can be done on this connection; wait for a retry.
    Parked,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl BluezSession {
    /// A session over `connector`. `access`, when given, is asked when the bus policy keeps this
    /// user from BlueZ; `user` names the user in the command that fixes it.
    pub fn new(
        connector: Arc<dyn BluezConnector>,
        activity: Arc<dyn Activity>,
        access: Option<Arc<AccessQuestion>>,
        user: impl Into<String>,
        reconnect_first: Duration,
    ) -> Arc<Self> {
        Arc::new_cyclic(|myself| Self {
            connector,
            objects: Arc::new(BluezObjects::new()),
            activity,
            access,
            user: user.into(),
            reconnect_first,
            shared: Mutex::new(Shared::default()),
            task: Mutex::new(None),
            disposed: AtomicBool::new(false),
            myself: myself.clone(),
        })
    }

    pub fn objects(&self) -> &Arc<BluezObjects> {
        &self.objects
    }

    /// The connection of this moment; an operation holds it for its whole length.
    pub fn bus(&self) -> Option<Arc<dyn BluezBus>> {
        lock(&self.shared).bus.clone()
    }

    /// BlueZ's unique bus name; `None` while BlueZ is not running or not yet known.
    pub fn owner(&self) -> Option<String> {
        lock(&self.shared).owner.clone()
    }

    pub fn is_disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    /// Opens the bus and reads BlueZ, on a task of its own. Nothing while one is already running.
    pub fn start(&self) {
        if self.is_disposed() {
            return;
        }
        let mut task = lock(&self.task);
        if task.as_ref().is_some_and(|running| !running.is_finished()) {
            return;
        }
        let Some(this) = self.myself.upgrade() else {
            return;
        };
        *task = Some(tokio::spawn(async move { this.run().await }));
    }

    /// Starts again from a fresh bus, as after the user joined the bluetooth group.
    pub fn retry(&self) {
        if self.is_disposed() {
            return;
        }
        self.stop_task();
        self.start();
    }

    /// Closes the bus once and is not ready after.
    pub fn dispose(&self) {
        if self.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stop_task();
    }

    fn stop_task(&self) {
        if let Some(task) = lock(&self.task).take() {
            task.abort();
        }
        let bus = {
            let mut shared = lock(&self.shared);
            shared.owner = None;
            shared.bus.take()
        };
        self.objects.clear();
        if let Some(bus) = bus {
            bus.close();
        }
    }

    fn backoff(&self, tries: u32) -> Duration {
        self.reconnect_first
            .saturating_mul(1u32 << tries.min(16))
            .min(RECONNECT_MAX)
    }

    async fn run(self: Arc<Self>) {
        let mut tries = 0u32;
        loop {
            if self.is_disposed() {
                return;
            }
            let bus = match self.connector.open().await {
                Ok(bus) => bus,
                Err(error) => {
                    self.activity.warn(&format!(
                        "Bluetooth unavailable: cannot reach the system bus ({error}); trying again."
                    ));
                    tokio::time::sleep(self.backoff(tries)).await;
                    tries = tries.saturating_add(1);
                    continue;
                }
            };
            if self.is_disposed() {
                bus.close();
                return;
            }
            tries = 0;
            lock(&self.shared).bus = Some(Arc::clone(&bus));
            match self.serve(&bus).await {
                Served::Closed => {
                    {
                        let mut shared = lock(&self.shared);
                        shared.bus = None;
                        shared.owner = None;
                    }
                    self.objects.clear();
                    self.activity.warn(
                        "The system bus connection closed; Bluetooth is not ready until it is back.",
                    );
                    tokio::time::sleep(self.backoff(tries)).await;
                    tries = tries.saturating_add(1);
                }
                Served::Parked => return,
            }
        }
    }

    async fn serve(&self, bus: &Arc<dyn BluezBus>) -> Served {
        let mut signals = match bus.watch().await {
            Ok(signals) => signals,
            Err(error) => {
                if error.is_access_denied() {
                    self.access_denied();
                } else {
                    self.activity.warn(&format!(
                        "Bluetooth unavailable: the system bus refused to watch BlueZ ({error})."
                    ));
                }
                return Served::Parked;
            }
        };
        let owner = match bus.name_owner().await {
            Ok(owner) => owner.filter(|name| !name.is_empty()),
            Err(error) => {
                if error.is_access_denied() {
                    self.access_denied();
                } else {
                    self.activity.warn(&format!(
                        "Bluetooth unavailable: could not ask the bus who BlueZ is ({error})."
                    ));
                }
                return self.drain_until_closed(&mut signals).await;
            }
        };
        lock(&self.shared).owner.clone_from(&owner);
        if owner.is_none() {
            self.activity
                .warn("BlueZ is not running; Bluetooth waits for it to start.");
        } else if self.read(bus).await.is_err() {
            return self.drain_until_closed(&mut signals).await;
        }
        while let Some(signal) = signals.recv().await {
            self.handle(bus, signal).await;
        }
        Served::Closed
    }

    /// After a refusal nothing more is read on this connection; a bus that then closes is opened
    /// again like any other.
    async fn drain_until_closed(&self, signals: &mut mpsc::UnboundedReceiver<BusSignal>) -> Served {
        while signals.recv().await.is_some() {}
        Served::Closed
    }

    /// A fresh snapshot under the current owner.
    async fn read(&self, bus: &Arc<dyn BluezBus>) -> Result<(), BluezError> {
        match bus.managed_objects().await {
            Ok(snapshot) => {
                self.objects.load(snapshot);
                let devices = self.objects.devices().len();
                let adapter = if self.objects.adapter().is_some() {
                    "present"
                } else {
                    "missing"
                };
                self.activity.info(&format!(
                    "BlueZ ready: {devices} device(s) known, adapter {adapter}"
                ));
                Ok(())
            }
            Err(error) => {
                self.objects.clear();
                if error.is_access_denied() {
                    self.access_denied();
                } else {
                    self.activity
                        .warn(&format!("Could not read BlueZ's devices: {error}"));
                }
                Err(error)
            }
        }
    }

    async fn handle(&self, bus: &Arc<dyn BluezBus>, signal: BusSignal) {
        if let BluezSignal::NameOwnerChanged { name, new, .. } = &signal.signal {
            if signal.sender != DBUS_NAME || name != BLUEZ {
                return;
            }
            // Nothing of the old daemon stays, even while the new one is read.
            self.objects.clear();
            if new.is_empty() {
                lock(&self.shared).owner = None;
                self.activity
                    .warn("BlueZ stopped; Bluetooth waits for it to come back.");
                return;
            }
            lock(&self.shared).owner = Some(new.clone());
            self.activity
                .info("BlueZ started; reading its devices again.");
            let _ = self.read(bus).await;
            return;
        }
        // Once BlueZ's owner is tracked, fail closed: while it is unknown, no signal is BlueZ's.
        let from_bluez = lock(&self.shared).owner.as_deref() == Some(signal.sender.as_str());
        if from_bluez && self.objects.is_ready() {
            self.objects.apply(&signal.signal);
        }
    }

    /// The bus policy keeps this user from BlueZ.
    fn access_denied(&self) {
        let command = manual_group_command(&self.user);
        self.activity.warn(&format!(
            "BlueZ refused this user: on many systems only members of the \"bluetooth\" group may \
             use it. To join it: {command}"
        ));
        if let (Some(access), Some(this)) = (&self.access, self.myself.upgrade()) {
            access.refused(Arc::new(SessionRetry(Arc::downgrade(&this))));
        }
    }
}

/// "Check again" for the access question: a retry of the session, if it is still there.
struct SessionRetry(Weak<BluezSession>);

#[async_trait]
impl CheckAgain for SessionRetry {
    async fn check_again(&self) {
        if let Some(session) = self.0.upgrade() {
            session.retry();
        }
    }
}
