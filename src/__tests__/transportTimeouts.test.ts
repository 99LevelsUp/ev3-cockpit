/**
 * Round-trip timeouts and adapter recovery.
 *
 * The TCP adapter is driven against a local fake brick, which makes the wedge
 * regression reproducible without hardware: before timeouts existed, one unanswered
 * send left the adapter permanently rejecting with "already has in-flight send
 * request", so a single silent brick killed the session for good.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as net from 'node:net';

import { BtSppAdapter } from '../transports/btSppAdapter';
import { createPendingReply } from '../transports/pendingReply';
import { TcpSocketAdapter } from '../transports/tcpSocketAdapter';
import { TimeoutError, TransportError } from '../errors/CockpitError';
import { waitFor } from './waitFor';

// ═══════════════════════════════════════════════════════════════════════
// createPendingReply
// ═══════════════════════════════════════════════════════════════════════

describe('createPendingReply', () => {
	it('fails the exchange with a TimeoutError once the budget expires', async () => {
		let failure: unknown;
		const pending = createPendingReply({
			resolve: () => { /* not reached */ },
			reject: () => { /* not reached */ },
			fail: (error) => { failure = error; },
			timeoutMs: 30,
			transport: 'TEST',
		});

		await waitFor(() => failure !== undefined, 2000);
		assert.ok(failure instanceof TimeoutError, 'expected a TimeoutError');
		assert.match((failure as Error).message, /TEST send timed out after 30 ms/);
		pending.cleanup();
	});

	it('does not fire once cleanup has run, so a resolved exchange stays resolved', async () => {
		let failed = false;
		const pending = createPendingReply({
			resolve: () => { /* not reached */ },
			reject: () => { /* not reached */ },
			fail: () => { failed = true; },
			timeoutMs: 25,
			transport: 'TEST',
		});

		pending.cleanup();
		await new Promise<void>((r) => setTimeout(r, 120));
		assert.equal(failed, false, 'cleanup must cancel the timer');
	});

	it('fails on abort with a TransportError rather than a timeout', async () => {
		const controller = new AbortController();
		let failure: unknown;
		const pending = createPendingReply({
			resolve: () => { /* not reached */ },
			reject: () => { /* not reached */ },
			fail: (error) => { failure = error; },
			timeoutMs: 5000,
			signal: controller.signal,
			transport: 'TEST',
		});

		controller.abort();
		await waitFor(() => failure !== undefined, 2000);
		assert.ok(failure instanceof TransportError);
		assert.ok(!(failure instanceof TimeoutError), 'abort is not a timeout');
		pending.cleanup();
	});

	it('never arms a timer when the budget is zero', async () => {
		let failed = false;
		const pending = createPendingReply({
			resolve: () => { /* not reached */ },
			reject: () => { /* not reached */ },
			fail: () => { failed = true; },
			timeoutMs: 0,
			transport: 'TEST',
		});

		await new Promise<void>((r) => setTimeout(r, 80));
		assert.equal(failed, false);
		pending.cleanup();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// TCP adapter against a fake brick
// ═══════════════════════════════════════════════════════════════════════

/** A reply the adapter will accept: length prefix, message counter, type, one byte. */
function replyPacket(counter: number): Buffer {
	const body = Buffer.from([counter & 0xff, (counter >> 8) & 0xff, 0x02, 0x00]);
	const out = Buffer.alloc(2 + body.length);
	out.writeUInt16LE(body.length, 0);
	body.copy(out, 2);
	return out;
}

/**
 * Fake brick that completes the unlock handshake, ignores the first command, and
 * answers the second. Ignoring then answering is what proves recovery: the adapter
 * has to survive the abandoned exchange to get the second reply at all.
 */
function startFakeBrick(): Promise<{ port: number; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		let commands = 0;
		const server = net.createServer((socket) => {
			socket.on('data', () => {
				if (commands === 0) {
					// The unlock request. Anything matching /accept\s*:\s*ev3/i satisfies it.
					socket.write('Accept:EV340\r\n\r\n');
					commands += 1;
					return;
				}
				commands += 1;
				if (commands === 3) {
					socket.write(replyPacket(2));
				}
				// commands === 2 is the first real command and goes unanswered on purpose.
			});
			socket.on('error', () => { /* the test tears the socket down */ });
		});
		server.listen(0, '127.0.0.1', () => {
			const address = server.address() as net.AddressInfo;
			resolve({
				port: address.port,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

describe('TcpSocketAdapter — timeout and recovery', () => {
	it('times out an unanswered send and stays usable for the next one', async () => {
		const brick = await startFakeBrick();
		const adapter = new TcpSocketAdapter({
			host: '127.0.0.1',
			port: brick.port,
			useDiscovery: false,
			handshakeTimeoutMs: 3000,
		});

		try {
			await adapter.open();
			assert.equal(adapter.isOpen, true);

			const packet = new Uint8Array([0x04, 0x00, 0x01, 0x00, 0x00, 0x00]);

			// The fake brick deliberately ignores this one.
			await assert.rejects(
				() => adapter.send(packet, { timeoutMs: 150, expectedMessageCounter: 1 }),
				(error: unknown) => {
					assert.ok(error instanceof TimeoutError, 'expected TimeoutError');
					assert.match((error as Error).message, /timed out/);
					return true;
				}
			);

			// The regression: this used to reject with "already has in-flight send
			// request" forever, because the abandoned exchange was never cleared.
			const reply = await adapter.send(packet, { timeoutMs: 3000, expectedMessageCounter: 2 });
			assert.ok(reply.length > 0, 'the adapter recovered and received a reply');
		} finally {
			await adapter.close().catch(() => { /* best effort */ });
			await brick.close();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// BtSppAdapter — the open deadline
// ═══════════════════════════════════════════════════════════════════════

describe('BtSppAdapter open deadline', () => {
	/** A port whose open() never calls back until the test lets it. */
	function slowPort() {
		let release: (() => void) | undefined;
		const port = {
			isOpen: false,
			closed: 0,
			open(cb?: (err?: Error | null) => void) {
				release = () => { port.isOpen = true; cb?.(null); };
			},
			close(cb?: (err?: Error | null) => void) {
				port.closed += 1;
				port.isOpen = false;
				cb?.(null);
			},
			write() { return true; },
			on() { return port; },
			removeAllListeners() { return port; },
			set(_o: { dtr?: boolean }, cb?: (err?: Error | null) => void) { cb?.(null); },
		};
		return { port, open: () => release?.() };
	}

	it('gives up on a port that never opens', async () => {
		const { port } = slowPort();
		const adapter = new BtSppAdapter({
			portPath: 'COM-TEST',
			connectTimeoutMs: 60,
			serialPortFactory: () => port as never,
		});

		await assert.rejects(() => adapter.open(), /timed out/);
		assert.equal(adapter.isOpen, false);
	});

	it('releases a port that opens after the deadline passed', async () => {
		// The failure this pins has now been mis-fixed three times. Closing in the catch
		// is a no-op — open is still in flight, serialport answers "Port is not open" —
		// and the handle is orphaned when the callback lands a moment later. On Windows
		// that COM port then refuses every later open until the extension host restarts.
		const { port, open } = slowPort();
		const adapter = new BtSppAdapter({
			portPath: 'COM-TEST',
			connectTimeoutMs: 60,
			serialPortFactory: () => port as never,
		});

		await assert.rejects(() => adapter.open(), /timed out/);
		assert.equal(port.closed, 0, 'nothing to close while the open is still in flight');

		// serialport finally answers, long after we stopped waiting.
		open();
		assert.equal(port.closed, 1, 'the late arrival must be released, not leaked');
		assert.equal(port.isOpen, false);
	});
});
