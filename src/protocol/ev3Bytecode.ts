/**
 * EV3 bytecode encoding primitives.
 *
 * These functions encode values into the EV3 VM bytecode format used by
 * direct commands. The LC (Local Constant) and GV (Global Variable) encodings
 * follow the LEGO EV3 Communication Developer Kit specification.
 */

// ── Integer encoding ────────────────────────────────────────────────

/** Encodes a 16-bit unsigned integer in little-endian byte order. */
export function uint16le(value: number): Uint8Array {
	const out = new Uint8Array(2);
	new DataView(out.buffer).setUint16(0, value & 0xffff, true);
	return out;
}

/** Encodes a 32-bit unsigned integer in little-endian byte order. */
export function uint32le(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0, true);
	return out;
}

/** Reads a 16-bit unsigned integer from a byte array at the given offset (LE). */
export function readUint16le(bytes: Uint8Array, offset: number): number {
	if (bytes.length < offset + 2) {
		throw new Error(`readUint16le: need 2 bytes at offset ${offset}, got ${bytes.length - offset}`);
	}
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

/** Reads a 32-bit unsigned integer from a byte array at the given offset (LE). */
export function readUint32le(bytes: Uint8Array, offset: number): number {
	if (bytes.length < offset + 4) {
		throw new Error(`readUint32le: need 4 bytes at offset ${offset}, got ${bytes.length - offset}`);
	}
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** Reads a 32-bit signed integer from a byte array at the given offset (LE). */
export function readInt32le(bytes: Uint8Array, offset: number): number {
	if (bytes.length < offset + 4) {
		throw new Error(`readInt32le: need 4 bytes at offset ${offset}, got ${bytes.length - offset}`);
	}
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

/** Reads a 32-bit float from a byte array at the given offset (LE). */
export function readFloat32le(bytes: Uint8Array, offset: number): number {
	if (bytes.length < offset + 4) {
		throw new Error(`readFloat32le: need 4 bytes at offset ${offset}, got ${bytes.length - offset}`);
	}
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, true);
}

// ── Byte array utilities ────────────────────────────────────────────

/** Concatenates multiple byte arrays into a single contiguous Uint8Array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

// ── Local Constant encodings (LC) ───────────────────────────────────

/**
 * Encodes a value as a 1-byte EV3 Local Constant (LC0).
 * Range: -31..31.
 */
export function lc0(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < -31 || value > 31) {
		throw new Error(`LC0 value out of range: ${value}`);
	}
	return new Uint8Array([value & 0x3f]);
}

/**
 * Encodes a value as a 2-byte EV3 Local Constant (LC1).
 * Range: -128..127. Wire format: `[0x81, value]`.
 */
export function lc1(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < -128 || value > 127) {
		throw new Error(`LC1 value out of range: ${value}`);
	}
	return new Uint8Array([0x81, value & 0xff]);
}

/**
 * Encodes a value as a 3-byte EV3 Local Constant (LC2).
 * Range: -32768..32767. Wire format: `[0x82, int16LE]`.
 */
export function lc2(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < -32768 || value > 32767) {
		throw new Error(`LC2 value out of range: ${value}`);
	}
	const out = new Uint8Array(3);
	out[0] = 0x82;
	new DataView(out.buffer).setInt16(1, value, true);
	return out;
}

// ── String encodings ────────────────────────────────────────────────

/** Encodes a string as a null-terminated C string in UTF-8. */
export function cString(text: string): Uint8Array {
	const encoded = Buffer.from(text, 'utf8');
	return concatBytes(encoded, new Uint8Array([0x00]));
}

/**
 * Encodes a string as an EV3 Local Constant String (LCS).
 * Wire format: `[0x84, null-terminated UTF-8]`.
 */
export function lcs(text: string): Uint8Array {
	return concatBytes(new Uint8Array([0x84]), cString(text));
}

// ── Global Variable references (GV) ────────────────────────────────

/**
 * Encodes a 1-byte EV3 Global Variable reference (GV0).
 * Offset range: 0..31. Wire format: `[0x60 | offset]`.
 */
export function gv0(offset: number): Uint8Array {
	if (!Number.isInteger(offset) || offset < 0 || offset > 31) {
		throw new Error(`GV0 offset out of range: ${offset}`);
	}
	return new Uint8Array([0x60 | offset]);
}

/**
 * Encodes a 2-byte EV3 Global Variable reference (GV1).
 * Offset range: 0..255. Wire format: `[0xE1, offset]`.
 */
export function gv1(offset: number): Uint8Array {
	if (!Number.isInteger(offset) || offset < 0 || offset > 255) {
		throw new Error(`GV1 offset out of range: ${offset}`);
	}
	return new Uint8Array([0xe1, offset & 0xff]);
}

// ── Parsing helpers ─────────────────────────────────────────────────

/** Reads a null-terminated string from a fixed-size slot in a byte array. */
export function readFixedCString(bytes: Uint8Array, offset: number, length: number): string {
	if (offset >= bytes.length) { return ''; }
	const end = Math.min(bytes.length, offset + length);
	let zeroIndex = end;
	for (let i = offset; i < end; i++) {
		if (bytes[i] === 0) { zeroIndex = i; break; }
	}
	return Buffer.from(bytes.subarray(offset, zeroIndex)).toString('utf8').trim();
}
