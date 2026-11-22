//! The rows a brick offers.
//!
//! Registering a row validates it and refuses what will not fit, rather than documenting the
//! limits: whoever adds a row learns at registration that it cannot be placed, not from a corrupt
//! frame at runtime. The bound is the tightest link a brick can be on, the 64-byte HID fallback:
//! 59 bytes of declared globals and 57 of bytecode. A row that fits there fits everywhere.
//!
//! Mode conflicts are not a registration matter: two rows reading two modes of one sensor are
//! alternatives a client chooses between, and the assembler keeps them out of one frame.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use ev3_contract::TelemetryRowInfo;
use ev3_transports::usb::HID_PACKET_BYTES;

use super::assembler::{FrameLimits, bytecode_budget_for, validate_row};
use super::error::TelemetryError;
use super::ev3_rows::{
    CHAIN_LAYERS, PortKind, SAMPLED_DIVIDER, SENSOR_PORT_NAMES, all_ev3_rows, port_row_id,
    sensor_value_row,
};
use super::row::{Lifetime, TelemetryRow};

/// The tightest link: every row is validated against it.
const HID_LIMITS: FrameLimits = FrameLimits {
    max_packet_bytes: HID_PACKET_BYTES,
};

/// The first slot whose global reference takes two bytes: where a row's bytecode is widest.
const WIDEST_SLOT: usize = 32;

/// A row in another mode, under the same id.
pub type ModeVariant = Arc<dyn Fn(u8) -> TelemetryRow + Send + Sync>;

/// Dot-separated segments of ASCII letters and digits, the first starting with a lowercase letter:
/// `ports.sensor.1.value`.
fn is_row_id(id: &str) -> bool {
    let mut segments = id.split('.');
    let Some(first) = segments.next() else {
        return false;
    };
    let alnum = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric());
    let rest: Vec<&str> = segments.collect();
    first.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && alnum(first)
        && !rest.is_empty()
        && rest.iter().all(|s| alnum(s))
}

#[derive(Default, Clone)]
pub struct RowRegistry {
    rows: Vec<TelemetryRow>,
    index: HashMap<String, usize>,
    variants: HashMap<String, ModeVariant>,
}

impl RowRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a row, or refuses it and adds nothing.
    pub fn register(&mut self, row: TelemetryRow) -> Result<(), TelemetryError> {
        if !is_row_id(&row.id) {
            return Err(TelemetryError::Assembly(format!(
                "Row id '{}' is not a namespaced path like 'ports.sensor.1.value'.",
                row.id
            )));
        }
        if self.index.contains_key(&row.id) {
            return Err(TelemetryError::Assembly(format!(
                "Row '{}' is already registered.",
                row.id
            )));
        }
        if let Lifetime::Repeating { divider: 0 } = row.lifetime {
            return Err(TelemetryError::Assembly(format!(
                "Row '{}' repeats on divider 0; a divider is a whole number of ticks, 1 or more.",
                row.id
            )));
        }
        validate_row(&row, HID_LIMITS)?;
        let bytecode = row.emit(WIDEST_SLOT)?.len();
        let budget = bytecode_budget_for(HID_LIMITS);
        if bytecode > budget {
            return Err(TelemetryError::Assembly(format!(
                "Row '{}' needs {bytecode} bytes of bytecode; {budget} go out on the HID fallback.",
                row.id
            )));
        }
        self.index.insert(row.id.clone(), self.rows.len());
        self.rows.push(row);
        Ok(())
    }

    /// Lets a registered row be read in other modes; the row a mode gives keeps the id.
    pub fn register_modes(&mut self, id: &str, in_mode: ModeVariant) -> Result<(), TelemetryError> {
        if !self.index.contains_key(id) {
            return Err(TelemetryError::Assembly(format!(
                "Row '{id}' is not registered."
            )));
        }
        self.variants.insert(id.to_owned(), in_mode);
        Ok(())
    }

    /// The row in `mode`, or `None` for a row without modes.
    pub fn in_mode(&self, id: &str, mode: u8) -> Option<TelemetryRow> {
        self.variants.get(id).map(|variant| variant(mode))
    }

    /// The ports whose mode a client can choose.
    pub fn mode_ports(&self) -> BTreeSet<String> {
        self.variants
            .keys()
            .filter_map(|id| self.get(id).and_then(|row| row.port.clone()))
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&TelemetryRow> {
        self.index.get(id).map(|&i| &self.rows[i])
    }

    /// Every registered row, in registration order, which is truncation priority.
    pub fn all(&self) -> &[TelemetryRow] {
        &self.rows
    }

    /// Every registered row as plain data: what a client can subscribe to.
    pub fn list(&self) -> Vec<TelemetryRowInfo> {
        self.rows
            .iter()
            .map(|row| TelemetryRowInfo {
                id: row.id.clone(),
                tier: row.tier.as_str().to_owned(),
                unit: row.unit.clone(),
                port: row.port.clone(),
                layer: row.layer.map(u64::from),
            })
            .collect()
    }
}

/// A registry holding every row an EV3 brick offers. A sensor is read in the mode its claim asks
/// for, a chain member's through the master the same way (measured); a motor's tacho has no mode.
pub fn ev3_row_registry() -> RowRegistry {
    let mut registry = RowRegistry::new();
    for row in all_ev3_rows() {
        registry
            .register(row)
            .expect("every EV3 row fits the HID link");
    }
    for (index, port) in SENSOR_PORT_NAMES.iter().enumerate() {
        for layer in std::iter::once(0).chain(CHAIN_LAYERS) {
            registry
                .register_modes(
                    &port_row_id(PortKind::Sensor, port, "value", layer),
                    Arc::new(move |mode| sensor_value_row(index, mode, SAMPLED_DIVIDER, layer)),
                )
                .expect("the sensor value rows are registered");
        }
    }
    registry
}
