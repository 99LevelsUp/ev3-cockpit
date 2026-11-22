//! Rows, links and a small brick for the telemetry tests.
//!
//! The brick here runs the instructions the EV3 rows emit against a table of ports and a daisy
//! chain, the way the firmware answers them, so the scheduler's gates are tested against what a
//! frame really asks rather than against a reply laid out by hand.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::packet::{input_device_sub, opcode};
use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_runtime::telemetry::assembler::FrameLimits;
use ev3_runtime::telemetry::brick_loop::TelemetrySender;
use ev3_runtime::telemetry::row::{Parsed, Reading, RowCodec, RowResult, RowSlot};
use ev3_runtime::telemetry::scheduler::FrameLink;
use ev3_runtime::telemetry::service::{TelemetryHost, TelemetryService, TelemetryServiceOptions};
use ev3_runtime::telemetry::{Lifetime, TelemetryError, TelemetryRow, Tier};
use ev3_transports::Transport;
use tokio::sync::oneshot;

pub const LIBUSB: FrameLimits = FrameLimits {
    max_packet_bytes: 1024,
};
pub const HID: FrameLimits = FrameLimits {
    max_packet_bytes: 64,
};

/// A row's bytecode: a marker, `pad` zero bytes, then the low byte of its slot, so a test reads
/// the layout off the wire. Parses four bytes as a float and anything narrower as its first byte.
pub struct MarkerCodec {
    pub pad: usize,
    pub bytes: usize,
}

impl RowCodec for MarkerCodec {
    fn emit(&self, slot: RowSlot) -> Result<Vec<u8>, TelemetryError> {
        let mut out = vec![0xaa];
        out.extend(std::iter::repeat_n(0, self.pad));
        out.push((slot & 0xff) as u8);
        Ok(out)
    }

    fn parse(&self, payload: &[u8], slot: RowSlot) -> Parsed {
        let value = if self.bytes == 4 {
            payload.get(slot..slot + 4).map_or(Reading::Missing, |b| {
                Reading::Number(f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]])))
            })
        } else {
            payload
                .get(slot)
                .map_or(Reading::Missing, |&b| Reading::Number(f64::from(b)))
        };
        Parsed::value(value)
    }
}

/// A test row: sampled, every tick, one byte at alignment 1 unless changed.
pub fn row(id: &str) -> TelemetryRow {
    TelemetryRow {
        id: id.to_owned(),
        tier: Tier::Sampled,
        lifetime: Lifetime::Repeating { divider: 1 },
        result: RowResult {
            bytes: 1,
            alignment: 1,
        },
        unit: None,
        port: None,
        layer: None,
        mode: None,
        reports_occupancy: false,
        reports_chain_depth: false,
        codec: Arc::new(MarkerCodec { pad: 0, bytes: 1 }),
    }
}

/// Builder methods for test rows.
pub trait RowExt {
    fn bytes(self, bytes: usize, alignment: usize) -> Self;
    fn every(self, divider: u32) -> Self;
    fn once(self) -> Self;
    fn off(self) -> Self;
    fn tier(self, tier: Tier) -> Self;
    fn port(self, port: &str) -> Self;
    fn mode(self, mode: u8) -> Self;
    fn occupancy(self) -> Self;
    fn pad(self, pad: usize) -> Self;
}

impl RowExt for TelemetryRow {
    fn bytes(mut self, bytes: usize, alignment: usize) -> Self {
        self.result = RowResult { bytes, alignment };
        self.codec = Arc::new(MarkerCodec { pad: 0, bytes });
        self
    }
    fn every(mut self, divider: u32) -> Self {
        self.lifetime = Lifetime::Repeating { divider };
        self
    }
    fn once(mut self) -> Self {
        self.lifetime = Lifetime::OneShot;
        self
    }
    fn off(mut self) -> Self {
        self.lifetime = Lifetime::Off;
        self
    }
    fn tier(mut self, tier: Tier) -> Self {
        self.tier = tier;
        self
    }
    fn port(mut self, port: &str) -> Self {
        self.port = Some(port.to_owned());
        self
    }
    fn mode(mut self, mode: u8) -> Self {
        self.mode = Some(mode);
        self
    }
    fn occupancy(mut self) -> Self {
        self.reports_occupancy = true;
        self
    }
    fn pad(mut self, pad: usize) -> Self {
        self.codec = Arc::new(MarkerCodec {
            pad,
            bytes: self.result.bytes,
        });
        self
    }
}

