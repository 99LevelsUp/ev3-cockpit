//! Replaces identifiers with the repository's placeholders as a session is recorded.
//!
//! Recordings are committed to a public repository, so nothing in one may identify a brick, a
//! computer, a user or a network. Every identifier the scrubber knows is replaced wherever it
//! appears, in every spelling, by one placeholder of the same length:
//!
//! - hardware addresses (a brick's Bluetooth address, which is also its USB serial and its TCP
//!   beacon serial; this computer's adapter address) become `00:16:53:F0:0A:0A`,
//!   `00:16:53:F0:0B:0B`, ... in whatever separators and case the original used;
//! - this computer's name becomes `HOSTA`, `HOSTB`, ..., a user name `USERA`, ..., cut or
//!   padded to the original's length;
//! - LAN addresses become addresses from the documentation ranges `192.0.2.x` and
//!   `198.51.100.x`.
//!
//! Lengths are kept so that a packet's length prefix still describes its bytes. Where no
//! placeholder of the same length exists (an IPv4 address of seven or eight characters), the
//! replacement is made in text, where length carries nothing, and refused in link bytes: the
//! recorder then fails rather than writing either the real value or a broken packet.

use std::fmt;

use crate::brick_key::BrickKey;

/// The scrubber could not replace an identifier without changing a length it must keep, or ran
/// out of placeholders. The value is never written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrubError {
    pub message: String,
}

impl fmt::Display for ScrubError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ScrubError {}

fn scrub_error(message: impl Into<String>) -> ScrubError {
    ScrubError {
        message: message.into(),
    }
}

/// Where a direct command's bytecode starts in a packet: length, message counter, type and the
/// global-variable size come first.
const DIRECT_OPS_OFFSET: usize = 7;

/// Where a direct reply's global variables start: length, message counter and type.
const DIRECT_GLOBALS_OFFSET: usize = 5;

/// The peer names in an exchange: the name slot of a `FAVOUR_ITEM` reply, the string an
/// `opCOM_REMOVE` request carries. Each up to its terminator, as raw bytes.
fn peer_names<'a>(request: &'a [u8], reply: &'a [u8]) -> Vec<&'a [u8]> {
    use ev3_protocol::commands::bt_peer_layout::NAME_BYTES;
    use ev3_protocol::packet::{com_get_sub, opcode};
    let Some(ops) = request.get(DIRECT_OPS_OFFSET..) else {
        return Vec::new();
    };
    let until_nul = |bytes: &'a [u8]| {
        let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        &bytes[..end]
    };
    let mut names = Vec::new();
    // Only a successful direct reply carries the name; an error reply's globals are not set.
    if ops.starts_with(&[opcode::COM_GET, com_get_sub::FAVOUR_ITEM])
        && reply.get(DIRECT_GLOBALS_OFFSET - 1) == Some(&ev3_protocol::packet::reply::DIRECT_REPLY)
        && let Some(globals) = reply.get(DIRECT_GLOBALS_OFFSET..)
    {
        names.push(until_nul(&globals[..globals.len().min(NAME_BYTES)]));
    }
    // opCOM_REMOVE, the radio as one short constant, then the name as a terminated string.
    if ops.first() == Some(&opcode::COM_REMOVE)
        && let Some(start) = ops.iter().position(|&b| b == LCS_PREFIX)
    {
        names.push(until_nul(&ops[start + 1..]));
    }
    names.retain(|name| !name.is_empty());
    names
}

/// The prefix byte of a terminated string constant in bytecode.
const LCS_PREFIX: u8 = 0x84;

/// Whether a name is exactly one of the repository's placeholders: a brick's (`AAA`, `BBB`, ...)
/// or a host's or user's as the scrubber writes them (`HOSTA`, `HOSTBBBB`, `USERC`, ...: the
/// prefix, then one letter repeated). Anything else that merely starts like one (`HOSTALICE`)
/// is a real name.
fn is_placeholder_name(name: &str) -> bool {
    let one_letter_repeated =
        |s: &[u8]| !s.is_empty() && s[0].is_ascii_uppercase() && s.iter().all(|&b| b == s[0]);
    let brick = name.len() == 3 && one_letter_repeated(name.as_bytes());
    let host_or_user = ["HOST", "USER"].iter().any(|prefix| {
        name.strip_prefix(prefix)
            .is_some_and(|rest| one_letter_repeated(rest.as_bytes()))
    });
    brick || host_or_user
}

