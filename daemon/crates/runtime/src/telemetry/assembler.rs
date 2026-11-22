//! Builds one direct command from the rows that come up on a tick, and says where each result
//! landed.
//!
//! Offsets are assigned here because they are a property of the whole frame, not of any row, and
//! the layout is returned rather than recomputed by the parser: a parser inferring offsets once
//! read four bytes from a slot the firmware had filled one byte of.
//!
//! Three limits, and the reply is the one that gets forgotten:
//!
//!  - bytecode ≤ packet − 7, the direct-command header;
//!  - declared globals ≤ packet − 5, because the reply on the wire is always the *declared*
//!    globals plus five bytes however few the program wrote, and `c_com.c` never checks it against
//!    `MAX_MSG_SIZE`;
//!  - declared globals ≤ 1019 regardless, for the same reason: `MAX_COMMAND_GLOBALS` is 1021, but
//!    1021 + 5 overruns the 1024-byte message.
//!
//! Alignment padding inflates the declaration faster than the bytecode, so the second limit can
//! bind before the first.

use std::collections::HashMap;

use ev3_protocol::bytecode::{gv0, gv1, uint16le};

use super::error::TelemetryError;
use super::row::{RowSlot, RowValue, TelemetryRow};

/// Bytes the direct-command header costs on the request: length, counter, type, globals.
pub const DIRECT_COMMAND_HEADER_BYTES: usize = 7;

/// Bytes the reply header costs: length, counter, type.
pub const DIRECT_REPLY_HEADER_BYTES: usize = 5;

/// The largest global allocation that can come back inside `MAX_MSG_SIZE`: the firmware validates
/// 1021 on the way in, and the reply is globals + 5, which nothing re-checks.
pub const MAX_USABLE_GLOBAL_BYTES: usize = 1019;

/// The link's packet budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameLimits {
    /// The largest packet the link carries: 64 on the HID fallback, 1024 over libusb.
    pub max_packet_bytes: usize,
}

/// One row and the offset its result was given.
#[derive(Debug, Clone)]
pub struct PlacedRow {
    pub row: TelemetryRow,
    pub slot: RowSlot,
}

#[derive(Debug, Clone)]
pub struct AssembledFrame {
    /// The bytecode body, without the globals word that [`build_telemetry_frame`] prepends.
    pub bytecode: Vec<u8>,
    /// Global bytes to declare, which is also what the reply carries.
    pub global_bytes: usize,
    /// Where each included row's result landed. The parser reads this, never infers it.
    pub placed: Vec<PlacedRow>,
    /// Rows that did not fit, in the order to try them next. Never dropped: the scheduler puts
    /// them at the front of the next tick, so truncation rotates instead of losing rows for good.
    pub deferred: Vec<TelemetryRow>,
}

fn assembly(message: String) -> TelemetryError {
    TelemetryError::Assembly(message)
}

/// Rounds `offset` up to a multiple of `alignment`. A guard rather than the mechanism: laying wide
/// results out first keeps the cursor aligned for well-formed rows, so this never pads; it stays
/// so that dropping the ordering costs padding, not a misaligned frame.
fn align_up(offset: usize, alignment: usize) -> usize {
    let remainder = offset % alignment;
    if remainder == 0 {
        offset
    } else {
        offset + (alignment - remainder)
    }
}

/// Bytes a global reference costs at `slot`: GV0 reaches 0-31 in one byte, past that GV1 takes
/// two. So a row's bytecode is not a fixed size: the same row costs more late in a wide frame.
pub fn global_ref_bytes(slot: RowSlot) -> usize {
    if slot <= 31 { 1 } else { 2 }
}

/// A global reference in the shortest form that reaches `slot`.
pub fn global_ref(slot: RowSlot) -> Result<Vec<u8>, TelemetryError> {
    let offset = u32::try_from(slot)
        .map_err(|_| assembly(format!("Global offset {slot} is out of range.")))?;
    let encoded = if slot <= 31 { gv0(offset) } else { gv1(offset) };
    encoded.map_err(|error| assembly(error.to_string()))
}

/// Global bytes that fit in a reply on this link, and inside `MAX_MSG_SIZE`.
pub fn global_budget_for(limits: FrameLimits) -> usize {
    limits
        .max_packet_bytes
        .saturating_sub(DIRECT_REPLY_HEADER_BYTES)
        .min(MAX_USABLE_GLOBAL_BYTES)
}

/// Bytecode bytes that fit in a request on this link.
pub fn bytecode_budget_for(limits: FrameLimits) -> usize {
    limits
        .max_packet_bytes
        .saturating_sub(DIRECT_COMMAND_HEADER_BYTES)
}

/// Refuses a row whose result can never be placed on this link.
pub fn validate_row(row: &TelemetryRow, limits: FrameLimits) -> Result<(), TelemetryError> {
    let crate::telemetry::row::RowResult { bytes, alignment } = row.result;
    if bytes == 0 {
        return Err(assembly(format!(
            "Row '{}' declares {bytes} result bytes.",
            row.id
        )));
    }
    if !matches!(alignment, 1 | 2 | 4) {
        return Err(assembly(format!(
            "Row '{}' declares alignment {alignment}; 1, 2 or 4 are the options.",
            row.id
        )));
    }
    if bytes % alignment != 0 {
        return Err(assembly(format!(
            "Row '{}' declares {bytes} bytes at alignment {alignment}, which cannot tile.",
            row.id
        )));
    }
    let budget = global_budget_for(limits);
    if bytes > budget {
        return Err(assembly(format!(
            "Row '{}' needs {bytes} result bytes but only {budget} can come back on a {}-byte \
             packet.",
            row.id, limits.max_packet_bytes
        )));
    }
    Ok(())
}

