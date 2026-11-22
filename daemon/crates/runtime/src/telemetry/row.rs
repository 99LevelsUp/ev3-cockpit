//! A telemetry row: one value the cockpit can read, with its own cadence and its own switch.
//!
//! Rows exist because cadence cuts across commands: the firmware version cannot change while a
//! brick is connected and its name can, though one command reads both, so neither a command nor a
//! category is a unit anyone can attach a rate to.
//!
//! A row owns the bytecode that reads it and the parse of its own result, but not where that
//! result lands. Offsets belong to the assembler, because they are a property of the whole frame:
//! `opINPUT_READSI` rejects a 32-bit result on an unaligned offset, and a row cannot know what came
//! before it.

use std::fmt;
use std::sync::Arc;

use super::error::TelemetryError;

/// Where a row's value goes in the reply buffer, once the assembler has decided.
pub type RowSlot = usize;

/// How often a row is read.
///
/// Three lifetimes, not one interval: the static rows need "once", which no divider can say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifetime {
    /// Registered but not wanted. Nothing schedules it.
    Off,
    /// Included on every `divider`-th tick; divider 1 is every tick.
    Repeating { divider: u32 },
    /// Included on the next tick it can go on, the first after connect or after it was added,
    /// then retired.
    OneShot,
}

impl Lifetime {
    /// The divider of a repeating row; 0 for anything not on a repeating schedule.
    pub fn divider(self) -> u32 {
        match self {
            Self::Repeating { divider } => divider,
            Self::Off | Self::OneShot => 0,
        }
    }
}

/// Does a row with this lifetime come up on `tick`? A one-shot comes up on tick 0 only; the
/// scheduler retires it rather than asking twice, but answering here keeps the predicate total.
pub fn comes_up_on_tick(lifetime: Lifetime, tick: u64) -> bool {
    match lifetime {
        Lifetime::Off => false,
        Lifetime::OneShot => tick == 0,
        Lifetime::Repeating { divider } => divider > 0 && tick.is_multiple_of(u64::from(divider)),
    }
}

/// Refuses a repeating lifetime whose divider is not a whole number of ticks, 1 or more.
pub fn check_lifetime(id: &str, lifetime: Lifetime) -> Result<(), TelemetryError> {
    match lifetime {
        Lifetime::Repeating { divider: 0 } => Err(TelemetryError::InvalidRows(format!(
            "Row '{id}' repeats on divider 0; a divider is a whole number of ticks, 1 or more."
        ))),
        _ => Ok(()),
    }
}

/// The three tiers a row is offered in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tier {
    /// Read on every tick: sensor values, tacho, buttons.
    Sampled,
    /// Read every few ticks: battery, name, radios, occupancy.
    Event,
    /// Read once: the firmware version.
    Static,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sampled => "sampled",
            Self::Event => "event",
            Self::Static => "static",
        }
    }
}

/// What a row's result occupies in the global buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowResult {
    pub bytes: usize,
    /// The byte alignment the brick requires for this result: a property of the instruction, not
    /// of the buffer. `opINPUT_READSI` rejects an unaligned 32-bit result and answers an error
    /// carrying the previous command's payload; measured 3 of 3 on a brick.
    pub alignment: usize,
}

/// A value as a row read it.
#[derive(Debug, Clone, PartialEq)]
pub enum Reading {
    Number(f64),
    Text(String),
    Flag(bool),
    /// The reply did not reach the row's slot.
    Missing,
}

impl Reading {
    /// The number, when this is one; a NaN is a number.
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            _ => None,
        }
    }

    /// Whether two readings would look the same to a reader: NaN is the same as NaN.
    pub fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Number(a), Self::Number(b)) => a.to_bits() == b.to_bits() || a == b,
            _ => self == other,
        }
    }
}

/// What a row's parse found at its slot.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub value: Reading,
    /// For an occupancy row: the mode the device reports beside its type code.
    pub mode: Option<u8>,
}

impl Parsed {
    pub fn value(value: Reading) -> Self {
        Self { value, mode: None }
    }
}

/// A parsed value, with when the reply carrying it arrived.
#[derive(Debug, Clone, PartialEq)]
pub struct RowValue {
    pub row_id: String,
    pub value: Reading,
    pub unit: Option<String>,
    pub mode: Option<u8>,
    /// Milliseconds since the Unix epoch. Per row rather than per snapshot: rows in one snapshot
    /// come from different ticks.
    pub sampled_at: u64,
}

/// The bytecode that reads a row and the parse of its result.
pub trait RowCodec: Send + Sync {
    /// Bytecode reading the value into `slot`.
    fn emit(&self, slot: RowSlot) -> Result<Vec<u8>, TelemetryError>;
    /// The value at `slot` of a reply payload.
    fn parse(&self, payload: &[u8], slot: RowSlot) -> Parsed;
}

/// One readable value, and everything the scheduler and assembler need to handle it.
///
/// `id` is the contract: namespaced and stable across versions, because it is what a client names
/// in a subscription.
#[derive(Clone)]
pub struct TelemetryRow {
    pub id: String,
    pub tier: Tier,
    pub lifetime: Lifetime,
    pub result: RowResult,
    pub unit: Option<String>,
    /// The port this row reads. A value row comes up only while its port is known, and mode
    /// ownership is per port.
    pub port: Option<String>,
    /// The daisy-chain layer of the brick whose port this row reads: 1-3 below the master, `None`
    /// for the master's own ports.
    pub layer: Option<u8>,
    /// The sensor mode this row selects, where it selects one.
    pub mode: Option<u8>,
    /// The row that reports what is plugged into `port`. Never gated: gating it on the type it
    /// reads would be circular, and a port that once went empty could never be seen to refill.
    pub reports_occupancy: bool,
    /// The row whose number is how many bricks hang below this one in a daisy chain.
    pub reports_chain_depth: bool,
    pub codec: Arc<dyn RowCodec>,
}

impl TelemetryRow {
    pub fn emit(&self, slot: RowSlot) -> Result<Vec<u8>, TelemetryError> {
        self.codec.emit(slot)
    }

    pub fn parse(&self, payload: &[u8], slot: RowSlot, sampled_at: u64) -> RowValue {
        let Parsed { value, mode } = self.codec.parse(payload, slot);
        RowValue {
            row_id: self.id.clone(),
            value,
            unit: self.unit.clone(),
            mode,
            sampled_at,
        }
    }

    /// The same row on another schedule: what it reads is unchanged.
    pub fn with_lifetime(&self, lifetime: Lifetime) -> Self {
        Self {
            lifetime,
            ..self.clone()
        }
    }
}

impl fmt::Debug for TelemetryRow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TelemetryRow")
            .field("id", &self.id)
            .field("tier", &self.tier)
            .field("lifetime", &self.lifetime)
            .field("result", &self.result)
            .field("port", &self.port)
            .field("layer", &self.layer)
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}
