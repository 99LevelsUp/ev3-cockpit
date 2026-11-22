//! Who wants which telemetry rows of one brick, and how often.
//!
//! A claim names rows and the interval it wants them at. Each row is read as fast as its fastest
//! claim asks, clamped to the transport's floor, so one client asking 10 Hz over Bluetooth cannot
//! take the link from everyone else. The tick runs at the fastest interval any claim got; a row's
//! divider is the whole number of ticks that is not slower than its claim asked.
//!
//! A claim is told what each row was granted: its request clamped to the floor, a promise of at
//! least that often. The grant is fixed when the claim is made and is not negotiated again: when
//! the foreground leaves, throttling moves the tick or the route changes the floor, what a row
//! really runs at travels in the data.
//!
//! The foreground (a brick some client shows in its panel) is a claim on every row: sampled rows
//! at the transport's foreground cadence, event rows every fifth of those, static rows once. It
//! holds no sensor mode: it reads whatever mode a claim holds, the device's default otherwise, so a
//! client can always ask another mode of a brick in the foreground.
//!
//! A mode is a parameter of a claim. The first claim on a port holds its mode; a claim asking
//! another mode is refused, naming the holder. The same mode is shared, and the port is free again
//! when the last claim holding it is released.

use std::collections::{BTreeMap, HashMap};

use super::cadence::Cadence;
use super::error::TelemetryError;
use super::registry::RowRegistry;
use super::row::{Lifetime, TelemetryRow, Tier};

/// How often a row is read: every so many milliseconds, or once.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RowRate {
    Every(f64),
    Once,
}

/// What each row of a claim was granted, by row id.
pub type Grant = BTreeMap<String, RowRate>;

/// One claim as its maker asks it.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimRequest {
    pub row_ids: Vec<String>,
    /// How often the rows are wanted, in milliseconds.
    pub interval_ms: f64,
    /// The mode to read a sensor port in, by port: `{"1": 2}`.
    pub modes: BTreeMap<String, u64>,
}

/// The rows to read and the tick to read them on.
#[derive(Debug, Clone)]
pub struct TelemetryPlan {
    pub period_ms: f64,
    pub rows: Vec<TelemetryRow>,
}

/// The tick a brick's transport allows, with any override for probes already applied.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClaimCadence {
    /// The fastest tick the transport permits.
    pub floor_ms: f64,
    /// The foreground's tick on this transport.
    pub foreground_ms: f64,
}

impl From<Cadence> for ClaimCadence {
    fn from(cadence: Cadence) -> Self {
        Self {
            floor_ms: cadence.floor_ms as f64,
            foreground_ms: cadence.foreground_ms as f64,
        }
    }
}

struct Claim {
    owner: String,
    row_ids: Vec<String>,
    interval_ms: f64,
    modes: BTreeMap<String, u8>,
    grant: Grant,
}

/// Event rows go every fifth foreground tick, as LEGO's Device Manager divides its slow tier.
const FOREGROUND_EVENT_FACTOR: f64 = 5.0;
/// The firmware's modes are 0-7 (`opINPUT_READSI`, `c_input.c`).
const MAX_MODE: u64 = 7;

/// The claims on one brick.
pub struct TelemetryClaims {
    registry: RowRegistry,
    cadence: ClaimCadence,
    foreground: bool,
    /// In the order they were made: the earliest claim holding a port's mode is its holder.
    claims: Vec<(u64, Claim)>,
    next: u64,
}

impl TelemetryClaims {
    pub fn new(registry: RowRegistry, cadence: ClaimCadence) -> Self {
        Self {
            registry,
            cadence,
            foreground: false,
            claims: Vec::new(),
            next: 1,
        }
    }

    /// Whether a client shows the brick in the foreground, which claims every row.
    pub fn set_foreground(&mut self, foreground: bool) {
        self.foreground = foreground;
    }

    /// The transport changed: the floor and the foreground's cadence with it. Grants stay.
    pub fn set_cadence(&mut self, cadence: ClaimCadence) {
        self.cadence = cadence;
    }

    /// Whether anything but the foreground claims a row.
    pub fn has_claims(&self) -> bool {
        !self.claims.is_empty()
    }

    /// Adds a claim and returns its handle, or refuses and adds nothing.
    pub fn claim(&mut self, request: &ClaimRequest, owner: &str) -> Result<u64, TelemetryError> {
        if !(request.interval_ms.is_finite() && request.interval_ms > 0.0) {
            return Err(TelemetryError::InvalidClaim(format!(
                "A claim's interval must be a positive number of milliseconds, not {}.",
                request.interval_ms
            )));
        }
        if request.row_ids.is_empty() {
            return Err(TelemetryError::InvalidClaim(
                "A claim names at least one row.".into(),
            ));
        }
        for id in &request.row_ids {
            if self.registry.get(id).is_none() {
                return Err(TelemetryError::InvalidClaim(format!(
                    "There is no telemetry row '{id}'; list the rows for their ids."
                )));
            }
        }
        let mode_ports = self.registry.mode_ports();
        let mut modes = BTreeMap::new();
        for (port, &mode) in &request.modes {
            if !mode_ports.contains(port) {
                return Err(TelemetryError::InvalidClaim(format!(
                    "Port {port} has no mode to choose."
                )));
            }
            if mode > MAX_MODE {
                return Err(TelemetryError::InvalidClaim(format!(
                    "A mode is a whole number from 0 to {MAX_MODE}, not {mode}."
                )));
            }
            let mode = mode as u8;
            if let Some((held, holder)) = self.holder_of(port)
                && held != mode
            {
                return Err(TelemetryError::ModeConflict(format!(
                    "Port {port} is read in mode {held} for {holder}; release that claim first."
                )));
            }
            modes.insert(port.clone(), mode);
        }
        let grant = request
            .row_ids
            .iter()
            .map(|id| {
                let rate = if self
                    .registry
                    .get(id)
                    .is_some_and(|r| r.tier == Tier::Static)
                {
                    RowRate::Once
                } else {
                    RowRate::Every(request.interval_ms.max(self.cadence.floor_ms))
                };
                (id.clone(), rate)
            })
            .collect();
        let handle = self.next;
        self.next += 1;
        self.claims.push((
            handle,
            Claim {
                owner: owner.to_owned(),
                row_ids: request.row_ids.clone(),
                interval_ms: request.interval_ms,
                modes,
                grant,
            },
        ));
        Ok(handle)
    }

