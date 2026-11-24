//! Serves a recorded session through the provider trait, in place of the hardware.
//!
//! Two modes:
//!
//! - **Strict** replays the recording exactly. Each brick's calls (and each provider's
//!   discoveries) must come in the recorded order with the recorded bytes, message counter
//!   included; anything else fails with `replay_deviation`. For failure-path tests in Rust,
//!   where the runtime drives the providers deterministically.
//! - **Matched** answers each request with the recorded replies to an equal request, its message
//!   counter masked, in recorded order, rewriting each reply's counter to the live request's.
//!   For client tests, whose counters and interleaving differ from the recorded run.
//!
//! Either way, a request with no recorded answer left fails with `replay_unmatched`, so a stale
//! fixture shows up instead of hiding. The calls a daemon makes on a timer, discovery, presence
//! checks and a program subscription's status polls, are the one exception in matched mode: once
//! their recorded answers run out they keep giving the last one, because how often a timer fires
//! depends on how long a test runs, not on what it does.
//!
//! Each call takes as long as it took when recorded, on tokio's clock, so a test with paused time
//! runs at once. A call the recorded caller abandoned is never finished.

use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;

use crate::brick_key::{BrickKey, Transport};
use crate::error::{ErrorCode, TransportError};
use crate::fixture::{Event, FORMAT_VERSION, Header, Line, Outcome, Via, from_hex, to_hex};
use crate::provider::{
    DiscoveryScanResult, ForgetResidue, PairingOutcome, ProbeLink, SendOptions, SessionHandle,
    TransportCapabilities, TransportProvider,
};

/// How replay matches live calls to the recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayMode {
    Strict,
    Matched,
}

/// A recording that cannot be replayed: unreadable, malformed, or of another format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixtureError {
    pub message: String,
}

impl fmt::Display for FixtureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FixtureError {}

fn fixture_error(message: impl Into<String>) -> FixtureError {
    FixtureError {
        message: message.into(),
    }
}

/// A loaded recording and the providers that serve it.
pub struct Replay {
    header: Header,
    shared: Arc<Shared>,
    providers: Vec<Arc<dyn TransportProvider>>,
}

impl Replay {
    /// Loads the recording at `path`.
    pub fn load(path: &Path, mode: ReplayMode) -> Result<Self, FixtureError> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| fixture_error(format!("Cannot read {}: {e}", path.display())))?;
        Self::from_text(&text, mode)
    }

    /// Loads a recording from its text.
    pub fn from_text(text: &str, mode: ReplayMode) -> Result<Self, FixtureError> {
        let mut lines = text.lines().filter(|l| !l.trim().is_empty());
        let header: Header = serde_json::from_str(
            lines
                .next()
                .ok_or_else(|| fixture_error("The recording is empty."))?,
        )
        .map_err(|e| fixture_error(format!("The recording's header is malformed: {e}")))?;
        if header.format != FORMAT_VERSION {
            return Err(fixture_error(format!(
                "The recording has format {}; this build reads format {FORMAT_VERSION}. \
                 Re-record the scenario.",
                header.format
            )));
        }

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0);
        let mut state = State::default();
        let mut declared: Vec<(Transport, i32, TransportCapabilities)> = Vec::new();
        for (index, line) in lines.enumerate() {
            let line: Line = serde_json::from_str(line).map_err(|e| {
                fixture_error(format!(
                    "Line {} of the recording is malformed: {e}",
                    index + 2
                ))
            })?;
            let mut event = line.event;
            if let Event::Discover {
                outcome: Outcome::Ok(scan),
                ..
            } = &mut event
            {
                scan.shift_times(now_ms);
            }
            match event {
                Event::Provider {
                    transport,
                    priority,
                    capabilities,
                } => declared.push((transport, priority, capabilities)),
                event => {
                    if !declared.iter().any(|(t, _, _)| *t == event.transport()) {
                        return Err(fixture_error(format!(
                            "Line {} uses the {} provider before the recording declares it.",
                            index + 2,
                            event.transport()
                        )));
                    }
                    match mode {
                        ReplayMode::Strict => state
                            .strict
                            .entry((event.transport(), event.brick_key().cloned()))
                            .or_default()
                            .push_back(event),
                        ReplayMode::Matched => state
                            .matched
                            .entry(match_key_of(&event))
                            .or_default()
                            .push_back(event),
                    }
                }
            }
        }

        let shared = Arc::new(Shared {
            mode,
            state: Mutex::new(state),
        });
        let providers = declared
            .into_iter()
            .map(|(transport, priority, capabilities)| {
                Arc::new(ReplayProvider {
                    shared: shared.clone(),
                    transport,
                    priority,
                    capabilities,
                }) as Arc<dyn TransportProvider>
            })
            .collect();
        Ok(Self {
            header,
            shared,
            providers,
        })
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    /// One provider for each the recording declares, in recorded order.
    pub fn providers(&self) -> Vec<Arc<dyn TransportProvider>> {
        self.providers.clone()
    }

    /// The provider for one transport, if the recording has one.
    pub fn provider(&self, transport: Transport) -> Option<Arc<dyn TransportProvider>> {
        self.providers
            .iter()
            .find(|p| p.transport() == transport)
            .cloned()
    }

    /// In strict mode, fails unless every recorded call was replayed: a session that did less
    /// than the recorded one deviated too. Matched mode has nothing to check.
    pub fn finish(&self) -> Result<(), TransportError> {
        if self.shared.mode == ReplayMode::Matched {
            return Ok(());
        }
        let state = self.shared.lock();
        let left: Vec<&Event> = state.strict.values().flatten().collect();
        match left.first() {
            None => Ok(()),
            Some(first) => Err(TransportError::new(
                ErrorCode::ReplayDeviation,
                format!(
                    "Strict replay ended with {} recorded calls not made, the first {}.",
                    left.len(),
                    describe_event(first)
                ),
            )),
        }
    }
}

