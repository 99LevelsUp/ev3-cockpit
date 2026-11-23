//! The cockpit daemon's exit codes. A client that starts the daemon reads them to tell a daemon
//! that ran and ended from one that never started.

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

/// Every exit code the daemon documents; a process that exited with one of them ran.
pub const ALL: [i32; 5] = [CLEAN, FAILED, LOCK_HELD, REFUSED, USAGE];
