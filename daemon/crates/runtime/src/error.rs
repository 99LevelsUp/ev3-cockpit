//! What a session call that did not succeed returns.

use std::fmt;

use ev3_protocol::ProtocolError;
use ev3_transports::{BrickKey, ErrorCode, Transport, TransportError};

/// A session call that failed, or a command the session refused.
///
/// Three groups a caller tells apart:
///
/// - **refused, never sent**: `NotConnected`, `LinkLost`, `Disconnected`, `Degraded`. Nothing
///   reached the brick.
/// - **the link failed**: `Transport`. The command may or may not have reached the brick.
/// - **the brick answered and the answer could not be read**: `Protocol`. The link works; this
///   is never counted as a missed heartbeat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    /// No session for this channel.
    NotConnected { brick_key: BrickKey },
    /// A session for this channel exists already.
    AlreadyConnected { brick_key: BrickKey },
    /// No provider handles this transport.
    NoProvider { transport: Transport },
    /// The session was disconnected while it was connecting; the connect did not take.
    ConnectionAbandoned { brick_key: BrickKey },
    /// The session's link is lost and reconnecting; the command was not sent.
    LinkLost { brick_key: BrickKey },
    /// The session ended while the command waited its turn; the command was not sent.
    Disconnected { brick_key: BrickKey },
    /// The channel failed too many times in a row; sends are refused until it reconnects.
    Degraded { brick_key: BrickKey },
    /// The provider failed: the link, a timeout, or an operation it refused.
    Transport(TransportError),
    /// The reply arrived but could not be read, or a command could not be encoded.
    Protocol(ProtocolError),
}

impl SessionError {
    /// Whether the brick's reply arrived, so the link is proven alive even though the call
    /// failed.
    pub fn reply_arrived(&self) -> bool {
        matches!(self, Self::Protocol(_))
    }

    /// Whether the failure is the link's (or a refusal because of the link), the kind a brick
    /// layer fails over on.
    pub fn is_link_fault(&self) -> bool {
        matches!(
            self,
            Self::LinkLost { .. } | Self::Degraded { .. } | Self::Transport(_)
        )
    }

    /// The provider's error code, for a `Transport` failure.
    pub fn transport_code(&self) -> Option<ErrorCode> {
        match self {
            Self::Transport(error) => Some(error.code),
            _ => None,
        }
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConnected { brick_key } => write!(f, "Brick {brick_key} is not connected."),
            Self::AlreadyConnected { brick_key } => {
                write!(f, "Brick {brick_key} is already connected.")
            }
            Self::NoProvider { transport } => {
                write!(f, "No transport provider registered for \"{transport}\".")
            }
            Self::ConnectionAbandoned { brick_key } => {
                write!(f, "{brick_key} was disconnected while it was connecting.")
            }
            Self::LinkLost { brick_key } => write!(
                f,
                "The link to {brick_key} is lost and reconnecting; the command was not sent."
            ),
            Self::Disconnected { brick_key } => write!(
                f,
                "The session to {brick_key} was disconnected; the command was not sent."
            ),
            Self::Degraded { brick_key } => write!(
                f,
                "Channel {brick_key} is degraded; sends are blocked until it reconnects."
            ),
            Self::Transport(error) => f.write_str(&error.message),
            Self::Protocol(error) => f.write_str(error.message()),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<TransportError> for SessionError {
    fn from(error: TransportError) -> Self {
        Self::Transport(error)
    }
}

impl From<ProtocolError> for SessionError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}
