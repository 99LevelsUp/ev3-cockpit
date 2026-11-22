//! The error every provider call returns: a code a caller can branch on and a message a user
//! can read.

use std::fmt;

use serde::{Deserialize, Serialize};

/// What kind of failure an error is. Serialized in snake case, the way the cockpit's error codes
/// are spelled everywhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The link failed, refused, or is not open; also an operation the provider does not offer.
    TransportFailed,
    /// No matching reply came within the round-trip budget.
    Timeout,
    /// A brick key that names no transport or no brick.
    InvalidBrickKey,
    /// Replay has no recorded answer left for this request: the fixture is stale.
    ReplayUnmatched,
    /// Strict replay got a request other than the one recorded next.
    ReplayDeviation,
}

impl ErrorCode {
    /// The code as it is written on the wire and in recordings.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TransportFailed => "transport_failed",
            Self::Timeout => "timeout",
            Self::InvalidBrickKey => "invalid_brick_key",
            Self::ReplayUnmatched => "replay_unmatched",
            Self::ReplayDeviation => "replay_deviation",
        }
    }
}

/// A provider call that did not succeed.
///
/// Plain data, so a recording can hold one and replay can hand back the same failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportError {
    pub code: ErrorCode,
    pub message: String,
}

impl TransportError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn transport_failed(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::TransportFailed, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Timeout, message)
    }

    /// A platform failure under the link (a reset socket, a closed port), given a cockpit code
    /// and the transport's name. Without the code, a consumer once got a bare "TCP socket closed."
    pub fn link_failed(transport_label: &str, detail: impl fmt::Display) -> Self {
        Self::transport_failed(format!("{transport_label} link failed: {detail}"))
    }

    /// An optional operation called on a provider that does not offer it. Callers read the
    /// provider's capabilities first, so reaching this is a bug above the provider.
    pub fn unsupported(transport_label: &str, operation: &str) -> Self {
        Self::transport_failed(format!(
            "The {transport_label} provider does not support {operation}."
        ))
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TransportError {}
