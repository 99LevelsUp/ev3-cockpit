//! What can go wrong between a client and the daemon.

use serde_json::{Value, json};

/// Why a client could not start or use the daemon; every client tells them apart the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// No daemon to start: nothing carried, the file gone, no manifest.
    MissingBinary,
    /// The binary does not match the SHA-256 its manifest recorded.
    ShaMismatch,
    /// The folder of the verified copies is not the user's alone.
    NotPrivate,
    /// Windows Smart App Control blocked the unsigned binary.
    SmartAppControl,
    /// The daemon refused to run (exit code 3).
    NameHeld,
    /// Another daemon held the channel's lock and none became reachable.
    LockHeld,
    /// The running daemon speaks another contract and could not be replaced.
    ContractMismatch,
    /// Anything else.
    Failed,
}

impl Failure {
    /// The name the clients' JSON carries (`failure` beside `daemon_unavailable`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingBinary => "missing_binary",
            Self::ShaMismatch => "sha_mismatch",
            Self::NotPrivate => "not_private",
            Self::SmartAppControl => "smart_app_control",
            Self::NameHeld => "name_held",
            Self::LockHeld => "lock_held",
            Self::ContractMismatch => "contract_mismatch",
            Self::Failed => "failed",
        }
    }
}

/// The contract code of an unreachable daemon.
pub const DAEMON_UNAVAILABLE: &str = "daemon_unavailable";

/// A failure of a client of the daemon.
#[derive(Debug, Clone)]
pub enum ClientError {
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

impl ClientError {
    /// A contract error made on this side.
    pub fn contract(code: &str, message: impl Into<String>) -> Self {
        Self::Contract {
            code: code.to_owned(),
            message: message.into(),
            data: json!({ "code": code }),
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
            Self::Other(message) => message,
            Self::Contract { message, .. } | Self::Start { message, .. } => message,
        }
    }

    /// The error as the clients' JSON carries it: the contract's error data with `code` and
    /// `message`, and `failure` for a start failure.
    pub fn json(&self) -> Value {
        match self {
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

    /// The contract's error code, typed; `None` for a code this version of the contract does not
    /// know (it stays readable through [`ClientError::code`]) and for an error that is not one.
    pub fn error_code(&self) -> Option<ev3_contract::ErrorCode> {
        serde_json::from_value(Value::String(self.code()?.to_owned())).ok()
    }

    /// The contract's error data, typed (`holder`, `candidates`, `command` where the daemon sent
    /// them); `None` for an error that is not a contract error.
    pub fn error_data(&self) -> Option<ev3_contract::ErrorData> {
        match self {
            Self::Contract { data, .. } => serde_json::from_value(data.clone()).ok(),
            Self::Start { .. } => serde_json::from_value(self.json()).ok(),
            Self::Other(_) => None,
        }
    }

    /// Why the daemon could not be started or used, for a start failure.
    pub fn failure(&self) -> Option<Failure> {
        match self {
            Self::Start { failure, .. } => Some(*failure),
            _ => None,
        }
    }

    /// The contract code, where there is one; a start failure is `daemon_unavailable`.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Contract { code, .. } => Some(code),
            Self::Start { .. } => Some(DAEMON_UNAVAILABLE),
            Self::Other(_) => None,
        }
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ClientError {}

pub type Result<T> = std::result::Result<T, ClientError>;
