//! Shell commands on the brick.
//!
//! One direct command runs the line through the brick's `system()` and answers its exit status.
//! Whether a client may run one at all (the access mode) is the daemon's decision, before this is
//! called.

use std::fmt;

use ev3_contract::ErrorCode;
use ev3_protocol::{BrickCommand, BrickResponse};

use crate::bricks::BrickError;
use crate::fs::{WriteReporter, kind_of};
use crate::programs::ProgramLink;

/// A shell command that did not run to an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellError {
    /// Refused before it left (an empty command is never encoded), lost with the link, or
    /// answered with an error.
    Command(BrickError),
    /// The brick answered with a reply of another kind.
    Protocol(String),
}

impl ShellError {
    /// The contract code of a refusal this module makes; `None` for a brick failure, whose code
    /// comes from the error it carries.
    pub fn code(&self) -> Option<ErrorCode> {
        match self {
            Self::Protocol(_) => Some(ErrorCode::ProtocolFailed),
            Self::Command(_) => None,
        }
    }
}

impl fmt::Display for ShellError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Command(error) => error.fmt(f),
            Self::Protocol(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ShellError {}

/// Runs `command` on the brick and answers its exit status. Reported as a write through `writes`
/// when given. Never resent: a command whose reply was lost may have run.
pub async fn run_shell(
    link: &dyn ProgramLink,
    command: &str,
    writes: Option<&WriteReporter>,
) -> Result<i32, ShellError> {
    let _scope = writes
        .zip(link.channel())
        .map(|(writes, channel)| writes.begin(channel, format!("Running {command}")));
    let request = BrickCommand::SystemRun {
        command: command.to_owned(),
    };
    match link.send(&request, None).await {
        Ok(BrickResponse::SystemRun { status }) => Ok(status),
        Ok(reply) => Err(ShellError::Protocol(format!(
            "Sent {} but got a {} reply.",
            request.kind(),
            kind_of(&reply)
        ))),
        Err(error) => Err(ShellError::Command(error)),
    }
}
