/**
 * EV3 bytecode encoding primitives.
 *
 * @remarks
 * These functions encode values into the EV3 VM bytecode format used by
 * direct commands. The LC (Local Constant) and GV (Global Variable) encodings
 * follow the LEGO EV3 Communication Developer Kit specification.
 *
 * @packageDocumentation
 */

/**
 * Encodes a 16-bit unsigned integer in little-endian byte order.
 *
 * @param value - Value to encode (masked to 16 bits)
 * @returns 2-byte Uint8Array in LE order
 */
export function uint16le(value: number): Uint8Array {
	const out = new Uint8Array(2);
	new DataView(out.buffer).setUint16(0, value & 0xffff, true);
	return out;
}

/**
 * Concatenates multiple byte arrays into a single contiguous Uint8Array.
 *
 * @param parts - Variable number of byte arrays to concatenate
 * @returns A new Uint8Array containing all input bytes in order
 */
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

/**
 * Encodes a value as a 1-byte EV3 Local Constant (LC0, range -31..31).
 *
 * @param value - Integer in range [-31, 31]
 * @returns Single-byte LC0 encoding
 * @throws Error if value is out of range or not an integer
 */
export function lc0(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < -31 || value > 31) {
		throw new Error(`LC0 value out of range: ${value}`);
	}
	return new Uint8Array([value & 0x3f]);
}

/**
 * Encodes a value as a 2-byte EV3 Local Constant (LC1, range -128..127).
 *
 * @param value - Integer in range [-128, 127]
 * @returns 2-byte LC1 encoding (0x81 prefix + value byte)
 * @throws Error if value is out of range or not an integer
 */
export function lc1(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < -128 || value > 127) {
		throw new Error(`LC1 value out of range: ${value}`);
	}
	return new Uint8Array([0x81, value & 0xff]);
}

/**
 * Encodes a 32-bit unsigned integer in little-endian byte order.
 *
 * @param value - Value to encode (coerced to unsigned 32-bit via `>>> 0`)
 * @returns 4-byte Uint8Array in LE order
 */
export function uint32le(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0, true);
	return out;
}

/**
 * Encodes a string as a null-terminated C string in UTF-8.
 *
 * @param text - String to encode
 * @returns UTF-8 bytes followed by a 0x00 terminator
 */
export function cString(text: string): Uint8Array {
	const encoded = Buffer.from(text, 'utf8');
	return concatBytes(encoded, new Uint8Array([0x00]));
}

/**
 * Encodes a value as a 3-byte EV3 Local Constant (LC2, range -32768..32767).
 *
 * @param value - Integer in range [-32768, 32767]
 * @returns 3-byte LC2 encoding (0x82 prefix + int16 LE)
 * @throws Error if value is out of range or not an integer
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

/**
 * Encodes a string as an EV3 Local Constant String (LCS).
 *
 * @remarks
 * LCS format: `0x84` prefix byte followed by a null-terminated C string.
 *
 * @param text - String to encode
 * @returns LCS-encoded byte array
 */
export function lcs(text: string): Uint8Array {
	return concatBytes(new Uint8Array([0x84]), cString(text));
}

/**
 * Encodes a 1-byte EV3 Global Variable reference (GV0, offset 0..31).
 *
 * @param offset - Global variable offset in range [0, 31]
 * @returns Single-byte GV0 encoding (0x60 | offset)
 * @throws Error if offset is out of range
 */
export function gv0(offset: number): Uint8Array {
	if (!Number.isInteger(offset) || offset < 0 || offset > 31) {
		throw new Error(`GV0 offset out of range: ${offset}`);
	}
	return new Uint8Array([0x60 | offset]);
}

/**
 * Encodes a 2-byte EV3 Global Variable reference (GV1, offset 0..255).
 *
 * @param offset - Global variable offset in range [0, 255]
 * @returns 2-byte GV1 encoding (0xE1 prefix + offset byte)
 * @throws Error if offset is out of range
 */
export function gv1(offset: number): Uint8Array {
	if (!Number.isInteger(offset) || offset < 0 || offset > 255) {
		throw new Error(`GV1 offset out of range: ${offset}`);
	}
	return new Uint8Array([0xe1, offset & 0xff]);
}

/**
 * Reads a 32-bit unsigned integer from a byte array at the given offset.
 *
 * @param bytes - Source byte array
 * @param offset - Byte offset to start reading from
 * @returns The decoded uint32 value
 * @throws Error if insufficient bytes remain at the offset
 */
export function readUint32le(bytes: Uint8Array, offset: number): number {
	if (bytes.length < offset + 4) {
		throw new Error('Expected 4-byte little-endian integer in system command payload.');
	}
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}
