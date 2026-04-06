import assert from 'assert/strict';
import { describe, it } from 'node:test';

import {
	uint16le, uint32le, readUint16le, readUint32le, readInt32le, readFloat32le,
	concatBytes, lc0, lc1, lc2, lcs, cString, gv0, gv1, readFixedCString,
} from '../protocol/ev3Bytecode';
import {
	encodeEv3Packet, decodeEv3Packet, extractLengthPrefixedPacket,
	EV3_COMMAND, EV3_REPLY,
} from '../protocol/ev3Packet';
import { buildCommand } from '../protocol/ev3Commands';
import { parseResponse } from '../protocol/ev3Responses';
import type { Ev3Packet } from '../protocol/ev3Packet';

// ── Bytecode encoding ───────────────────────────────────────────────

describe('ev3Bytecode — integer encoding', () => {
	it('uint16le encodes 0x1234', () => {
		const result = uint16le(0x1234);
		assert.deepEqual([...result], [0x34, 0x12]);
	});

	it('uint32le encodes 0xDEADBEEF', () => {
		const result = uint32le(0xdeadbeef);
		assert.deepEqual([...result], [0xef, 0xbe, 0xad, 0xde]);
	});

	it('readUint16le round-trips', () => {
		const encoded = uint16le(42);
		assert.equal(readUint16le(encoded, 0), 42);
	});

	it('readUint32le round-trips', () => {
		const encoded = uint32le(123456);
		assert.equal(readUint32le(encoded, 0), 123456);
	});

	it('readInt32le reads negative values', () => {
		const buf = new Uint8Array(4);
		new DataView(buf.buffer).setInt32(0, -500, true);
		assert.equal(readInt32le(buf, 0), -500);
	});

	it('readFloat32le reads floating point', () => {
		const buf = new Uint8Array(4);
		new DataView(buf.buffer).setFloat32(0, 3.14, true);
		const val = readFloat32le(buf, 0);
		assert.ok(Math.abs(val - 3.14) < 0.01);
	});

	it('throws on insufficient bytes', () => {
		assert.throws(() => readUint32le(new Uint8Array(2), 0));
		assert.throws(() => readFloat32le(new Uint8Array(3), 0));
	});
});

describe('ev3Bytecode — concatBytes', () => {
	it('concatenates multiple arrays', () => {
		const result = concatBytes(
			new Uint8Array([1, 2]),
			new Uint8Array([3]),
			new Uint8Array([4, 5, 6]),
		);
		assert.deepEqual([...result], [1, 2, 3, 4, 5, 6]);
	});

	it('handles empty arrays', () => {
		const result = concatBytes(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2]));
		assert.deepEqual([...result], [1, 2]);
	});
});

describe('ev3Bytecode — LC encodings', () => {
	it('lc0 encodes small positive values', () => {
		assert.deepEqual([...lc0(5)], [5]);
		assert.deepEqual([...lc0(0)], [0]);
		assert.deepEqual([...lc0(31)], [31]);
	});

	it('lc0 throws on out-of-range values', () => {
		assert.throws(() => lc0(32));
		assert.throws(() => lc0(-32));
		assert.throws(() => lc0(1.5));
	});

	it('lc1 encodes medium values', () => {
		assert.deepEqual([...lc1(100)], [0x81, 100]);
		assert.deepEqual([...lc1(-1)], [0x81, 0xff]);
	});

	it('lc1 throws on out-of-range', () => {
		assert.throws(() => lc1(128));
		assert.throws(() => lc1(-129));
	});

	it('lc2 encodes large values', () => {
		const result = lc2(1000);
		assert.equal(result[0], 0x82);
		const val = new DataView(result.buffer).getInt16(1, true);
		assert.equal(val, 1000);
	});

	it('lc2 encodes negative values', () => {
		const result = lc2(-1000);
		const val = new DataView(result.buffer).getInt16(1, true);
		assert.equal(val, -1000);
	});
});

describe('ev3Bytecode — string encoding', () => {
	it('cString produces null-terminated UTF-8', () => {
		const result = cString('abc');
		assert.deepEqual([...result], [0x61, 0x62, 0x63, 0x00]);
	});

	it('lcs prepends 0x84 prefix', () => {
		const result = lcs('hi');
		assert.equal(result[0], 0x84);
		assert.equal(result[result.length - 1], 0x00);
	});
});

