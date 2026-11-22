//! Wi-Fi bricks: found by their UDP beacon, connected over TCP.
//!
//! Discovery binds UDP 3015 only while something is scanning, and lets go once scans stop. While
//! it listens it also sends a one-byte datagram to each local subnet's broadcast address every
//! few seconds: a host firewall that drops unsolicited inbound UDP lets the beacons through once
//! the same socket has sent outbound first (measured on a default Windows install, where the
//! brick announced the whole time and discovery saw nothing for half an hour). That changes no
//! firewall setting; it is the ordinary outbound-then-inbound pattern of any discovery client.

pub mod beacon;
pub mod ifaces;
pub mod socket;

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::brick_key::{BrickKey, Transport};
use crate::error::TransportError;
use crate::pending::Exchanger;
use crate::provider::{
    DiscoveryItem, DiscoveryScanResult, NameSource, PresenceState, SendOptions, SessionHandle,
    TransportCapabilities, TransportProvider,
};

use beacon::{BEACON_PORT, BEACON_PRIME_INTERVAL, BeaconState, TCP_PORT, to_broadcast_address};
use socket::{SEND_TIMEOUT, TcpLink, UNLOCK_TIMEOUT};

/// One harmless byte, sent only to open the inbound path.
const BEACON_PROBE: [u8; 1] = [0x00];

/// How a [`TcpProvider`] is set up.
#[derive(Debug, Clone)]
pub struct TcpOptions {
    /// Connect here when a key carries no address, and list only the brick announcing from here.
    pub host: Option<String>,
    /// TCP port; the beacon's own port when absent, then 5555.
    pub port: Option<u16>,
    /// UDP port the beacon is heard on.
    pub discovery_port: u16,
    /// When false nothing is bound or broadcast, and `discover` says so rather than returning an
    /// empty list: that reads identically to "no bricks on this network" and would leave a
    /// scheduler polling a provider that can never answer.
    pub use_discovery: bool,
}

impl Default for TcpOptions {
    fn default() -> Self {
        Self {
            host: None,
            port: None,
            discovery_port: BEACON_PORT,
            use_discovery: true,
        }
    }
}

struct Session {
    link: TcpLink,
    exchanger: Exchanger,
}

/// The TCP transport: beacon discovery and one unlocked socket per connected brick.
pub struct TcpProvider {
    options: TcpOptions,
    beacons: Arc<StdMutex<BeaconState>>,
    listener: Mutex<Option<JoinHandle<()>>>,
    sessions: Mutex<HashMap<BrickKey, Arc<Mutex<Session>>>>,
    disposed: AtomicBool,
}

fn lock(state: &StdMutex<BeaconState>) -> MutexGuard<'_, BeaconState> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

impl TcpProvider {
    pub fn new(options: TcpOptions) -> Self {
        Self {
            options,
            beacons: Arc::new(StdMutex::new(BeaconState::new())),
            listener: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            disposed: AtomicBool::new(false),
        }
    }

    /// Whether the beacon port is bound right now.
    pub fn listening(&self) -> bool {
        lock(&self.beacons).is_listening()
    }

    fn assert_not_disposed(&self) -> Result<(), TransportError> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err(TransportError::transport_failed(
                "TcpTransportProvider has been disposed.",
            ));
        }
        Ok(())
    }

    /// Binds the beacon port if nothing holds it for us yet, and starts the listener.
    async fn ensure_listening(&self) -> Result<(), TransportError> {
        let mut listener = self.listener.lock().await;
        let was_listening = lock(&self.beacons).note_scan(Instant::now());
        if was_listening {
            return Ok(());
        }
        let port = self.options.discovery_port;
        let socket = bind_beacon_socket(port).map_err(|e| {
            TransportError::transport_failed(format!(
                "TCP beacon port {port} is unavailable: {e} (rebinding for the next scan)"
            ))
        })?;
        lock(&self.beacons).set_listening(true);
        *listener = Some(tokio::spawn(listen(socket, port, self.beacons.clone())));
        Ok(())
    }

    /// The address, port and serial a connect to `key` uses.
    fn resolve(&self, key: &BrickKey) -> Result<(String, u16, String), TransportError> {
        let id = key.id();
        let is_ip = id.parse::<Ipv4Addr>().is_ok();
        // A key built from a serial carries no address, but this provider already heard the
        // beacon that named it. Asking a second listener to rediscover cannot work: this
        // provider holds the beacon port.
        let cached = if is_ip {
            None
        } else {
            lock(&self.beacons).find_fresh(id, Instant::now())
        };
        let host = if is_ip {
            Some(id.to_owned())
        } else {
            cached
                .as_ref()
                .map(|c| c.ip.to_string())
                .or_else(|| self.options.host.clone())
        };
        let Some(host) = host.filter(|h| !h.is_empty()) else {
            return Err(TransportError::transport_failed(format!(
                "No address known for {key}. Its beacon has expired \u{2014} wait for the next announcement, or configure a host explicitly."
            )));
        };
        let port = self
            .options
            .port
            .or_else(|| cached.as_ref().map(|c| c.port))
            .unwrap_or(TCP_PORT);
        let serial = if is_ip { String::new() } else { id.to_owned() };
        Ok((host, port, serial))
    }

    async fn session(&self, key: &BrickKey) -> Option<Arc<Mutex<Session>>> {
        self.sessions.lock().await.get(key).cloned()
    }
}

