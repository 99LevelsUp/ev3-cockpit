/**
 * The D-Bus wire format, little-endian, for the types BlueZ uses (step-7 plan, U3, owner decision
 * D1: the cockpit's own minimal client, no dependency).
 *
 * Values in TypeScript: `y n q i u d` are numbers, `x t` bigints, `b` a boolean, `s o g` strings,
 * an array a JS array, a dict a `Map` (a plain object is accepted when writing a string-keyed
 * one), a struct an array of its fields, and a variant a {@link Variant}. Alignment is counted
 * from the start of the message; a body starts on an 8-byte boundary, so it can be written from
 * offset 0. Big-endian messages are not read: the bus does not reorder bytes, and BlueZ runs on
 * the same little-endian host.
 */

/** A value with its own signature, as `v` carries it. */
export class Variant {
	constructor(readonly signature: string, readonly value: DBusValue) {}
}

export type DBusValue =
	| number | bigint | boolean | string | Variant
	| DBusValue[]
	| Map<DBusValue, DBusValue>
	| { [key: string]: DBusValue };

const ALIGN: Record<string, number> = {
	y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, '(': 8, '{': 8, v: 1,
};

const BASIC = 'ybnqiuxtdsog';

const OBJECT_PATH = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;

/** The length of the one complete type at the start of `signature`. */
function completeTypeLength(signature: string, at: number): number {
	const c = signature[at];
	if (c === undefined) { throw new Error(`D-Bus signature "${signature}" ends inside a type.`); }
	if (BASIC.includes(c) || c === 'v') { return 1; }
	if (c === 'a') { return 1 + completeTypeLength(signature, at + 1); }
	if (c === '(' || c === '{') {
		const close = c === '(' ? ')' : '}';
		let i = at + 1;
		let fields = 0;
		while (signature[i] !== close) {
			if (signature[i] === undefined) { throw new Error(`D-Bus signature "${signature}" has an unclosed ${c}.`); }
			i += completeTypeLength(signature, i);
			fields += 1;
		}
		if (fields === 0 || (c === '{' && fields !== 2)) {
			throw new Error(`D-Bus signature "${signature}" has an empty struct or a dict entry without two fields.`);
		}
		if (c === '{' && !BASIC.includes(signature[at + 1])) {
			throw new Error(`D-Bus signature "${signature}" has a dict key that is not a basic type.`);
		}
		return i + 1 - at;
	}
	throw new Error(`D-Bus signature "${signature}" has an unknown type code "${c}".`);
}

/** A signature as its complete types: `sa{sv}as` → `s`, `a{sv}`, `as`. */
export function splitSignature(signature: string): string[] {
	const types: string[] = [];
	for (let at = 0; at < signature.length;) {
		const length = completeTypeLength(signature, at);
		types.push(signature.slice(at, at + length));
		at += length;
	}
	return types;
}

/** The fields of a struct or dict entry type, `(sa{sv})` → `s`, `a{sv}`. */
function innerTypes(type: string): string[] {
	return splitSignature(type.slice(1, -1));
}

// ── Writing ─────────────────────────────────────────────────────────

class Writer {
	private chunks: Buffer[] = [];
	length = 0;

	constructor(private readonly start: number) {}

	align(n: number): void {
		const pad = (n - ((this.start + this.length) % n)) % n;
		if (pad) { this.push(Buffer.alloc(pad)); }
	}

	push(bytes: Buffer): void {
		this.chunks.push(bytes);
		this.length += bytes.length;
	}

	result(): Buffer {
		return Buffer.concat(this.chunks, this.length);
	}

	/** Overwrites the 4 bytes at `at` (counted from this writer's first byte) with `n`. */
	patchUint32(at: number, n: number): void {
		const whole = this.result();
		whole.writeUInt32LE(n, at);
		this.chunks = [whole];
	}
}

function fail(type: string, value: unknown, why: string): never {
	throw new TypeError(`D-Bus ${type}: ${why} (${typeof value === 'bigint' ? `${value}n` : JSON.stringify(value)}).`);
}

