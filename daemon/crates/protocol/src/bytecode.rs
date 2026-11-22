//! EV3 bytecode encoding primitives.
//!
//! These encode values into the EV3 VM bytecode format used by direct commands. The LC (Local
//! Constant) and GV (Global Variable) encodings follow the LEGO EV3 Communication Developer Kit
//! specification.

use crate::error::ProtocolError;

// ── Integer encoding ────────────────────────────────────────────────

/// Encodes a 16-bit unsigned integer in little-endian byte order.
pub fn uint16le(value: u16) -> [u8; 2] {
    value.to_le_bytes()
}

/// Encodes a 32-bit unsigned integer in little-endian byte order.
pub fn uint32le(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}

fn take<const N: usize>(bytes: &[u8], offset: usize, name: &str) -> Result<[u8; N], ProtocolError> {
    let end = offset.checked_add(N).filter(|end| *end <= bytes.len());
    match end {
        Some(end) => {
            let mut out = [0u8; N];
            out.copy_from_slice(&bytes[offset..end]);
            Ok(out)
        }
        None => Err(ProtocolError::new(format!(
            "{name}: need {N} bytes at offset {offset}, got {}",
            bytes.len() as i64 - offset as i64
        ))),
    }
}

/// Reads a 16-bit unsigned integer from a byte slice at the given offset (little-endian).
pub fn read_uint16le(bytes: &[u8], offset: usize) -> Result<u16, ProtocolError> {
    take::<2>(bytes, offset, "readUint16le").map(u16::from_le_bytes)
}

/// Reads a 32-bit unsigned integer from a byte slice at the given offset (little-endian).
pub fn read_uint32le(bytes: &[u8], offset: usize) -> Result<u32, ProtocolError> {
    take::<4>(bytes, offset, "readUint32le").map(u32::from_le_bytes)
}

/// Reads a 32-bit signed integer from a byte slice at the given offset (little-endian).
pub fn read_int32le(bytes: &[u8], offset: usize) -> Result<i32, ProtocolError> {
    take::<4>(bytes, offset, "readInt32le").map(i32::from_le_bytes)
}

/// Reads a 32-bit float from a byte slice at the given offset (little-endian).
pub fn read_float32le(bytes: &[u8], offset: usize) -> Result<f32, ProtocolError> {
    take::<4>(bytes, offset, "readFloat32le").map(f32::from_le_bytes)
}

// ── Byte array utilities ────────────────────────────────────────────

/// Concatenates multiple byte slices into one contiguous vector.
pub fn concat_bytes(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(|p| p.len()).sum());
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

// ── Local Constant encodings (LC) ───────────────────────────────────

/// Encodes a value as a 1-byte EV3 Local Constant (LC0). Range: -31..31.
pub fn lc0(value: i32) -> Result<Vec<u8>, ProtocolError> {
    if !(-31..=31).contains(&value) {
        return Err(ProtocolError::new(format!(
            "LC0 value out of range: {value}"
        )));
    }
    Ok(vec![(value & 0x3f) as u8])
}

/// Encodes a value as a 2-byte EV3 Local Constant (LC1). Range: -128..127.
/// Wire format: `[0x81, value]`.
pub fn lc1(value: i32) -> Result<Vec<u8>, ProtocolError> {
    if !(-128..=127).contains(&value) {
        return Err(ProtocolError::new(format!(
            "LC1 value out of range: {value}"
        )));
    }
    Ok(vec![0x81, (value & 0xff) as u8])
}

/// Encodes a value as a 3-byte EV3 Local Constant (LC2). Range: -32768..32767.
/// Wire format: `[0x82, int16LE]`.
pub fn lc2(value: i32) -> Result<Vec<u8>, ProtocolError> {
    let narrow = i16::try_from(value)
        .map_err(|_| ProtocolError::new(format!("LC2 value out of range: {value}")))?;
    let [lo, hi] = narrow.to_le_bytes();
    Ok(vec![0x82, lo, hi])
}

// ── String encodings ────────────────────────────────────────────────

/// Encodes a string as a null-terminated C string in UTF-8.
pub fn c_string(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 1);
    out.extend_from_slice(text.as_bytes());
    out.push(0x00);
    out
}

/// Encodes a string as an EV3 Local Constant String (LCS).
/// Wire format: `[0x84, null-terminated UTF-8]`.
pub fn lcs(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 2);
    out.push(0x84);
    out.extend_from_slice(text.as_bytes());
    out.push(0x00);
    out
}

// ── Global Variable references (GV) ────────────────────────────────

/// Encodes a 1-byte EV3 Global Variable reference (GV0).
/// Offset range: 0..31. Wire format: `[0x60 | offset]`.
pub fn gv0(offset: u32) -> Result<Vec<u8>, ProtocolError> {
    if offset > 31 {
        return Err(ProtocolError::new(format!(
            "GV0 offset out of range: {offset}"
        )));
    }
    Ok(vec![0x60 | offset as u8])
}

/// Encodes a 2-byte EV3 Global Variable reference (GV1).
/// Offset range: 0..255. Wire format: `[0xE1, offset]`.
pub fn gv1(offset: u32) -> Result<Vec<u8>, ProtocolError> {
    let narrow = u8::try_from(offset)
        .map_err(|_| ProtocolError::new(format!("GV1 offset out of range: {offset}")))?;
    Ok(vec![0xe1, narrow])
}

// ── Parsing helpers ─────────────────────────────────────────────────

/// Reads a null-terminated string from a fixed-size slot in a byte slice, trimmed.
///
/// An offset past the end gives an empty string; a slot that runs past the end is cut at the end.
pub fn read_fixed_c_string(bytes: &[u8], offset: usize, length: usize) -> String {
    if offset >= bytes.len() {
        return String::new();
    }
    let end = bytes.len().min(offset.saturating_add(length));
    let slot = &bytes[offset..end];
    let cut = slot.iter().position(|b| *b == 0).unwrap_or(slot.len());
    String::from_utf8_lossy(&slot[..cut]).trim().to_owned()
}