/// A UDP socket bound shared on `port`: every window's cockpit, and a probe, hears the brick's
/// broadcast, which each socket bound with `SO_REUSEADDR` receives.
fn bind_beacon_socket(port: u16) -> std::io::Result<UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    socket.set_reuse_address(true)?;
    socket.set_broadcast(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port)).into())?;
    UdpSocket::from_std(socket.into())
}

/// Hears beacons, primes the firewall, and ends once scans have stopped for a freshness window.
async fn listen(socket: UdpSocket, port: u16, state: Arc<StdMutex<BeaconState>>) {
    let mut ticker = tokio::time::interval(BEACON_PRIME_INTERVAL);
    let mut buffer = [0u8; 2048];
    loop {
        tokio::select! {
            received = socket.recv_from(&mut buffer) => {
                // A spurious ICMP error surfaces as a failed receive on Windows; the socket
                // is still good.
                if let Ok((length, SocketAddr::V4(sender))) = received {
                    lock(&state).accept_datagram(
                        &buffer[..length],
                        *sender.ip(),
                        Instant::now(),
                        epoch_ms(),
                    );
                }
            }
            _ = ticker.tick() => {
                if lock(&state).stop_if_idle(Instant::now()) {
                    return;
                }
                prime(&socket, port, &state).await;
            }
        }
    }
}

/// Sends the probe to each local subnet's broadcast address, best effort.
async fn prime(socket: &UdpSocket, port: u16, state: &Arc<StdMutex<BeaconState>>) {
    let interfaces = ifaces::local_ipv4_interfaces();
    {
        let mut state = lock(state);
        for interface in &interfaces {
            state.add_local_address(interface.address);
        }
    }
    for interface in interfaces {
        if let Some(target) = to_broadcast_address(interface.address, interface.netmask) {
            let _ = socket
                .send_to(&BEACON_PROBE, SocketAddrV4::new(target, port))
                .await;
        }
    }
}

#[async_trait]
impl TransportProvider for TcpProvider {
    fn transport(&self) -> Transport {
        Transport::Tcp
    }

    /// Wi-Fi is the slowest and least steady link the brick has.
    fn priority(&self) -> i32 {
        10
    }

    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            supports_telemetry_frames: true,
            ..TransportCapabilities::default()
        }
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        self.assert_not_disposed()?;
        if !self.options.use_discovery {
            return Err(TransportError::transport_failed(
                "TCP discovery is disabled for this provider (useDiscovery: false), so no beacon listener is bound. Connect by host instead, or construct the provider with discovery enabled.",
            ));
        }
        self.ensure_listening().await?;

        let seen = lock(&self.beacons).fresh(Instant::now());
        let sessions = self.sessions.lock().await;
        let mut items = Vec::new();
        for beacon in seen {
            let info = beacon.info;
            if let Some(host) = &self.options.host
                && *host != info.ip.to_string()
            {
                continue;
            }
            let Ok(brick_key) = BrickKey::new(Transport::Tcp, &info.serial_number.to_lowercase())
            else {
                continue;
            };
            let named = !info.name.is_empty();
            items.push(DiscoveryItem {
                connected: sessions.contains_key(&brick_key),
                brick_key,
                display_name: if named {
                    info.name
                } else {
                    format!("EV3 [{}]", info.ip)
                },
                // The beacon follows a rename within seconds (measured 29.10.2026).
                name_source: Some(if named {
                    NameSource::Beacon
                } else {
                    NameSource::Fallback
                }),
                transport: Transport::Tcp,
                presence_state: PresenceState::Available,
                remembered: false,
                favorite: false,
                paired: None,
                heard: None,
                heard_at: None,
                signal_info: None,
                bt_visible: None,
                last_seen_at: beacon.received_epoch_ms,
            });
        }
        Ok(DiscoveryScanResult {
            transport: Transport::Tcp,
            items,
        })
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.assert_not_disposed()?;
        if self.sessions.lock().await.contains_key(brick_key) {
            return Err(TransportError::transport_failed(format!(
                "{brick_key} is already connected."
            )));
        }
        let (host, port, serial) = self.resolve(brick_key)?;
        let link = TcpLink::open(&host, port, &serial, "WiFi", UNLOCK_TIMEOUT)
            .await
            .map_err(|e| {
                TransportError::transport_failed(format!("Connect failed for {brick_key}: {e}"))
            })?;
        let mut sessions = self.sessions.lock().await;
        if sessions.contains_key(brick_key) {
            return Err(TransportError::transport_failed(format!(
                "{brick_key} is already connected."
            )));
        }
        sessions.insert(
            brick_key.clone(),
            Arc::new(Mutex::new(Session {
                link,
                exchanger: Exchanger::new("TCP", SEND_TIMEOUT),
            })),
        );
        Ok(SessionHandle {
            brick_key: brick_key.clone(),
            transport: Transport::Tcp,
        })
    }

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError> {
        self.sessions.lock().await.remove(brick_key);
        Ok(())
    }

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        self.assert_not_disposed()?;
        let session = self.session(brick_key).await.ok_or_else(|| {
            TransportError::transport_failed(format!("{brick_key} is not connected."))
        })?;
        let mut session = session.lock().await;
        let Session { link, exchanger } = &mut *session;
        exchanger.exchange(link, packet, options).await
    }

    async fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        if let Some(task) = self.listener.lock().await.take() {
            task.abort();
        }
        lock(&self.beacons).stop();
        self.sessions.lock().await.clear();
    }
}
