//! BlueZ as the provider sees it: the operations it asks of BlueZ over D-Bus, behind one trait
//! so the logic above runs against a fake BlueZ in tests, and BlueZ's objects kept in memory.
//!
//! The cache is one `GetManagedObjects`, kept current by `InterfacesAdded`, `InterfacesRemoved`
//! and `PropertiesChanged`. Discovery answers from it, never from a bus round trip. BlueZ holds a
//! paired brick's name while it is not connected, unlike Windows.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use tokio::sync::{Notify, mpsc, watch};

use crate::bt::{format_mac, is_lego_mac};

use super::agent::PairingAgent;

/// BlueZ's well-known bus name.
pub const BLUEZ: &str = "org.bluez";
/// The bus daemon's own name, the only sender of `NameOwnerChanged`.
pub const DBUS_NAME: &str = "org.freedesktop.DBus";
pub const DEVICE_INTERFACE: &str = "org.bluez.Device1";
pub const ADAPTER_INTERFACE: &str = "org.bluez.Adapter1";

/// The bus policy refused this user a message to BlueZ.
pub const ACCESS_DENIED: &str = "org.freedesktop.DBus.Error.AccessDenied";
/// Nobody owns the name asked about: BlueZ is not running.
pub const NAME_HAS_NO_OWNER: &str = "org.freedesktop.DBus.Error.NameHasNoOwner";
pub const ERROR_FAILED: &str = "org.bluez.Error.Failed";
pub const ERROR_IN_PROGRESS: &str = "org.bluez.Error.InProgress";
pub const ERROR_ALREADY_EXISTS: &str = "org.bluez.Error.AlreadyExists";
pub const ERROR_DOES_NOT_EXIST: &str = "org.bluez.Error.DoesNotExist";
pub const ERROR_REJECTED: &str = "org.bluez.Error.Rejected";

/// One property value, as far as the provider reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropValue {
    Str(String),
    Bool(bool),
    Int(i64),
    /// A value of a type nothing here reads.
    Other,
}

/// `a{sv}`: one interface's properties.
pub type Properties = HashMap<String, PropValue>;
/// One object's interfaces and their properties.
pub type Interfaces = HashMap<String, Properties>;

/// A call BlueZ or the bus refused, or one that never got an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BluezError {
    /// The D-Bus error name (`org.bluez.Error.InProgress`); empty for a failure that is not a
    /// D-Bus error (the bus closed, a reply of the wrong shape).
    pub name: String,
    pub message: String,
}

impl BluezError {
    pub fn new(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            message: message.into(),
        }
    }

    /// A failure that is not a D-Bus error.
    pub fn local(message: impl Into<String>) -> Self {
        Self::new("", message)
    }

    pub fn is(&self, name: &str) -> bool {
        self.name == name
    }

    /// The bus policy keeps this user from BlueZ.
    pub fn is_access_denied(&self) -> bool {
        self.is(ACCESS_DENIED)
    }

    /// The last part of the name: `InProgress` for `org.bluez.Error.InProgress`.
    pub fn short_name(&self) -> &str {
        self.name.rsplit('.').next().unwrap_or(&self.name)
    }
}

impl std::fmt::Display for BluezError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.name.is_empty() {
            f.write_str(&self.message)
        } else {
            write!(f, "{}: {}", self.name, self.message)
        }
    }
}

/// A signal the provider listens to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BluezSignal {
    InterfacesAdded {
        path: String,
        interfaces: Interfaces,
    },
    InterfacesRemoved {
        path: String,
        interfaces: Vec<String>,
    },
    PropertiesChanged {
        path: String,
        interface: String,
        changed: Properties,
        invalidated: Vec<String>,
    },
    /// Who owns a bus name now; `new` empty when nobody does.
    NameOwnerChanged {
        name: String,
        old: String,
        new: String,
    },
}

/// A signal and the unique bus name that sent it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusSignal {
    pub sender: String,
    pub signal: BluezSignal,
}