/// Key of a matched-mode queue: transport, operation, brick, link, and the request with its
/// message counter masked.
type MatchKey = (
    Transport,
    &'static str,
    Option<BrickKey>,
    Option<Via>,
    Vec<u8>,
);

#[derive(Default)]
struct State {
    /// Strict mode: each brick's calls in order, and each provider's discoveries under `None`.
    strict: BTreeMap<(Transport, Option<BrickKey>), VecDeque<Event>>,
    /// Matched mode: the recorded answers to each distinct request, in order.
    matched: BTreeMap<MatchKey, VecDeque<Event>>,
    /// Matched mode: the last answer served to each polled call.
    last_polled: BTreeMap<MatchKey, Event>,
    /// What the last connect or recover said the link carries.
    max_packet_bytes: BTreeMap<(Transport, BrickKey), Option<usize>>,
}

struct Shared {
    mode: ReplayMode,
    state: Mutex<State>,
}

/// A live call, as replay compares it with the recording.
struct Call<'a> {
    transport: Transport,
    name: &'static str,
    brick_key: Option<&'a BrickKey>,
    via: Option<Via>,
    request: Option<&'a [u8]>,
}

impl Call<'_> {
    fn describe(&self) -> String {
        let mut text = format!("{} on {}", self.name, self.transport);
        if let Some(key) = self.brick_key {
            text.push_str(&format!(" for {key}"));
        }
        if let Some(request) = self.request {
            text.push_str(&format!(" with request {}", to_hex(request)));
        }
        text
    }
}

fn describe_event(event: &Event) -> String {
    let mut text = format!("{} on {}", event.name(), event.transport());
    if let Some(key) = event.brick_key() {
        text.push_str(&format!(" for {key}"));
    }
    if let Event::Exchange { request_hex, .. } = event {
        text.push_str(&format!(" with request {request_hex}"));
    }
    text
}

/// Whether `request` asks the brick whether a user program runs: the direct command
/// `opPROGRAM_INFO GET_STATUS` for the user slot, as `BrickCommand::ProgramStatus` builds it. A
/// subscription's follower sends it on a timer, with the same bytes a request's own status check
/// sends, so it is a polled call too.
fn is_program_status_poll(request: &[u8]) -> bool {
    use ev3_protocol::packet::{command, opcode, program_info_sub, program_slot};
    // LC0 carries a value below 32 as the value itself, so the named codes are the bytes.
    const GET_STATUS_USER_SLOT: [u8; 3] = [
        opcode::PROGRAM_INFO,
        program_info_sub::GET_STATUS,
        program_slot::USER,
    ];
    // A direct command's payload starts with its two-byte global and local variable sizes.
    ev3_protocol::decode_ev3_packet(request).is_ok_and(|packet| {
        packet.packet_type == command::DIRECT_COMMAND_REPLY
            && packet
                .payload
                .get(2..)
                .is_some_and(|code| code.starts_with(&GET_STATUS_USER_SLOT))
    })
}

