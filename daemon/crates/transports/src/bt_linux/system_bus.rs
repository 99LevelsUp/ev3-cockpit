//! The BlueZ seam over the real system bus, through `zbus`: a thin translation of each
//! operation into its D-Bus call and of each reply, signal and error back. Nothing here decides
//! anything; the logic above is tested against a fake BlueZ, and this part on hardware.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
// zbus re-exports the trait its stream implements only here; naming it directly would need a
// dependency of its own.
use futures_core::Stream;
use zbus::message::Header;
use zbus::{Connection, DBusError, Message, MessageStream, ObjectPath, OwnedObjectPath, Variant};

use super::agent::{AgentRefusal, PairingAgent};
use super::bluez::{
    ADAPTER_INTERFACE, BLUEZ, BluezBus, BluezConnector, BluezError, BluezSignal, BusSignal,
    DBUS_NAME, DEVICE_INTERFACE, Interfaces, NAME_HAS_NO_OWNER, PropValue, Properties,
};

const OBJECT_MANAGER: &str = "org.freedesktop.DBus.ObjectManager";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const AGENT_MANAGER: &str = "org.bluez.AgentManager1";

/// How long a call may wait for its answer: a call BlueZ never answers would otherwise hold the
/// Bluetooth queue, or the session, for good. `Pair` alone is bounded by the pairing instead,
/// which outlasts this.
pub const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// Waits for call at most [`CALL_TIMEOUT`].
async fn bounded<T>(
    what: &str,
    call: impl std::future::Future<Output = Result<T, BluezError>>,
) -> Result<T, BluezError> {
    match tokio::time::timeout(CALL_TIMEOUT, call).await {
        Ok(answer) => answer,
        Err(_) => Err(BluezError::local(format!(
            "D-Bus call {what} timed out after {} ms.",
            CALL_TIMEOUT.as_millis()
        ))),
    }
}

/// The rule for BlueZ's owner changing hands.
const OWNER_RULE: &str = "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.bluez'";
/// The rule for BlueZ's own signals: the bus resolves the well-known name to its owner.
const BLUEZ_RULE: &str = "type='signal',sender='org.bluez'";

fn convert(error: zbus::Error) -> BluezError {
    match &error {
        zbus::Error::MethodError(name, detail, _) => {
            BluezError::new(name.to_string(), detail.clone().unwrap_or_default())
        }
        zbus::Error::FDO(fdo) => BluezError::new(
            fdo.name().to_string(),
            fdo.description().unwrap_or_default().to_owned(),
        ),
        zbus::Error::DBus(inner) => BluezError::new(
            inner.name().to_string(),
            inner.description().unwrap_or_default().to_owned(),
        ),
        _ => BluezError::local(error.to_string()),
    }
}

fn object_path(path: &str) -> Result<ObjectPath<'_>, BluezError> {
    ObjectPath::try_from(path)
        .map_err(|error| BluezError::local(format!("Not an object path: {path} ({error})")))
}

fn prop_value(value: &Variant<'_>) -> PropValue {
    match value {
        Variant::Str(text) => PropValue::Str(text.to_string()),
        Variant::ObjectPath(path) => PropValue::Str(path.as_str().to_owned()),
        Variant::Bool(flag) => PropValue::Bool(*flag),
        Variant::U8(v) => PropValue::Int(i64::from(*v)),
        Variant::I16(v) => PropValue::Int(i64::from(*v)),
        Variant::U16(v) => PropValue::Int(i64::from(*v)),
        Variant::I32(v) => PropValue::Int(i64::from(*v)),
        Variant::U32(v) => PropValue::Int(i64::from(*v)),
        Variant::I64(v) => PropValue::Int(*v),
        Variant::U64(v) => i64::try_from(*v).map_or(PropValue::Other, PropValue::Int),
        Variant::Variant(inner) => prop_value(inner),
        _ => PropValue::Other,
    }
}

