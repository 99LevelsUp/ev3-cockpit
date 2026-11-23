//! `ev3-cockpitd`, the per-user cockpit daemon: the channel clients find it on, the key both sides
//! prove they hold, the single-instance lock, the JSON-RPC codec and dispatcher, settings, log and
//! the confinement every local file path goes through.
//!
//! `docs/channel.md` at the repository root is the written spec of the channel; the TypeScript
//! client follows the same document.

pub mod access;
pub mod build_info;
pub mod channel;
pub mod cli;
pub mod confine;
pub mod holders;
pub mod key;
pub mod leases;
pub mod lifecycle;
pub mod lock;
pub mod log;
pub mod methods;
pub mod migrate;
pub mod questions;
pub mod resolver;
pub mod rpc;
pub mod runs;
pub mod server;
pub mod settings;
pub mod state;
pub mod surface;

// Shared with the native clients, which must not link the transports.
pub use ev3_channel::daemon_exit as exit_code;
pub use ev3_channel::{codec, fsutil, hex, paths, random_bytes, security};
