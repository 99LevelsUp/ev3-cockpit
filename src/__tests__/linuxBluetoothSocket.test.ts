/**
 * The libc bindings behind the Linux Bluetooth transport (step-7 plan, U1).
 *
 * The bytes matter more than the calls: the kernel reads `struct sockaddr_rc` and
 * `struct pollfd` exactly as laid out, and BlueZ's `bdaddr_t` holds the address with its bytes
 * reversed. A wrong order connects to nobody, silently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	AF_BLUETOOTH, BTPROTO_RFCOMM, BTPROTO_L2CAP, SOCK_STREAM, SOCK_SEQPACKET, SOCK_NONBLOCK, SOCK_CLOEXEC,
	EINPROGRESS, EAGAIN, EBUSY, ECONNREFUSED, EHOSTDOWN, EHOSTUNREACH, ETIMEDOUT, EINTR, EBADF, EIO,
	POLLIN, POLLOUT, POLLERR, POLLHUP, POLLNVAL, SOCKADDR_RC_SIZE, MSG_NOSIGNAL,
	macToBdaddr, sockaddrRc, encodePollFd, decodeRevents, loadLinuxBtSocket, resetLinuxBtSocketCache,
	bindLinuxBtSocket, type RawLibc,
} from '../transports/linuxBluetoothSocket';
import { BackendUnavailableError } from '../errors/CockpitError';

describe('linuxBluetoothSocket — constants (Linux, every architecture the cockpit ships)', () => {
	it('uses the kernel values', () => {
		assert.equal(AF_BLUETOOTH, 31);
		assert.equal(BTPROTO_L2CAP, 0);
		assert.equal(BTPROTO_RFCOMM, 3);
		assert.equal(SOCK_STREAM, 1);
		assert.equal(SOCK_SEQPACKET, 5);
		assert.equal(SOCK_NONBLOCK, 0o4000);
		assert.equal(SOCK_CLOEXEC, 0o2000000);
		assert.equal(MSG_NOSIGNAL, 0x4000);
		assert.deepEqual([EAGAIN, EBUSY, ETIMEDOUT, ECONNREFUSED, EHOSTDOWN, EHOSTUNREACH, EINPROGRESS], [11, 16, 110, 111, 112, 113, 115]);
		assert.deepEqual([POLLIN, POLLOUT, POLLERR, POLLHUP, POLLNVAL], [0x1, 0x4, 0x8, 0x10, 0x20]);
		assert.deepEqual([EIO, EBADF, EINTR], [5, 9, 4]);
	});
});

describe('linuxBluetoothSocket — the address', () => {
	it('reverses the bytes, as bdaddr_t holds them', () => {
		assert.deepEqual([...macToBdaddr('00:16:53:F0:0A:0B')!], [0x0b, 0x0a, 0xf0, 0x53, 0x16, 0x00]);
	});

	it('takes any separator, or none, and either case', () => {
		const expected = [...macToBdaddr('00:16:53:F0:0A:0B')!];
		assert.deepEqual([...macToBdaddr('00-16-53-f0-0a-0b')!], expected);
		assert.deepEqual([...macToBdaddr('001653F00A0B')!], expected);
	});

	it('refuses an address with anything before, after or inside it (review of 66cde2b)', () => {
		assert.equal(macToBdaddr('zz00:16:53:F0:0A:0B'), undefined);
		assert.equal(macToBdaddr('00:16:53:F0:0A:0Bzz'), undefined);
		assert.equal(macToBdaddr('00:16:5x3:F0:0A:0B'), undefined);
		assert.equal(macToBdaddr(' 00:16:53:F0:0A:0B'), undefined);
		assert.equal(macToBdaddr('00:16-53:F0:0A:0B'), undefined, 'one separator throughout');
		assert.equal(macToBdaddr('0016:53F0:0A0B'), undefined);
	});

	it('refuses anything that is not six bytes', () => {
		assert.equal(macToBdaddr('00:16:53:F0:0A'), undefined);
		assert.equal(macToBdaddr('00:16:53:F0:0A:0B:0C'), undefined);
		assert.equal(macToBdaddr('not a mac'), undefined);
	});
});

describe('linuxBluetoothSocket — struct sockaddr_rc', () => {
	it('is family, the reversed address, the channel, then padding: ten bytes', () => {
		const bytes = sockaddrRc('00:16:53:F0:0A:0B', 1)!;
		assert.equal(SOCKADDR_RC_SIZE, 10);
		assert.equal(bytes.length, SOCKADDR_RC_SIZE);
		assert.deepEqual([...bytes], [31, 0, 0x0b, 0x0a, 0xf0, 0x53, 0x16, 0x00, 1, 0]);
	});

	it('refuses a bad address or a channel outside 1–30', () => {
		assert.equal(sockaddrRc('nonsense', 1), undefined);
		assert.equal(sockaddrRc('00:16:53:F0:0A:0B', 0), undefined);
		assert.equal(sockaddrRc('00:16:53:F0:0A:0B', 31), undefined);
	});
});

describe('linuxBluetoothSocket — struct pollfd', () => {
	it('is the descriptor, the events, then room for the answer: eight bytes', () => {
		const bytes = encodePollFd(20, POLLOUT);
		assert.equal(bytes.length, 8);
		assert.deepEqual([...bytes], [20, 0, 0, 0, POLLOUT, 0, 0, 0]);
	});

	it('reads what the kernel answered', () => {
		const bytes = encodePollFd(20, POLLOUT);
		bytes.writeInt16LE(POLLOUT | POLLERR, 6);
		assert.equal(decodeRevents(bytes), POLLOUT | POLLERR);
	});
});

describe('linuxBluetoothSocket — the loader', () => {
	it('refuses on any platform but Linux, without touching koffi', () => {
		resetLinuxBtSocketCache();
		assert.throws(() => loadLinuxBtSocket('win32'), BackendUnavailableError);
		assert.throws(() => loadLinuxBtSocket('win32'), /Linux/);
		resetLinuxBtSocketCache();
	});

	it('binds every call it promises on Linux', { skip: process.platform !== 'linux' }, () => {
		resetLinuxBtSocketCache();
		const api = loadLinuxBtSocket('linux');
		for (const name of ['socket', 'connect', 'connectState', 'canWrite', 'send', 'recv', 'close', 'hasPendingData', 'lastError'] as const) {
			assert.equal(typeof api[name], 'function', name);
		}
		resetLinuxBtSocketCache();
	});
});

describe('linuxBluetoothSocket — what the bindings make of the raw calls', () => {
	interface RawSetup {
		/** What poll answers: `revents`, or a failure with errno. */
		poll?: { revents: number } | { fails: number };
		/** `SO_ERROR` held by the socket; reading it clears it, as Linux does. */
		soError?: number;
		/** getsockopt fails with this errno. */
		getsockoptFails?: number;
	}

	function rawWith(setup: RawSetup): { raw: RawLibc; errno: () => number; calls: string[] } {
		const calls: string[] = [];
		let errnoNow = 0;
		let soError = setup.soError ?? 0;
		const raw: RawLibc = {
			socket: () => 20,
			connect: () => -1,
			poll: (pollFd: Buffer) => {
				calls.push('poll');
				const p = setup.poll ?? { revents: 0 };
				if ('fails' in p) { errnoNow = p.fails; return -1; }
				if (p.revents === 0) { return 0; }
				pollFd.writeInt16LE(p.revents, 6);
				return 1;
			},
			getsockopt: (_fd, _level, _name, value: number[]) => {
				calls.push('getsockopt');
				if (setup.getsockoptFails) { errnoNow = setup.getsockoptFails; return -1; }
				value[0] = soError;
				soError = 0;
				return 0;
			},
			send: (_fd, _data, length, flags) => { calls.push(`send ${length} ${flags}`); return length; },
			recv: (_fd, _buffer, length) => { calls.push(`recv ${length}`); return 0; },
			close: () => 0,
		};
		return { raw, errno: () => errnoNow, calls };
	}
	const bind = (setup: RawSetup) => { const r = rawWith(setup); return { api: bindLinuxBtSocket(r.raw, r.errno), calls: r.calls }; };

	it('says pending while poll reports nothing', () => {
		assert.deepEqual(bind({ poll: { revents: 0 } }).api.connectState(20), { state: 'pending', error: 0 });
	});

	it('says connected only when writable, with no error flag and SO_ERROR 0', () => {
		assert.deepEqual(bind({ poll: { revents: POLLOUT } }).api.connectState(20), { state: 'connected', error: 0 });
	});

	it('hands back the error SO_ERROR held, once: Linux clears it on reading (review of 66cde2b)', () => {
		const { api } = bind({ poll: { revents: POLLOUT | POLLERR }, soError: EHOSTDOWN });
		assert.deepEqual(api.connectState(20), { state: 'failed', error: EHOSTDOWN });
	});

	it('fails a descriptor poll calls invalid, with EBADF, and never calls it connected (review of 66cde2b)', () => {
		assert.deepEqual(bind({ poll: { revents: POLLNVAL } }).api.connectState(20), { state: 'failed', error: EBADF });
		assert.deepEqual(bind({ poll: { revents: POLLOUT | POLLNVAL } }).api.connectState(20), { state: 'failed', error: EBADF });
	});

	it('fails when getsockopt fails, with its errno, rather than read the untouched 0 as success', () => {
		assert.deepEqual(bind({ poll: { revents: POLLOUT }, getsockoptFails: EBADF }).api.connectState(20), { state: 'failed', error: EBADF });
	});

	it('fails when poll itself fails, with its errno; an interrupted poll is only pending', () => {
		const ENOMEM = 12;
		assert.deepEqual(bind({ poll: { fails: ENOMEM } }).api.connectState(20), { state: 'failed', error: ENOMEM });
		assert.deepEqual(bind({ poll: { fails: EINTR } }).api.connectState(20), { state: 'pending', error: 0 });
	});

	it('is not connected on a flag that is not POLLOUT', () => {
		assert.deepEqual(bind({ poll: { revents: POLLIN } }).api.connectState(20), { state: 'pending', error: 0 });
	});

	it('fails an error or hang-up flag with SO_ERROR 0 as EIO', () => {
		assert.deepEqual(bind({ poll: { revents: POLLHUP } }).api.connectState(20), { state: 'failed', error: EIO });
	});

	it('sends with MSG_NOSIGNAL, so a vanished brick cannot kill the extension host with SIGPIPE', () => {
		const { api, calls } = bind({});
		api.send(20, new Uint8Array(7), 7);
		assert.deepEqual(calls, [`send 7 ${MSG_NOSIGNAL}`]);
	});

	it('never hands libc a length beyond the buffer, or one that is not a whole number (review of 66cde2b)', () => {
		const { api, calls } = bind({});
		for (const length of [8, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(() => api.send(20, new Uint8Array(7), length), RangeError, `send ${length}`);
			assert.throws(() => api.recv(20, new Uint8Array(7), length), RangeError, `recv ${length}`);
		}
		assert.deepEqual(calls, [], 'nothing reached libc');
		api.recv(20, new Uint8Array(7).subarray(2), 5);
		assert.deepEqual(calls, ['recv 5']);
	});

	it('reports pending data, and a hang-up or a broken descriptor as something to read, so the read surfaces it', () => {
		assert.equal(bind({ poll: { revents: POLLIN } }).api.hasPendingData(20), true);
		assert.equal(bind({ poll: { revents: POLLHUP } }).api.hasPendingData(20), true);
		assert.equal(bind({ poll: { revents: POLLNVAL } }).api.hasPendingData(20), true);
		assert.equal(bind({ poll: { fails: EBADF } }).api.hasPendingData(20), true);
		assert.equal(bind({ poll: { fails: EINTR } }).api.hasPendingData(20), false);
		assert.equal(bind({ poll: { revents: 0 } }).api.hasPendingData(20), false);
	});

	it('says whether the socket can take more bytes now, never blocking', () => {
		assert.equal(bind({ poll: { revents: POLLOUT } }).api.canWrite(20), true);
		assert.equal(bind({ poll: { revents: 0 } }).api.canWrite(20), false);
		assert.equal(bind({ poll: { revents: POLLERR } }).api.canWrite(20), true, 'an error is for the write to surface');
		assert.equal(bind({ poll: { fails: EBADF } }).api.canWrite(20), true);
		assert.equal(bind({ poll: { fails: EINTR } }).api.canWrite(20), false);
	});

	it('passes errno through', () => {
		const r = rawWith({});
		assert.equal(bindLinuxBtSocket(r.raw, () => EINPROGRESS).lastError(), EINPROGRESS);
	});
});
