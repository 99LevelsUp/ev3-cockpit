//! The one error this crate returns: a packet, a command or a reply the protocol refuses.

use std::fmt;

/// A malformed packet, an out-of-range value, or a reply the brick flagged as an error.
///
/// Carries a human-readable message only. The callers that matter to the protocol (a counter
/// mismatch, a brick-reported error) are told apart by the function that returned them, not by a
/// code, because every one of them ends the same way: the exchange is refused and the link is
/// not torn down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    message: String,
}

impl ProtocolError {
    /// An error with the given message.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The message, exactly as it is shown to a user.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProtocolError {}
