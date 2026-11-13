/**
 * The libc calls behind the Linux Bluetooth transport, through `koffi` (step-7 plan, U1, KTD2).
 *
 * Node has no `AF_BLUETOOTH`, so the socket is opened the way `windowsWinsock.ts` opens one on
 * Windows: a handful of libc functions bound through `koffi`, behind an interface the adapter can
 * be driven through without a radio. Measured on HOSTC (Raspberry Pi 5, arm64, 11.11.2026):
 * `koffi.load('libc.so.6')` and `socket(31, 1, 3)` give a descriptor in the extension's own
 * process, so Linux needs no helper process.
 *
 * The structs are built as bytes rather than registered with `koffi`: the layouts are small and
 * fixed, a byte test pins them, and nothing is registered process-wide where another extension
 * in the same host could collide with it. Linux on every architecture the cockpit ships (x64,
 * arm64) is little-endian and uses the generic errno values below.
 */

import * as os from 'os';
import { BackendUnavailableError } from '../errors/CockpitError';

// ── Kernel constants ────────────────────────────────────────────────

export const AF_BLUETOOTH = 31;
export const BTPROTO_L2CAP = 0;
export const BTPROTO_RFCOMM = 3;
export const SOCK_STREAM = 1;
export const SOCK_SEQPACKET = 5;
export const SOCK_NONBLOCK = 0o4000;
export const SOCK_CLOEXEC = 0o2000000;
/** A send to a peer that went away fails with `EPIPE` instead of killing the process with SIGPIPE. */
export const MSG_NOSIGNAL = 0x4000;

export const EINTR = 4;
export const EIO = 5;
export const EBADF = 9;
export const EAGAIN = 11;
export const EBUSY = 16;
export const ETIMEDOUT = 110;
export const ECONNREFUSED = 111;
export const EHOSTDOWN = 112;
export const EHOSTUNREACH = 113;
export const EINPROGRESS = 115;

export const POLLIN = 0x1;
export const POLLOUT = 0x4;
export const POLLERR = 0x8;
export const POLLHUP = 0x10;
export const POLLNVAL = 0x20;

const SOL_SOCKET = 1;
const SO_ERROR = 4;


/** `struct sockaddr_rc`: `sa_family_t`, `bdaddr_t` (6 bytes), `uint8_t` channel, padded to 10. */
export const SOCKADDR_RC_SIZE = 10;

// ── API surface ─────────────────────────────────────────────────────

/** Where a non-blocking connect stands; `error` is the errno of a failed one, else 0. */
export interface ConnectState {
	readonly state: 'pending' | 'connected' | 'failed';
	readonly error: number;
}

/**
 * The subset of libc this transport needs.
 *
 * An interface for the same reason as `Winsock2Api`: a connect that never lands, a short write
 * and a peer that closes mid-exchange are awkward to stage on a brick and easy on a fake.
 */
export interface LinuxBtSocketApi {
	/** A new socket descriptor, or -1 (see {@link lastError}). */
	socket(family: number, type: number, protocol: number): number;
	/**
	 * Starts a connect to `address` (a `sockaddr` as bytes). On a non-blocking socket it answers
	 * -1 with {@link EINPROGRESS} at once; {@link connectState} says when it has landed. Never a
	 * blocking connect on a worker: on Windows one could not be aborted (DESIGN §4.1.1).
	 */
	connect(fd: number, address: Uint8Array): number;
	/**
	 * Where a non-blocking connect stands, without blocking: `poll` with a zero timeout, then
	 * `SO_ERROR`. The state and the error come together because Linux clears `SO_ERROR` when it
	 * is read: a second read would answer 0 and lose why the connect failed.
	 */
	connectState(fd: number): ConnectState;
	/**
	 * Whether the socket can take more bytes now: a zero-timeout `poll` for `POLLOUT`. An error or a
	 * hang-up counts as yes, so the write that follows surfaces it; an interrupted poll as no.
	 */
	canWrite(fd: number): boolean;
	/** Bytes accepted, or -1. Never raises SIGPIPE ({@link MSG_NOSIGNAL}). */
	send(fd: number, data: Uint8Array, length: number): number;
	/** Bytes received, 0 at end of stream, or -1 ({@link EAGAIN} when nothing is waiting). */
	recv(fd: number, buffer: Uint8Array, length: number): number;
	/** Closes the descriptor; also abandons a connect still in flight. */
	close(fd: number): number;
	/** True when `fd` has bytes waiting, or the peer has hung up. Never blocks. */
	hasPendingData(fd: number): boolean;
	/** `errno` of the last failed call on this thread. */
	lastError(): number;
}