/// The agent capability the cockpit registers with: it can show and type a PIN, which is how the
/// brick pairs.
pub const AGENT_CAPABILITY: &str = "KeyboardDisplay";

/// One connection to the system bus, and what the provider asks of BlueZ over it.
///
/// An operation holds the connection it started on for its whole length, so its cleanup
/// (`StopDiscovery`, `CancelPairing`, `UnregisterAgent`) goes where it started, never to a later
/// connection.
#[async_trait]
pub trait BluezBus: Send + Sync {
    /// Asks the bus for BlueZ's signals and for changes of BlueZ's owner, and hands them over in
    /// order. The receiver ends when the connection closes.
    async fn watch(&self) -> Result<mpsc::UnboundedReceiver<BusSignal>, BluezError>;
    /// The unique name that owns `org.bluez`; `None` when nobody does.
    async fn name_owner(&self) -> Result<Option<String>, BluezError>;
    /// `GetManagedObjects`: every object BlueZ holds.
    async fn managed_objects(&self) -> Result<Vec<(String, Interfaces)>, BluezError>;
    /// `SetDiscoveryFilter` with `Transport=bredr`: the classic radio only.
    async fn set_discovery_filter_bredr(&self, adapter: &str) -> Result<(), BluezError>;
    async fn start_discovery(&self, adapter: &str) -> Result<(), BluezError>;
    async fn stop_discovery(&self, adapter: &str) -> Result<(), BluezError>;
    /// `Adapter1.RemoveDevice`: the device record, link key included.
    async fn remove_device(&self, adapter: &str, device: &str) -> Result<(), BluezError>;
    /// Switches the adapter on or off through its `Powered` property.
    async fn set_powered(&self, adapter: &str, on: bool) -> Result<(), BluezError>;
    /// Serves `agent` at `path` on this connection, answering BlueZ's `Agent1` calls.
    async fn export_agent(&self, path: &str, agent: Arc<PairingAgent>) -> Result<(), BluezError>;
    /// Stops serving the agent at `path`.
    async fn withdraw_agent(&self, path: &str);
    /// `AgentManager1.RegisterAgent`. Never followed by `RequestDefaultAgent`: an agent the
    /// calling connection registered is the one BlueZ asks about a pairing that connection
    /// started, so the desktop's own agent stays the default.
    async fn register_agent(&self, path: &str, capability: &str) -> Result<(), BluezError>;
    async fn unregister_agent(&self, path: &str) -> Result<(), BluezError>;
    /// `Device1.Pair`. No deadline of its own: the caller bounds it.
    async fn pair(&self, device: &str) -> Result<(), BluezError>;
    async fn cancel_pairing(&self, device: &str) -> Result<(), BluezError>;
    /// Closes the connection.
    fn close(&self);
}

/// Opens connections to the system bus.
#[async_trait]
pub trait BluezConnector: Send + Sync {
    async fn open(&self) -> Result<Arc<dyn BluezBus>, BluezError>;
}

/// One device BlueZ knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BluezDevice {
    pub path: String,
    pub address: Option<String>,
    pub name: Option<String>,
    pub alias: Option<String>,
    pub class_of_device: Option<u32>,
    pub paired: bool,
    pub bonded: bool,
    pub trusted: bool,
    pub connected: bool,
    /// Only while a discovery hears it.
    pub rssi: Option<i32>,
}

/// This computer's first Bluetooth adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BluezAdapter {
    pub path: String,
    pub address: Option<String>,
    /// The name this computer's radio gives itself; what a brick lists it under.
    pub alias: Option<String>,
    pub powered: bool,
    pub discovering: bool,
}

impl BluezAdapter {
    /// `hci0` for `/org/bluez/hci0`.
    pub fn hci(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }
}

/// A device's Name, or a user's own Alias; never the dashed address BlueZ puts in Alias when a
/// device has no Name.
pub fn device_name(device: &BluezDevice) -> String {
    if let Some(name) = &device.name {
        return name.clone();
    }
    match &device.alias {
        Some(alias) if !is_address_alias(alias) => alias.clone(),
        _ => String::new(),
    }
}

