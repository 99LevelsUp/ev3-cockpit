//! Which transport a provider handles, and the key that names one channel to one brick.
//!
//! Defined here, the way the TypeScript core defines it, until the daemon maps it onto the
//! contract's own types.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, TransportError};

/// A channel kind. Serialized as the prefix it gives a brick key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Mock,
    Usb,
    Tcp,
    Bt,
}

impl Transport {
    pub const ALL: [Transport; 4] = [Self::Mock, Self::Usb, Self::Tcp, Self::Bt];

    /// The key prefix: `mock`, `usb`, `tcp`, `bt`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mock => "mock",
            Self::Usb => "usb",
            Self::Tcp => "tcp",
            Self::Bt => "bt",
        }
    }

    /// The transport named by a key prefix, if any.
    pub fn parse(prefix: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == prefix)
    }
}

impl fmt::Display for Transport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Separator between the transport prefix and the transport-local identifier.
const SEPARATOR: char = ':';

/// Stable identifier for a brick within one transport: `<transport>:<id>`. Never based on a
/// display name.
///
/// Always well formed: a known transport, a separator, and a non-empty identifier. Everything
/// after the *first* separator is the identifier, so a Bluetooth MAC keeps its colons.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct BrickKey(String);

impl BrickKey {
    /// Builds a key from a transport and a transport-local identifier.
    ///
    /// The identifier is trimmed and its case kept. Favorites and auto-connect are bound to the
    /// key, but only the transport knows whether its identifier is case-insensitive: hex serials
    /// and MACs are, and USB and Bluetooth upper-case theirs before calling; a mock id or a TCP
    /// host name is not, and folding those here would corrupt them.
    ///
    /// Refuses an empty or blank identifier: `usb:` identifies nothing.
    pub fn new(transport: Transport, id: &str) -> Result<Self, TransportError> {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            return Err(TransportError::new(
                ErrorCode::InvalidBrickKey,
                format!("Cannot build a brick key for {transport} from an empty identifier."),
            ));
        }
        Ok(Self(format!("{transport}{SEPARATOR}{trimmed}")))
    }

    /// Reads a key back from its string form, refusing one that names no known transport or
    /// has nothing after the separator.
    pub fn parse(key: &str) -> Result<Self, TransportError> {
        let invalid = || {
            TransportError::new(
                ErrorCode::InvalidBrickKey,
                format!("\"{key}\" is not a brick key."),
            )
        };
        let index = key.find(SEPARATOR).ok_or_else(invalid)?;
        if index == 0 || index == key.len() - 1 {
            return Err(invalid());
        }
        Transport::parse(&key[..index]).ok_or_else(invalid)?;
        Ok(Self(key.to_owned()))
    }

    /// The transport half.
    pub fn transport(&self) -> Transport {
        let index = self.0.find(SEPARATOR).unwrap_or(0);
        Transport::parse(&self.0[..index]).unwrap_or(Transport::Mock)
    }

    /// The identifier half, everything after the first separator.
    pub fn id(&self) -> &str {
        let index = self.0.find(SEPARATOR).unwrap_or(0);
        &self.0[index + 1..]
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The brick's hardware identity, if the identifier carries one: the twelve upper-case hex
    /// digits once `:` and `-` are dropped.
    ///
    /// The EV3 uses its Bluetooth address as its USB serial and announces the same digits in its
    /// TCP beacon, so `usb:001653F00C0C`, `bt:00:16:53:F0:0C:0C` and `tcp:001653f00c0c` are one
    /// brick. An identifier that is not exactly twelve hex digits has none, so a malformed address
    /// can never be shortened into another brick's identity.
    pub fn hardware_id(&self) -> Option<String> {
        let digits: String = self
            .id()
            .chars()
            .filter(|c| *c != ':' && *c != '-')
            .collect::<String>()
            .to_ascii_uppercase();
        (digits.len() == 12 && digits.chars().all(|c| c.is_ascii_hexdigit())).then_some(digits)
    }
}

impl fmt::Display for BrickKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for BrickKey {
    type Error = TransportError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<BrickKey> for String {
    fn from(key: BrickKey) -> Self {
        key.0
    }
}
