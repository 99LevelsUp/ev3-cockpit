/**
 * Unit tests for {@link BtWinsockAdapter}, driven by a fake `ws2_32.dll`.
 *
 * The paths worth covering are the ones a radio makes awkward to stage: a connect that
 * never answers, a write the stack only partly accepts, a peer that hangs up mid-exchange,
 * and the difference between "this host has no Bluetooth" and "this brick did not answer".
 * The last one decides whether the provider may try the next backend immediately or has to
 * wait out the channel, so it is not a cosmetic distinction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BtWinsockAdapter } from '../transports/btWinsockAdapter';
import {
	Winsock2Api,
	SocketHandle,
	BluetoothAddress,
	macToBtAddr,
	isInvalidSocket,
	SOCKET_ERROR,
	WSAEWOULDBLOCK,
} from '../transports/windowsWinsock';
import { BackendUnavailableError, BrickUnreachableError, TimeoutError, TransportError } from '../errors/CockpitError';

const MAC = '00:16:53:aa:bb:cc';

/** A `ws2_32.dll` that does whatever a test needs it to. */
class FakeWinsock implements Winsock2Api {
	socketHandle: SocketHandle = 42;
	/** What `connect` returns when not held: `0` connected at once, or SOCKET_ERROR. */
	connectResult = 0;
	/** Starts the connect in the background: pending until {@link finishConnect}. */
	holdConnect = false;
	/** Where a held connect stands, as `connectState` reports it. */
	pending: 'pending' | 'connected' | 'failed' = 'pending';
	/** `SO_ERROR` of a connect that failed in the background. */
	failCode = 0;
	nonBlockingCalls: boolean[] = [];
	connectCalls = 0;
	lastErrorCode = 0;
	closed: SocketHandle[] = [];
	sent: Uint8Array[] = [];
	/** Bytes `send` accepts per call; `undefined` accepts everything offered. */
	acceptBytes?: number;
	sendResult?: number;
	/** Queued inbound chunks, delivered one per `recv`. */
	inbound: Uint8Array[] = [];
	/** Delivered once `inbound` runs dry: `0` is an orderly close. */
	recvAtEnd?: number;

	lastAddress?: BluetoothAddress;

	socket(): SocketHandle {
		return this.socketHandle;
	}

	/** When set, `connect` throws this instead of returning a code. */
	connectThrows?: Error;

	setNonBlocking(_socket: SocketHandle, on: boolean): number {
		this.nonBlockingCalls.push(on);
		return 0;
	}

	connect(_socket: SocketHandle, address: BluetoothAddress): number {
		this.lastAddress = address;
		this.connectCalls += 1;
		if (this.connectThrows) { throw this.connectThrows; }
		if (!this.holdConnect) { return this.connectResult; }
		this.pending = 'pending';
		this.lastErrorCode = WSAEWOULDBLOCK;
		return SOCKET_ERROR;
	}

	connectState(): 'pending' | 'connected' | 'failed' {
		return this.pending;
	}

	socketError(): number {
		return this.failCode;
	}

	/** Lets a held connect land: `0` connected, anything else failed with that code. */
	finishConnect(result: number): void {
		if (result === 0) { this.pending = 'connected'; return; }
		this.pending = 'failed';
		this.failCode = result;
	}

	send(_socket: SocketHandle, data: Uint8Array, length: number): number {
		if (this.sendResult !== undefined) { return this.sendResult; }
		const accepted = Math.min(this.acceptBytes ?? length, length);
		this.sent.push(Uint8Array.from(data.subarray(0, accepted)));
		return accepted;
	}

	recv(_socket: SocketHandle, buffer: Uint8Array, length: number): number {
		const chunk = this.inbound.shift();
		if (!chunk) {
			const end = this.recvAtEnd ?? 0;
			this.recvAtEnd = undefined;
			return end;
		}
		const copied = Math.min(chunk.length, length);
		buffer.set(chunk.subarray(0, copied));
		return copied;
	}

	closesocket(socket: SocketHandle): number {
		this.closed.push(socket);
		return 0;
	}

	hasPendingData(): number {
		return this.inbound.length > 0 || this.recvAtEnd !== undefined ? 1 : 0;
	}

	lastError(): number {
		return this.lastErrorCode;
	}
}

/** A framed EV3 reply: 2-byte little-endian body length, then counter and payload. */
function reply(counter: number, payload: number[] = [0x02]): Uint8Array {
	const body = [counter & 0xff, (counter >> 8) & 0xff, ...payload];
	return Uint8Array.from([body.length & 0xff, (body.length >> 8) & 0xff, ...body]);
}

// ═══════════════════════════════════════════════════════════════════════
// Address helpers
// ═══════════════════════════════════════════════════════════════════════

