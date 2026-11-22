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
pub mod server;
pub mod settings;
pub mod state;
pub mod surface;

/// Exit codes of the binary.
pub mod exit_code {
    /// A clean exit: idle, asked to exit, the key changed, or a signal.
    pub const CLEAN: i32 = 0;
    /// Something failed that the daemon could not work around.
    pub const FAILED: i32 = 1;
    /// Another daemon holds this channel's lock.
    pub const LOCK_HELD: i32 = 2;
    /// The daemon refused to run: elevated or root, a pipe name someone else holds, a socket
    /// directory others can reach, or a channel and mode that must not run together.
    pub const REFUSED: i32 = 3;
    /// The command line was not understood.
    pub const USAGE: i32 = 64;
}

// Shared with the native clients, which must not link the transports.
pub use ev3_channel::{codec, fsutil, hex, paths, random_bytes, security};
