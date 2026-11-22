//! Bluetooth parts every platform shares: the connection queue every radio operation takes turns
//! in, background presence, and how a brick's address is read and written.

pub mod presence;
pub mod queue;

/// The first three bytes of every EV3's Bluetooth address: LEGO's organisationally unique
/// identifier.
pub const LEGO_OUI: &str = "001653";

/// The EV3's fixed pairing PIN. Every brick uses it and none can change it.
pub const PAIRING_PIN: &str = "1234";

/// The address's twelve hex digits, upper case, with every other character dropped. How two
/// spellings of one address are compared.
pub fn normalise_mac(mac: &str) -> String {
    mac.chars()
        .filter(char::is_ascii_hexdigit)
        .collect::<String>()
        .to_ascii_uppercase()
}

/// Whether an address carries LEGO's identifier, however it is spelled.
pub fn is_lego_mac(mac: &str) -> bool {
    mac.chars()
        .filter(|c| *c != ':' && *c != '-')
        .collect::<String>()
        .to_ascii_uppercase()
        .starts_with(LEGO_OUI)
}

/// Parses an address written as six hex bytes, separated all by colons, all by dashes, or not at
/// all, into the 64-bit form Windows and BlueZ store it in: `00:16:53:f0:0a:0a` becomes
/// `0x001653f00a0a`, the first written byte the most significant.
///
/// Anything else is refused rather than mined for twelve hex digits: a string that happens to
/// hold them is not an address.
pub fn parse_mac(mac: &str) -> Option<u64> {
    let bytes = mac.as_bytes();
    let separator = match bytes.len() {
        12 => None,
        17 => match bytes[2] {
            b':' | b'-' => Some(bytes[2]),
            _ => return None,
        },
        _ => return None,
    };
    let mut digits = Vec::with_capacity(12);
    for (index, byte) in bytes.iter().enumerate() {
        let is_separator_slot = separator.is_some() && index % 3 == 2;
        if is_separator_slot {
            if Some(*byte) != separator {
                return None;
            }
        } else if byte.is_ascii_hexdigit() {
            digits.push(*byte);
        } else {
            return None;
        }
    }
    let text = std::str::from_utf8(&digits).ok()?;
    u64::from_str_radix(text, 16).ok()
}

/// The address as the rest of the cockpit writes it: six upper-case hex bytes separated by
/// colons.
pub fn format_mac(address: u64) -> String {
    (0..6)
        .rev()
        .map(|byte| format!("{:02X}", (address >> (byte * 8)) & 0xff))
        .collect::<Vec<_>>()
        .join(":")
}

/// An address as a message shows it: the twelve digits without separators, as the brick's own
/// display shows them. Anything that is not twelve hex digits is shown as given.
pub fn describe_address(mac: &str) -> String {
    let digits: String = mac
        .chars()
        .filter(|c| *c != ':' && *c != '-')
        .collect::<String>()
        .to_ascii_uppercase();
    if digits.len() == 12 && digits.chars().all(|c| c.is_ascii_hexdigit()) {
        digits
    } else {
        mac.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mac_keeps_byte_order() {
        assert_eq!(parse_mac("00:16:53:f0:0a:0a"), Some(0x0016_53f0_0a0a));
    }

    #[test]
    fn parse_mac_accepts_colons_dashes_or_nothing() {
        for mac in ["00:16:53:f0:0a:0a", "00-16-53-F0-0A-0A", "001653f00a0a"] {
            assert_eq!(parse_mac(mac), Some(0x0016_53f0_0a0a), "{mac}");
        }
    }

    #[test]
    fn parse_mac_refuses_anything_else() {
        for mac in [
            "00:16:53",
            "",
            "xx:00:16:53:f0:0a:0a",
            "00:16:53-f0:0a:0a",
            "0016.53f0.0a0a",
            "0:16:53:f0:0a:0a0",
            "00:16:53:f0:0a:0g",
            " 00:16:53:f0:0a:0a",
            "00:16:53:f0:0a:0a:",
            "mac 001653f00a0a",
        ] {
            assert_eq!(parse_mac(mac), None, "{mac:?}");
        }
    }

    #[test]
    fn format_mac_writes_upper_case_with_colons() {
        assert_eq!(format_mac(0x0016_53f0_0a0a), "00:16:53:F0:0A:0A");
    }

    #[test]
    fn lego_addresses_are_recognised_however_spelled() {
        assert!(is_lego_mac("00:16:53:aa:bb:cc"));
        assert!(is_lego_mac("001653AABBCC"));
        assert!(!is_lego_mac("00:17:53:aa:bb:cc"));
    }

    #[test]
    fn an_address_is_described_by_its_digits() {
        assert_eq!(describe_address("00:16:53:aa:bb:cc"), "001653AABBCC");
        assert_eq!(describe_address("not-an-address"), "not-an-address");
    }
}
