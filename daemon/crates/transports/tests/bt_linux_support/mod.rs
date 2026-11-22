//! A fake BlueZ for the Linux Bluetooth tests: records every call, answers as scripted, and
//! sends signals when told. No D-Bus anywhere.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ev3_transports::bt_linux::access::Activity;
use ev3_transports::bt_linux::agent::PairingAgent;
use ev3_transports::bt_linux::bluez::{
    ADAPTER_INTERFACE, BluezBus, BluezConnector, BluezError, BluezSignal, BusSignal,
    DEVICE_INTERFACE, Interfaces, PropValue, Properties,
};
use ev3_transports::bt_linux::session::BluezSession;
use tokio::sync::mpsc;

pub const ADAPTER: &str = "/org/bluez/hci0";
/// A documentation-range address for this computer's adapter.
pub const ADAPTER_ADDRESS: &str = "00:00:5E:00:53:01";
pub const AAA: &str = "00:16:53:F0:0A:0A";
pub const BBB: &str = "00:16:53:F0:0A:0B";
pub const CCC: &str = "00:16:53:F0:0A:0C";
pub const AAA_PATH: &str = "/org/bluez/hci0/dev_00_16_53_F0_0A_0A";
pub const BBB_PATH: &str = "/org/bluez/hci0/dev_00_16_53_F0_0A_0B";
pub const CCC_PATH: &str = "/org/bluez/hci0/dev_00_16_53_F0_0A_0C";
/// BlueZ's unique bus name in the tests.
pub const BLUEZ_OWNER: &str = ":1.7";

pub fn props(entries: &[(&str, PropValue)]) -> Properties {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

pub fn s(value: &str) -> PropValue {
    PropValue::Str(value.to_owned())
}

pub fn adapter_object() -> (String, Interfaces) {
    (
        ADAPTER.to_owned(),
        HashMap::from([(
            ADAPTER_INTERFACE.to_owned(),
            props(&[
                ("Address", s(ADAPTER_ADDRESS)),
                ("Alias", s("HOSTD")),
                ("Powered", PropValue::Bool(true)),
            ]),
        )]),
    )
}

pub fn device_props(
    address: &str,
    name: Option<&str>,
    paired: bool,
    rssi: Option<i64>,
) -> Properties {
    let mut entries = vec![
        ("Address", s(address)),
        ("Paired", PropValue::Bool(paired)),
        ("Connected", PropValue::Bool(false)),
    ];
    if let Some(name) = name {
        entries.push(("Name", s(name)));
        entries.push(("Alias", s(name)));
    } else {
        entries.push(("Alias", s(&address.replace(':', "-"))));
    }
    if let Some(rssi) = rssi {
        entries.push(("RSSI", PropValue::Int(rssi)));
    }
    props(&entries)
}

pub fn device_object(
    path: &str,
    address: &str,
    name: Option<&str>,
    paired: bool,
    rssi: Option<i64>,
) -> (String, Interfaces) {
    (
        path.to_owned(),
        HashMap::from([(
            DEVICE_INTERFACE.to_owned(),
            device_props(address, name, paired, rssi),
        )]),
    )
}

pub fn from_bluez(signal: BluezSignal) -> BusSignal {
    BusSignal {
        sender: BLUEZ_OWNER.to_owned(),
        signal,
    }
}

pub fn rssi_report(path: &str, rssi: i64) -> BluezSignal {
    BluezSignal::PropertiesChanged {
        path: path.to_owned(),
        interface: DEVICE_INTERFACE.to_owned(),
        changed: props(&[("RSSI", PropValue::Int(rssi))]),
        invalidated: Vec::new(),
    }
}

/// One recorded call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub member: String,
    pub args: Vec<String>,
}

impl Call {
    fn new(member: &str, args: &[&str]) -> Self {
        Self {
            member: member.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        }
    }
}

/// How a scripted call answers.
#[derive(Debug, Clone)]
pub enum Reply {
    Ok,
    Err(BluezError),
    /// Never answers.
    Hang,
    /// Answers after a pause.
    After(Duration, Box<Reply>),
}

type Hook = Box<dyn Fn(&FakeBus, &Call) + Send + Sync>;
/// What GetManagedObjects answers.
type Snapshot = Vec<(String, Interfaces)>;

