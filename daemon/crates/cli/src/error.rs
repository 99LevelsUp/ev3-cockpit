//! What can go wrong in `ev3`, and the exit code each failure maps to.

use serde_json::{Value, json};

pub use ev3_client::error::{DAEMON_UNAVAILABLE, Failure};

/// The exit codes; `ev3 help` lists them.
pub mod exit {
    pub const OK: u8 = 0;
    pub const FAILURE: u8 = 1;
    pub const USAGE: u8 = 2;
    pub const BRICK_BUSY: u8 = 3;
    pub const UNCERTAIN: u8 = 4;
    pub const NEEDS_PERSON: u8 = 5;
    pub const DAEMON_UNAVAILABLE: u8 = 6;
    pub const SMART_APP_CONTROL: u8 = 7;
    pub const DAEMON_NOT_STARTABLE: u8 = 8;
    pub const CONTRACT_MISMATCH: u8 = 9;
}

/// A failure of `ev3`.
#[derive(Debug, Clone)]
pub enum CliError {
    /// The command line is wrong.
    Usage(String),
    /// The daemon, or this side of the contract, refused or failed: `code` is the contract code,
    /// `data` the error data with any extras (`holder`, `candidates`, `command`).
    Contract {
        code: String,
        message: String,
        data: Value,
    },
    /// The daemon could not be started or used.
    Start { failure: Failure, message: String },
    /// Anything else.
    Other(String),
}

impl CliError {
    pub fn usage(message: impl Into<String>) -> Self {
        Self::Usage(message.into())
    }

    /// A contract error made on this side.
    pub fn contract(code: &str, message: impl Into<String>) -> Self {
        Self::Contract {
            code: code.to_owned(),
            message: message.into(),
            data: json!({ "code": code }),
        }
    }

    /// Refused until a person runs `command` in a terminal.
    pub fn needs_person(message: impl Into<String>, command: &str) -> Self {
        Self::Contract {
            code: "needs_person".into(),
            message: message.into(),
            data: json!({ "code": "needs_person", "command": command }),
        }
    }

    pub fn start(failure: Failure, message: impl Into<String>) -> Self {
        Self::Start {
            failure,
            message: message.into(),
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::contract(DAEMON_UNAVAILABLE, message)
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Usage(message) | Self::Other(message) => message,
            Self::Contract { message, .. } | Self::Start { message, .. } => message,
        }
    }

    /// The exit code a script reads.
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Usage(_) => exit::USAGE,
            Self::Start { failure, .. } => match failure {
                Failure::SmartAppControl => exit::SMART_APP_CONTROL,
                Failure::MissingBinary | Failure::ShaMismatch | Failure::NotPrivate => {
                    exit::DAEMON_NOT_STARTABLE
                }
                Failure::ContractMismatch => exit::CONTRACT_MISMATCH,
                _ => exit::DAEMON_UNAVAILABLE,
            },
            Self::Contract { code, .. } => match code.as_str() {
                "brick_busy" => exit::BRICK_BUSY,
                "needs_person" => exit::NEEDS_PERSON,
                DAEMON_UNAVAILABLE => exit::DAEMON_UNAVAILABLE,
                _ => exit::FAILURE,
            },
            Self::Other(_) => exit::FAILURE,
        }
    }

    /// The `error` object `--json` prints.
    pub fn json(&self) -> Value {
        match self {
            Self::Usage(message) => json!({ "code": "usage", "message": message }),
            Self::Other(message) => json!({ "code": "internal", "message": message }),
            Self::Start { failure, message } => json!({
                "code": DAEMON_UNAVAILABLE, "message": message, "failure": failure.as_str(),
            }),
            Self::Contract {
                code,
                message,
                data,
            } => {
                let mut object = data.as_object().cloned().unwrap_or_default();
                object.insert("code".into(), Value::String(code.clone()));
                object.insert("message".into(), Value::String(message.clone()));
                Value::Object(object)
            }
        }
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for CliError {}

/// A failure of the client library keeps its kind: a contract error, a start failure or another.
impl From<ev3_client::ClientError> for CliError {
    fn from(error: ev3_client::ClientError) -> Self {
        match error {
            ev3_client::ClientError::Contract {
                code,
                message,
                data,
            } => Self::Contract {
                code,
                message,
                data,
            },
            ev3_client::ClientError::Start { failure, message } => Self::Start { failure, message },
            ev3_client::ClientError::Other(message) => Self::Other(message),
        }
    }
}
pub type Result<T> = std::result::Result<T, CliError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_failure_has_the_documented_exit_code() {
        let start = |failure| CliError::start(failure, "x").exit_code();
        assert_eq!(start(Failure::SmartAppControl), 7);
        assert_eq!(start(Failure::MissingBinary), 8);
        assert_eq!(start(Failure::ShaMismatch), 8);
        assert_eq!(start(Failure::NotPrivate), 8);
        assert_eq!(start(Failure::ContractMismatch), 9);
        assert_eq!(start(Failure::LockHeld), 6);
        assert_eq!(start(Failure::NameHeld), 6);
        assert_eq!(start(Failure::Failed), 6);
        assert_eq!(CliError::usage("x").exit_code(), 2);
        assert_eq!(CliError::contract("brick_busy", "x").exit_code(), 3);
        assert_eq!(CliError::needs_person("x", "ev3 forget A").exit_code(), 5);
        assert_eq!(CliError::unavailable("x").exit_code(), 6);
        assert_eq!(CliError::contract("not_found", "x").exit_code(), 1);
    }

    #[test]
    fn the_json_error_carries_the_failure_and_the_extras() {
        assert_eq!(
            CliError::start(Failure::ShaMismatch, "m").json(),
            json!({ "code": "daemon_unavailable", "message": "m", "failure": "sha_mismatch" })
        );
        assert_eq!(
            CliError::needs_person("m", "ev3 forget A").json(),
            json!({ "code": "needs_person", "message": "m", "command": "ev3 forget A" })
        );
    }
}