function integer(type: string, value: DBusValue, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value)) { fail(type, value, 'not an integer'); }
	if (value < min || value > max) { fail(type, value, `out of range ${min}..${max}`); }
	return value;
}

function big(type: string, value: DBusValue, min: bigint, max: bigint): bigint {
	const n = typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : value;
	if (typeof n !== 'bigint') { fail(type, value, 'not an integer'); }
	if (n < min || n > max) { fail(type, value, `out of range ${min}..${max}`); }
	return n;
}

function text(type: string, value: DBusValue): string {
	if (typeof value !== 'string') { fail(type, value, 'not a string'); }
	if (value.includes('\0')) { fail(type, value, 'a string may not hold a NUL'); }
	return value;
}

function writeValue(w: Writer, type: string, value: DBusValue): void {
	const c = type[0];
	w.align(ALIGN[c]);
	const fixed = (size: number, put: (b: Buffer) => void): void => { const b = Buffer.alloc(size); put(b); w.push(b); };
	switch (c) {
	case 'y': { const n = integer('y', value, 0, 0xff); fixed(1, (b) => b.writeUInt8(n)); return; }
	case 'b': {
		if (typeof value !== 'boolean') { fail('b', value, 'not a boolean'); }
		fixed(4, (b) => b.writeUInt32LE(value ? 1 : 0)); return;
	}
	case 'n': { const n = integer('n', value, -0x8000, 0x7fff); fixed(2, (b) => b.writeInt16LE(n)); return; }
	case 'q': { const n = integer('q', value, 0, 0xffff); fixed(2, (b) => b.writeUInt16LE(n)); return; }
	case 'i': { const n = integer('i', value, -0x80000000, 0x7fffffff); fixed(4, (b) => b.writeInt32LE(n)); return; }
	case 'u': { const n = integer('u', value, 0, 0xffffffff); fixed(4, (b) => b.writeUInt32LE(n)); return; }
	case 'x': { const n = big('x', value, -(2n ** 63n), 2n ** 63n - 1n); fixed(8, (b) => b.writeBigInt64LE(n)); return; }
	case 't': { const n = big('t', value, 0n, 2n ** 64n - 1n); fixed(8, (b) => b.writeBigUInt64LE(n)); return; }
	case 'd': {
		if (typeof value !== 'number') { fail('d', value, 'not a number'); }
		fixed(8, (b) => b.writeDoubleLE(value)); return;
	}
	case 's': case 'o': {
		const s = text(c, value);
		if (c === 'o' && !OBJECT_PATH.test(s)) { fail('o', value, 'not an object path'); }
		const utf8 = Buffer.from(s, 'utf8');
		fixed(4, (b) => b.writeUInt32LE(utf8.length));
		w.push(Buffer.concat([utf8, Buffer.alloc(1)]));
		return;
	}
	case 'g': {
		const s = text('g', value);
		splitSignature(s);
		if (s.length > 255) { fail('g', value, 'a signature is at most 255 bytes'); }
		w.push(Buffer.concat([Buffer.from([s.length]), Buffer.from(s, 'ascii'), Buffer.alloc(1)]));
		return;
	}
	case 'v': {
		if (!(value instanceof Variant)) { fail('v', value, 'not a Variant'); }
		if (splitSignature(value.signature).length !== 1) { fail('v', value.signature, 'a variant holds exactly one complete type'); }
		writeValue(w, 'g', value.signature);
		writeValue(w, value.signature, value.value);
		return;
	}
	case '(': case '{': {
		// A dict entry is written like a struct of its key and value.
		const fields = innerTypes(type);
		if (!Array.isArray(value) || value.length !== fields.length) { fail(type, value, `a struct of ${fields.length} fields`); }
		fields.forEach((field, i) => writeValue(w, field, value[i]));
		return;
	}
	case 'a': {
		const element = type.slice(1);
		const lengthAt = w.length;
		w.push(Buffer.alloc(4));
		w.align(ALIGN[element[0]]);
		const start = w.length;
		const entries = element[0] === '{' ? dictEntries(type, value) : arrayItems(type, value);
		for (const entry of entries) { writeValue(w, element, entry); }
		const length = w.length - start;
		// The length excludes the padding before the first element.
		w.patchUint32(lengthAt, length);
		return;
	}
	default:
		throw new Error(`D-Bus type "${type}" cannot be written.`);
	}
}