/// The request with its message counter, bytes 2 and 3, zeroed.
fn masked(request: &[u8]) -> Vec<u8> {
    let mut out = request.to_vec();
    if out.len() >= 4 {
        out[2] = 0;
        out[3] = 0;
    }
    out
}

fn request_of(event: &Event) -> Option<Vec<u8>> {
    match event {
        Event::Exchange { request_hex, .. } => Some(from_hex(request_hex).unwrap_or_default()),
        _ => None,
    }
}

fn via_of(event: &Event) -> Option<Via> {
    match event {
        Event::Exchange { via, .. } => Some(*via),
        _ => None,
    }
}

fn match_key_of(event: &Event) -> MatchKey {
    (
        event.transport(),
        event.name(),
        event.brick_key().cloned(),
        via_of(event),
        request_of(event).map(|r| masked(&r)).unwrap_or_default(),
    )
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The recorded event that answers `call`.
    fn take(&self, call: &Call<'_>) -> Result<Event, TransportError> {
        let mut state = self.lock();
        let unmatched = || {
            TransportError::new(
                ErrorCode::ReplayUnmatched,
                format!(
                    "Replay has no recorded answer left for {}; the fixture is stale. Re-record \
                     the scenario.",
                    call.describe()
                ),
            )
        };
        match self.mode {
            ReplayMode::Strict => {
                let queue = state
                    .strict
                    .get_mut(&(call.transport, call.brick_key.cloned()))
                    .ok_or_else(unmatched)?;
                let next = queue.front().ok_or_else(unmatched)?;
                let same = next.name() == call.name
                    && via_of(next) == call.via
                    && request_of(next).as_deref() == call.request;
                if !same {
                    return Err(TransportError::new(
                        ErrorCode::ReplayDeviation,
                        format!(
                            "Strict replay expected {}, got {}.",
                            describe_event(next),
                            call.describe()
                        ),
                    ));
                }
                queue.pop_front().ok_or_else(unmatched)
            }
            ReplayMode::Matched => {
                let key: MatchKey = (
                    call.transport,
                    call.name,
                    call.brick_key.cloned(),
                    call.via,
                    call.request.map(masked).unwrap_or_default(),
                );
                let polled = matches!(call.name, "discover" | "presence")
                    || call.request.is_some_and(is_program_status_poll);
                match state.matched.get_mut(&key).and_then(VecDeque::pop_front) {
                    Some(event) => {
                        if polled {
                            state.last_polled.insert(key, event.clone());
                        }
                        Ok(event)
                    }
                    None if polled => state.last_polled.get(&key).cloned().ok_or_else(unmatched),
                    None => Err(unmatched()),
                }
            }
        }
    }

    /// Takes the answer to `call` and waits as long as the recorded call took.
    async fn serve(&self, call: Call<'_>) -> Result<Event, TransportError> {
        let event = self.take(&call)?;
        tokio::time::sleep(Duration::from_millis(event.elapsed_ms())).await;
        Ok(event)
    }

    /// The reply an exchange event holds; never returns for an abandoned one.
    async fn exchange(
        &self,
        transport: Transport,
        brick_key: &BrickKey,
        via: Via,
        packet: &[u8],
    ) -> Result<Vec<u8>, TransportError> {
        let event = self
            .serve(Call {
                transport,
                name: "exchange",
                brick_key: Some(brick_key),
                via: Some(via),
                request: Some(packet),
            })
            .await?;
        let Event::Exchange {
            reply_hex, error, ..
        } = event
        else {
            return Err(mismatched_event());
        };
        if let Some(error) = error {
            return Err(error);
        }
        let Some(reply_hex) = reply_hex else {
            return std::future::pending().await;
        };
        let mut reply = from_hex(&reply_hex).ok_or_else(|| {
            TransportError::transport_failed("The recorded reply is not valid hex.")
        })?;
        if self.mode == ReplayMode::Matched && reply.len() >= 4 && packet.len() >= 4 {
            reply[2] = packet[2];
            reply[3] = packet[3];
        }
        Ok(reply)
    }
}

fn mismatched_event() -> TransportError {
    TransportError::new(
        ErrorCode::ReplayDeviation,
        "The recording holds a different kind of event here.",
    )
}

