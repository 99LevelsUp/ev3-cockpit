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
	EINPROGRESS, EAGAIN, EBUSY, ECONNREFUSED, EHOSTDOWN, EHOSTUNREACH, ETIMEDOUT,
	POLLIN, POLLOUT, POLLERR, POLLHUP, SOCKADDR_RC_SIZE, MSG_NOSIGNAL,
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
		assert.deepEqual([POLLIN, POLLOUT, POLLERR, POLLHUP], [0x1, 0x4, 0x8, 0x10]);
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
		for (const name of ['socket', 'connect', 'connectState', 'socketError', 'send', 'recv', 'close', 'hasPendingData', 'lastError'] as const) {
			assert.equal(typeof api[name], 'function', name);
		}
		resetLinuxBtSocketCache();
	});
});

describe('linuxBluetoothSocket — what the bindings make of the raw calls', () => {
	function rawWith(poll: { revents: number }, soError = 0): { raw: RawLibc; sent: number[][] } {
		const sent: number[][] = [];
		const raw: RawLibc = {
			socket: () => 20,
			connect: () => -1,
			poll: (pollFd: Buffer) => {
				if (poll.revents === 0) { return 0; }
				pollFd.writeInt16LE(poll.revents, 6);
				return 1;
			},
			getsockopt: (_fd, _level, _name, value: number[]) => { value[0] = soError; return 0; },
			send: (_fd, _data, length, flags) => { sent.push([length, flags]); return length; },
			recv: () => 0,
			close: () => 0,
		};
		return { raw, sent };
	}

	it('says pending while poll reports nothing', () => {
		const api = bindLinuxBtSocket(rawWith({ revents: 0 }).raw, () => 0);
		assert.equal(api.connectState(20), 'pending');
	});

	it('says connected when writable and SO_ERROR is 0', () => {
		const api = bindLinuxBtSocket(rawWith({ revents: POLLOUT }).raw, () => 0);
		assert.equal(api.connectState(20), 'connected');
	});

	it('says failed when SO_ERROR holds an error, however writable it looks', () => {
		const api = bindLinuxBtSocket(rawWith({ revents: POLLOUT }, EHOSTDOWN).raw, () => 0);
		assert.equal(api.connectState(20), 'failed');
		assert.equal(api.socketError(20), EHOSTDOWN);
	});

	it('says failed on an error or hang-up even with SO_ERROR 0', () => {
		assert.equal(bindLinuxBtSocket(rawWith({ revents: POLLOUT | POLLERR }).raw, () => 0).connectState(20), 'failed');
		assert.equal(bindLinuxBtSocket(rawWith({ revents: POLLHUP }).raw, () => 0).connectState(20), 'failed');
	});

	it('sends with MSG_NOSIGNAL, so a vanished brick cannot kill the extension host with SIGPIPE', () => {
		const { raw, sent } = rawWith({ revents: 0 });
		bindLinuxBtSocket(raw, () => 0).send(20, new Uint8Array(7), 7);
		assert.deepEqual(sent, [[7, MSG_NOSIGNAL]]);
	});

	it('reports pending data, and a hang-up as something to read', () => {
		assert.equal(bindLinuxBtSocket(rawWith({ revents: POLLIN }).raw, () => 0).hasPendingData(20), true);
		assert.equal(bindLinuxBtSocket(rawWith({ revents: POLLHUP }).raw, () => 0).hasPendingData(20), true);
		assert.equal(bindLinuxBtSocket(rawWith({ revents: 0 }).raw, () => 0).hasPendingData(20), false);
	});

	it('passes errno through', () => {
		assert.equal(bindLinuxBtSocket(rawWith({ revents: 0 }).raw, () => EINPROGRESS).lastError(), EINPROGRESS);
	});
});
