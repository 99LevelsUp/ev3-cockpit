//! The recording format: JSON lines, one header and then one line per provider event.
//!
//! ```text
//! {"format":1,"recorder":1,"scenario":"connect-and-read"}
//! {"at_ms":0,"event":"provider","transport":"usb","priority":30,"capabilities":{...}}
//! {"at_ms":3,"event":"discover","transport":"usb","elapsed_ms":12,"outcome":{"ok":{...}}}
//! {"at_ms":40,"event":"exchange","transport":"usb","brick_key":"usb:001653F00A0A",
//!  "via":"session","request_hex":"0900010000...","reply_hex":"...","elapsed_ms":8}
//! ```
//!
//! Times are milliseconds since the recording started, never the wall clock; a discovery's
//! timestamps are stored relative to the same start. Bytes are lower-case hex in fields whose
//! name ends in `_hex`. Keys are written in a fixed order, so the same session always gives the same
//! text.

use serde::{Deserialize, Serialize};

use crate::brick_key::{BrickKey, Transport};
use crate::error::TransportError;
use crate::provider::{
    DiscoveryScanResult, ForgetResidue, PairingOutcome, SessionHandle, TransportCapabilities,
};

/// Version of the line format. A reader refuses any other.
pub const FORMAT_VERSION: u32 = 1;

/// Version of what the recorder captures and how it scrubs it. Raised whenever a change would
/// make a new recording of the same scenario differ; a fixture keeps the version it was made
/// with.
pub const RECORDER_VERSION: u32 = 1;

/// The file a recording is written to, inside the directory the recorder is handed.
pub const RECORDING_FILE: &str = "recording.jsonl";

/// The first line of a recording.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    pub format: u32,
    pub recorder: u32,
    /// The scenario script the session ran.
    pub scenario: String,
}

/// Every line after the header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    /// When the call started, in ms since the recording started.
    pub at_ms: u64,
    #[serde(flatten)]
    pub event: Event,
}

/// Which link an exchange went over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    /// The brick's session.
    Session,
    /// A probe link opened outside any session.
    Probe,
}

/// A call's result as a recording holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome<T> {
    Ok(T),
    Err(TransportError),
    /// The caller dropped the call before it finished, typically on its own timer. Replay
    /// never finishes such a call, so the caller abandons it again.
    Abandoned,
}

impl<T: Clone> From<&Result<T, TransportError>> for Outcome<T> {
    fn from(result: &Result<T, TransportError>) -> Self {
        match result {
            Ok(value) => Self::Ok(value.clone()),
            Err(error) => Self::Err(error.clone()),
        }
    }
}

/// One provider-level event of a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// A provider taking part in the session, written when it is wrapped.
    Provider {
        transport: Transport,
        priority: i32,
        capabilities: TransportCapabilities,
    },
    Discover {
        transport: Transport,
        elapsed_ms: u64,
        outcome: Outcome<DiscoveryScanResult>,
    },
    Connect {
        transport: Transport,
        brick_key: BrickKey,
        elapsed_ms: u64,
        outcome: Outcome<SessionHandle>,
        /// What the provider said the live link carries, read right after the connect.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_packet_bytes: Option<usize>,
    },
    Recover {
        transport: Transport,
        brick_key: BrickKey,
        elapsed_ms: u64,
        outcome: Outcome<SessionHandle>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_packet_bytes: Option<usize>,
    },
    Disconnect {
        transport: Transport,
        brick_key: BrickKey,
        elapsed_ms: u64,
        outcome: Outcome<()>,
    },
    /// One packet each way, or the failure in place of the reply. With neither a reply nor an
    /// error, the caller abandoned the exchange.
    Exchange {
        transport: Transport,
        brick_key: BrickKey,
        via: Via,
        request_hex: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_hex: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<TransportError>,
        elapsed_ms: u64,
    },
    OpenProbe {
        transport: Transport,
        brick_key: BrickKey,
        elapsed_ms: u64,
        outcome: Outcome<()>,
    },
    Presence {
        transport: Transport,
        brick_key: BrickKey,
        elapsed_ms: u64,
        outcome: Outcome<bool>,
    },
    Pair {
        transport: Transport,
        brick_key: BrickKey,
        elapsed_ms: u64,
        outcome: Outcome<PairingOutcome>,
    },
    Forget {
        transport: Transport,
        brick_key: BrickKey,
        elapsed_ms: u64,
        outcome: Outcome<Vec<ForgetResidue>>,
    },
}