/// Address separators a spelling may use: colons, dashes (Windows), underscores (BlueZ object
/// paths), or none (a USB serial, a registry key).
const SEPARATORS: [&str; 4] = [":", "-", "_", ""];

/// Placeholder addresses run `00:16:53:F0:0A:0A`, `00:16:53:F0:0B:0B`, ...: the last two bytes
/// count up from 0x0A together.
const FIRST_PLACEHOLDER_BYTE: u8 = 0x0a;

/// Identifiers seen so far and the placeholder each one gets. Consistent within one recording:
/// the same identifier always becomes the same placeholder.
#[derive(Debug, Clone, Default)]
pub struct Scrubber {
    /// Twelve upper-case hex digits, real and placeholder.
    addresses: Vec<(String, String)>,
    /// Host and user names, real and placeholder.
    names: Vec<(String, String)>,
    hosts: usize,
    users: usize,
    /// Dotted IPv4 addresses, real and placeholder.
    ips: Vec<(String, String)>,
}

impl Scrubber {
    pub fn new() -> Self {
        Self::default()
    }

    /// A hardware address in any spelling: with colons, dashes or underscores, or bare.
    pub fn register_address(&mut self, address: &str) -> Result<(), ScrubError> {
        let digits: String = address
            .chars()
            .filter(|c| !matches!(c, ':' | '-' | '_'))
            .collect::<String>()
            .to_ascii_uppercase();
        if digits.len() != 12 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(scrub_error(
                "A hardware address must be twelve hex digits; this one is not registered.",
            ));
        }
        self.add_address(digits)
    }

    /// This computer's name, as the operating system and its Bluetooth radio report it.
    pub fn register_host_name(&mut self, name: &str) -> Result<(), ScrubError> {
        self.add_name(name, "HOST", true)
    }

    /// The user's account name, which appears in paths under the home directory.
    pub fn register_user_name(&mut self, name: &str) -> Result<(), ScrubError> {
        self.add_name(name, "USER", false)
    }

    /// A LAN address in dotted IPv4 form.
    pub fn register_ip(&mut self, ip: &str) -> Result<(), ScrubError> {
        match parse_ipv4(ip.as_bytes()) {
            Some((octets, len)) if len == ip.len() => self.add_ip(ip, octets),
            _ => Err(scrub_error(
                "Not a dotted IPv4 address; it is not registered.",
            )),
        }
    }

    /// Learns the identifiers a piece of text carries: the hardware identity of a brick key, and
    /// every separated hardware address and IPv4 address in it.
    pub fn learn_from_text(&mut self, text: &str) -> Result<(), ScrubError> {
        if let Some(digits) = BrickKey::parse(text).ok().and_then(|k| k.hardware_id()) {
            self.add_address(digits)?;
        }
        self.learn_from_bytes(text.as_bytes())
    }

    /// Learns the separated hardware addresses and IPv4 addresses in link bytes.
    pub fn learn_from_bytes(&mut self, bytes: &[u8]) -> Result<(), ScrubError> {
        for digits in separated_addresses(bytes) {
            self.add_address(digits)?;
        }
        for (text, octets) in ipv4_addresses(bytes) {
            self.add_ip(&text, octets)?;
        }
        Ok(())
    }

    /// Learns the names of other computers and phones an exchange carries: the peer name a
    /// `FAVOUR_ITEM` reply reports from the brick's Bluetooth list, and the one an `opCOM_REMOVE`
    /// request names. Each is registered like this computer's name; a repository placeholder
    /// (`AAA`, `HOSTA`, ...) is left as it is. A name that is not UTF-8 is refused, since its
    /// bytes could not be matched to replace it.
    pub fn learn_from_exchange(&mut self, request: &[u8], reply: &[u8]) -> Result<(), ScrubError> {
        for name in peer_names(request, reply) {
            let name = std::str::from_utf8(name).map_err(|_| {
                scrub_error(
                    "A Bluetooth peer name in the exchange is not UTF-8, so it cannot be \
                     replaced; the exchange is not recorded.",
                )
            })?;
            if !is_placeholder_name(name.trim()) {
                self.register_host_name(name)?;
            }
        }
        Ok(())
    }

    /// Text with every known identifier replaced.
    pub fn scrub_text(&self, text: &str) -> String {
        let (bytes, _) = replace_all(text.as_bytes(), &self.patterns());
        // Patterns and placeholders are whole UTF-8 strings, and UTF-8 never matches a whole
        // string from the middle of a character, so the result is still UTF-8.
        String::from_utf8(bytes).unwrap_or_default()
    }

    /// Link bytes with every known identifier replaced, or a refusal when a replacement would
    /// change their length.
    pub fn scrub_bytes(&self, bytes: &[u8]) -> Result<Vec<u8>, ScrubError> {
        let (out, length_changed) = replace_all(bytes, &self.patterns());
        if length_changed {
            return Err(scrub_error(
                "An identifier in the link bytes has no placeholder of the same length; the \
                 exchange is not recorded.",
            ));
        }
        Ok(out)
    }

    fn add_address(&mut self, digits: String) -> Result<(), ScrubError> {
        // Only a placeholder this recording handed out is skipped. An address merely shaped like
        // one is replaced too: every brick shares the vendor prefix, so a real one can carry it.
        if self
            .addresses
            .iter()
            .any(|(real, placeholder)| *real == digits || *placeholder == digits)
        {
            return Ok(());
        }
        let mut byte = FIRST_PLACEHOLDER_BYTE.checked_add(
            u8::try_from(self.addresses.len()).map_err(|_| scrub_error("Too many addresses."))?,
        );
        loop {
            let b = byte.ok_or_else(|| scrub_error("Ran out of placeholder addresses."))?;
            let candidate = format!("001653F0{b:02X}{b:02X}");
            let taken = self
                .addresses
                .iter()
                .any(|(real, placeholder)| *real == candidate || *placeholder == candidate);
            if !taken && candidate != digits {
                self.addresses.push((digits, candidate));
                return Ok(());
            }
            byte = b.checked_add(1);
        }
    }

    fn add_name(&mut self, name: &str, prefix: &str, host: bool) -> Result<(), ScrubError> {
        let name = name.trim();
        if name.is_empty() || self.names.iter().any(|(real, _)| real == name) {
            return Ok(());
        }
        if name.len() < 2 {
            return Err(scrub_error(
                "A name of one character cannot be replaced without replacing that character \
                 everywhere.",
            ));
        }
        let index = if host { self.hosts } else { self.users };
        let letter = char::from(
            b'A' + u8::try_from(index)
                .ok()
                .filter(|i| *i < 26)
                .ok_or_else(|| scrub_error("Ran out of placeholder names."))?,
        );
        let len = name.len();
        let placeholder = if len > prefix.len() {
            let mut p = format!("{prefix}{letter}");
            p.extend(std::iter::repeat_n(letter, len - prefix.len() - 1));
            p
        } else {
            format!("{}{letter}", &prefix[..len - 1])
        };
        if host {
            self.hosts += 1;
        } else {
            self.users += 1;
        }
        self.names.push((name.to_owned(), placeholder));
        Ok(())
    }

    fn add_ip(&mut self, text: &str, octets: [u8; 4]) -> Result<(), ScrubError> {
        if is_documentation_ip(octets) || self.ips.iter().any(|(real, _)| real == text) {
            return Ok(());
        }
        let placeholder = self
            .ip_placeholder(text.len())
            .ok_or_else(|| scrub_error("Ran out of placeholder IP addresses."))?;
        self.ips.push((text.to_owned(), placeholder));
        Ok(())
    }

    /// A documentation-range address of `len` characters, or of the nearest length there is.
    fn ip_placeholder(&self, len: usize) -> Option<String> {
        let (template, digits): (&str, usize) = match len {
            9..=11 => ("192.0.2.", len - 8),
            12..=14 => ("198.51.100.", len - 11),
            15 => ("198.051.100.", 3),
            0..=8 => ("192.0.2.", 1),
            _ => return None,
        };
        let range = match digits {
            1 => 1..=9,
            2 => 10..=99,
            _ => 100..=254,
        };
        range
            .map(|n: u16| format!("{template}{n}"))
            .find(|candidate| !self.ips.iter().any(|(_, p)| p == candidate))
    }

    /// Every spelling of every identifier and its replacement, longest first.
    fn patterns(&self) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut patterns: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        let mut push = |from: String, to: String| {
            if !patterns.iter().any(|(f, _)| *f == from.as_bytes()) {
                patterns.push((from.into_bytes(), to.into_bytes()));
            }
        };
        for (real, placeholder) in &self.addresses {
            for separator in SEPARATORS {
                let from = spell_address(real, separator);
                let to = spell_address(placeholder, separator);
                // Upper case first: an address of digits only has one spelling for both, and
                // the placeholder's letters are upper case then.
                push(from.to_ascii_uppercase(), to.to_ascii_uppercase());
                push(from.to_ascii_lowercase(), to.to_ascii_lowercase());
            }
        }
        for (real, placeholder) in &self.names {
            push(real.clone(), placeholder.clone());
            push(real.to_ascii_uppercase(), placeholder.to_ascii_uppercase());
            push(real.to_ascii_lowercase(), placeholder.to_ascii_lowercase());
        }
        for (real, placeholder) in &self.ips {
            push(real.clone(), placeholder.clone());
        }
        patterns.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
        patterns
    }
}

