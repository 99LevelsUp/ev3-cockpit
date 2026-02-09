import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	PendingReply,
	getMessageCounter,
	drainPendingReply,
	rejectPendingReply,
	extractLengthPrefixedPacket
} from '../transport/pendingReply';

function createFakePendingReply(
	expectedMessageCounter?: number
): PendingReply & { resolved?: Uint8Array; rejected?: unknown; cleanedUp: boolean } {
	const state: PendingReply & { resolved?: Uint8Array; rejected?: unknown; cleanedUp: boolean } = {
		resolve: (packet) => { state.resolved = packet; },
		reject: (error) => { state.rejected = error; },
		cleanup: () => { state.cleanedUp = true; },
		cleanedUp: false,
		expectedMessageCounter
	};
	return state;
}

/** Build a minimal EV3 packet with 2-byte length prefix + 2-byte message counter + body. */
function buildPacket(messageCounter: number, bodyBytes: number[] = []): Buffer {
	const body = Buffer.alloc(2 + bodyBytes.length);
	body.writeUInt16LE(messageCounter, 0);
	Buffer.from(bodyBytes).copy(body, 2);
	const header = Buffer.alloc(2);
	header.writeUInt16LE(body.length, 0);
	return Buffer.concat([header, body]);
}

describe('getMessageCounter', () => {
	it('extracts counter from a valid packet', () => {
		const packet = buildPacket(42);
		// skip the 2-byte length prefix for the wire-level packet view
		const wirePacket = new Uint8Array(packet);
		assert.equal(getMessageCounter(wirePacket), 42);
	});

	it('returns -1 for a packet shorter than 4 bytes', () => {
		assert.equal(getMessageCounter(new Uint8Array([0x01, 0x02, 0x03])), -1);
	});
});

describe('extractLengthPrefixedPacket', () => {
	it('extracts a complete packet and returns remaining buffer', () => {
		const pkt = buildPacket(1, [0xAA, 0xBB]);
		const trailing = Buffer.from([0xFF, 0xFE]);
		const buf = Buffer.concat([pkt, trailing]);

		const result = extractLengthPrefixedPacket(buf);
		assert.ok(result);
		assert.deepEqual(Buffer.from(result.packet), pkt);
		assert.deepEqual(result.remaining, trailing);
	});

	it('returns undefined when buffer is too short for length header', () => {
		assert.equal(extractLengthPrefixedPacket(Buffer.from([0x05])), undefined);
	});

	it('returns undefined when buffer has header but incomplete body', () => {
		const buf = Buffer.alloc(2);
		buf.writeUInt16LE(10, 0); // claims 10 bytes body but nothing follows
		assert.equal(extractLengthPrefixedPacket(buf), undefined);
	});

	it('handles zero-length body packet', () => {
		const buf = Buffer.alloc(2);
		buf.writeUInt16LE(0, 0);
		const result = extractLengthPrefixedPacket(buf);
		assert.ok(result);
		assert.equal(result.packet.length, 2);
		assert.equal(result.remaining.length, 0);
	});
});

describe('drainPendingReply', () => {
	it('returns undefined when no pending reply', () => {
		assert.equal(drainPendingReply(undefined, () => undefined), undefined);
	});

	it('resolves when packet matches expected counter', () => {
		const pkt = buildPacket(7, [0x01]);
		const pending = createFakePendingReply(7);
		const extractOnce = (() => {
			let called = false;
			return () => {
				if (!called) { called = true; return new Uint8Array(pkt); }
				return undefined;
			};
		})();

		const result = drainPendingReply(pending, extractOnce);
		assert.equal(result, undefined);
		assert.ok(pending.resolved);
		assert.ok(pending.cleanedUp);
	});

	it('resolves when no expected counter (any packet matches)', () => {
		const pkt = buildPacket(99);
		const pending = createFakePendingReply(); // no expectedMessageCounter
		const result = drainPendingReply(pending, () => {
			const p = new Uint8Array(pkt);
			// return once then undefined
			pkt.fill(0);
			return p.length > 0 ? p : undefined;
		});
		assert.equal(result, undefined);
		assert.ok(pending.resolved);
	});

	it('skips non-matching packets and keeps pending if none match', () => {
		const pkt = buildPacket(5);
		const pending = createFakePendingReply(99);
		let calls = 0;
		const result = drainPendingReply(pending, () => {
			if (calls++ === 0) return new Uint8Array(pkt);
			return undefined;
		});
		assert.equal(result, pending); // still pending
		assert.equal(pending.resolved, undefined);
	});
});

describe('rejectPendingReply', () => {
	it('returns undefined when no pending reply', () => {
		assert.equal(rejectPendingReply(undefined, new Error('x')), undefined);
	});

	it('rejects and cleans up a pending reply', () => {
		const pending = createFakePendingReply();
		const err = new Error('connection lost');
		const result = rejectPendingReply(pending, err);
		assert.equal(result, undefined);
		assert.equal(pending.rejected, err);
		assert.ok(pending.cleanedUp);
	});
});