    /// Releases one claim; releasing it again does nothing.
    pub fn release(&mut self, handle: u64) {
        self.claims.retain(|(h, _)| *h != handle);
    }

    /// Ends every claim, as when the brick goes; returns the handles that ended.
    pub fn end_all(&mut self) -> Vec<u64> {
        self.claims.drain(..).map(|(handle, _)| handle).collect()
    }

    /// What each row of a claim was granted when it was made; `None` for a released claim.
    pub fn grant_of(&self, handle: u64) -> Option<&Grant> {
        self.claims
            .iter()
            .find(|(h, _)| *h == handle)
            .map(|(_, claim)| &claim.grant)
    }

    /// The rows to read, with their dividers and modes, and the tick to read them on.
    pub fn plan(&self) -> TelemetryPlan {
        let wanted = self.wanted_intervals();
        if wanted.is_empty() {
            return TelemetryPlan {
                period_ms: self.cadence.foreground_ms,
                rows: Vec::new(),
            };
        }
        // Every interval is clamped to the floor already, so the period is too.
        let period_ms = wanted
            .values()
            .filter_map(|rate| match rate {
                RowRate::Every(ms) => Some(*ms),
                RowRate::Once => None,
            })
            .reduce(f64::min)
            .unwrap_or(self.cadence.foreground_ms);
        let mut rows = Vec::new();
        // Registration order is truncation priority.
        for base in self.registry.all() {
            let Some(rate) = wanted.get(&base.id) else {
                continue;
            };
            let mode = base
                .port
                .as_deref()
                .and_then(|port| self.holder_of(port))
                .map(|(mode, _)| mode);
            let row = mode
                .and_then(|mode| self.registry.in_mode(&base.id, mode))
                .unwrap_or_else(|| base.clone());
            let lifetime = match rate {
                RowRate::Once => Lifetime::OneShot,
                RowRate::Every(ms) => Lifetime::Repeating {
                    divider: ((ms / period_ms).floor() as u32).max(1),
                },
            };
            rows.push(row.with_lifetime(lifetime));
        }
        TelemetryPlan { period_ms, rows }
    }

    /// The fastest interval asked of each row, `Once` for a static row.
    fn wanted_intervals(&self) -> HashMap<String, RowRate> {
        let mut wanted: HashMap<String, RowRate> = HashMap::new();
        let floor = self.cadence.floor_ms;
        let registry = &self.registry;
        let mut want = |id: &str, ms: f64| {
            let Some(row) = registry.get(id) else { return };
            if row.tier == Tier::Static {
                wanted.insert(id.to_owned(), RowRate::Once);
                return;
            }
            let asked = ms.max(floor);
            let rate = match wanted.get(id) {
                Some(RowRate::Every(before)) => before.min(asked),
                _ => asked,
            };
            wanted.insert(id.to_owned(), RowRate::Every(rate));
        };
        if self.foreground {
            for row in registry.all() {
                let ms = if row.tier == Tier::Sampled {
                    self.cadence.foreground_ms
                } else {
                    self.cadence.foreground_ms * FOREGROUND_EVENT_FACTOR
                };
                want(&row.id, ms);
            }
        }
        for (_, claim) in &self.claims {
            for id in &claim.row_ids {
                want(id, claim.interval_ms);
                // A chain member's row comes up only once the chain's depth reaches its layer,
                // and a member's value only once its port's occupancy has reported. A claim names
                // the row it wants, so the rows that open it are read beside it, at the event
                // cadence; the grant still names only what was asked.
                let Some(row) = registry.get(id) else {
                    continue;
                };
                if row.layer.is_none_or(|layer| layer == 0) {
                    continue;
                }
                for gate in registry.all() {
                    let opens = gate.reports_chain_depth
                        || (gate.reports_occupancy
                            && gate.port == row.port
                            && !row.reports_occupancy);
                    if opens {
                        want(&gate.id, claim.interval_ms * FOREGROUND_EVENT_FACTOR);
                    }
                }
            }
        }
        wanted
    }

    /// The mode a port is held in, and by whom: the earliest claim still holding it.
    fn holder_of(&self, port: &str) -> Option<(u8, &str)> {
        self.claims.iter().find_map(|(_, claim)| {
            claim
                .modes
                .get(port)
                .map(|&mode| (mode, claim.owner.as_str()))
        })
    }
}