/// A recorded outcome as the call's result; never returns for an abandoned call.
async fn settle<T>(outcome: Outcome<T>) -> Result<T, TransportError> {
    match outcome {
        Outcome::Ok(value) => Ok(value),
        Outcome::Err(error) => Err(error),
        Outcome::Abandoned => std::future::pending().await,
    }
}

struct ReplayProvider {
    shared: Arc<Shared>,
    transport: Transport,
    priority: i32,
    capabilities: TransportCapabilities,
}

impl ReplayProvider {
    fn call<'a>(&self, name: &'static str, brick_key: Option<&'a BrickKey>) -> Call<'a> {
        Call {
            transport: self.transport,
            name,
            brick_key,
            via: None,
            request: None,
        }
    }

    async fn session(
        &self,
        name: &'static str,
        brick_key: &BrickKey,
    ) -> Result<SessionHandle, TransportError> {
        let (outcome, max_packet_bytes) =
            match self.shared.serve(self.call(name, Some(brick_key))).await? {
                Event::Connect {
                    outcome,
                    max_packet_bytes,
                    ..
                }
                | Event::Recover {
                    outcome,
                    max_packet_bytes,
                    ..
                } => (outcome, max_packet_bytes),
                _ => return Err(mismatched_event()),
            };
        if matches!(outcome, Outcome::Ok(_)) {
            self.shared
                .lock()
                .max_packet_bytes
                .insert((self.transport, brick_key.clone()), max_packet_bytes);
        }
        settle(outcome).await
    }
}

#[async_trait]
impl TransportProvider for ReplayProvider {
    fn transport(&self) -> Transport {
        self.transport
    }

    fn priority(&self) -> i32 {
        self.priority
    }

    fn capabilities(&self) -> TransportCapabilities {
        self.capabilities
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        match self.shared.serve(self.call("discover", None)).await? {
            Event::Discover { outcome, .. } => settle(outcome).await,
            _ => Err(mismatched_event()),
        }
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.session("connect", brick_key).await
    }

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError> {
        match self
            .shared
            .serve(self.call("disconnect", Some(brick_key)))
            .await?
        {
            Event::Disconnect { outcome, .. } => settle(outcome).await,
            _ => Err(mismatched_event()),
        }
    }

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        _options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        self.shared
            .exchange(self.transport, brick_key, Via::Session, packet)
            .await
    }

    fn max_packet_bytes(&self, brick_key: &BrickKey) -> Option<usize> {
        self.shared
            .lock()
            .max_packet_bytes
            .get(&(self.transport, brick_key.clone()))
            .copied()
            .flatten()
    }

    async fn open_probe(&self, brick_key: &BrickKey) -> Result<Box<dyn ProbeLink>, TransportError> {
        match self
            .shared
            .serve(self.call("open_probe", Some(brick_key)))
            .await?
        {
            Event::OpenProbe { outcome, .. } => settle(outcome).await?,
            _ => return Err(mismatched_event()),
        }
        Ok(Box::new(ReplayProbe {
            shared: self.shared.clone(),
            transport: self.transport,
            brick_key: brick_key.clone(),
        }))
    }

    async fn recover(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.session("recover", brick_key).await
    }

    async fn forget(&self, brick_key: &BrickKey) -> Result<Vec<ForgetResidue>, TransportError> {
        match self
            .shared
            .serve(self.call("forget", Some(brick_key)))
            .await?
        {
            Event::Forget { outcome, .. } => settle(outcome).await,
            _ => Err(mismatched_event()),
        }
    }

    async fn pair(&self, brick_key: &BrickKey) -> Result<PairingOutcome, TransportError> {
        match self
            .shared
            .serve(self.call("pair", Some(brick_key)))
            .await?
        {
            Event::Pair { outcome, .. } => settle(outcome).await,
            _ => Err(mismatched_event()),
        }
    }

    async fn check_presence(&self, brick_key: &BrickKey) -> Result<bool, TransportError> {
        match self
            .shared
            .serve(self.call("presence", Some(brick_key)))
            .await?
        {
            Event::Presence { outcome, .. } => settle(outcome).await,
            _ => Err(mismatched_event()),
        }
    }
}

struct ReplayProbe {
    shared: Arc<Shared>,
    transport: Transport,
    brick_key: BrickKey,
}

#[async_trait]
impl ProbeLink for ReplayProbe {
    async fn send_packet(
        &mut self,
        packet: &[u8],
        _options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        self.shared
            .exchange(self.transport, &self.brick_key, Via::Probe, packet)
            .await
    }

    async fn close(&mut self) {}
}
