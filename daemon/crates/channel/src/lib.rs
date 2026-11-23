//! What the cockpit daemon and its native clients share: the state root and a channel's files,
//! files only the user can open, the per-user key, the channel record and the JSON-RPC framing.
//!
//! `docs/channel.md` at the repository root is the written spec. Nothing here touches hardware, so
//! the `ev3` command links this crate without the transports.

pub mod codec;
pub mod daemon_exit;
pub mod fsutil;
pub mod key;
pub mod paths;
pub mod record;
pub mod security;
pub mod version;

/// `bytes` as lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The date `days` after 1970-01-01 in the proleptic Gregorian calendar, as (year, month, day)
/// (Howard Hinnant's civil-from-days). The daemon's log and `ev3`'s times both read it.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `N` bytes from the operating system's random source.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the operating system's random source works");
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_since_the_epoch_read_as_calendar_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(20_780), (2026, 11, 23));
    }
}