describe('ev3Bytecode — GV encodings', () => {
	it('gv0 encodes small offsets', () => {
		assert.deepEqual([...gv0(0)], [0x60]);
		assert.deepEqual([...gv0(5)], [0x65]);
		assert.deepEqual([...gv0(31)], [0x7f]);
	});

	it('gv0 throws on out-of-range', () => {
		assert.throws(() => gv0(32));
		assert.throws(() => gv0(-1));
	});

	it('gv1 encodes larger offsets', () => {
		assert.deepEqual([...gv1(32)], [0xe1, 32]);
		assert.deepEqual([...gv1(255)], [0xe1, 255]);
	});

	it('gv1 throws on out-of-range', () => {
		assert.throws(() => gv1(256));
		assert.throws(() => gv1(-1));
	});
});

describe('ev3Bytecode — readFixedCString', () => {
	it('reads null-terminated string from buffer', () => {
		const buf = new Uint8Array([0x41, 0x42, 0x00, 0xff, 0xff]);
		assert.equal(readFixedCString(buf, 0, 5), 'AB');
	});

	it('handles no null terminator', () => {
		const buf = new Uint8Array([0x41, 0x42, 0x43]);
		assert.equal(readFixedCString(buf, 0, 3), 'ABC');
	});

	it('returns empty for offset beyond buffer', () => {
		assert.equal(readFixedCString(new Uint8Array([1, 2]), 10, 5), '');
	});
});

// ── Packet framing ──────────────────────────────────────────────────

describe('ev3Packet — encode/decode round-trip', () => {
	it('round-trips a direct command', () => {
		const payload = new Uint8Array([0x81, 0x02, 0x60]);
		const encoded = encodeEv3Packet(42, EV3_COMMAND.DIRECT_COMMAND_REPLY, payload);
		const decoded = decodeEv3Packet(encoded);

		assert.equal(decoded.messageCounter, 42);
		assert.equal(decoded.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
		assert.deepEqual([...decoded.payload], [...payload]);
	});

	it('round-trips a packet with no payload', () => {
		const encoded = encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_NO_REPLY);
		const decoded = decodeEv3Packet(encoded);

		assert.equal(decoded.messageCounter, 1);
		assert.equal(decoded.type, EV3_COMMAND.DIRECT_COMMAND_NO_REPLY);
		assert.equal(decoded.payload.length, 0);
	});

	it('wraps message counter to 16 bits', () => {
		const encoded = encodeEv3Packet(0x10042, EV3_REPLY.DIRECT_REPLY);
		const decoded = decodeEv3Packet(encoded);
		assert.equal(decoded.messageCounter, 0x0042);
	});

	it('throws on too-short packet', () => {
		assert.throws(() => decodeEv3Packet(new Uint8Array([1, 2, 3])));
	});

	it('throws on length mismatch', () => {
		const bad = new Uint8Array([0xff, 0x00, 0x01, 0x00, 0x02]);
		assert.throws(() => decodeEv3Packet(bad));
	});
});

describe('ev3Packet — extractLengthPrefixedPacket', () => {
	it('extracts a complete packet', () => {
		const pkt = encodeEv3Packet(1, 0x00, new Uint8Array([0xaa]));
		const extra = new Uint8Array([0xbb, 0xcc]);
		const buf = concatBytes(pkt, extra);

		const result = extractLengthPrefixedPacket(buf);
		assert.ok(result !== null);
		assert.deepEqual([...result.packet], [...pkt]);
		assert.deepEqual([...result.remaining], [0xbb, 0xcc]);
	});

	it('returns null for incomplete data', () => {
		assert.equal(extractLengthPrefixedPacket(new Uint8Array([0x10, 0x00])), null);
	});

	it('returns null for empty buffer', () => {
		assert.equal(extractLengthPrefixedPacket(new Uint8Array([])), null);
	});
});

// ── Command builder ─────────────────────────────────────────────────