/// A float laid out at offset 0 of a 64-byte reply.
pub fn float_reply(value: f32) -> Vec<u8> {
    let mut reply = vec![0u8; 64];
    reply[..4].copy_from_slice(&value.to_le_bytes());
    reply
}

type Answer = Box<dyn FnMut(&[u8]) -> Result<Vec<u8>, TelemetryError> + Send>;

struct LinkState {
    limits: FrameLimits,
    sent: Vec<Vec<u8>>,
    answer: Answer,
    /// Call numbers (from 1) whose reply is held until the test releases it.
    hold: Vec<usize>,
    held: VecDeque<oneshot::Sender<()>>,
}

/// A link that records each frame and answers it with what the test says.
#[derive(Clone)]
pub struct TestLink {
    state: Arc<Mutex<LinkState>>,
}

impl TestLink {
    pub fn new(limits: FrameLimits) -> Self {
        Self::answering(limits, |_| Ok(vec![0u8; 64]))
    }

    pub fn answering(
        limits: FrameLimits,
        answer: impl FnMut(&[u8]) -> Result<Vec<u8>, TelemetryError> + Send + 'static,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(LinkState {
                limits,
                sent: Vec::new(),
                answer: Box::new(answer),
                hold: Vec::new(),
                held: VecDeque::new(),
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, LinkState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Holds the reply to these calls (numbered from 1) until [`TestLink::release`].
    pub fn hold(&self, calls: &[usize]) {
        self.lock().hold = calls.to_vec();
    }

    /// Lets the oldest held reply go.
    pub fn release(&self) {
        if let Some(gate) = self.lock().held.pop_front() {
            let _ = gate.send(());
        }
    }

    pub fn held(&self) -> usize {
        self.lock().held.len()
    }

    pub fn calls(&self) -> usize {
        self.lock().sent.len()
    }

    pub fn sent(&self) -> Vec<Vec<u8>> {
        self.lock().sent.clone()
    }

    pub fn set_limits(&self, limits: FrameLimits) {
        self.lock().limits = limits;
    }

    pub fn as_link(&self) -> Arc<dyn FrameLink> {
        Arc::new(self.clone())
    }
}

#[async_trait]
impl FrameLink for TestLink {
    async fn send_frame(&self, payload: Vec<u8>) -> Result<Vec<u8>, TelemetryError> {
        let (reply, gate) = {
            let mut state = self.lock();
            state.sent.push(payload.clone());
            let call = state.sent.len();
            let reply = (state.answer)(&payload);
            let gate = state.hold.contains(&call).then(|| {
                let (tx, rx) = oneshot::channel();
                state.held.push_back(tx);
                rx
            });
            (reply, gate)
        };
        if let Some(gate) = gate {
            let _ = gate.await;
        }
        reply
    }

    fn frame_limits(&self) -> FrameLimits {
        self.lock().limits
    }
}

/// Lets every ready task run on a paused clock.
pub async fn flush() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

// ── A brick layer the test drives by hand ───────────────────────────

/// Where a brick stands with the fake brick layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conn {
    Connected,
    /// Signed in, no route: the link went and comes back by itself.
    Reconnecting,
    Disconnected,
}

type Reply = Box<dyn FnMut(&str, &BrickCommand) -> BrickResponse + Send>;

pub struct FakeState {
    pub sessions: HashMap<String, Conn>,
    pub routes: HashMap<String, Transport>,
    pub active: Option<String>,
    /// The transport each frame went out on, in order.
    pub sent: Vec<Option<Transport>>,
    pub holding: bool,
    held: Vec<oneshot::Sender<()>>,
    /// How long each brick's frames take, on tokio's clock.
    pub latency: HashMap<String, Duration>,
    pub max_packet_bytes: Option<usize>,
    reply: Reply,
}

/// Sessions, routes and the active brick, moved by the test; every move refreshes the service the
/// way the brick layer's events do.
pub struct FakeBricks {
    state: Mutex<FakeState>,
    service: OnceLock<TelemetryService>,
}

