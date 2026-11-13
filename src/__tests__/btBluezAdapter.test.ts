/**
 * Unit tests for {@link BtBluezAdapter} (step-7 plan, U2), driven by a fake libc.
 *
 * The same paths as the Winsock adapter's — a connect that never answers, a short write, a peer
 * that hangs up, "this host has no Bluetooth" against "this brick did not answer" — plus what is
 * Linux's own: errno instead of WSA codes, `EBUSY` from a channel closed a moment ago (measured
 * on HOSTC, 11.11.2026), and a non-blocking socket whose `recv` may answer `EAGAIN`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BtBluezAdapter } from '../transports/btBluezAdapter';
import {
	LinuxBtSocketApi, AF_BLUETOOTH, BTPROTO_RFCOMM, SOCK_STREAM, SOCK_NONBLOCK, SOCK_CLOEXEC,
	EINPROGRESS, EAGAIN, EBUSY, ECONNREFUSED, EHOSTDOWN, ETIMEDOUT,
} from '../transports/linuxBluetoothSocket';
import { BackendUnavailableError, BrickUnreachableError, TimeoutError, TransportError } from '../errors/CockpitError';

const MAC = '00:16:53:F0:0A:0B';
const EAFNOSUPPORT = 97;
const EACCES = 13;

/** A libc that does whatever a test needs it to. */
class FakeLibc implements LinuxBtSocketApi {
	fd = 20;
	socketArgs?: [number, number, number];
	/** `connect` answers: 0 connected at once, or -1 with {@link connectErrno}. */
	connectResult = -1;
	connectErrno = EINPROGRESS;
	state: 'pending' | 'connected' | 'failed' = 'pending';
	soError = 0;
	lastAddress?: Uint8Array;
	errnoNow = 0;
	closed: number[] = [];
	sent: Uint8Array[] = [];
	acceptBytes?: number;
	sendResult?: number;
	inbound: Uint8Array[] = [];
	/** After `inbound` runs dry while data is reported: 0 an orderly close, -1 with {@link recvErrno}. */
	recvAtEnd?: number;
	recvErrno = EAGAIN;

	socket(family: number, type: number, protocol: number): number {
		this.socketArgs = [family, type, protocol];
		return this.fd;
	}
	connect(_fd: number, address: Uint8Array): number {
		this.lastAddress = Uint8Array.from(address);
		this.errnoNow = this.connectErrno;
		return this.connectResult;
	}
	connectState(): 'pending' | 'connected' | 'failed' { return this.state; }
	socketError(): number { return this.soError; }
	send(_fd: number, data: Uint8Array, length: number): number {
		if (this.sendResult !== undefined) { this.errnoNow = 104; return this.sendResult; }
		const accepted = Math.min(this.acceptBytes ?? length, length);
		this.sent.push(Uint8Array.from(data.subarray(0, accepted)));
		return accepted;
	}
	recv(_fd: number, buffer: Uint8Array, length: number): number {
		const chunk = this.inbound.shift();
		if (!chunk) {
			const end = this.recvAtEnd ?? -1;
			this.recvAtEnd = undefined;
			this.errnoNow = this.recvErrno;
			return end;
		}
		const copied = Math.min(chunk.length, length);
		buffer.set(chunk.subarray(0, copied));
		return copied;
	}
	close(fd: number): number { this.closed.push(fd); return 0; }
	hasPendingData(): boolean { return this.inbound.length > 0 || this.recvAtEnd !== undefined; }
	lastError(): number { return this.errnoNow; }
}

function reply(counter: number, payload: number[] = [0x02]): Uint8Array {
	const body = [counter & 0xff, (counter >> 8) & 0xff, ...payload];
	return Uint8Array.from([body.length & 0xff, (body.length >> 8) & 0xff, ...body]);
}

function request(counter: number): Uint8Array {
	return reply(counter, [0x00, 0x00, 0x00]);
}