struct Layout {
    placed: Vec<PlacedRow>,
    bytecode: Vec<u8>,
    global_bytes: usize,
}

/// Lays out a candidate set, or `None` when it does not fit. 32-bit results go first, the
/// Communication Developer Kit's "float/32 bits first and 8 bits last": it makes alignment free
/// instead of paid for in padding. The caller's order is kept within an alignment class, so the
/// truncation priority survives.
fn lay_out(
    candidates: &[TelemetryRow],
    limits: FrameLimits,
) -> Result<Option<Layout>, TelemetryError> {
    let mut ordered: Vec<&TelemetryRow> = candidates.iter().collect();
    ordered.sort_by_key(|row| std::cmp::Reverse(row.result.alignment));
    let mut placed = Vec::with_capacity(ordered.len());
    let mut bytecode = Vec::new();
    let mut cursor = 0;
    for row in ordered {
        let slot = align_up(cursor, row.result.alignment.max(1));
        bytecode.extend_from_slice(&row.emit(slot)?);
        placed.push(PlacedRow {
            row: row.clone(),
            slot,
        });
        cursor = slot + row.result.bytes;
    }
    if cursor > global_budget_for(limits) || bytecode.len() > bytecode_budget_for(limits) {
        return Ok(None);
    }
    Ok(Some(Layout {
        placed,
        bytecode,
        global_bytes: cursor,
    }))
}

/// Composes as many of `rows` as fit, in the order given, and defers the rest.
///
/// The order is the truncation priority. Growing a prefix and laying it out again each time is
/// quadratic in the rows, nothing at the few dozen a brick has, and the only exact way, since
/// padding makes a row's cost depend on what precedes it.
pub fn assemble_frame(
    rows: &[TelemetryRow],
    limits: FrameLimits,
) -> Result<AssembledFrame, TelemetryError> {
    check_no_mode_conflict(rows)?;
    let mut best = None;
    let mut taken = 0;
    for count in 1..=rows.len() {
        match lay_out(&rows[..count], limits)? {
            Some(layout) => {
                best = Some(layout);
                taken = count;
            }
            None => break,
        }
    }
    let Some(best) = best else {
        let first = rows.first().map_or_else(
            || " (no rows given).".to_owned(),
            |row| format!("; '{}' was first.", row.id),
        );
        return Err(assembly(format!(
            "No row fits a {}-byte packet{first}",
            limits.max_packet_bytes
        )));
    };
    Ok(AssembledFrame {
        bytecode: best.bytecode,
        global_bytes: best.global_bytes,
        placed: best.placed,
        deferred: rows[taken..].to_vec(),
    })
}

/// Refuses two modes of one port among `rows`.
///
/// A safety net rather than the mechanism: mode ownership is per device across ticks, because two
/// modes in alternating frames switch the device every frame, the firmware sets it busy each time,
/// and both rows read NaN for ever. Two reads of the same mode are fine: SI, RAW and percent off
/// one port in one frame was reproduced on a brick.
pub fn check_no_mode_conflict(rows: &[TelemetryRow]) -> Result<(), TelemetryError> {
    let mut by_port: HashMap<&str, (u8, &str)> = HashMap::new();
    for row in rows {
        let (Some(port), Some(mode)) = (row.port.as_deref(), row.mode) else {
            continue;
        };
        match by_port.get(port) {
            Some(&(seen, holder)) if seen != mode => {
                return Err(assembly(format!(
                    "Rows '{holder}' (mode {seen}) and '{}' (mode {mode}) both claim port {port}. \
                     One active mode row per port.",
                    row.id
                )));
            }
            Some(_) => {}
            None => {
                by_port.insert(port, (mode, &row.id));
            }
        }
    }
    Ok(())
}

/// The direct-command payload: the declared-globals word, then the bytecode. Locals are zero: a
/// telemetry frame reads into globals and computes nothing.
pub fn build_telemetry_frame(frame: &AssembledFrame) -> Result<Vec<u8>, TelemetryError> {
    if frame.global_bytes > MAX_USABLE_GLOBAL_BYTES {
        return Err(assembly(format!(
            "Frame declares {} global bytes; {MAX_USABLE_GLOBAL_BYTES} is the most that can come \
             back inside MAX_MSG_SIZE.",
            frame.global_bytes
        )));
    }
    let globals = u16::try_from(frame.global_bytes).unwrap_or(u16::MAX);
    let mut payload = uint16le(globals).to_vec();
    payload.extend_from_slice(&frame.bytecode);
    Ok(payload)
}

/// Every placed row read out of a reply payload, in the order they were placed.
pub fn parse_frame(frame: &AssembledFrame, payload: &[u8], sampled_at: u64) -> Vec<RowValue> {
    frame
        .placed
        .iter()
        .map(|placed| placed.row.parse(payload, placed.slot, sampled_at))
        .collect()
}