impl FakeBricks {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FakeState {
                sessions: HashMap::new(),
                routes: HashMap::new(),
                active: None,
                sent: Vec::new(),
                holding: false,
                held: Vec::new(),
                latency: HashMap::new(),
                max_packet_bytes: Some(1024),
                reply: Box::new(|_, _| BrickResponse::TelemetryFrame {
                    payload: vec![0; 1024],
                }),
            }),
            service: OnceLock::new(),
        })
    }

    pub fn state(&self) -> MutexGuard<'_, FakeState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Answers each command with what `reply` says.
    pub fn reply_with(
        &self,
        reply: impl FnMut(&str, &BrickCommand) -> BrickResponse + Send + 'static,
    ) {
        self.state().reply = Box::new(reply);
    }

    /// A service over these bricks, which every move refreshes.
    pub fn service(self: &Arc<Self>, options: TelemetryServiceOptions) -> TelemetryService {
        let service = TelemetryService::new(self.clone(), options).unwrap();
        self.service.set(service.clone()).ok();
        service
    }

    fn refresh(&self, brick: &str) {
        if let Some(service) = self.service.get() {
            service.refresh(brick);
        }
    }

    pub fn connect(&self, brick: &str, transport: Transport) {
        {
            let mut state = self.state();
            state.routes.insert(brick.into(), transport);
            state.sessions.insert(brick.into(), Conn::Connected);
        }
        self.refresh(brick);
    }

    pub fn set_active(&self, next: Option<&str>) {
        let previous = std::mem::replace(&mut self.state().active, next.map(str::to_owned));
        for brick in previous.iter().map(String::as_str).chain(next) {
            self.refresh(brick);
        }
    }

    pub fn lose_link(&self, brick: &str) {
        {
            let mut state = self.state();
            state.routes.remove(brick);
            state.sessions.insert(brick.into(), Conn::Reconnecting);
        }
        self.refresh(brick);
    }

    pub fn disconnect(&self, brick: &str) {
        {
            let mut state = self.state();
            state.routes.remove(brick);
            state.sessions.insert(brick.into(), Conn::Disconnected);
        }
        self.refresh(brick);
    }

    /// As the brick layer signs a brick out: the sign-in is gone before either event fires.
    pub fn sign_out(&self, brick: &str) {
        {
            let mut state = self.state();
            state.routes.remove(brick);
            state.sessions.remove(brick);
        }
        self.refresh(brick);
        self.refresh(brick);
    }

    pub fn move_route(&self, brick: &str, transport: Transport) {
        {
            let mut state = self.state();
            state.routes.insert(brick.into(), transport);
            state.sessions.insert(brick.into(), Conn::Connected);
        }
        self.refresh(brick);
        self.refresh(brick);
    }

    pub fn hold_sends(&self) {
        self.state().holding = true;
    }

    pub fn release_sends(&self) {
        let held = {
            let mut state = self.state();
            state.holding = false;
            std::mem::take(&mut state.held)
        };
        for gate in held {
            let _ = gate.send(());
        }
    }

    pub fn sent(&self) -> usize {
        self.state().sent.len()
    }
}

#[async_trait]
impl TelemetrySender for FakeBricks {
    async fn send(
        &self,
        brick_id: &str,
        command: BrickCommand,
    ) -> Result<BrickResponse, TelemetryError> {
        let (gate, latency, reply) = {
            let mut state = self.state();
            let route = state.routes.get(brick_id).copied();
            state.sent.push(route);
            let reply = (state.reply)(brick_id, &command);
            let gate = state.holding.then(|| {
                let (tx, rx) = oneshot::channel();
                state.held.push(tx);
                rx
            });
            (gate, state.latency.get(brick_id).copied(), reply)
        };
        if let Some(gate) = gate {
            let _ = gate.await;
        }
        if let Some(latency) = latency {
            tokio::time::sleep(latency).await;
        }
        Ok(reply)
    }

    fn max_packet_bytes(&self, _brick_id: &str) -> Option<usize> {
        self.state().max_packet_bytes
    }

    fn transport_of(&self, brick_id: &str) -> Option<Transport> {
        self.state().routes.get(brick_id).copied()
    }
}

impl TelemetryHost for FakeBricks {
    fn active_brick(&self) -> Option<String> {
        self.state().active.clone()
    }

    fn has_session(&self, brick_id: &str) -> bool {
        self.state()
            .sessions
            .get(brick_id)
            .is_some_and(|conn| *conn != Conn::Disconnected)
    }

