//! What telemetry refuses, and the contract code each refusal carries to a client.

use std::fmt;

use ev3_contract::ErrorCode;

/// A telemetry call that did not succeed. Nothing it refused was changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelemetryError {
    /// A row or a frame that cannot be placed on the link: too wide, misaligned, or two modes of
    /// one port.
    Assembly(String),
    /// A row set or a period the scheduler will not run: a divider that is not a whole number of
    /// ticks, one id twice, a period of no time.
    InvalidRows(String),
    /// A setting out of its range; the message names it.
    InvalidSetting(String),
    /// A claim that names no row, an unknown row, a nonsense interval or a mode out of range.
    InvalidClaim(String),
    /// A sensor port is read in another mode for another claim; the message names its holder.
    ModeConflict(String),
    /// The brick has no session.
    NotConnected(String),
    /// The claim could never be read: the brick's link carries no telemetry frames, or telemetry
    /// was shut down.
    SubscriptionFailed(String),
    /// A frame did not come back: the link failed it, or it came back as another command.
    Frame(String),
}

impl TelemetryError {
    /// The contract code a client decides on.
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Assembly(_) | Self::InvalidRows(_) | Self::InvalidSetting(_) => {
                ErrorCode::Internal
            }
            Self::InvalidClaim(_) => ErrorCode::InvalidRequest,
            Self::ModeConflict(_) => ErrorCode::ModeConflict,
            Self::NotConnected(_) => ErrorCode::NotConnected,
            Self::SubscriptionFailed(_) => ErrorCode::SubscriptionFailed,
            Self::Frame(_) => ErrorCode::ProtocolFailed,
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::Assembly(m)
            | Self::InvalidRows(m)
            | Self::InvalidSetting(m)
            | Self::InvalidClaim(m)
            | Self::ModeConflict(m)
            | Self::NotConnected(m)
            | Self::SubscriptionFailed(m)
            | Self::Frame(m) => m,
        }
    }
}

impl fmt::Display for TelemetryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for TelemetryError {}
