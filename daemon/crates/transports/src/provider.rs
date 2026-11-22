//! The contract every transport implements: discovery, the session's byte exchange, and the
//! operating-system side of a brick (presence, pairing, forgetting).
//!
//! Byte level on purpose. A transport carries frames and knows nothing about what a command
//! means; the command layer above owns the codec and the message counter.

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::brick_key::{BrickKey, Transport};
use crate::error::TransportError;

/// What a successful connect hands back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionHandle {
    pub brick_key: BrickKey,
    pub transport: Transport,
}

/// What a provider offers beyond the calls every provider has.
///
/// Declared rather than found out by calling: the runtime decides whether to offer an action, or
/// start a loop, without probing for it and catching the failure every time.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportCapabilities {
    /// The provider reports signal strength.
    pub supports_signal_info: bool,
    /// [`TransportProvider::forget`] removes OS-level evidence of a brick (unpair) and reports
    /// what it could not remove.
    pub supports_forget: bool,
    /// The provider can execute a composed telemetry frame. True for every transport that puts
    /// bytes on a wire, because a frame is bytecode and the brick's own VM runs it.
    pub supports_telemetry_frames: bool,
    /// A failed connect is retried only when the brick is seen again, never on a timer. True for
    /// Bluetooth: every attempt pages the one radio, and a reconnect too soon after a close
    /// locked a brick out for minutes on all three bricks measured. False means a failed connect
    /// is retried on a backoff while the brick stays visible.
    pub rejoin_on_evidence_only: bool,
    /// [`TransportProvider::recover`] re-establishes a lost connection.
    pub supports_recover: bool,
    /// [`TransportProvider::open_probe`] opens a link to a brick that has no session. Only where
    /// asking costs next to nothing (USB); not Bluetooth, where every open pages the one radio.
    pub supports_probe: bool,
    /// [`TransportProvider::pair`] pairs a brick with this computer.
    pub supports_pairing: bool,
    /// [`TransportProvider::check_presence`] asks whether a paired brick is there without
    /// connecting.
    pub supports_presence: bool,
}

/// Where a brick's state on one transport stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceState {
    Remembered,
    Available,
    Unavailable,
    Removed,
}

/// Where a brick's name came from, which decides how far it can be trusted.
///
/// Only `brick` (the brick's own `info` reply) and `beacon` (its TCP announcement) follow a
/// rename; the rest are records that go stale. The USB descriptor is fixed when the cable goes
/// in, and Windows' Bluetooth record catches up only at the next Bluetooth connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NameSource {
    Brick,
    Beacon,
    UsbDescriptor,
    BtCache,
    Fallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalStrength {
    Strong,
    Medium,
    Weak,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignalInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rssi: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strength: Option<SignalStrength>,
}

/// What one transport reports about one brick it can see: one channel, before bricks are
/// grouped.
///
/// When `presence_state` is `Remembered`, `remembered` is always true. The inverse does not hold:
/// a saved brick that is currently visible is `remembered` and `Available`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryItem {
    pub brick_key: BrickKey,
    pub display_name: String,
    /// Where `display_name` came from; `Fallback` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_source: Option<NameSource>,
    pub transport: Transport,
    pub presence_state: PresenceState,
    pub remembered: bool,
    pub connected: bool,
    pub favorite: bool,
    /// Paired with this computer. Bluetooth only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired: Option<bool>,
    /// Whether a paired brick answered its recent presence checks. Bluetooth only; absent before
    /// the first check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heard: Option<bool>,
    /// When a paired brick last answered a presence check, in ms since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heard_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal_info: Option<SignalInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bt_visible: Option<bool>,
    /// When the transport last saw the brick, in ms since the epoch.
    pub last_seen_at: i64,
}

/// One discovery scan of one transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryScanResult {
    pub transport: Transport,
    pub items: Vec<DiscoveryItem>,
}

impl DiscoveryScanResult {
    /// Moves every timestamp by `delta_ms`. A recording stores them relative to its start and
    /// replay moves them back onto the clock it runs on, so a replayed brick is as fresh as it
    /// was when recorded.
    pub fn shift_times(&mut self, delta_ms: i64) {
        for item in &mut self.items {
            item.last_seen_at += delta_ms;
            if let Some(heard_at) = item.heard_at.as_mut() {
                *heard_at += delta_ms;
            }
        }
    }
}