    fn is_connected(&self, brick_id: &str) -> bool {
        self.state().sessions.get(brick_id) == Some(&Conn::Connected)
    }

    /// USB and Bluetooth execute frames; TCP stands in for a link that does not.
    fn serves_frames(&self, transport: Transport) -> bool {
        matches!(transport, Transport::Usb | Transport::Bt)
    }
}

// ── A brick that answers frames ─────────────────────────────────────

pub const TYPE_NONE: u8 = 126;

/// Ports of a brick and the bricks chained below it, by layer: sensors 0-3 and motors 0-3 per
/// layer, each a type code and a value.
#[derive(Clone)]
pub struct ChainBrick {
    /// `sensors[layer][port]` = (type, SI value).
    pub sensors: Vec<[(u8, f32); 4]>,
    pub motors: Vec<[u8; 4]>,
}

impl ChainBrick {
    /// A master with `depth` bricks below it, a touch sensor on the master's port 1 reading 1 and
    /// an ultrasonic sensor on each member's port 1 reading 10 × its layer.
    pub fn chain(depth: usize) -> Self {
        let mut sensors = vec![[(TYPE_NONE, f32::NAN); 4]; 4];
        let motors = vec![[TYPE_NONE; 4]; 4];
        sensors[0][0] = (16, 1.0);
        for (layer, ports) in sensors.iter_mut().enumerate().take(depth + 1).skip(1) {
            ports[0] = (30, 10.0 * layer as f32);
        }
        Self { sensors, motors }
    }

    fn type_of(&self, layer: usize, port: usize) -> u8 {
        if port >= 16 {
            self.motors[layer][port - 16]
        } else {
            self.sensors[layer][port].0
        }
    }

    /// Runs a telemetry frame: the globals word, then the row instructions.
    pub fn answer(&self, payload: &[u8]) -> Vec<u8> {
        let globals = usize::from(u16::from_le_bytes([payload[0], payload[1]]) & 0x03ff);
        let mut out = vec![0u8; globals];
        let mut code = Code {
            bytes: &payload[2..],
            at: 0,
        };
        while let Some(op) = code.byte() {
            match op {
                opcode::INPUT_DEVICE => {
                    let sub = code.byte().unwrap();
                    assert_eq!(sub, input_device_sub::GET_TYPEMODE, "unexpected subcode");
                    let layer = code.constant();
                    let port = code.constant();
                    let (type_slot, mode_slot) = (code.global(), code.global());
                    out[type_slot] = self.type_of(layer, port);
                    out[mode_slot] = 0;
                }
                opcode::INPUT_READ_SI => {
                    let layer = code.constant();
                    let port = code.constant();
                    let _type = code.constant();
                    let _mode = code.constant();
                    let slot = code.global();
                    let value = self.sensors[layer][port].1;
                    out[slot..slot + 4].copy_from_slice(&value.to_le_bytes());
                }
                opcode::INPUT_DEVICE_LIST => {
                    let length = code.constant();
                    let (list, changed) = (code.global(), code.global());
                    for layer in 0..4 {
                        for port in 0..4 {
                            out[list + layer * 4 + port] = self.sensors[layer][port].0;
                            out[list + 16 + layer * 4 + port] = self.motors[layer][port];
                        }
                    }
                    assert_eq!(length, 32);
                    out[changed] = 0;
                }
                other => panic!("the test brick does not run opcode {other:#04x}"),
            }
        }
        out
    }
}

struct Code<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Code<'_> {
    fn byte(&mut self) -> Option<u8> {
        let byte = self.bytes.get(self.at).copied();
        self.at += 1;
        byte
    }

    /// A short (one byte) or one-byte-following (0x81) constant.
    fn constant(&mut self) -> usize {
        let first = self.byte().unwrap();
        if first == 0x81 {
            usize::from(self.byte().unwrap())
        } else {
            usize::from(first & 0x3f)
        }
    }

    /// A GV0 (0x60 | offset) or GV1 (0xe1, offset) global reference.
    fn global(&mut self) -> usize {
        let first = self.byte().unwrap();
        if first == 0xe1 {
            usize::from(self.byte().unwrap())
        } else {
            assert_eq!(first & 0xe0, 0x60, "not a global reference");
            usize::from(first & 0x1f)
        }
    }
}