type WireProperties = HashMap<String, zbus::OwnedVariant>;
type WireInterfaces = HashMap<String, WireProperties>;

fn properties(wire: &WireProperties) -> Properties {
    wire.iter()
        .map(|(key, value)| (key.clone(), prop_value(value)))
        .collect()
}

fn interfaces(wire: &WireInterfaces) -> Interfaces {
    wire.iter()
        .map(|(name, props)| (name.clone(), properties(props)))
        .collect()
}

/// One signal off the bus, if it is one the provider listens to.
fn parse_signal(message: &Message) -> Option<BusSignal> {
    let header: Header<'_> = message.header();
    let sender = header.sender()?.as_str().to_owned();
    let interface = header.interface()?.as_str().to_owned();
    let member = header.member()?.as_str().to_owned();
    let path = header.path().map(|path| path.as_str().to_owned());
    let body = message.body();
    let signal = match (interface.as_str(), member.as_str()) {
        (DBUS_NAME, "NameOwnerChanged") => {
            let (name, old, new) = body.deserialize::<(String, String, String)>().ok()?;
            BluezSignal::NameOwnerChanged { name, old, new }
        }
        (OBJECT_MANAGER, "InterfacesAdded") => {
            let (object, added) = body
                .deserialize::<(OwnedObjectPath, WireInterfaces)>()
                .ok()?;
            BluezSignal::InterfacesAdded {
                path: object.as_str().to_owned(),
                interfaces: interfaces(&added),
            }
        }
        (OBJECT_MANAGER, "InterfacesRemoved") => {
            let (object, removed) = body.deserialize::<(OwnedObjectPath, Vec<String>)>().ok()?;
            BluezSignal::InterfacesRemoved {
                path: object.as_str().to_owned(),
                interfaces: removed,
            }
        }
        (PROPERTIES, "PropertiesChanged") => {
            let (changed_on, changed, invalidated) = body
                .deserialize::<(String, WireProperties, Vec<String>)>()
                .ok()?;
            BluezSignal::PropertiesChanged {
                path: path?,
                interface: changed_on,
                changed: properties(&changed),
                invalidated,
            }
        }
        _ => return None,
    };
    Some(BusSignal { sender, signal })
}

/// Hands one stream's signals over until the connection closes or nobody listens any more.
async fn forward(
    stream: MessageStream,
    connection: Connection,
    to: mpsc::UnboundedSender<BusSignal>,
) {
    let mut stream = Box::pin(stream);
    loop {
        let next = tokio::select! {
            next = std::future::poll_fn(|cx| stream.as_mut().poll_next(cx)) => next,
            () = connection.closed() => return,
        };
        match next {
            Some(Ok(message)) => {
                if let Some(signal) = parse_signal(&message)
                    && to.send(signal).is_err()
                {
                    return;
                }
            }
            Some(Err(_)) | None => return,
        }
    }
}

/// The errors the agent answers with.
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.bluez.Error")]
enum AgentError {
    #[zbus(error)]
    ZBus(zbus::Error),
    Rejected(String),
}

impl From<AgentRefusal> for AgentError {
    fn from(refusal: AgentRefusal) -> Self {
        Self::Rejected(refusal.message().to_owned())
    }
}

/// The agent as BlueZ calls it.
struct AgentObject {
    agent: Arc<PairingAgent>,
}

fn sender_of<'h>(header: &'h Header<'_>) -> Option<&'h str> {
    header.sender().map(|sender| sender.as_str())
}

#[zbus::interface(name = "org.bluez.Agent1")]
impl AgentObject {
    fn release(&self, #[zbus(header)] header: Header<'_>) -> Result<(), AgentError> {
        Ok(self.agent.release(sender_of(&header))?)
    }