/// A record of a forgotten brick that outlives `forget`.
///
/// Each provider names its own, so the layers above never need to know which operating system
/// they run on: Windows returns its registry key and its in-memory device record, BlueZ its own
/// paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgetResidue {
    /// Where the record is, exactly enough for a user to find it: a registry path, a file.
    pub location: String,
    /// One line on why it stays: who owns it, or what ends it.
    pub reason: String,
}

/// How a pairing attempt ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingOutcome {
    pub ok: bool,
    /// Why it did not happen, in the words a user reads. Absent on success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The operating system's own status (`Paired`, `NotFound`, `AlreadyPaired`, ...), for the
    /// log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// Per-exchange overrides a caller passes through a provider to the link.
///
/// There is no abort signal: dropping the future abandons the exchange, and the link discards
/// what the abandoned exchange left behind before the next one starts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SendOptions {
    /// Round-trip budget; `None` takes the transport's own. `Some(Duration::ZERO)` disables the
    /// timer entirely, so the exchange waits indefinitely: a sentinel, not "do not wait".
    pub timeout: Option<Duration>,
    /// The message counter the reply must carry. Replies with another counter belong to an
    /// abandoned exchange and are stepped over. `None` accepts the first reply.
    pub expected_message_counter: Option<u16>,
}

/// A short-lived byte link to a brick outside any session: one question asked without signing
/// the brick in. Close it promptly; while it is open the provider holds the device and a connect
/// waits.
#[async_trait]
pub trait ProbeLink: Send {
    async fn send_packet(
        &mut self,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError>;

    async fn close(&mut self);
}

/// The contract every transport (USB, Bluetooth, TCP, and replay standing in for them)
/// implements.
///
/// Object safe: the runtime holds providers as `Arc<dyn TransportProvider>` in a registry, and
/// every future is `Send`, so a call can run on any thread of a multi-thread runtime.
///
/// The optional operations default to a `transport_failed` refusal; a provider that offers one
/// overrides it and declares it in [`TransportProvider::capabilities`].
#[async_trait]
pub trait TransportProvider: Send + Sync {
    /// Which transport this provider handles.
    fn transport(&self) -> Transport;

    /// How strongly traffic prefers this transport when a brick is reachable over several;
    /// higher wins. USB 30, Bluetooth 20, TCP 10, mock 0: the owner's order, USB, then Bluetooth,
    /// then TCP. Declared by each transport so nothing above the providers names one.
    fn priority(&self) -> i32;

    fn capabilities(&self) -> TransportCapabilities;

    /// Runs one discovery scan and returns the bricks visible now.
    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError>;

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError>;

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError>;

    /// Sends one packet to a connected brick and returns the reply packet.
    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError>;

    /// Largest packet the live link to this brick carries, where that is not simply the
    /// firmware's own 1024-byte buffer. USB answers, because one brick carries 1024 bytes over
    /// libusb and 64 over HID. `None` means the firmware default.
    fn max_packet_bytes(&self, _brick_key: &BrickKey) -> Option<usize> {
        None
    }

    /// Opens a [`ProbeLink`] to a brick that has no session.
    async fn open_probe(
        &self,
        _brick_key: &BrickKey,
    ) -> Result<Box<dyn ProbeLink>, TransportError> {
        Err(TransportError::unsupported(
            self.transport().as_str(),
            "probe links",
        ))
    }

    /// Re-establishes a lost connection.
    async fn recover(&self, _brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        Err(TransportError::unsupported(
            self.transport().as_str(),
            "recovery",
        ))
    }

    /// Removes OS-level evidence for a brick (a Bluetooth unpair) and returns the records the
    /// provider knows it left behind, so the user can be told where they are. Empty when nothing
    /// is left.
    async fn forget(&self, _brick_key: &BrickKey) -> Result<Vec<ForgetResidue>, TransportError> {
        Err(TransportError::unsupported(
            self.transport().as_str(),
            "forget",
        ))
    }

    /// Pairs a brick with this computer.
    async fn pair(&self, _brick_key: &BrickKey) -> Result<PairingOutcome, TransportError> {
        Err(TransportError::unsupported(
            self.transport().as_str(),
            "pairing",
        ))
    }

    /// Whether a paired brick without a session answers, found without connecting.
    async fn check_presence(&self, _brick_key: &BrickKey) -> Result<bool, TransportError> {
        Err(TransportError::unsupported(
            self.transport().as_str(),
            "presence checks",
        ))
    }

    /// Releases everything the provider holds. Called once, at shutdown.
    async fn dispose(&self) {}
}