/// A fake BlueZ connection.
pub struct FakeBus {
    pub calls: Mutex<Vec<Call>>,
    replies: Mutex<HashMap<String, VecDeque<Reply>>>,
    sender: Mutex<Option<mpsc::UnboundedSender<BusSignal>>>,
    pub watch_error: Mutex<Option<BluezError>>,
    pub owner: Mutex<Result<Option<String>, BluezError>>,
    pub objects: Mutex<VecDeque<Result<Snapshot, BluezError>>>,
    pub default_objects: Mutex<Vec<(String, Interfaces)>>,
    pub agent: Mutex<Option<Arc<PairingAgent>>>,
    /// What the agent answered to the PIN request during `Pair`.
    pub pin_answers: Mutex<Vec<Result<String, String>>>,
    /// `Pair` asks the agent for the PIN first, as BlueZ does for an EV3.
    pub pair_asks_pin: AtomicBool,
    pub closed: AtomicBool,
    hook: Mutex<Option<Hook>>,
}

impl Default for FakeBus {
    fn default() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            replies: Mutex::new(HashMap::new()),
            sender: Mutex::new(None),
            watch_error: Mutex::new(None),
            owner: Mutex::new(Ok(Some(BLUEZ_OWNER.to_owned()))),
            objects: Mutex::new(VecDeque::new()),
            default_objects: Mutex::new(vec![adapter_object()]),
            agent: Mutex::new(None),
            pin_answers: Mutex::new(Vec::new()),
            pair_asks_pin: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            hook: Mutex::new(None),
        }
    }
}

impl FakeBus {
    pub fn new(objects: Vec<(String, Interfaces)>) -> Arc<Self> {
        let bus = Self::default();
        *bus.default_objects.lock().unwrap() = objects;
        Arc::new(bus)
    }

    /// The next call to `member` answers `reply`; later calls answer as scripted next, or Ok.
    pub fn reply(&self, member: &str, reply: Reply) {
        self.replies
            .lock()
            .unwrap()
            .entry(member.to_owned())
            .or_default()
            .push_back(reply);
    }

    /// Called on every call, after it is recorded.
    pub fn on_call(&self, hook: impl Fn(&FakeBus, &Call) + Send + Sync + 'static) {
        *self.hook.lock().unwrap() = Some(Box::new(hook));
    }

    pub fn emit(&self, signal: BusSignal) {
        if let Some(sender) = self.sender.lock().unwrap().as_ref() {
            let _ = sender.send(signal);
        }
    }

    /// The bus closes under the session.
    pub fn drop_connection(&self) {
        self.sender.lock().unwrap().take();
    }

    pub fn members(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.member.clone())
            .collect()
    }

    pub fn count(&self, member: &str) -> usize {
        self.members().iter().filter(|m| *m == member).count()
    }

    async fn answer(&self, call: Call) -> Result<(), BluezError> {
        let member = call.member.clone();
        self.calls.lock().unwrap().push(call.clone());
        if let Some(hook) = self.hook.lock().unwrap().as_ref() {
            hook(self, &call);
        }
        let reply = self
            .replies
            .lock()
            .unwrap()
            .get_mut(&member)
            .and_then(VecDeque::pop_front)
            .unwrap_or(Reply::Ok);
        play(reply).await
    }
}

fn play(
    reply: Reply,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), BluezError>> + Send>> {
    Box::pin(async move {
        match reply {
            Reply::Ok => Ok(()),
            Reply::Err(error) => Err(error),
            Reply::Hang => std::future::pending().await,
            Reply::After(pause, then) => {
                tokio::time::sleep(pause).await;
                play(*then).await
            }
        }
    })
}

#[async_trait]
impl BluezBus for FakeBus {
    async fn watch(&self) -> Result<mpsc::UnboundedReceiver<BusSignal>, BluezError> {
        self.calls.lock().unwrap().push(Call::new("AddMatch", &[]));
        if let Some(error) = self.watch_error.lock().unwrap().clone() {
            return Err(error);
        }
        let (to, from) = mpsc::unbounded_channel();
        *self.sender.lock().unwrap() = Some(to);
        Ok(from)
    }