async function opened(libc = new FakeLibc()): Promise<{ adapter: BtBluezAdapter; libc: FakeLibc }> {
	libc.connectResult = 0;
	const adapter = new BtBluezAdapter({ mac: MAC, socketApi: libc });
	await adapter.open();
	return { adapter, libc };
}

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('BtBluezAdapter — opening', () => {
	it('opens a non-blocking RFCOMM socket to channel 1 at the brick, address reversed', async () => {
		const libc = new FakeLibc();
		libc.connectResult = 0;
		const adapter = new BtBluezAdapter({ mac: MAC, socketApi: libc });
		await adapter.open();
		assert.deepEqual(libc.socketArgs, [AF_BLUETOOTH, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, BTPROTO_RFCOMM]);
		assert.deepEqual([...libc.lastAddress!], [31, 0, 0x0b, 0x0a, 0xf0, 0x53, 0x16, 0x00, 1, 0]);
		assert.equal(adapter.isOpen, true);
		await adapter.close();
	});

	it('waits out EINPROGRESS without blocking, then counts as open', async () => {
		const libc = new FakeLibc();
		const adapter = new BtBluezAdapter({ mac: MAC, socketApi: libc, connectTimeoutMs: 2000 });
		const opening = adapter.open();
		await tick(80);
		assert.equal(adapter.isOpen, false);
		libc.state = 'connected';
		await opening;
		assert.equal(adapter.isOpen, true);
		await adapter.close();
	});

	it('reports a host with no Bluetooth stack as backend-unavailable, not a failed connect', async () => {
		const libc = new FakeLibc();
		libc.fd = -1;
		libc.errnoNow = EAFNOSUPPORT;
		const adapter = new BtBluezAdapter({ mac: MAC, socketApi: libc });
		const error = await adapter.open().then(() => undefined, (e: unknown) => e);
		assert.ok(error instanceof BackendUnavailableError, `got ${String(error)}`);
		assert.match((error as Error).message, /errno 97/);
	});

	it('refuses something that is not a MAC before touching the radio', async () => {
		const libc = new FakeLibc();
		const adapter = new BtBluezAdapter({ mac: 'not a mac', socketApi: libc });
		await assert.rejects(() => adapter.open(), BackendUnavailableError);
		assert.equal(libc.socketArgs, undefined);
	});

	for (const [name, code] of [['EHOSTDOWN', EHOSTDOWN], ['ECONNREFUSED', ECONNREFUSED], ['ETIMEDOUT', ETIMEDOUT], ['EBUSY', EBUSY]] as const) {
		it(`reads ${name} as a brick that did not answer, and closes the socket`, async () => {
			const libc = new FakeLibc();
			const adapter = new BtBluezAdapter({ mac: MAC, socketApi: libc });
			const opening = adapter.open();
			libc.state = 'failed';
			libc.soError = code;
			const error = await opening.then(() => undefined, (e: unknown) => e);
			assert.ok(error instanceof BrickUnreachableError, `got ${String(error)}`);
			assert.match((error as Error).message, new RegExp(`errno ${code}`));
			assert.deepEqual(libc.closed, [20]);
		});
	}

	it('says EBUSY means the brick\'s channel was closed a moment ago', async () => {
		const libc = new FakeLibc();
		libc.connectErrno = EBUSY;
		const adapter = new BtBluezAdapter({ mac: MAC, socketApi: libc });
		await assert.rejects(() => adapter.open(), /closed a moment ago/);
	});

	it('reads any other errno as an ordinary transport failure', async () => {
		const libc = new FakeLibc();
		libc.connectErrno = EACCES;
		const adapter = new BtBluezAdapter({ mac: MAC, socketApi: libc });
		const error = await adapter.open().then(() => undefined, (e: unknown) => e);
		assert.ok(error instanceof TransportError);
		assert.ok(!(error instanceof BrickUnreachableError));
		assert.ok(!(error instanceof BackendUnavailableError));
		assert.deepEqual(libc.closed, [20]);
	});

	it('gives up on a connect that never answers, closes the socket, and adopts nothing later', async () => {
		const libc = new FakeLibc();
		const adapter = new BtBluezAdapter({ mac: MAC, socketApi: libc, connectTimeoutMs: 120 });
		await assert.rejects(() => adapter.open(), TimeoutError);
		assert.deepEqual(libc.closed, [20]);
		libc.state = 'connected';
		await tick(80);
		assert.equal(adapter.isOpen, false);
	});
});

