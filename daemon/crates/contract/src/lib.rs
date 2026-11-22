//! The daemon-client contract, generated from the schema in `contract/` at the repository root.
//!
//! The types come from `contract/schema/*.json`; the contract version, the method metadata, the
//! [`Methods`] dispatch trait, the [`Notification`] enum, the error families and the settings spec
//! come from `contract/methods.json`. The build script generates all of it, so nothing here is
//! mirrored by hand and nothing can go stale.

#[allow(
    clippy::all,
    clippy::pedantic,
    missing_docs,
    unused_imports,
    irrefutable_let_patterns
)]
mod types {
    include!(concat!(env!("OUT_DIR"), "/types.rs"));
}
pub use types::*;

mod generated {
    use super::*;
    include!(concat!(env!("OUT_DIR"), "/methods.rs"));
}
pub use generated::*;

pub mod hello;

use serde::Serialize;
use serde::de::DeserializeOwned;

/// What the method table says about one request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MethodInfo {
    /// The JSON-RPC method name.
    pub name: &'static str,
    /// Takes the brick's write lease for exactly its own length.
    pub leased: bool,
    /// Runs only after a person said yes, in every case or in some, as the method's doc says.
    pub needs_person: bool,
    /// Part of the stable core: readable by every client and daemon version.
    pub stable_core: bool,
    /// The client kinds that may send it.
    pub callable_by: &'static [ClientKind],
}

/// The request named `name`, if the contract has it.
pub fn method_info(name: &str) -> Option<&'static MethodInfo> {
    METHODS.iter().find(|info| info.name == name)
}

/// Every setting with its rules.
pub fn setting_specs() -> Vec<SettingSpec> {
    serde_json::from_str(SETTING_SPECS_JSON)
        .expect("the generated setting specs match the SettingSpec type")
}

/// An error as it crosses the wire: the JSON-RPC error's code is the family's number, its message
/// the text, and its data the [`ErrorData`].
#[derive(Clone, Debug)]
pub struct ContractError {
    /// What went wrong, ready to show.
    pub message: String,
    /// The code a client decides on, with its family and the extras some codes carry.
    pub data: ErrorData,
}

impl ContractError {
    /// An error with `code`, in the family the method table gives it.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        let family = code.family();
        Self {
            message: message.into(),
            data: ErrorData {
                code,
                family,
                holder: None,
                candidates: Vec::new(),
                command: None,
            },
        }
    }

    /// The JSON-RPC error code: the number of the error's family.
    pub fn number(&self) -> i64 {
        self.data.family.number()
    }
}

impl std::fmt::Display for ContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.data.code)
    }
}

impl std::error::Error for ContractError {}

/// A request's parameters as `T`; absent parameters read as an empty object.
fn decode<T: DeserializeOwned>(
    method: &str,
    params: serde_json::Value,
) -> Result<T, ContractError> {
    let params = match params {
        serde_json::Value::Null => serde_json::Value::Object(serde_json::Map::new()),
        other => other,
    };
    serde_json::from_value(params).map_err(|error| {
        ContractError::new(
            ErrorCode::InvalidRequest,
            format!("The parameters of {method} do not fit the contract: {error}."),
        )
    })
}

fn encode<T: Serialize>(result: T) -> Result<serde_json::Value, ContractError> {
    serde_json::to_value(result).map_err(|error| {
        ContractError::new(
            ErrorCode::Internal,
            format!("The result could not be encoded: {error}."),
        )
    })
}