    async fn name_owner(&self) -> Result<Option<String>, BluezError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::new("GetNameOwner", &[]));
        self.owner.lock().unwrap().clone()
    }

    async fn managed_objects(&self) -> Result<Vec<(String, Interfaces)>, BluezError> {
        let call = Call::new("GetManagedObjects", &[]);
        let scripted = self.objects.lock().unwrap().pop_front();
        self.answer(call).await?;
        match scripted {
            Some(answer) => answer,
            None => Ok(self.default_objects.lock().unwrap().clone()),
        }
    }

    async fn set_discovery_filter_bredr(&self, adapter: &str) -> Result<(), BluezError> {
        self.answer(Call::new("SetDiscoveryFilter", &[adapter, "bredr"]))
            .await
    }

    async fn start_discovery(&self, adapter: &str) -> Result<(), BluezError> {
        self.answer(Call::new("StartDiscovery", &[adapter])).await
    }

    async fn stop_discovery(&self, adapter: &str) -> Result<(), BluezError> {
        self.answer(Call::new("StopDiscovery", &[adapter])).await
    }

    async fn remove_device(&self, adapter: &str, device: &str) -> Result<(), BluezError> {
        self.answer(Call::new("RemoveDevice", &[adapter, device]))
            .await
    }

    async fn set_powered(&self, adapter: &str, on: bool) -> Result<(), BluezError> {
        let value = if on { "true" } else { "false" };
        self.answer(Call::new("SetPowered", &[adapter, value]))
            .await
    }

    async fn export_agent(&self, path: &str, agent: Arc<PairingAgent>) -> Result<(), BluezError> {
        *self.agent.lock().unwrap() = Some(agent);
        self.answer(Call::new("ExportAgent", &[path])).await
    }

    async fn withdraw_agent(&self, path: &str) {
        self.agent.lock().unwrap().take();
        self.calls
            .lock()
            .unwrap()
            .push(Call::new("WithdrawAgent", &[path]));
    }

    async fn register_agent(&self, path: &str, capability: &str) -> Result<(), BluezError> {
        self.answer(Call::new("RegisterAgent", &[path, capability]))
            .await
    }

    async fn unregister_agent(&self, path: &str) -> Result<(), BluezError> {
        self.answer(Call::new("UnregisterAgent", &[path])).await
    }

    async fn pair(&self, device: &str) -> Result<(), BluezError> {
        if self.pair_asks_pin.load(Ordering::SeqCst) {
            let agent = self.agent.lock().unwrap().clone();
            if let Some(agent) = agent {
                let answer = agent
                    .request_pin_code(Some(BLUEZ_OWNER), device)
                    .map_err(|refusal| refusal.message().to_owned());
                self.pin_answers.lock().unwrap().push(answer);
            }
        }
        self.answer(Call::new("Pair", &[device])).await
    }

    async fn cancel_pairing(&self, device: &str) -> Result<(), BluezError> {
        self.answer(Call::new("CancelPairing", &[device])).await
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.drop_connection();
    }
}

/// Hands out scripted connections; a fresh default one when the script runs out.
#[derive(Default)]
pub struct FakeConnector {
    pub script: Mutex<VecDeque<Result<Arc<FakeBus>, BluezError>>>,
    pub opened: AtomicUsize,
    pub last: Mutex<Option<Arc<FakeBus>>>,
}

impl FakeConnector {
    pub fn with(buses: Vec<Result<Arc<FakeBus>, BluezError>>) -> Arc<Self> {
        let connector = Self::default();
        *connector.script.lock().unwrap() = buses.into();
        Arc::new(connector)
    }
}

#[async_trait]
impl BluezConnector for FakeConnector {
    async fn open(&self) -> Result<Arc<dyn BluezBus>, BluezError> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        let next = self
            .script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(Arc::new(FakeBus::default())));
        let bus = next?;
        *self.last.lock().unwrap() = Some(Arc::clone(&bus));
        Ok(bus)
    }
}

/// Collects what the provider says.
#[derive(Default)]
pub struct Said {
    pub lines: Mutex<Vec<(String, String)>>,
}

impl Said {
    pub fn warnings(&self) -> Vec<String> {
        self.lines
            .lock()
            .unwrap()
            .iter()
            .filter(|(level, _)| level == "warn")
            .map(|(_, line)| line.clone())
            .collect()
    }

    pub fn all(&self) -> Vec<String> {
        self.lines
            .lock()
            .unwrap()
            .iter()
            .map(|(_, line)| line.clone())
            .collect()
    }

    pub fn count_containing(&self, text: &str) -> usize {
        self.all().iter().filter(|line| line.contains(text)).count()
    }
}

impl Activity for Said {
    fn info(&self, message: &str) {
        self.lines
            .lock()
            .unwrap()
            .push(("info".into(), message.to_owned()));
    }

    fn warn(&self, message: &str) {
        self.lines
            .lock()
            .unwrap()
            .push(("warn".into(), message.to_owned()));
    }
}

/// Lets spawned tasks run until `done` holds, on a paused or a real clock; panics after a long
/// while of (virtual) time.
pub async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..10_000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("condition never held");
}

/// A session over `bus`, started, its objects read.
pub async fn ready_session(bus: Arc<FakeBus>, said: Arc<Said>) -> Arc<BluezSession> {
    let connector = FakeConnector::with(vec![Ok(bus)]);
    let session = BluezSession::new(connector, said, None, "student", Duration::from_secs(1));
    session.start();
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
    session
}