/// Twelve digits spelled in pairs joined by `separator`.
fn spell_address(digits: &str, separator: &str) -> String {
    digits
        .as_bytes()
        .chunks(2)
        .map(|pair| String::from_utf8_lossy(pair).into_owned())
        .collect::<Vec<_>>()
        .join(separator)
}

/// One left-to-right pass, longest pattern first at each position, so a replacement is never
/// replaced again. Also says whether any replacement changed the length.
fn replace_all(input: &[u8], patterns: &[(Vec<u8>, Vec<u8>)]) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(input.len());
    let mut length_changed = false;
    let mut i = 0;
    while i < input.len() {
        let rest = &input[i..];
        match patterns
            .iter()
            .find(|(from, _)| !from.is_empty() && rest.starts_with(from))
        {
            Some((from, to)) => {
                length_changed |= from.len() != to.len();
                out.extend_from_slice(to);
                i += from.len();
            }
            None => {
                out.push(input[i]);
                i += 1;
            }
        }
    }
    (out, length_changed)
}

/// The digits of every `xx:xx:xx:xx:xx:xx` in the bytes, with colons, dashes or underscores as
/// separators.
fn separated_addresses(bytes: &[u8]) -> Vec<String> {
    let mut found = Vec::new();
    if bytes.len() < 17 {
        return found;
    }
    for window in bytes.windows(17) {
        let separator = window[2];
        if !matches!(separator, b':' | b'-' | b'_') {
            continue;
        }
        let shaped = window.iter().enumerate().all(|(i, b)| {
            if i % 3 == 2 {
                *b == separator
            } else {
                b.is_ascii_hexdigit()
            }
        });
        if shaped {
            let digits: String = window
                .iter()
                .enumerate()
                .filter(|(i, _)| i % 3 != 2)
                .map(|(_, b)| char::from(b.to_ascii_uppercase()))
                .collect();
            found.push(digits);
        }
    }
    found
}

