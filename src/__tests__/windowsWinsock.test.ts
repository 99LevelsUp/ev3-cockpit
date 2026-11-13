/**
 * Unit tests for the Winsock2 binding layer: what {@link bindWinsock2} makes of the raw `ws2_32.dll`
 * calls, driven by a fake of them. The same defects the Linux socket binding had in review (step 7
 * U1) are checked here: a failed `select` read as "still connecting", a failed `getsockopt` read
 * as success, a length larger than the buffer handed to native code, and a MAC taken from any
 * string that happens to hold twelve hex digits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FdSet, RawWinsock2, SOCKET_ERROR, SocketHandle, bindWinsock2, macToBtAddr } from '../transports/windowsWinsock';

const SOL_SOCKET = 0xffff;
const SO_ERROR = 0x1007;

/** The raw calls, each answering what a test sets. */
function raw(overrides: Partial<RawWinsock2> = {}) {
	const calls: { name: string; args: unknown[] }[] = [];
	let lastError = 0;
	const note = (name: string, args: unknown[]) => { calls.push({ name, args }); };
	const fake: RawWinsock2 = {
		socket: (...args) => { note('socket', args); return 42; },
		connect: (...args) => { note('connect', args); return 0; },
		send: (...args) => { note('send', args); return args[2]; },
		recv: (...args) => { note('recv', args); return 0; },
		closesocket: (...args) => { note('closesocket', args); return 0; },
		select: (...args) => { note('select', args); return 0; },
		ioctlsocket: (...args) => { note('ioctlsocket', args); return 0; },
		getsockopt: (...args) => { note('getsockopt', args); return 0; },
		WSAGetLastError: () => lastError,
		...overrides,
	};
	return { fake, calls, failWith(code: number) { lastError = code; } };
}

/** Which of `select`'s three sets carried the socket. */
const setOf = (args: unknown[]): 'read' | 'write' | 'except' | undefined => {
	const [, read, write, except] = args as (FdSet | null)[];
	return read ? 'read' : write ? 'write' : except ? 'except' : undefined;
};

describe('windowsWinsock binding — a connect in progress', () => {
	it('is connected when the socket is writable, failed when it is in the exception set, pending otherwise', () => {
		for (const [ready, expected] of [['write', 'connected'], ['except', 'failed'], [undefined, 'pending']] as const) {
			const r = raw({ select: (...args) => (setOf(args) === ready ? 1 : 0) });
			assert.equal(bindWinsock2(r.fake).connectState(42 as SocketHandle), expected);
		}
	});

	it('reports a select that itself failed as a failed connect, not as one still under way', () => {
		// Read as "pending", the open would poll a dead socket until its deadline and then
		// call it a timeout: the wrong diagnosis, given late.
		for (const failing of ['write', 'except'] as const) {
			const r = raw({ select: (...args) => (setOf(args) === failing ? SOCKET_ERROR : 0) });
			assert.equal(bindWinsock2(r.fake).connectState(42 as SocketHandle), 'failed', `select on the ${failing} set failed`);
		}
	});

	it("reads the connect's own error from SO_ERROR", () => {
		const r = raw({ getsockopt: (_s, level, name, value) => { assert.deepEqual([level, name], [SOL_SOCKET, SO_ERROR]); value[0] = 10061; return 0; } });
		assert.equal(bindWinsock2(r.fake).socketError(42 as SocketHandle), 10061);
	});

	it('reports why getsockopt failed rather than an error code it never wrote', () => {
		const r = raw({ getsockopt: () => SOCKET_ERROR });
		r.failWith(10038);
		assert.equal(bindWinsock2(r.fake).socketError(42 as SocketHandle), 10038);
	});
});

describe('windowsWinsock binding — lengths handed to native code', () => {
	it('passes the length and no flags through', () => {
		const r = raw();
		const api = bindWinsock2(r.fake);
		api.send(42 as SocketHandle, new Uint8Array(8), 8);
		api.recv(42 as SocketHandle, new Uint8Array(8), 5);
		assert.deepEqual(r.calls.filter((c) => c.name !== 'select').map((c) => [c.name, c.args[2], c.args[3]]),
			[['send', 8, 0], ['recv', 5, 0]]);
	});

	it('refuses a length the buffer does not have, before native code reads or writes past it', () => {
		const r = raw();
		const api = bindWinsock2(r.fake);
		for (const length of [9, -1, 1.5, Number.NaN]) {
			assert.throws(() => api.send(42 as SocketHandle, new Uint8Array(8), length), RangeError, `send ${length}`);
			assert.throws(() => api.recv(42 as SocketHandle, new Uint8Array(8), length), RangeError, `recv ${length}`);
		}
		assert.deepEqual(r.calls, [], 'nothing reached ws2_32');
	});

	it('takes the length of a view, not of the buffer under it', () => {
		const r = raw();
		const view = new Uint8Array(new ArrayBuffer(16), 4, 8);
		assert.throws(() => bindWinsock2(r.fake).recv(42 as SocketHandle, view, 12), RangeError);
	});
});

describe('windowsWinsock — MAC addresses', () => {
	it('accepts six hex bytes with colons, with dashes, or with nothing between them', () => {
		for (const mac of ['00:16:53:f0:0a:0a', '00-16-53-F0-0A-0A', '001653f00a0a']) {
			assert.equal(macToBtAddr(mac), 0x001653f00a0an, mac);
		}
	});

	it('refuses anything else, rather than picking twelve hex digits out of it', () => {
		for (const mac of ['xx:00:16:53:f0:0a:0a', '00:16:53-f0:0a:0a', '0016.53f0.0a0a', '0:16:53:f0:0a:0a0',
			'00:16:53:f0:0a:0g', ' 00:16:53:f0:0a:0a', '00:16:53:f0:0a:0a:', 'mac 001653f00a0a']) {
			assert.equal(macToBtAddr(mac), undefined, mac);
		}
	});
});