describe('ev3Commands — buildCommand', () => {
	it('builds battery command as direct command with reply', () => {
		const result = buildCommand({ kind: 'battery' });
		assert.equal(result.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
		assert.ok(result.payload.length > 0);
	});

	it('builds ports command as direct command with reply', () => {
		const result = buildCommand({ kind: 'ports' });
		assert.equal(result.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
		// Global allocation header should be 48 bytes
		const globalBytes = readUint16le(result.payload, 0);
		assert.equal(globalBytes, 48);
	});

	it('builds buttons command as direct command with reply', () => {
		const result = buildCommand({ kind: 'buttons' });
		assert.equal(result.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
		const globalBytes = readUint16le(result.payload, 0);
		assert.equal(globalBytes, 6);
	});

	it('builds info command as direct command with reply', () => {
		const result = buildCommand({ kind: 'info' });
		assert.equal(result.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
		const globalBytes = readUint16le(result.payload, 0);
		assert.equal(globalBytes, 56); // 16+8+8+12+12
	});

	it('builds fs:list as system command', () => {
		const result = buildCommand({ kind: 'fs:list', path: '/home' });
		assert.equal(result.type, EV3_COMMAND.SYSTEM_COMMAND_REPLY);
	});

	it('builds fs:write as system command', () => {
		const result = buildCommand({ kind: 'fs:write', path: '/test.txt', content: 'hello' });
		assert.equal(result.type, EV3_COMMAND.SYSTEM_COMMAND_REPLY);
	});

	it('builds fs:delete as system command', () => {
		const result = buildCommand({ kind: 'fs:delete', path: '/test.txt' });
		assert.equal(result.type, EV3_COMMAND.SYSTEM_COMMAND_REPLY);
	});
});

// ── Response parser ─────────────────────────────────────────────────

describe('ev3Responses — parseResponse', () => {
	function makeReply(type: number, payload: Uint8Array): Ev3Packet {
		return { messageCounter: 1, type, payload };
	}

	it('parses battery response', () => {
		const payload = new Uint8Array(4);
		new DataView(payload.buffer).setFloat32(0, 0.35, true);
		const result = parseResponse(
			{ kind: 'battery' },
			makeReply(EV3_REPLY.DIRECT_REPLY, payload),
		);
		assert.equal(result.kind, 'battery');
		assert.ok((result as { level: number }).level > 0);
	});

	it('parses buttons response', () => {
		const payload = new Uint8Array([1, 0, 0, 0, 1, 0]);
		const result = parseResponse(
			{ kind: 'buttons' },
			makeReply(EV3_REPLY.DIRECT_REPLY, payload),
		);
		assert.equal(result.kind, 'buttons');
		const state = (result as { state: Record<string, boolean> }).state;
		assert.equal(state['up'], true);
		assert.equal(state['enter'], false);
		assert.equal(state['left'], true);
	});

	it('parses ports response with all empty', () => {
		const payload = new Uint8Array(48).fill(126);
		const result = parseResponse(
			{ kind: 'ports' },
			makeReply(EV3_REPLY.DIRECT_REPLY, payload),
		);
		assert.equal(result.kind, 'ports');
		const ports = result as { motorPorts: unknown[]; sensorPorts: unknown[] };
		assert.equal(ports.sensorPorts.length, 4);
		assert.equal(ports.motorPorts.length, 4);
	});

	it('throws on direct reply error', () => {
		assert.throws(() => {
			parseResponse(
				{ kind: 'battery' },
				makeReply(EV3_REPLY.DIRECT_REPLY_ERROR, new Uint8Array()),
			);
		}, /direct command error/i);
	});

	it('throws on system reply error', () => {
		assert.throws(() => {
			parseResponse(
				{ kind: 'fs:list', path: '/bad' },
				makeReply(EV3_REPLY.SYSTEM_REPLY_ERROR, new Uint8Array([0x06])),
			);
		}, /system command error/i);
	});

	it('parses fs:write response', () => {
		const result = parseResponse(
			{ kind: 'fs:write', path: '/test', content: 'x' },
			makeReply(EV3_REPLY.SYSTEM_REPLY, new Uint8Array([0x00])),
		);
		assert.equal(result.kind, 'fs:write');
	});

	it('parses fs:delete response', () => {
		const result = parseResponse(
			{ kind: 'fs:delete', path: '/test' },
			makeReply(EV3_REPLY.SYSTEM_REPLY, new Uint8Array([0x00])),
		);
		assert.equal(result.kind, 'fs:delete');
		assert.equal((result as { deleted: boolean }).deleted, true);
	});
});
