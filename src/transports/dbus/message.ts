/**
 * D-Bus messages: the fixed header, the header fields, the body (step-7 plan, U3).
 *
 * Little-endian only (see `wire.ts`). A message is `yyyyuua(yv)` — endianness, type, flags,
 * protocol version, body length, serial, header fields — padded to 8, then the body.
 */

import { DBusValue, Variant, marshal, unmarshal } from './wire';

export const MessageType = {
	MethodCall: 1,
	MethodReturn: 2,
	Error: 3,
	Signal: 4,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** The method call expects no reply. */
export const FLAG_NO_REPLY_EXPECTED = 0x1;

export interface DBusMessage {
	type: MessageType;
	flags: number;
	serial: number;
	path?: string;
	interface?: string;
	member?: string;
	errorName?: string;
	replySerial?: number;
	destination?: string;
	sender?: string;
	/** The body's signature; absent for an empty body. */
	signature?: string;
	body: DBusValue[];
}

const FIELD = {
	path: [1, 'o'],
	interface: [2, 's'],
	member: [3, 's'],
	errorName: [4, 's'],
	replySerial: [5, 'u'],
	destination: [6, 's'],
	sender: [7, 's'],
	signature: [8, 'g'],
} as const;
type FieldName = keyof typeof FIELD;

const LITTLE_ENDIAN = 0x6c; // 'l'
const BIG_ENDIAN = 0x42; // 'B'
const PROTOCOL_VERSION = 1;
/** The specification's limit on a whole message. */
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

const align8 = (n: number): number => Math.ceil(n / 8) * 8;

/** The message as bytes. */
export function encodeMessage(message: DBusMessage): Buffer {
	const body = message.signature ? marshal(message.signature, message.body) : Buffer.alloc(0);
	const fields: DBusValue[] = [];
	for (const name of Object.keys(FIELD) as FieldName[]) {
		const value = message[name];
		if (value === undefined || value === '') { continue; }
		const [code, signature] = FIELD[name];
		fields.push([code, new Variant(signature, value)]);
	}
	const header = marshal('yyyyuua(yv)', [
		LITTLE_ENDIAN, message.type, message.flags, PROTOCOL_VERSION, body.length, message.serial, fields,
	]);
	return Buffer.concat([header, Buffer.alloc(align8(header.length) - header.length), body]);
}

/**
 * Reads one message from the front of `buf`.
 *
 * @returns The message and how many bytes it took, or `undefined` while `buf` holds only part of it.
 * @throws For a message this client cannot read: big-endian, another protocol version, oversized.
 */
export function decodeMessage(buf: Buffer): { message: DBusMessage; length: number } | undefined {
	if (buf.length < 16) { return undefined; }
	if (buf[0] === BIG_ENDIAN) { throw new Error('D-Bus: a big-endian message; this client reads little-endian only.'); }
	if (buf[0] !== LITTLE_ENDIAN) { throw new Error(`D-Bus: not a message (endianness byte 0x${buf[0].toString(16)}).`); }
	if (buf[3] !== PROTOCOL_VERSION) { throw new Error(`D-Bus: protocol version ${buf[3]}, not 1.`); }
	const bodyLength = buf.readUInt32LE(4);
	const fieldsLength = buf.readUInt32LE(12);
	const bodyStart = align8(16 + fieldsLength);
	const total = bodyStart + bodyLength;
	if (total > MAX_MESSAGE_BYTES) { throw new Error(`D-Bus: a message of ${total} bytes is over the limit.`); }
	if (buf.length < total) { return undefined; }

	const [, type, flags, , , serial, fields] = unmarshal('yyyyuua(yv)', buf.subarray(0, 16 + fieldsLength)) as
		[number, MessageType, number, number, number, number, [number, Variant][]];
	const message: DBusMessage = { type, flags, serial, body: [] };
	for (const [code, variant] of fields) {
		const name = (Object.keys(FIELD) as FieldName[]).find((key) => FIELD[key][0] === code);
		// Unknown fields are skipped, as the specification asks.
		if (name) { (message as unknown as Record<string, DBusValue>)[name] = variant.value; }
	}
	if (message.signature) {
		message.body = unmarshal(message.signature, buf.subarray(bodyStart, total));
	}
	return { message, length: total };
}
