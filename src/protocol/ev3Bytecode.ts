export function uint16le(value: number): Uint8Array {
	const out = new Uint8Array(2);
	new DataView(out.buffer).setUint16(0, value & 0xffff, true);
	return out;
}

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

export function lc0(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < -31 || value > 31) {
		throw new Error(`LC0 value out of range: ${value}`);
	}
	return new Uint8Array([value & 0x3f]);
}

export function lc1(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < -128 || value > 127) {
		throw new Error(`LC1 value out of range: ${value}`);
	}
	return new Uint8Array([0x81, value & 0xff]);
}

export function uint32le(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0, true);
	return out;
}

export function cString(text: string): Uint8Array {
	const encoded = Buffer.from(text, 'utf8');
	return concatBytes(encoded, new Uint8Array([0x00]));
}

export function lc2(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < -32768 || value > 32767) {
		throw new Error(`LC2 value out of range: ${value}`);
	}
	const out = new Uint8Array(3);
	out[0] = 0x82;
	new DataView(out.buffer).setInt16(1, value, true);
	return out;
}

export function lcs(text: string): Uint8Array {
	return concatBytes(new Uint8Array([0x84]), cString(text));
}

export function gv0(offset: number): Uint8Array {
	if (!Number.isInteger(offset) || offset < 0 || offset > 31) {
		throw new Error(`GV0 offset out of range: ${offset}`);
	}
	return new Uint8Array([0x60 | offset]);
}

export function readUint32le(bytes: Uint8Array, offset: number): number {
	if (bytes.length < offset + 4) {
		throw new Error('Expected 4-byte little-endian integer in system command payload.');
	}
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}