describe('BtBluezAdapter — exchanges', () => {
	it('returns the reply whose counter matches the request', async () => {
		const { adapter, libc } = await opened();
		libc.inbound.push(reply(7), reply(8));
		const answer = await adapter.send(request(8), { expectedMessageCounter: 8, timeoutMs: 1000 });
		assert.deepEqual([...answer], [...reply(8)]);
		await adapter.close();
	});

	it('reassembles a reply split across two reads', async () => {
		const { adapter, libc } = await opened();
		const whole = reply(3, [0x02, 0x41, 0x42, 0x43]);
		libc.inbound.push(whole.subarray(0, 3), whole.subarray(3));
		const answer = await adapter.send(request(3), { expectedMessageCounter: 3, timeoutMs: 1000 });
		assert.deepEqual([...answer], [...whole]);
		await adapter.close();
	});

	it('writes the whole packet even when the stack takes it in pieces', async () => {
		const { adapter, libc } = await opened();
		libc.acceptBytes = 2;
		libc.inbound.push(reply(1));
		await adapter.send(request(1), { expectedMessageCounter: 1, timeoutMs: 1000 });
		assert.deepEqual([...Buffer.concat(libc.sent.map((c) => Buffer.from(c)))], [...request(1)]);
		await adapter.close();
	});

	it('fails the exchange when the write is refused', async () => {
		const { adapter, libc } = await opened();
		libc.sendResult = -1;
		await assert.rejects(() => adapter.send(request(1), { timeoutMs: 1000 }), /send failed \(errno 104\)/);
		await adapter.close();
	});

	it('fails the exchange rather than spinning when the write stalls at zero', async () => {
		const { adapter, libc } = await opened();
		libc.sendResult = 0;
		await assert.rejects(() => adapter.send(request(1), { timeoutMs: 1000 }), /stalled/);
		await adapter.close();
	});

	it('takes EAGAIN on a read as nothing yet, not as a failure', async () => {
		const { adapter, libc } = await opened();
		libc.recvAtEnd = -1;
		libc.recvErrno = EAGAIN;
		const pending = adapter.send(request(4), { expectedMessageCounter: 4, timeoutMs: 1000 });
		await tick(30);
		libc.inbound.push(reply(4));
		const answer = await pending;
		assert.equal(answer[2], 4);
		assert.equal(adapter.isOpen, true);
		await adapter.close();
	});

	it('fails the outstanding exchange when the brick hangs up, and counts as closed', async () => {
		const { adapter, libc } = await opened();
		libc.recvAtEnd = 0;
		await assert.rejects(() => adapter.send(request(1), { timeoutMs: 1000 }), /closed by the brick/);
		assert.equal(adapter.isOpen, false);
	});

	it('fails the outstanding exchange on a read error other than EAGAIN', async () => {
		const { adapter, libc } = await opened();
		libc.recvAtEnd = -1;
		libc.recvErrno = 104;
		await assert.rejects(() => adapter.send(request(1), { timeoutMs: 1000 }), /receive failed \(errno 104\)/);
		assert.equal(adapter.isOpen, false);
	});

	it('refuses a second exchange while one is outstanding', async () => {
		const { adapter } = await opened();
		const first = adapter.send(request(1), { timeoutMs: 200 });
		await assert.rejects(() => adapter.send(request(2), { timeoutMs: 200 }), /in-flight/);
		await assert.rejects(() => first);
		await adapter.close();
	});

	it('times out an exchange the brick never answers, and stays usable afterwards', async () => {
		const { adapter, libc } = await opened();
		await assert.rejects(() => adapter.send(request(1), { timeoutMs: 60 }), TimeoutError);
		libc.inbound.push(reply(2));
		const answer = await adapter.send(request(2), { expectedMessageCounter: 2, timeoutMs: 1000 });
		assert.equal(answer[2], 2);
		await adapter.close();
	});

	it('closes the descriptor, rejects what is outstanding, and refuses a send once closed', async () => {
		const { adapter, libc } = await opened();
		const pending = adapter.send(request(1), { timeoutMs: 1000 });
		await adapter.close();
		await assert.rejects(() => pending, /closed/);
		assert.deepEqual(libc.closed, [20]);
		await assert.rejects(() => adapter.send(request(2)), /not open/);
	});
});
