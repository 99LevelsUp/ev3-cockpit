//! The runtime's failures as contract errors: the code a client decides on, and the runtime's own
//! message.

use ev3_contract::{ContractError, ErrorCode};
use ev3_runtime::{
    BrickError, FsError, ProgramError, Refused, SessionError, ShellError, TelemetryError,
};
use ev3_transports::TransportError;

fn error(code: ErrorCode, message: impl Into<String>) -> ContractError {
    ContractError::new(code, message)
}

pub fn from_transport(e: &TransportError) -> ContractError {
    use ev3_transports::ErrorCode as T;
    let code = match e.code {
        T::TransportFailed => ErrorCode::TransportFailed,
        T::Timeout => ErrorCode::Timeout,
        T::InvalidBrickKey => ErrorCode::InvalidBrickKey,
        T::ReplayUnmatched | T::ReplayDeviation => ErrorCode::ReplayUnmatched,
    };
    error(code, e.message.clone())
}

pub fn from_session(e: &SessionError) -> ContractError {
    let code = match e {
        SessionError::NotConnected { .. } | SessionError::Disconnected { .. } => {
            ErrorCode::NotConnected
        }
        SessionError::AlreadyConnected { .. } => ErrorCode::AlreadyConnected,
        SessionError::NoProvider { .. } => ErrorCode::NoProvider,
        SessionError::ConnectionAbandoned { .. } => ErrorCode::ConnectionAbandoned,
        SessionError::LinkLost { .. } => ErrorCode::LinkLost,
        SessionError::Degraded { .. } => ErrorCode::SessionFailed,
        SessionError::Transport(t) => return from_transport(t),
        SessionError::Protocol(_) => ErrorCode::ProtocolFailed,
    };
    error(code, e.to_string())
}

pub fn from_brick(e: &BrickError) -> ContractError {
    let code = match e {
        BrickError::NotAvailable { .. } => ErrorCode::ConnectionFailed,
        BrickError::NotSignedIn { .. } | BrickError::NoRoute { .. } | BrickError::Held { .. } => {
            ErrorCode::NotConnected
        }
        BrickError::ConnectionAbandoned { .. } => ErrorCode::ConnectionAbandoned,
        BrickError::ChannelChanged { .. } => ErrorCode::ChannelChanged,
        BrickError::Session(s) => return from_session(s),
    };
    error(code, e.to_string())
}

pub fn from_fs(e: &FsError) -> ContractError {
    let code = match e {
        FsError::PathTooLong { .. } | FsError::PathHasControlCharacter => ErrorCode::InvalidRequest,
        FsError::Command(b) => {
            let mut mapped = from_brick(b);
            mapped.message = e.to_string();
            return mapped;
        }
        FsError::Protocol(_) | FsError::NotCreated { .. } | FsError::NotEmpty { .. } => {
            ErrorCode::ProtocolFailed
        }
        FsError::MoveIncomplete { .. } => ErrorCode::TransportFailed,
        FsError::Stalled { .. } => ErrorCode::Timeout,
        FsError::Cancelled => ErrorCode::Cancelled,
        FsError::TooLarge { .. } => ErrorCode::InvalidRequest,
    };
    error(code, e.to_string())
}

pub fn from_program(e: &ProgramError) -> ContractError {
    if let Some(code) = e.code() {
        return error(code, e.to_string());
    }
    let mut mapped = match e {
        ProgramError::Files(f) => from_fs(f),
        ProgramError::Command(b) => from_brick(b),
        _ => error(ErrorCode::Internal, e.to_string()),
    };
    mapped.message = e.to_string();
    mapped
}

pub fn from_shell(e: &ShellError) -> ContractError {
    if let Some(code) = e.code() {
        return error(code, e.to_string());
    }
    match e {
        ShellError::Command(b) => from_brick(b),
        ShellError::Protocol(m) => error(ErrorCode::ProtocolFailed, m.clone()),
    }
}

pub fn from_telemetry(e: &TelemetryError) -> ContractError {
    error(e.code(), e.to_string())
}

/// A destructive operation that did not run: `command` is what a person runs instead.
pub fn from_refused(e: &Refused, command: &str, what: &str) -> ContractError {
    match e {
        Refused::Declined => error(
            ErrorCode::Cancelled,
            format!("{what}: the person said no. Nothing was changed."),
        ),
        Refused::Unanswered => needs_person(what, command),
        Refused::Busy { .. } => {
            let mut busy = error(ErrorCode::BrickBusy, e.to_string());
            busy.data.holder = Some("a forget or a clear of its Bluetooth list".into());
            busy
        }
    }
}

/// The refusal of an operation that needs a person's yes and did not get one.
pub fn needs_person(what: &str, command: &str) -> ContractError {
    let mut refused = error(
        ErrorCode::NeedsPerson,
        format!(
            "{what} needs a person's yes, and none came: run {command} in a terminal, or use \
             VS Code."
        ),
    );
    refused.data.command = Some(command.to_owned());
    refused
}