function arrayItems(type: string, value: DBusValue): DBusValue[] {
	if (!Array.isArray(value)) { fail(type, value, 'not an array'); }
	return value;
}

function dictEntries(type: string, value: DBusValue): DBusValue[][] {
	if (value instanceof Map) { return [...value.entries()]; }
	if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Variant)) {
		return Object.entries(value);
	}
	return fail(type, value, 'not a Map or an object');
}

/**
 * Writes `values` as `signature`.
 *
 * @param start Where in the message the bytes go, for alignment (default 0: a body).
 */
export function marshal(signature: string, values: DBusValue[], start = 0): Buffer {
	const types = splitSignature(signature);
	if (types.length !== values.length) {
		throw new TypeError(`D-Bus signature "${signature}" has ${types.length} types, ${values.length} values given.`);
	}
	const w = new Writer(start);
	types.forEach((type, i) => writeValue(w, type, values[i]));
	return w.result();
}

// ── Reading ─────────────────────────────────────────────────────────

class Reader {
	at = 0;

	constructor(private readonly buf: Buffer, private readonly start: number) {}

	align(n: number): void {
		this.at += (n - ((this.start + this.at) % n)) % n;
		this.need(0);
	}

	need(n: number): void {
		if (this.at + n > this.buf.length) {
			throw new RangeError(`D-Bus: read past the end of the data (${this.at + n} of ${this.buf.length} bytes).`);
		}
	}

	take(n: number): Buffer {
		this.need(n);
		const part = this.buf.subarray(this.at, this.at + n);
		this.at += n;
		return part;
	}
}

function readValue(r: Reader, type: string): DBusValue {
	const c = type[0];
	r.align(ALIGN[c]);
	switch (c) {
	case 'y': return r.take(1).readUInt8(0);
	case 'b': return r.take(4).readUInt32LE(0) !== 0;
	case 'n': return r.take(2).readInt16LE(0);
	case 'q': return r.take(2).readUInt16LE(0);
	case 'i': return r.take(4).readInt32LE(0);
	case 'u': return r.take(4).readUInt32LE(0);
	case 'x': return r.take(8).readBigInt64LE(0);
	case 't': return r.take(8).readBigUInt64LE(0);
	case 'd': return r.take(8).readDoubleLE(0);
	case 's': case 'o': {
		const length = r.take(4).readUInt32LE(0);
		const s = r.take(length).toString('utf8');
		r.take(1);
		return s;
	}
	case 'g': {
		const length = r.take(1).readUInt8(0);
		const s = r.take(length).toString('ascii');
		r.take(1);
		return s;
	}
	case 'v': {
		const signature = readValue(r, 'g') as string;
		if (splitSignature(signature).length !== 1) { throw new TypeError(`D-Bus variant signature "${signature}" is not one type.`); }
		return new Variant(signature, readValue(r, signature));
	}
	case '(':
		return innerTypes(type).map((field) => readValue(r, field));
	case 'a': {
		const element = type.slice(1);
		const length = r.take(4).readUInt32LE(0);
		r.align(ALIGN[element[0]]);
		const end = r.at + length;
		r.need(length);
		if (element[0] === '{') {
			const [keyType, valueType] = innerTypes(element);
			const map = new Map<DBusValue, DBusValue>();
			while (r.at < end) {
				r.align(8);
				const key = readValue(r, keyType);
				map.set(key, readValue(r, valueType));
			}
			return map;
		}
		const items: DBusValue[] = [];
		while (r.at < end) { items.push(readValue(r, element)); }
		return items;
	}
	default:
		throw new Error(`D-Bus type "${type}" cannot be read.`);
	}
}

/**
 * Reads `signature` from `buf`.
 *
 * @param start Where in the message `buf` begins, for alignment (default 0: a body).
 */
export function unmarshal(signature: string, buf: Buffer, start = 0): DBusValue[] {
	const r = new Reader(buf, start);
	return splitSignature(signature).map((type) => readValue(r, type));
}
