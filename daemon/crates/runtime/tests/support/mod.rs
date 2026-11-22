//! A fake brick behind a fake provider, for session tests.
//!
//! It behaves the way the real USB, Bluetooth and TCP providers do where sessions break: it
//! keeps its own record of a link until `disconnect`, so a `connect` while that record survives
//! answers "already connected"; a pulled cable fails sends at once and refuses connects; and
//! replies are real EV3 packets built from the request, so the session's codec runs.

#![allow(dead_code)]

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::commands::info_layout;
use ev3_protocol::packet::reply;
use ev3_protocol::{BrickCommand, build_command, encode_ev3_packet};
use ev3_transports::{
    BrickKey, DiscoveryItem, DiscoveryScanResult, NameSource, PresenceState, ProbeLink,
    SendOptions, SessionHandle, Transport, TransportCapabilities, TransportError,
    TransportProvider,
};
use tokio::sync::Semaphore;

/// A USB key in the bench's address range; no real brick has it.
pub fn usb_key() -> BrickKey {
    BrickKey::new(Transport::Usb, "00165300000A").unwrap()
}

/// The same brick over Bluetooth.
pub fn bt_key() -> BrickKey {
    BrickKey::new(Transport::Bt, "00:16:53:00:00:0A").unwrap()
}

/// The same brick over Wi-Fi, as its beacon names it.
pub fn tcp_key() -> BrickKey {
    BrickKey::new(Transport::Tcp, "00165300000a").unwrap()
}

/// The wall clock in ms since the epoch, the unit discovery items carry.
pub fn wall_ms() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(since.as_millis()).unwrap()
}

/// A sighting of `key`, available, named `name` from `source`.
pub fn sighting(key: &BrickKey, name: &str, source: Option<NameSource>) -> DiscoveryItem {
    DiscoveryItem {
        brick_key: key.clone(),
        display_name: name.to_owned(),
        name_source: source,
        transport: key.transport(),
        presence_state: PresenceState::Available,
        remembered: false,
        connected: false,
        favorite: false,
        paired: None,
        heard: None,
        heard_at: None,
        signal_info: None,
        bt_visible: None,
        last_seen_at: wall_ms(),
    }
}

/// What the brick answers to a battery query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Battery {
    /// 80 %.
    Good,
    /// A level byte above 100: the layout of another firmware. The reply arrives and does not
    /// parse.
    Unreadable,
}

/// How the fake link fails a send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendFault {
    /// Fails at once with this error.
    Fail(TransportError),
    /// Answers nothing; fails with the transport's timeout after `after`.
    Silent { after: Duration },
}

pub struct FakeState {
    /// The cable is in (or the radio in range). Out: sends fail, connects are refused.
    pub cable_in: bool,
    /// The provider's own record of an open link.
    pub held: bool,
    /// Links opened and not closed: the leak detector.
    pub open_links: i32,
    pub connect_calls: u32,
    pub recover_calls: u32,
    pub disconnect_calls: u32,
    /// Connects refused because the provider still held the brick.
    pub refused_while_held: u32,
    /// How long each connect or recover takes.
    pub connect_delay: Duration,
    /// When set, a connect or recover waits for a permit before it answers.
    pub gate: Option<Arc<Semaphore>>,
    /// Each connect or recover with this number (from 1) waits for a permit from `gate`.
    pub gated_calls: Vec<u32>,
    /// Connects or recovers with these numbers (from 1) fail, whatever else holds.
    pub failing_calls: Vec<u32>,
    /// A fault for every send, until cleared.
    pub fault: Option<SendFault>,
    /// The next this many sends never answer (on the wire when the link goes).
    pub hang_next: u32,
    pub battery: Battery,
    /// The bytes of the info reply's name field; `AAA` and zeros by default.
    pub name_field: Vec<u8>,
    /// Every request that reached the link.
    pub requests: Vec<Vec<u8>>,
    /// Events in order, for tests that check the order of opens and closes.
    pub events: Vec<String>,
    /// What discovery lists; empty means the brick is not seen on this transport.
    pub seen: Vec<DiscoveryItem>,
    /// Connects or recovers inside the provider now, and the most there have been at once.
    pub connecting: u32,
    pub most_connecting: u32,
    /// Probe links opened (USB only).
    pub probes: u32,
    /// When set, opening a probe fails with this.
    pub probe_failure: Option<String>,
    /// A priority other than the real provider's.
    pub priority: Option<i32>,
    /// How long each disconnect takes.
    pub disconnect_delay: Duration,
}