/// Every dotted IPv4 address standing on its own in the bytes.
fn ipv4_addresses(bytes: &[u8]) -> Vec<(String, [u8; 4])> {
    let mut found = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let starts = bytes[i].is_ascii_digit()
            && (i == 0 || !(bytes[i - 1].is_ascii_digit() || bytes[i - 1] == b'.'));
        if starts && let Some((octets, len)) = parse_ipv4(&bytes[i..]) {
            let after = bytes.get(i + len).copied();
            let after_next = bytes.get(i + len + 1).copied();
            let ends = !matches!(after, Some(b) if b.is_ascii_digit())
                && !(after == Some(b'.') && matches!(after_next, Some(b) if b.is_ascii_digit()));
            if ends {
                let text = String::from_utf8_lossy(&bytes[i..i + len]).into_owned();
                found.push((text, octets));
                i += len;
                continue;
            }
        }
        i += 1;
    }
    found
}

/// A dotted quad at the start of `bytes`: its octets and how many bytes it spans.
fn parse_ipv4(bytes: &[u8]) -> Option<([u8; 4], usize)> {
    let mut octets = [0u8; 4];
    let mut pos = 0;
    for (index, octet) in octets.iter_mut().enumerate() {
        if index > 0 {
            if bytes.get(pos) != Some(&b'.') {
                return None;
            }
            pos += 1;
        }
        let start = pos;
        while pos < bytes.len() && bytes[pos].is_ascii_digit() && pos - start < 3 {
            pos += 1;
        }
        if pos == start {
            return None;
        }
        let value: u16 = std::str::from_utf8(&bytes[start..pos]).ok()?.parse().ok()?;
        *octet = u8::try_from(value).ok()?;
    }
    Some((octets, pos))
}

/// The documentation ranges, `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`: already
/// placeholders, never someone's network.
fn is_documentation_ip(octets: [u8; 4]) -> bool {
    matches!(
        octets,
        [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _]
    )
}