// ── Byte layouts ────────────────────────────────────────────────────

/** Six hex bytes separated by one of `:` or `-` throughout, or not separated at all. */
const MAC_FORMAT = /^[0-9A-Fa-f]{2}(?:([:-]?)[0-9A-Fa-f]{2})(?:\1[0-9A-Fa-f]{2}){4}$/;

/**
 * A MAC address as `bdaddr_t` holds it: the six bytes reversed (`str2ba`).
 *
 * @returns The bytes, or `undefined` if the input is not six hex bytes.
 */
export function macToBdaddr(mac: string): Uint8Array | undefined {
	// The whole input, one separator throughout (or none): stripping what is not hex first would
	// take `zz00:16:53:F0:0A:0B` for an address.
	const text = String(mac ?? '');
	if (!MAC_FORMAT.test(text)) { return undefined; }
	const hex = text.replace(/[:-]/g, '');
	const bytes = new Uint8Array(6);
	for (let i = 0; i < 6; i += 1) {
		bytes[5 - i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * `struct sockaddr_rc` for an RFCOMM connect.
 *
 * @returns The bytes, or `undefined` for a bad address or a channel outside 1–30.
 */
export function sockaddrRc(mac: string, channel: number): Buffer | undefined {
	const bdaddr = macToBdaddr(mac);
	if (!bdaddr || !Number.isInteger(channel) || channel < 1 || channel > 30) { return undefined; }
	const bytes = Buffer.alloc(SOCKADDR_RC_SIZE);
	bytes.writeUInt16LE(AF_BLUETOOTH, 0);
	Buffer.from(bdaddr).copy(bytes, 2);
	bytes.writeUInt8(channel, 8);
	return bytes;
}

/** `struct pollfd` for one descriptor: `int fd`, `short events`, `short revents`. */
export function encodePollFd(fd: number, events: number): Buffer {
	const bytes = Buffer.alloc(8);
	bytes.writeInt32LE(fd, 0);
	bytes.writeInt16LE(events, 4);
	return bytes;
}

/** The `revents` the kernel wrote back into a {@link encodePollFd} buffer. */
export function decodeRevents(pollFd: Buffer): number {
	return pollFd.readInt16LE(6);
}

// ── Loader ──────────────────────────────────────────────────────────

let cached: LinuxBtSocketApi | undefined;
let loadFailure: string | undefined;

interface KoffiLike {
	load(name: string): { func(signature: string): unknown };
	errno(): number;
}

/** The libc functions as `koffi` binds them. Exported so the logic over them can be tested. */
export interface RawLibc {
	socket(family: number, type: number, protocol: number): number;
	connect(fd: number, address: Uint8Array, length: number): number;
	poll(pollFds: Buffer, count: number, timeoutMs: number): number;
	getsockopt(fd: number, level: number, name: number, value: number[], length: number[]): number;
	send(fd: number, data: Uint8Array, length: number, flags: number): number | bigint;
	recv(fd: number, buffer: Uint8Array, length: number, flags: number): number | bigint;
	close(fd: number): number;
}

/**
 * The API over the raw calls: zero-timeout polls, `SO_ERROR`, `MSG_NOSIGNAL` on every send.
 * Nothing here blocks: the extension host runs on this thread.
 */
export function bindLinuxBtSocket(raw: RawLibc, errno: () => number): LinuxBtSocketApi {
	/**
	 * `revents` of one zero-timeout poll; 0 when nothing happened. A failed poll answers its errno
	 * as a negative number; an interrupted one counts as nothing yet.
	 */
	const pollNow = (fd: number, events: number): number => {
		const pollFd = encodePollFd(fd, events);
		const ready = raw.poll(pollFd, 1, 0);
		if (ready < 0) {
			const code = errno();
			return code === EINTR ? 0 : -(code || EIO);
		}
		return ready > 0 ? decodeRevents(pollFd) : 0;
	};
	/** `SO_ERROR`, which reading clears; a failed read answers its own errno. */
	const takeSocketError = (fd: number): number => {
		const value = [0];
		if (raw.getsockopt(fd, SOL_SOCKET, SO_ERROR, value, [4]) < 0) { return errno() || EIO; }
		return value[0];
	};
	/** A whole number of bytes within the buffer; anything else would let libc past its end. */
	const checkLength = (buffer: Uint8Array, length: number, call: string): void => {
		if (!Number.isSafeInteger(length) || length < 0 || length > buffer.byteLength) {
			throw new RangeError(`${call}: length ${length} is not within the ${buffer.byteLength}-byte buffer.`);
		}
	};
	return {
		socket: (family, type, protocol) => raw.socket(family, type, protocol),
		connect: (fd, address) => raw.connect(fd, address, address.length),
		connectState: (fd) => {
			const revents = pollNow(fd, POLLOUT);
			if (revents < 0) { return { state: 'failed', error: -revents }; }
			if (revents === 0) { return { state: 'pending', error: 0 }; }
			if (revents & POLLNVAL) { return { state: 'failed', error: EBADF }; }
			const error = takeSocketError(fd);
			if (error !== 0) { return { state: 'failed', error }; }
			if (revents & (POLLERR | POLLHUP)) { return { state: 'failed', error: EIO }; }
			return revents & POLLOUT ? { state: 'connected', error: 0 } : { state: 'pending', error: 0 };
		},
		canWrite: (fd) => {
			const revents = pollNow(fd, POLLOUT);
			return revents < 0 || (revents & (POLLOUT | POLLERR | POLLHUP | POLLNVAL)) !== 0;
		},
		send: (fd, data, length) => {
			checkLength(data, length, 'send');
			return Number(raw.send(fd, data, length, MSG_NOSIGNAL));
		},
		recv: (fd, buffer, length) => {
			checkLength(buffer, length, 'recv');
			return Number(raw.recv(fd, buffer, length, 0));
		},
		close: (fd) => raw.close(fd),
		// A hang-up, an invalid descriptor or a failed poll count as something to read, so the
		// read that follows surfaces the error; an interrupted poll is nothing yet.
		hasPendingData: (fd) => {
			const revents = pollNow(fd, POLLIN);
			return revents < 0 || (revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) !== 0;
		},
		lastError: () => errno(),
	};
}

/**
 * Loads the libc bindings, or explains why this host cannot have them.
 *
 * Cached both ways, like `loadWinsock2`: a load that worked is reused, and one that failed will
 * not start working later in the session.
 *
 * @param platform The host's platform (default: this one). For tests.
 * @throws {BackendUnavailableError} Off Linux, or when `koffi` or libc cannot be loaded.
 */
export function loadLinuxBtSocket(platform: NodeJS.Platform = os.platform()): LinuxBtSocketApi {
	if (cached) { return cached; }
	if (loadFailure !== undefined) { throw new BackendUnavailableError(loadFailure); }

	const fail = (reason: string): never => {
		loadFailure = reason;
		throw new BackendUnavailableError(reason);
	};

	if (platform !== 'linux') {
		return fail(`The BlueZ RFCOMM socket is Linux-only; this host is ${platform}.`);
	}

	let koffi: KoffiLike;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		koffi = require('koffi') as KoffiLike;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return fail(`The BlueZ RFCOMM socket requires package "koffi". (${detail})`);
	}

	try {
		const libc = koffi.load('libc.so.6');
		const raw: RawLibc = {
			socket: libc.func('int socket(int, int, int)') as RawLibc['socket'],
			connect: libc.func('int connect(int, const uint8_t *, uint32_t)') as RawLibc['connect'],
			poll: libc.func('int poll(_Inout_ uint8_t *, unsigned long, int)') as RawLibc['poll'],
			getsockopt: libc.func('int getsockopt(int, int, int, _Out_ int32_t *, _Inout_ uint32_t *)') as RawLibc['getsockopt'],
			send: libc.func('intptr_t send(int, const uint8_t *, size_t, int)') as RawLibc['send'],
			recv: libc.func('intptr_t recv(int, _Out_ uint8_t *, size_t, int)') as RawLibc['recv'],
			close: libc.func('int close(int)') as RawLibc['close'],
		};
		cached = bindLinuxBtSocket(raw, () => koffi.errno());
		return cached;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return fail(`The BlueZ RFCOMM socket bindings failed to load. (${detail})`);
	}
}

/** Forgets a cached load. Test seam; an adapter already created keeps its bindings. */
export function resetLinuxBtSocketCache(): void {
	cached = undefined;
	loadFailure = undefined;
}