    fn request_pin_code(
        &self,
        device: OwnedObjectPath,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<String, AgentError> {
        Ok(self
            .agent
            .request_pin_code(sender_of(&header), device.as_str())?)
    }

    fn display_pin_code(
        &self,
        device: OwnedObjectPath,
        _pincode: String,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), AgentError> {
        Ok(self
            .agent
            .display_pin_code(sender_of(&header), device.as_str())?)
    }

    fn request_passkey(
        &self,
        device: OwnedObjectPath,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<u32, AgentError> {
        Ok(self
            .agent
            .request_passkey(sender_of(&header), device.as_str())?)
    }

    fn display_passkey(
        &self,
        device: OwnedObjectPath,
        _passkey: u32,
        _entered: u16,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), AgentError> {
        Ok(self
            .agent
            .display_passkey(sender_of(&header), device.as_str())?)
    }

    fn request_confirmation(
        &self,
        device: OwnedObjectPath,
        _passkey: u32,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), AgentError> {
        Ok(self
            .agent
            .request_confirmation(sender_of(&header), device.as_str())?)
    }

    fn request_authorization(
        &self,
        device: OwnedObjectPath,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), AgentError> {
        Ok(self
            .agent
            .request_authorization(sender_of(&header), device.as_str())?)
    }

    fn authorize_service(
        &self,
        device: OwnedObjectPath,
        _uuid: String,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), AgentError> {
        Ok(self
            .agent
            .authorize_service(sender_of(&header), device.as_str())?)
    }

    fn cancel(&self, #[zbus(header)] header: Header<'_>) -> Result<(), AgentError> {
        Ok(self.agent.cancel(sender_of(&header))?)
    }
}

/// One connection to the system bus.
#[derive(Debug, Clone)]
pub struct SystemBus {
    connection: Connection,
}

impl SystemBus {
    /// A call to BlueZ, bounded by [`CALL_TIMEOUT`].
    async fn bluez_call<B>(
        &self,
        path: &str,
        interface: &str,
        member: &str,
        body: &B,
    ) -> Result<Message, BluezError>
    where
        B: serde::Serialize + zbus::DynamicType,
    {
        bounded(
            &format!("{interface}.{member}"),
            self.unbounded_call(path, interface, member, body),
        )
        .await
    }

    async fn unbounded_call<B>(
        &self,
        path: &str,
        interface: &str,
        member: &str,
        body: &B,
    ) -> Result<Message, BluezError>
    where
        B: serde::Serialize + zbus::DynamicType,
    {
        self.connection
            .call_method(
                Some(BLUEZ),
                object_path(path)?,
                Some(interface),
                member,
                body,
            )
            .await
            .map_err(convert)
    }
}

#[async_trait]
impl BluezBus for SystemBus {
    async fn watch(&self) -> Result<mpsc::UnboundedReceiver<BusSignal>, BluezError> {
        let owners = bounded("AddMatch", async {
            MessageStream::for_match_rule(OWNER_RULE, &self.connection, None)
                .await
                .map_err(convert)
        })
        .await?;
        let bluez = bounded("AddMatch", async {
            MessageStream::for_match_rule(BLUEZ_RULE, &self.connection, None)
                .await
                .map_err(convert)
        })
        .await?;
        let (to, from) = mpsc::unbounded_channel();
        tokio::spawn(forward(owners, self.connection.clone(), to.clone()));
        tokio::spawn(forward(bluez, self.connection.clone(), to));
        Ok(from)
    }

    async fn name_owner(&self) -> Result<Option<String>, BluezError> {
        let reply = bounded("GetNameOwner", async {
            self.connection
                .call_method(
                    Some(DBUS_NAME),
                    "/org/freedesktop/DBus",
                    Some(DBUS_NAME),
                    "GetNameOwner",
                    &(BLUEZ,),
                )
                .await
                .map_err(convert)
        })
        .await;
        match reply {
            Ok(message) => message
                .body()
                .deserialize::<String>()
                .map(Some)
                .map_err(convert),
            Err(error) if error.is(NAME_HAS_NO_OWNER) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn managed_objects(&self) -> Result<Vec<(String, Interfaces)>, BluezError> {
        let reply = self
            .bluez_call("/", OBJECT_MANAGER, "GetManagedObjects", &())
            .await?;
        let objects = reply
            .body()
            .deserialize::<HashMap<OwnedObjectPath, WireInterfaces>>()
            .map_err(convert)?;
        Ok(objects
            .iter()
            .map(|(path, wire)| (path.as_str().to_owned(), interfaces(wire)))
            .collect())
    }

    async fn set_discovery_filter_bredr(&self, adapter: &str) -> Result<(), BluezError> {
        let mut filter: HashMap<&str, Variant<'_>> = HashMap::new();
        filter.insert("Transport", Variant::from("bredr"));
        self.bluez_call(adapter, ADAPTER_INTERFACE, "SetDiscoveryFilter", &(filter,))
            .await
            .map(drop)
    }

    async fn start_discovery(&self, adapter: &str) -> Result<(), BluezError> {
        self.bluez_call(adapter, ADAPTER_INTERFACE, "StartDiscovery", &())
            .await
            .map(drop)
    }

    async fn stop_discovery(&self, adapter: &str) -> Result<(), BluezError> {
        self.bluez_call(adapter, ADAPTER_INTERFACE, "StopDiscovery", &())
            .await
            .map(drop)
    }

    async fn remove_device(&self, adapter: &str, device: &str) -> Result<(), BluezError> {
        let device = object_path(device)?;
        self.bluez_call(adapter, ADAPTER_INTERFACE, "RemoveDevice", &(device,))
            .await
            .map(drop)
    }

    async fn set_powered(&self, adapter: &str, on: bool) -> Result<(), BluezError> {
        self.bluez_call(
            adapter,
            PROPERTIES,
            "Set",
            &(ADAPTER_INTERFACE, "Powered", Variant::Bool(on)),
        )
        .await
        .map(drop)
    }

    async fn export_agent(&self, path: &str, agent: Arc<PairingAgent>) -> Result<(), BluezError> {
        self.connection
            .object_server()
            .at(object_path(path)?, AgentObject { agent })
            .await
            .map(drop)
            .map_err(convert)
    }

    async fn withdraw_agent(&self, path: &str) {
        if let Ok(path) = object_path(path) {
            let _ = self
                .connection
                .object_server()
                .remove::<AgentObject, _>(path)
                .await;
        }
    }

    async fn register_agent(&self, path: &str, capability: &str) -> Result<(), BluezError> {
        let agent = object_path(path)?;
        self.bluez_call(
            "/org/bluez",
            AGENT_MANAGER,
            "RegisterAgent",
            &(agent, capability),
        )
        .await
        .map(drop)
    }

    async fn unregister_agent(&self, path: &str) -> Result<(), BluezError> {
        let agent = object_path(path)?;
        self.bluez_call("/org/bluez", AGENT_MANAGER, "UnregisterAgent", &(agent,))
            .await
            .map(drop)
    }

    async fn pair(&self, device: &str) -> Result<(), BluezError> {
        // Bounded by the pairing, which waits longer than an ordinary call.
        self.unbounded_call(device, DEVICE_INTERFACE, "Pair", &())
            .await
            .map(drop)
    }

    async fn cancel_pairing(&self, device: &str) -> Result<(), BluezError> {
        self.bluez_call(device, DEVICE_INTERFACE, "CancelPairing", &())
            .await
            .map(drop)
    }

    fn close(&self) {
        let connection = self.connection.clone();
        tokio::spawn(async move {
            let _ = connection.close().await;
        });
    }
}

/// Opens connections to this host's system bus.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemBusConnector;

#[async_trait]
impl BluezConnector for SystemBusConnector {
    async fn open(&self) -> Result<Arc<dyn BluezBus>, BluezError> {
        let connection = Connection::system().await.map_err(convert)?;
        Ok(Arc::new(SystemBus { connection }))
    }
}
