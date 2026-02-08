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
