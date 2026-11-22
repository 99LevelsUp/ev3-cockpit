//! What a port is doing, from the type code its occupancy row reports. Codes from `bytecodes.h` of
//! firmware 1.09d.
//!
//! A port's value is read only when it is `Known`. Not because reading otherwise blocks:
//! `opINPUT_READSI`, which the value rows use, never changes the dispatch status (`c_input.c`
//! `cInputReadSi`) and answers NaN for a port that is empty, faulty or still busy. There is simply
//! nothing to learn from the read, and its bytes are scarce on the 64-byte HID link.

const TYPE_TERMINAL: u8 = 124;
const TYPE_UNKNOWN: u8 = 125;
const TYPE_NONE: u8 = 126;
const TYPE_ERROR: u8 = 127;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PortState {
    /// No occupancy row has reported on the port yet. Read as if known: a cold start does not
    /// wait.
    Unreported,
    /// `TYPE_NONE` 126: nothing attached.
    Empty,
    /// `TYPE_UNKNOWN` 125: attached, being identified, a second or two after every plug-in.
    Identifying,
    /// A device type: the value is read.
    Known,
    /// `TYPE_ERROR` 127: attached, type invalid.
    Error,
    /// `TYPE_TERMINAL` 124: a console, not a peripheral.
    Terminal,
    /// Any other code at or above 124: shown as such, never guessed at.
    NotReadable,
}

impl PortState {
    /// The name a client reads.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unreported => "unreported",
            Self::Empty => "empty",
            Self::Identifying => "identifying",
            Self::Known => "known",
            Self::Error => "error",
            Self::Terminal => "terminal",
            Self::NotReadable => "not-readable",
        }
    }
}

/// The state of a port that last reported `code`; `None` when nothing has reported.
pub fn port_state_of(code: Option<u8>) -> PortState {
    match code {
        None => PortState::Unreported,
        Some(code) if code < TYPE_TERMINAL => PortState::Known,
        Some(TYPE_TERMINAL) => PortState::Terminal,
        Some(TYPE_UNKNOWN) => PortState::Identifying,
        Some(TYPE_NONE) => PortState::Empty,
        Some(TYPE_ERROR) => PortState::Error,
        Some(_) => PortState::NotReadable,
    }
}

/// Is a port type code one whose value is read? Only a known device's.
pub fn is_readable_type(code: u8) -> bool {
    port_state_of(Some(code)) == PortState::Known
}
