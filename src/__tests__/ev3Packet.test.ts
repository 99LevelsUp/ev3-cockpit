import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND } from '../protocol/ev3Packet';

test('EV3 packet encoder/decoder roundtrip preserves fields', () => {
	const payload = new Uint8Array([0x12, 0x34, 0x56]);
	const encoded = encodeEv3Packet(0x1_0002, EV3_COMMAND.DIRECT_COMMAND_REPLY, payload);
	const decoded = decodeEv3Packet(encoded);

	assert.equal(decoded.messageCounter, 0x0002);
	assert.equal(decoded.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
	assert.deepEqual(Array.from(decoded.payload), [0x12, 0x34, 0x56]);
});

test('EV3 packet decoder rejects packets shorter than minimum header', () => {
	assert.throws(() => decodeEv3Packet(new Uint8Array([0x00, 0x00, 0x00, 0x00])));
});

test('EV3 packet decoder rejects packets with invalid declared body length', () => {
	const malformed = new Uint8Array([0x05, 0x00, 0x01, 0x00, 0x00]);
	assert.throws(() => decodeEv3Packet(malformed));
});

