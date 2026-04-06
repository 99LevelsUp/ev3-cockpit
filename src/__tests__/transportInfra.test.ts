/**
 * Unit tests for transport infrastructure:
 * - TransportGuard (rate limiting, firmware safety, degradation)
 * - BtConnectionQueue (serialized RFCOMM, cooldowns, backoff)
 * - PendingReply utilities (message counter matching, drain, length-prefix extraction)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TransportGuard } from '../transports/transportGuard';
import { BtConnectionQueue } from '../transports/btConnectionQueue';
import {
	getMessageCounter,
	drainPendingReply,
	rejectPendingReply,
	extractLengthPrefixedPacket,
	PendingReply,
} from '../transports/pendingReply';

// ═══════════════════════════════════════════════════════════════════════
// TransportGuard
// ═══════════════════════════════════════════════════════════════════════

describe('TransportGuard', () => {
	let guard: TransportGuard;

	beforeEach(() => {
		guard = new TransportGuard({
			maxCommandsPerSec: 3,
			switchCooldownMs: 100,
			degradationThreshold: 2,
		});
	});

	it('allows opening a transport', () => {
		assert.doesNotThrow(() => guard.openTransport('brick1', 'usb'));
	});

	it('rejects opening a different transport while one is active', () => {
		guard.openTransport('brick1', 'usb');
		assert.throws(() => guard.openTransport('brick1', 'tcp'), /already has active transport/);
	});

	it('allows reopening the same transport', () => {
		guard.openTransport('brick1', 'usb');
		assert.doesNotThrow(() => guard.openTransport('brick1', 'usb'));
	});

	it('enforces transport switch cooldown', () => {
		guard.openTransport('brick1', 'usb');
		guard.closeTransport('brick1');
		// Immediately try to open different transport — should fail due to cooldown
		assert.throws(() => guard.openTransport('brick1', 'tcp'), /cooldown/);
	});

	it('allows transport switch after cooldown', async () => {
		guard = new TransportGuard({
			maxCommandsPerSec: 3,
			switchCooldownMs: 10,
			degradationThreshold: 2,
		});
		guard.openTransport('brick1', 'usb');
		guard.closeTransport('brick1');
		await new Promise<void>((r) => setTimeout(r, 15));
		assert.doesNotThrow(() => guard.openTransport('brick1', 'tcp'));
	});

	it('enforces rate limit', () => {
		guard.checkRateLimit('brick1');
		guard.checkRateLimit('brick1');
		guard.checkRateLimit('brick1');
		assert.throws(() => guard.checkRateLimit('brick1'), /Rate limit/);
	});

	it('resets rate limit after 1 second window', async () => {
		guard = new TransportGuard({
			maxCommandsPerSec: 2,
			switchCooldownMs: 100,
			degradationThreshold: 2,
		});
		guard.checkRateLimit('brick1');
		guard.checkRateLimit('brick1');
		assert.throws(() => guard.checkRateLimit('brick1'));
		await new Promise<void>((r) => setTimeout(r, 1050));
		assert.doesNotThrow(() => guard.checkRateLimit('brick1'));
	});

	it('tracks consecutive failures and triggers degradation', () => {
		let degradedBrick: string | undefined;
		let degradedState: boolean | undefined;
		guard = new TransportGuard({
			maxCommandsPerSec: 10,
			switchCooldownMs: 100,
			degradationThreshold: 2,
			onDegradationChange: (id, state) => {
				degradedBrick = id;
				degradedState = state;
			},
		});

		guard.recordFailure('brick1');
		assert.equal(guard.isDegraded('brick1'), false);

		guard.recordFailure('brick1');
		assert.equal(guard.isDegraded('brick1'), true);
		assert.equal(degradedBrick, 'brick1');
		assert.equal(degradedState, true);
	});

	it('blocks sends when degraded', () => {
		guard.recordFailure('brick1');
		guard.recordFailure('brick1');
		assert.throws(() => guard.checkRateLimit('brick1'), /degraded/);
	});

	it('resets degradation on success', () => {
		guard.recordFailure('brick1');
		guard.recordFailure('brick1');
		assert.equal(guard.isDegraded('brick1'), true);

		guard.recordSuccess('brick1');
		assert.equal(guard.isDegraded('brick1'), false);
	});

	it('tracks RTT', () => {
		assert.equal(guard.getLastRttMs('brick1'), undefined);
		guard.recordSuccess('brick1', 42);
		assert.equal(guard.getLastRttMs('brick1'), 42);
	});

	it('forgets brick state', () => {
		guard.recordFailure('brick1');
		guard.forget('brick1');
		assert.equal(guard.isDegraded('brick1'), false);
		assert.equal(guard.getLastRttMs('brick1'), undefined);
	});

	it('disposes all state', () => {
		guard.openTransport('brick1', 'usb');
		guard.dispose();
		// After dispose, brick state is gone — no error for opening
		assert.doesNotThrow(() => guard.openTransport('brick1', 'tcp'));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// BtConnectionQueue
// ═══════════════════════════════════════════════════════════════════════

describe('BtConnectionQueue', () => {
	it('acquires and releases a slot', async () => {
		const queue = new BtConnectionQueue({
			maxConcurrent: 1,
			interConnectionCooldownMs: 0,
			errorRecoveryCooldownMs: 0,
		});
		const release = await queue.acquire('brick1');
		assert.equal(queue.active, 1);
		release();
		assert.equal(queue.active, 0);
	});

	it('serializes concurrent connections', async () => {
		const queue = new BtConnectionQueue({
			maxConcurrent: 1,
			interConnectionCooldownMs: 0,
			errorRecoveryCooldownMs: 0,
		});

		const order: string[] = [];

		const p1 = queue.enqueue('brick1', async () => {
			order.push('start-1');
			await new Promise<void>((r) => setTimeout(r, 20));
			order.push('end-1');
		});

		const p2 = queue.enqueue('brick2', async () => {
			order.push('start-2');
			order.push('end-2');
		});

		await Promise.all([p1, p2]);
		assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
	});

	it('enqueue auto-releases on error', async () => {
		const queue = new BtConnectionQueue({
			maxConcurrent: 1,
			interConnectionCooldownMs: 0,
			errorRecoveryCooldownMs: 0,
		});

		await assert.rejects(async () => {
			await queue.enqueue('brick1', async () => {
				throw new Error('fail');
			});
		}, /fail/);

		assert.equal(queue.active, 0);
	});

	it('dispose rejects pending entries', async () => {
		const queue = new BtConnectionQueue({
			maxConcurrent: 1,
			interConnectionCooldownMs: 50000,
			errorRecoveryCooldownMs: 0,
		});

		// First: acquire and hold to block queue
		const release = await queue.acquire('brick1');

		// Second: enqueue should wait (blocked by active slot)
		const p2 = queue.acquire('brick2').then(
			() => 'resolved',
			() => 'rejected'
		);

		release();

		// Now brick2 would wait for cooldown. Dispose should reject it.
		queue.dispose();
		const result = await p2;
		assert.equal(result, 'rejected');
	});

	it('reports pending count', async () => {
		const queue = new BtConnectionQueue({
			maxConcurrent: 1,
			interConnectionCooldownMs: 0,
			errorRecoveryCooldownMs: 0,
		});

		// Acquire slot
		const release = await queue.acquire('brick1');
		assert.equal(queue.pending, 0);

		// Second acquire will be pending
		const p2 = queue.acquire('brick2');
		// Give the queue time to process
		await new Promise<void>((r) => setTimeout(r, 10));
		assert.equal(queue.pending, 1);

		release();
		await p2.then((rel) => rel());
		assert.equal(queue.pending, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// PendingReply utilities
// ═══════════════════════════════════════════════════════════════════════

describe('PendingReply utilities', () => {
	describe('getMessageCounter', () => {
		it('returns -1 for short packets', () => {
			assert.equal(getMessageCounter(new Uint8Array([1, 2, 3])), -1);
		});

		it('reads 16-bit LE counter from bytes 2-3', () => {
			// bytes: [xx, xx, 0x05, 0x00, xx] → counter = 5
			assert.equal(getMessageCounter(new Uint8Array([0, 0, 5, 0, 0])), 5);
			// bytes: [xx, xx, 0x00, 0x01, xx] → counter = 256
			assert.equal(getMessageCounter(new Uint8Array([0, 0, 0, 1, 0])), 256);
		});
	});

	describe('drainPendingReply', () => {
		it('returns undefined for undefined input', () => {
			assert.equal(drainPendingReply(undefined, () => undefined), undefined);
		});

		it('resolves pending reply on matching counter', () => {
			let resolved: Uint8Array | undefined;
			const pending: PendingReply = {
				resolve: (p) => { resolved = p; },
				reject: () => {},
				cleanup: () => {},
				expectedMessageCounter: 42,
			};

			// Packet with counter = 42 at bytes 2-3
			const packet = new Uint8Array([5, 0, 42, 0, 0x02, 0, 0]);
			const result = drainPendingReply(pending, () => packet);

			assert.equal(result, undefined);
			assert.ok(resolved);
			assert.deepEqual(resolved, packet);
		});

		it('returns pending reply if no match', () => {
			const pending: PendingReply = {
				resolve: () => {},
				reject: () => {},
				cleanup: () => {},
				expectedMessageCounter: 42,
			};

			let called = false;
			const result = drainPendingReply(pending, () => {
				if (called) { return undefined; }
				called = true;
				// Wrong counter
				return new Uint8Array([5, 0, 99, 0, 0x02, 0, 0]);
			});

			assert.equal(result, pending);
		});

		it('resolves without counter check when expectedMessageCounter is undefined', () => {
			let resolved = false;
			const pending: PendingReply = {
				resolve: () => { resolved = true; },
				reject: () => {},
				cleanup: () => {},
			};

			const packet = new Uint8Array([3, 0, 0, 0, 0x02]);
			drainPendingReply(pending, () => packet);
			assert.equal(resolved, true);
		});
	});

	describe('rejectPendingReply', () => {
		it('returns undefined for undefined input', () => {
			assert.equal(rejectPendingReply(undefined, new Error('test')), undefined);
		});

		it('rejects and cleans up', () => {
			let rejected: unknown;
			let cleaned = false;
			const pending: PendingReply = {
				resolve: () => {},
				reject: (e) => { rejected = e; },
				cleanup: () => { cleaned = true; },
			};

			const error = new Error('test');
			const result = rejectPendingReply(pending, error);

			assert.equal(result, undefined);
			assert.equal(rejected, error);
			assert.equal(cleaned, true);
		});
	});

	describe('extractLengthPrefixedPacket', () => {
		it('returns undefined for empty buffer', () => {
			assert.equal(extractLengthPrefixedPacket(Buffer.alloc(0)), undefined);
		});

		it('returns undefined for incomplete buffer', () => {
			// bodyLength = 5, totalLength = 7, but only 4 bytes available
			const buf = Buffer.from([5, 0, 1, 2]);
			assert.equal(extractLengthPrefixedPacket(buf), undefined);
		});

		it('extracts a complete packet', () => {
			// bodyLength = 3, totalLength = 5, buffer has exactly 5 bytes
			const buf = Buffer.from([3, 0, 0xAA, 0xBB, 0xCC]);
			const result = extractLengthPrefixedPacket(buf);
			assert.ok(result);
			assert.deepEqual(result.packet, new Uint8Array([3, 0, 0xAA, 0xBB, 0xCC]));
			assert.equal(result.remaining.length, 0);
		});

		it('returns remaining bytes after packet', () => {
			// bodyLength = 3, totalLength = 5, buffer has 8 bytes (3 remaining)
			const buf = Buffer.from([3, 0, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
			const result = extractLengthPrefixedPacket(buf);
			assert.ok(result);
			assert.deepEqual(result.packet, new Uint8Array([3, 0, 0xAA, 0xBB, 0xCC]));
			assert.equal(result.remaining.length, 3);
			assert.deepEqual([...result.remaining], [0xDD, 0xEE, 0xFF]);
		});
	});
});
