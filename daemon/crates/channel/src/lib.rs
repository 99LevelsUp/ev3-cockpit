//! What the cockpit daemon and its native clients share: the state root and a channel's files,
//! files only the user can open, the per-user key, the channel record and the JSON-RPC framing.
//!
//! `docs/channel.md` at the repository root is the written spec. Nothing here touches hardware, so
//! the `ev3` command links this crate without the transports.

pub mod codec;
pub mod fsutil;
pub mod key;
pub mod paths;
pub mod record;
pub mod security;

/// `bytes` as lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `N` bytes from the operating system's random source.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the operating system's random source works");
    bytes
}