describe('windowsWinsock address helpers', () => {
	it('keeps MAC byte order, so the first written byte is the most significant', () => {
		assert.equal(macToBtAddr('00:16:53:5d:7e:2d'), 0x0016535d7e2dn);
	});

	it('accepts a MAC with no separators', () => {
		assert.equal(macToBtAddr('0016535d7e2d'), 0x0016535d7e2dn);
	});

	it('rejects anything that is not six hex bytes', () => {
		assert.equal(macToBtAddr('00:16:53'), undefined);
		assert.equal(macToBtAddr(''), undefined);
	});

	it('treats both zero and all-ones as no socket', () => {
		assert.equal(isInvalidSocket(0), true);
		assert.equal(isInvalidSocket(0n), true);
		assert.equal(isInvalidSocket(0xFFFFFFFFFFFFFFFFn), true);
		assert.equal(isInvalidSocket(-1), true);
		assert.equal(isInvalidSocket(42), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Opening
// ═══════════════════════════════════════════════════════════════════════

describe('BtWinsockAdapter — opening', () => {
	it('connects to the requested channel at the brick address', async () => {
		const api = new FakeWinsock();
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });

		await adapter.open();

		assert.equal(adapter.isOpen, true);
		assert.equal(api.lastAddress?.btAddr, 0x001653aabbccn);
		assert.equal(api.lastAddress?.port, 1);
		await adapter.close();
	});

	it('reports a host with no radio as backend-unavailable, not as a failed connect', async () => {
		const api = new FakeWinsock();
		api.socketHandle = 0;
		api.lastErrorCode = 10050;
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });

		await assert.rejects(adapter.open(), (error: unknown) => {
			// The provider reads this type to decide whether the next backend may go
			// immediately. A plain TransportError would make it wait out a channel that
			// was never touched.
			assert.ok(error instanceof BackendUnavailableError);
			return true;
		});
	});

	it('reports a brick that refused the channel as an ordinary transport failure', async () => {
		const api = new FakeWinsock();
		api.connectResult = SOCKET_ERROR;
		api.lastErrorCode = 10060;
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });

		await assert.rejects(adapter.open(), (error: unknown) => {
			assert.ok(error instanceof TransportError);
			assert.ok(!(error instanceof BackendUnavailableError));
			// WSAETIMEDOUT: the brick did not answer, which is what the user is told.
			assert.ok(error instanceof BrickUnreachableError);
			assert.match((error as Error).message, /10060/);
			return true;
		});
		assert.deepEqual(api.closed, [42], 'the refused socket is released');
	});

	it('gives up on a connect that never answers, and closes the socket to abort it', async () => {
		const api = new FakeWinsock();
		api.holdConnect = true;
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api, connectTimeoutMs: 20 });

		await assert.rejects(adapter.open(), TimeoutError);

		// Without this the caller holds the host's only Bluetooth slot for as long as the
		// brick stays silent, which on RFCOMM is indefinitely.
		assert.deepEqual(api.closed, [42]);
		assert.equal(adapter.isOpen, false);
	});

	it('releases the socket when the FFI call itself throws', async () => {
		const api = new FakeWinsock();
		api.connectThrows = new Error('koffi: cannot marshal SOCKADDR_BTH');
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });

		await assert.rejects(adapter.open(), /failed/);

		// Neither the timeout nor the SOCKET_ERROR path runs here, and a handle left open
		// stays charged against the host's one RFCOMM channel with nothing referencing it.
		assert.deepEqual(api.closed, [42]);
	});

	it('does not adopt a connection that lands after it was abandoned', async () => {
		const api = new FakeWinsock();
		api.holdConnect = true;
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api, connectTimeoutMs: 20 });

		const opening = assert.rejects(adapter.open(), TimeoutError);
		await new Promise((resolve) => setTimeout(resolve, 40));
		api.finishConnect(0);
		await opening;

		assert.equal(adapter.isOpen, false, 'a late success must not resurrect the adapter');
	});

	it('connects without blocking, then returns the socket to blocking mode', async () => {
		const api = new FakeWinsock();
		api.holdConnect = true;
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api, connectTimeoutMs: 2000 });

		const opening = adapter.open();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(adapter.isOpen, false, 'still pending, and nothing waited on a thread for it');
		api.finishConnect(0);
		await opening;

		assert.equal(adapter.isOpen, true);
		assert.deepEqual(api.nonBlockingCalls, [true, false]);
		await adapter.close();
	});

	it('reports the error the connect actually ended with', async () => {
		// Read through SO_ERROR on the socket itself. The blocking version read the thread's
		// last error on a different thread from the one that made the call, and reported
		// codes like 10048 and 10038 that had nothing to do with the connect.
		const api = new FakeWinsock();
		api.holdConnect = true;
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api, connectTimeoutMs: 2000 });

		const opening = adapter.open();
		await new Promise((resolve) => setTimeout(resolve, 30));
		api.finishConnect(10064);

		await assert.rejects(opening, /WSA error 10064/);
		assert.deepEqual(api.closed, [42]);
	});

	it('leaves nothing behind after a deadline: the next open reaches the stack at once', async () => {
		// Measured 29.10.2026 with the blocking version: after four deadlines in one process,
		// later connects failed in a millisecond without reaching the radio, and the process
		// could not exit. Nothing here may stay parked once a deadline has passed.
		const api = new FakeWinsock();
		api.holdConnect = true;
		const first = new BtWinsockAdapter({ mac: MAC, winsockApi: api, connectTimeoutMs: 20 });
		await assert.rejects(first.open(), TimeoutError);

		api.holdConnect = false;
		api.connectResult = 0;
		const second = new BtWinsockAdapter({ mac: MAC, winsockApi: api, connectTimeoutMs: 20 });
		await second.open();

		assert.equal(api.connectCalls, 2);
		assert.equal(second.isOpen, true);
		await second.close();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Exchanges
// ═══════════════════════════════════════════════════════════════════════

describe('BtWinsockAdapter — exchanges', () => {
	it('returns the reply whose counter matches the request', async () => {
		const api = new FakeWinsock();
		api.inbound = [reply(7)];
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });
		await adapter.open();

		const answer = await adapter.send(Uint8Array.from([0, 0, 7, 0]), {
			expectedMessageCounter: 7,
		});

		assert.deepEqual(Array.from(answer), Array.from(reply(7)));
		await adapter.close();
	});

	it('reassembles a reply split across two reads', async () => {
		const api = new FakeWinsock();
		const whole = reply(3, [0x02, 0x11, 0x22]);
		api.inbound = [whole.subarray(0, 3), whole.subarray(3)];
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });
		await adapter.open();

		const answer = await adapter.send(Uint8Array.from([0, 0, 3, 0]), {
			expectedMessageCounter: 3,
		});

		assert.deepEqual(Array.from(answer), Array.from(whole));
		await adapter.close();
	});

	it('writes the whole packet even when the stack accepts it in pieces', async () => {
		const api = new FakeWinsock();
		api.acceptBytes = 4;
		api.inbound = [reply(1)];
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });
		await adapter.open();

		const packet = Uint8Array.from([9, 0, 1, 0, 5, 6, 7, 8, 9, 10, 11]);
		await adapter.send(packet, { expectedMessageCounter: 1 });

		// Break the loop in writeAll and this drops to a single 4-byte call: a truncated
		// command the brick still acts on.
		const written = Buffer.concat(api.sent.map((chunk) => Buffer.from(chunk)));
		assert.deepEqual(Array.from(written), Array.from(packet));
		await adapter.close();
	});

	it('fails the exchange when the stack refuses the write', async () => {
		const api = new FakeWinsock();
		api.sendResult = SOCKET_ERROR;
		api.lastErrorCode = 10054;
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });
		await adapter.open();

		await assert.rejects(adapter.send(Uint8Array.from([2, 0, 1, 0])), /10054/);
		await adapter.close();
	});

	it('fails the exchange rather than spinning when the write stalls at zero', async () => {
		const api = new FakeWinsock();
		api.sendResult = 0;
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });
		await adapter.open();

		await assert.rejects(adapter.send(Uint8Array.from([2, 0, 1, 0])), /stalled/);
		await adapter.close();
	});

	it('refuses a second exchange while one is outstanding', async () => {
		const api = new FakeWinsock();
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });
		await adapter.open();

		const first = adapter.send(Uint8Array.from([2, 0, 1, 0]), { timeoutMs: 50 });
		await assert.rejects(
			adapter.send(Uint8Array.from([2, 0, 2, 0])),
			/already has in-flight/
		);

		await assert.rejects(first, TimeoutError);
		await adapter.close();
	});

	it('times out an exchange the brick never answers, and stays usable afterwards', async () => {
		const api = new FakeWinsock();
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });
		await adapter.open();

		await assert.rejects(
			adapter.send(Uint8Array.from([2, 0, 1, 0]), { timeoutMs: 30 }),
			TimeoutError
		);

		api.inbound = [reply(2)];
		const answer = await adapter.send(Uint8Array.from([2, 0, 2, 0]), {
			expectedMessageCounter: 2,
		});
		assert.deepEqual(Array.from(answer), Array.from(reply(2)));
		await adapter.close();
	});

	it('fails the outstanding exchange when the brick hangs up', async () => {
		const api = new FakeWinsock();
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });
		await adapter.open();

		// Winsock reports an orderly shutdown as a readable socket that yields zero bytes.
		// The send budget is left long on purpose: if the close went unnoticed this would
		// fail as a timeout instead, and the two are not the same diagnosis.
		api.recvAtEnd = 0;

		await assert.rejects(
			adapter.send(Uint8Array.from([2, 0, 1, 0]), { timeoutMs: 5000 }),
			/closed by the brick/
		);
		assert.equal(adapter.isOpen, false);
		await adapter.close();
	});

	it('rejects a send once closed', async () => {
		const api = new FakeWinsock();
		const adapter = new BtWinsockAdapter({ mac: MAC, winsockApi: api });
		await adapter.open();
		await adapter.close();

		await assert.rejects(adapter.send(Uint8Array.from([2, 0, 1, 0])), /is not open/);
		assert.deepEqual(api.closed, [42]);
	});
});