/// BlueZ's default Alias for a device without a Name: its address, dashed.
fn is_address_alias(alias: &str) -> bool {
    let bytes = alias.as_bytes();
    bytes.len() == 17
        && bytes.iter().enumerate().all(|(index, byte)| {
            if index % 3 == 2 {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// The object path BlueZ gives a device on `adapter_path`:
/// `/org/bluez/hci0/dev_00_16_53_F0_0A_0A`.
pub fn device_path(adapter_path: &str, address: u64) -> String {
    format!(
        "{adapter_path}/dev_{}",
        format_mac(address).replace(':', "_")
    )
}

fn text(props: &Properties, key: &str) -> Option<String> {
    match props.get(key) {
        Some(PropValue::Str(value)) => Some(value.clone()),
        _ => None,
    }
}

fn flag(props: &Properties, key: &str) -> bool {
    matches!(props.get(key), Some(PropValue::Bool(true)))
}

fn integer(props: &Properties, key: &str) -> Option<i64> {
    match props.get(key) {
        Some(PropValue::Int(value)) => Some(*value),
        _ => None,
    }
}

#[derive(Debug, Default)]
struct CacheState {
    ready: bool,
    objects: BTreeMap<String, Interfaces>,
    /// RSSI-bearing signals per device: what a discovery heard, a same value included.
    reports: HashMap<String, u32>,
}

type Listener = Arc<dyn Fn() + Send + Sync>;

/// BlueZ's objects, kept in memory.
pub struct BluezObjects {
    state: Mutex<CacheState>,
    changes: watch::Sender<u64>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_listener: AtomicU64,
}

impl std::fmt::Debug for BluezObjects {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BluezObjects")
            .field("ready", &self.is_ready())
            .finish_non_exhaustive()
    }
}

impl Default for BluezObjects {
    fn default() -> Self {
        Self::new()
    }
}

impl BluezObjects {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(CacheState::default()),
            changes: watch::channel(0).0,
            listeners: Mutex::new(Vec::new()),
            next_listener: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> MutexGuard<'_, CacheState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether BlueZ's objects have been read.
    pub fn is_ready(&self) -> bool {
        self.lock().ready
    }

    /// Takes a fresh snapshot: everything held before, the RSSI counts included, is dropped.
    pub fn load(&self, snapshot: Vec<(String, Interfaces)>) {
        {
            let mut state = self.lock();
            state.objects.clear();
            state.reports.clear();
            for (path, interfaces) in snapshot {
                state.objects.insert(path, interfaces);
            }
            state.ready = true;
        }
        self.notify();
    }

    /// Forgets everything and is not ready: BlueZ went, or the bus closed.
    pub fn clear(&self) {
        {
            let mut state = self.lock();
            state.ready = false;
            state.objects.clear();
            state.reports.clear();
        }
        self.notify();
    }

    /// Applies one of BlueZ's signals. True when it changed something.
    pub fn apply(&self, signal: &BluezSignal) -> bool {
        let changed = {
            let mut state = self.lock();
            count_report(&mut state, signal);
            match signal {
                BluezSignal::InterfacesAdded { path, interfaces } => {
                    let held = state.objects.entry(path.clone()).or_default();
                    for (name, props) in interfaces {
                        held.insert(name.clone(), props.clone());
                    }
                    true
                }
                BluezSignal::InterfacesRemoved { path, interfaces } => {
                    match state.objects.get_mut(path) {
                        Some(held) => {
                            for name in interfaces {
                                held.remove(name);
                            }
                            if held.is_empty() {
                                state.objects.remove(path);
                            }
                            true
                        }
                        None => false,
                    }
                }
                BluezSignal::PropertiesChanged {
                    path,
                    interface,
                    changed,
                    invalidated,
                } => {
                    // Only objects the cache already holds: a change does not make an object up.
                    match state
                        .objects
                        .get_mut(path)
                        .and_then(|held| held.get_mut(interface))
                    {
                        Some(props) => {
                            for (key, value) in changed {
                                props.insert(key.clone(), value.clone());
                            }
                            // BlueZ invalidates what it no longer knows, in practice RSSI and
                            // TxPower. A boolean it invalidates keeps its last known value rather
                            // than read false.
                            for key in invalidated {
                                if !matches!(props.get(key), Some(PropValue::Bool(_))) {
                                    props.remove(key);
                                }
                            }
                            true
                        }
                        None => false,
                    }
                }
                BluezSignal::NameOwnerChanged { .. } => false,
            }
        };
        if changed {
            self.notify();
        }
        changed
    }

    /// Every device BlueZ knows: paired, and heard by a discovery.
    pub fn devices(&self) -> Vec<BluezDevice> {
        let state = self.lock();
        state
            .objects
            .iter()
            .filter_map(|(path, interfaces)| {
                let props = interfaces.get(DEVICE_INTERFACE)?;
                Some(BluezDevice {
                    path: path.clone(),
                    address: text(props, "Address"),
                    name: text(props, "Name"),
                    alias: text(props, "Alias"),
                    class_of_device: integer(props, "Class").and_then(|v| u32::try_from(v).ok()),
                    paired: flag(props, "Paired"),
                    bonded: flag(props, "Bonded"),
                    trusted: flag(props, "Trusted"),
                    connected: flag(props, "Connected"),
                    rssi: integer(props, "RSSI").and_then(|v| i32::try_from(v).ok()),
                })
            })
            .collect()
    }

    /// The device at `path`, if BlueZ holds it.
    pub fn device(&self, path: &str) -> Option<BluezDevice> {
        self.devices()
            .into_iter()
            .find(|device| device.path == path)
    }

    /// The first adapter by path, `hci0` on a typical host; a second radio is not used.
    pub fn adapter(&self) -> Option<BluezAdapter> {
        let state = self.lock();
        state.objects.iter().find_map(|(path, interfaces)| {
            let props = interfaces.get(ADAPTER_INTERFACE)?;
            Some(BluezAdapter {
                path: path.clone(),
                address: text(props, "Address"),
                alias: text(props, "Alias"),
                powered: flag(props, "Powered"),
                discovering: flag(props, "Discovering"),
            })
        })
    }

    /// How many signals carrying an RSSI have come for this device: an `InterfacesAdded` with
    /// one, or a `PropertiesChanged` setting it. The evidence a discovery heard it; the snapshot
    /// is none, and an RSSI BlueZ still holds from an earlier discovery is none either. Under a
    /// filtered discovery BlueZ reports every result, a same value too (measured: three reports
    /// in 30 s, equal values among them).
    pub fn rssi_reports(&self, path: &str) -> u32 {
        self.lock().reports.get(path).copied().unwrap_or(0)
    }

    /// The devices with a well-formed address, for discovery. Refuses before BlueZ's objects are
    /// read, so discovery says so once rather than show an empty list as though there were no
    /// bricks.
    pub fn list_devices(&self) -> Result<Vec<BluezDevice>, String> {
        if !self.is_ready() {
            return Err("BlueZ is not ready: its objects have not been read.".into());
        }
        Ok(self
            .devices()
            .into_iter()
            .filter(|device| {
                device
                    .address
                    .as_deref()
                    .and_then(crate::bt::parse_mac)
                    .is_some()
            })
            .collect())
    }

    /// The LEGO bricks among [`BluezObjects::list_devices`].
    pub fn list_bricks(&self) -> Result<Vec<BluezDevice>, String> {
        Ok(self
            .list_devices()?
            .into_iter()
            .filter(|device| device.address.as_deref().is_some_and(is_lego_mac))
            .collect())
    }

    /// This computer's Bluetooth name: the adapter's Alias, which BlueZ defaults to the host
    /// name.
    pub fn radio_name(&self) -> Option<String> {
        self.adapter()
            .and_then(|adapter| adapter.alias)
            .filter(|alias| !alias.is_empty())
    }

    /// A receiver that sees a new value after every change.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Calls `listener` after every change, outside the cache's lock. Returns its id for
    /// [`BluezObjects::remove_listener`].
    pub fn on_change(&self, listener: impl Fn() + Send + Sync + 'static) -> u64 {
        let id = self.next_listener.fetch_add(1, Ordering::SeqCst);
        self.listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((id, Arc::new(listener)));
        id
    }

    pub fn remove_listener(&self, id: u64) {
        self.listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|(listener, _)| *listener != id);
    }

    fn notify(&self) {
        self.changes
            .send_modify(|version| *version = version.wrapping_add(1));
        let listeners: Vec<Listener> = self
            .listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            listener();
        }
    }
}

fn count_report(state: &mut CacheState, signal: &BluezSignal) {
    let path = match signal {
        BluezSignal::InterfacesAdded { path, interfaces }
            if interfaces
                .get(DEVICE_INTERFACE)
                .is_some_and(|props| props.contains_key("RSSI")) =>
        {
            Some(path)
        }
        BluezSignal::PropertiesChanged {
            path,
            interface,
            changed,
            ..
        } if interface == DEVICE_INTERFACE && changed.contains_key("RSSI") => Some(path),
        _ => None,
    };
    if let Some(path) = path {
        *state.reports.entry(path.clone()).or_insert(0) += 1;
    }
}

/// A one-way stop signal: set once, seen by every waiter, before or after it was set.
#[derive(Debug, Default)]
pub struct CancelFlag {
    flag: AtomicBool,
    notify: Notify,
}

impl CancelFlag {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        loop {
            // Created before the flag is read, so a cancel between the read and the wait is seen.
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// Sets a [`CancelFlag`] when dropped: a caller that goes away tells the work it started.
#[derive(Debug)]
pub struct CancelOnDrop(pub Arc<CancelFlag>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Runs `work` on a task of its own and waits for it; dropping the wait cancels `cancel`, and
/// the work runs on to its own end, so the cleanup it owes (a `StopDiscovery`, a `CancelPairing`,
/// writing an adapter's `authorized` file back to 1) still happens. `None` when the work
/// panicked.
pub async fn run_detached<T, F>(cancel: Arc<CancelFlag>, work: F) -> Option<T>
where
    T: Send + 'static,
    F: std::future::Future<Output = T> + Send + 'static,
{
    let _guard = CancelOnDrop(cancel);
    tokio::spawn(work).await.ok()
}

/// The radio's discovery as one resource, between the pairing search and the inquiry. A search
/// that gives up before its `StartDiscovery` settles stops that discovery later, when it does;
/// the caller, and its turn in the Bluetooth queue, are gone by then. Whoever starts the next
/// discovery waits here first, so that late `StopDiscovery` cannot end it.
#[derive(Debug, Default)]
pub struct DiscoveryGate {
    outstanding: Mutex<usize>,
    idle: Notify,
}

/// One discovery's end still to come; the gate is idle once every hold is dropped.
#[derive(Debug)]
pub struct GateHold(Arc<DiscoveryGate>);

impl Drop for GateHold {
    fn drop(&mut self) {
        let mut outstanding = self
            .0
            .outstanding
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *outstanding = outstanding.saturating_sub(1);
        drop(outstanding);
        self.0.idle.notify_waiters();
    }
}

impl DiscoveryGate {
    /// Marks a discovery whose end is still to come.
    pub fn hold(self: &Arc<Self>) -> GateHold {
        *self
            .outstanding
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
        GateHold(Arc::clone(self))
    }

    /// Discoveries whose end is still to come.
    pub fn outstanding(&self) -> usize {
        *self
            .outstanding
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Settles once no discovery's end is outstanding.
    pub async fn idle(&self) {
        loop {
            let notified = self.idle.notified();
            if self.outstanding() == 0 {
                return;
            }
            notified.await;
        }
    }
}
