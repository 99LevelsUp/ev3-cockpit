//! `ev3-client`: a native client of the cockpit daemon, for `ev3`, `ev3 mcp` and add-ons such as
//! EVƎ C. It finds the user's daemon, or starts a verified copy of one, proves the user's key in the
//! hello, and speaks the contract (`ev3-contract`) over the channel (`ev3-channel`). It links no
//! transport: the daemon holds the bricks.
//!
//! - [`client::Client`]: one connection, its requests, notifications and the bricks as last heard.
//! - [`ensure`]: which daemon a client works with, started or replaced by the rules in
//!   `docs/channel.md`.
//! - [`launch`]: the verified copy of a daemon binary and its start.

pub mod client;
pub mod connect;
pub mod endpoint;
pub mod ensure;
pub mod error;
pub mod events;
pub mod launch;

pub use client::{Client, ClientOptions, Launch};
pub use ev3_channel::paths::Paths;
pub use events::{Events, ProgramStates};

/// The files of the user's channel, or of the test channel `channel` names, under the user's
/// state root: what a client passes as [`ClientOptions::paths`].
pub fn user_paths(channel: Option<&str>) -> Result<Paths> {
    let root = ev3_channel::paths::default_state_root()
        .map_err(|message| ClientError::start(Failure::Failed, message))?;
    Ok(Paths::new(&root, channel))
}
pub use error::{ClientError, DAEMON_UNAVAILABLE, Failure, Result};

/// The contract this client speaks, its types and method markers: take the contract from here,
/// so it never differs from the client's.
pub use ev3_contract as contract;
pub use ev3_contract::{CONTRACT_VERSION, Method, method};