pub struct FakeProvider {
    transport: Transport,
    recover: bool,
    state: Mutex<FakeState>,
}

impl FakeProvider {
    pub fn new(transport: Transport) -> Arc<Self> {
        Self::build(transport, false)
    }

    /// A provider that recovers a lost link itself.
    pub fn recovering(transport: Transport) -> Arc<Self> {
        Self::build(transport, true)
    }

    fn build(transport: Transport, recover: bool) -> Arc<Self> {
        let mut name_field = b"AAA".to_vec();
        name_field.resize(info_layout::LEN_BRICK_NAME, 0);
        Arc::new(Self {
            transport,
            recover,
            state: Mutex::new(FakeState {
                cable_in: true,
                held: false,
                open_links: 0,
                connect_calls: 0,
                recover_calls: 0,
                disconnect_calls: 0,
                refused_while_held: 0,
                connect_delay: Duration::ZERO,
                gate: None,
                gated_calls: Vec::new(),
                failing_calls: Vec::new(),
                fault: None,
                hang_next: 0,
                battery: Battery::Good,
                name_field,
                requests: Vec::new(),
                events: Vec::new(),
                seen: Vec::new(),
                connecting: 0,
                most_connecting: 0,
                probes: 0,
                probe_failure: None,
                priority: None,
                disconnect_delay: Duration::ZERO,
            }),
        })
    }

    pub fn state(&self) -> MutexGuard<'_, FakeState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Pulls the cable: the provider keeps its record, as a real one does when a link dies on
    /// its own.
    pub fn pull_cable(&self) {
        let mut state = self.state();
        state.cable_in = false;
        state.fault = Some(SendFault::Fail(TransportError::transport_failed(
            "USB send failed: LIBUSB_ERROR_NO_DEVICE",
        )));
    }

    pub fn plug_cable(&self) {
        let mut state = self.state();
        state.cable_in = true;
        state.fault = None;
    }

    pub fn as_provider(self: &Arc<Self>) -> Arc<dyn TransportProvider> {
        self.clone()
    }

    async fn open(
        &self,
        brick_key: &BrickKey,
        recover: bool,
    ) -> Result<SessionHandle, TransportError> {
        let (call, delay, gate) = {
            let mut state = self.state();
            let call = if recover {
                state.recover_calls += 1;
                state.recover_calls
            } else {
                state.connect_calls += 1;
                state.connect_calls
            };
            let label = if recover { "recover" } else { "connect" };
            state.events.push(format!("{label} {call}"));
            let gate = state
                .gated_calls
                .contains(&call)
                .then(|| state.gate.clone())
                .flatten();
            state.connecting += 1;
            state.most_connecting = state.most_connecting.max(state.connecting);
            (call, state.connect_delay, gate)
        };
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        let mut state = self.state();
        state.connecting -= 1;
        if state.failing_calls.contains(&call) {
            state.events.push(format!("link {call} failed"));
            return Err(TransportError::transport_failed("The link never came up."));
        }
        if !state.cable_in {
            state.events.push(format!("link {call} failed"));
            return Err(TransportError::transport_failed(
                "No EV3 found on the USB bus.",
            ));
        }
        if state.held && !recover {
            state.refused_while_held += 1;
            return Err(TransportError::transport_failed(format!(
                "Brick {brick_key} is already connected."
            )));
        }
        if !state.held {
            state.held = true;
            state.open_links += 1;
        }
        state.events.push(format!("link {call} open"));
        Ok(SessionHandle {
            brick_key: brick_key.clone(),
            transport: self.transport,
        })
    }
}

