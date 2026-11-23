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
pub mod launch;

pub use client::{Client, ClientOptions};
pub use error::{ClientError, DAEMON_UNAVAILABLE, Failure, Result};