impl Event {
    pub fn transport(&self) -> Transport {
        match self {
            Self::Provider { transport, .. }
            | Self::Discover { transport, .. }
            | Self::Connect { transport, .. }
            | Self::Recover { transport, .. }
            | Self::Disconnect { transport, .. }
            | Self::Exchange { transport, .. }
            | Self::OpenProbe { transport, .. }
            | Self::Presence { transport, .. }
            | Self::Pair { transport, .. }
            | Self::Forget { transport, .. } => *transport,
        }
    }

    /// The brick the call named, if it named one.
    pub fn brick_key(&self) -> Option<&BrickKey> {
        match self {
            Self::Provider { .. } | Self::Discover { .. } => None,
            Self::Connect { brick_key, .. }
            | Self::Recover { brick_key, .. }
            | Self::Disconnect { brick_key, .. }
            | Self::Exchange { brick_key, .. }
            | Self::OpenProbe { brick_key, .. }
            | Self::Presence { brick_key, .. }
            | Self::Pair { brick_key, .. }
            | Self::Forget { brick_key, .. } => Some(brick_key),
        }
    }

    /// The operation's name, as the `event` field spells it.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Provider { .. } => "provider",
            Self::Discover { .. } => "discover",
            Self::Connect { .. } => "connect",
            Self::Recover { .. } => "recover",
            Self::Disconnect { .. } => "disconnect",
            Self::Exchange { .. } => "exchange",
            Self::OpenProbe { .. } => "open_probe",
            Self::Presence { .. } => "presence",
            Self::Pair { .. } => "pair",
            Self::Forget { .. } => "forget",
        }
    }

    /// Sets how long the call took.
    pub fn set_elapsed_ms(&mut self, value: u64) {
        match self {
            Self::Provider { .. } => {}
            Self::Discover { elapsed_ms, .. }
            | Self::Connect { elapsed_ms, .. }
            | Self::Recover { elapsed_ms, .. }
            | Self::Disconnect { elapsed_ms, .. }
            | Self::Exchange { elapsed_ms, .. }
            | Self::OpenProbe { elapsed_ms, .. }
            | Self::Presence { elapsed_ms, .. }
            | Self::Pair { elapsed_ms, .. }
            | Self::Forget { elapsed_ms, .. } => *elapsed_ms = value,
        }
    }

    /// How long the call took, for replay to take as long.
    pub fn elapsed_ms(&self) -> u64 {
        match self {
            Self::Provider { .. } => 0,
            Self::Discover { elapsed_ms, .. }
            | Self::Connect { elapsed_ms, .. }
            | Self::Recover { elapsed_ms, .. }
            | Self::Disconnect { elapsed_ms, .. }
            | Self::Exchange { elapsed_ms, .. }
            | Self::OpenProbe { elapsed_ms, .. }
            | Self::Presence { elapsed_ms, .. }
            | Self::Pair { elapsed_ms, .. }
            | Self::Forget { elapsed_ms, .. } => *elapsed_ms,
        }
    }
}

/// Bytes as lower-case hex.
pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from(DIGITS[usize::from(b >> 4)]));
        out.push(char::from(DIGITS[usize::from(b & 0x0f)]));
    }
    out
}

/// Hex back to bytes; `None` for an odd length or a character that is not a hex digit.
pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}