/// A direct reply with `globals` bytes, or the battery or info layout when the request is one.
fn answer(request: &[u8], battery: Battery, name_field: &[u8]) -> Vec<u8> {
    let counter = u32::from(u16::from_le_bytes([request[2], request[3]]));
    let body = &request[4..];
    let is = |command: &BrickCommand| {
        let encoded = build_command(command).unwrap();
        body[0] == encoded.packet_type && body[1..] == encoded.payload[..]
    };
    let payload = if is(&BrickCommand::Battery) {
        let mut globals = Vec::new();
        globals.extend_from_slice(&7.5f32.to_le_bytes());
        globals.extend_from_slice(&0.2f32.to_le_bytes());
        globals.push(match battery {
            Battery::Good => 80,
            Battery::Unreadable => 200,
        });
        globals
    } else if is(&BrickCommand::Info) {
        let mut globals = vec![0u8; info_layout::TOTAL_INFO_BYTES];
        globals[..name_field.len()].copy_from_slice(name_field);
        globals
    } else {
        let globals = usize::from(u16::from_le_bytes([body[1], body[2]]) & 0x03ff);
        vec![0u8; globals]
    };
    encode_ev3_packet(counter, reply::DIRECT_REPLY, &payload).unwrap()
}

#[async_trait]
impl TransportProvider for FakeProvider {
    fn transport(&self) -> Transport {
        self.transport
    }

    /// The real providers' order: USB, Bluetooth, TCP.
    fn priority(&self) -> i32 {
        self.state().priority.unwrap_or(match self.transport {
            Transport::Usb => 30,
            Transport::Bt => 20,
            Transport::Tcp => 10,
            Transport::Mock => 0,
        })
    }

    /// As the real providers declare: Bluetooth rejoins only on evidence, USB probes.
    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            supports_recover: self.recover,
            rejoin_on_evidence_only: self.transport == Transport::Bt,
            supports_probe: self.transport == Transport::Usb,
            ..TransportCapabilities::default()
        }
    }

    /// Stamped at each scan, as the real providers do.
    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        let now = wall_ms();
        let items = self
            .state()
            .seen
            .iter()
            .map(|item| DiscoveryItem {
                last_seen_at: now,
                ..item.clone()
            })
            .collect();
        Ok(DiscoveryScanResult {
            transport: self.transport,
            items,
        })
    }

    /// A probe answers from the same brick as a session, without holding the link.
    async fn open_probe(
        &self,
        _brick_key: &BrickKey,
    ) -> Result<Box<dyn ProbeLink>, TransportError> {
        let mut state = self.state();
        if let Some(failure) = &state.probe_failure {
            return Err(TransportError::transport_failed(failure.clone()));
        }
        state.probes += 1;
        Ok(Box::new(FakeProbe {
            battery: state.battery,
            name_field: state.name_field.clone(),
        }))
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.open(brick_key, false).await
    }

    async fn recover(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.open(brick_key, true).await
    }

    async fn disconnect(&self, _brick_key: &BrickKey) -> Result<(), TransportError> {
        let delay = self.state().disconnect_delay;
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let mut state = self.state();
        state.disconnect_calls += 1;
        if state.held {
            state.held = false;
            state.open_links -= 1;
            state.events.push("link closed".into());
        }
        Ok(())
    }

    async fn send_packet(
        &self,
        _brick_key: &BrickKey,
        packet: &[u8],
        _options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        let (fault, hang, reply) = {
            let mut state = self.state();
            if !state.held {
                return Err(TransportError::transport_failed("The link is not open."));
            }
            state.requests.push(packet.to_vec());
            let hang = state.hang_next > 0;
            if hang {
                state.hang_next -= 1;
            }
            (
                state.fault.clone(),
                hang,
                answer(packet, state.battery, &state.name_field),
            )
        };
        if hang {
            return std::future::pending().await;
        }
        match fault {
            None => Ok(reply),
            Some(SendFault::Fail(error)) => Err(error),
            Some(SendFault::Silent { after }) => {
                tokio::time::sleep(after).await;
                Err(TransportError::timeout(format!(
                    "{} send timed out after {} ms with no matching reply.",
                    self.transport.as_str().to_ascii_uppercase(),
                    after.as_millis()
                )))
            }
        }
    }
}

struct FakeProbe {
    battery: Battery,
    name_field: Vec<u8>,
}

#[async_trait]
impl ProbeLink for FakeProbe {
    async fn send_packet(
        &mut self,
        packet: &[u8],
        _options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        Ok(answer(packet, self.battery, &self.name_field))
    }

    async fn close(&mut self) {}
}

/// Lets every task that is ready run: a millisecond on the clock, and on a paused clock the
/// runtime runs the ready tasks before it moves it.
pub async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}
