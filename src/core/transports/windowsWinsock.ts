/**
 * Winsock2 `AF_BTH` bindings — RFCOMM sockets to a Bluetooth peer, without a helper process.
 *
 * Windows exposes Bluetooth RFCOMM as an ordinary socket family, so a brick can be reached
 * with `socket`/`connect`/`send`/`recv` from `ws2_32.dll` and nothing else. That is what the
 * testlab measured and selected as the Bluetooth runtime; this module is its binding layer,
 * ported here.
 *
 * The FFI is `koffi`, deliberately: everything native in this extension goes through it
 * rather than through a spawned process, so a backend either runs inside the extension host
 * or does not exist. See DESIGN §4.1.1 for why the WinRT alternative was dropped.
 */

import * as os from 'os';
import { BackendUnavailableError } from '../errors/CockpitError';

// ── Winsock constants ───────────────────────────────────────────────

/** Address family for Bluetooth. `AF_BTH` in `ws2bth.h`. */
export const AF_BTH = 32;
/** Protocol for RFCOMM connections. `BTHPROTO_RFCOMM` in `ws2bth.h`. */
export const BTHPROTO_RFCOMM = 3;
/** Stream socket type. */
export const SOCK_STREAM = 1;
/** Return value of a failed Winsock call. */
export const SOCKET_ERROR = -1;
/** Size of `SOCKADDR_BTH`: 2 + 8 + 16 + 4 bytes. */
export const SOCKADDR_BTH_SIZE = 30;

/**
 * RFCOMM channel the EV3 serves SPP on.
 *
 * Addressed by channel rather than by SDP service lookup. The brick advertises the Serial
 * Port Profile on channel 1 and has since the firmware shipped, and going straight at it
 * skips a service discovery round trip on a link where round trips are the expensive part.
 */
export const EV3_RFCOMM_CHANNEL = 1;

/** `WSAETIMEDOUT` — the peer did not answer the connection request. */
export const WSAETIMEDOUT = 10060;
/** `WSAECONNREFUSED` — the peer is reachable but refused the channel. */
export const WSAECONNREFUSED = 10061;
/** `WSAEWOULDBLOCK` — a non-blocking connect has started and is still in progress. */
export const WSAEWOULDBLOCK = 10035;

// ── API surface ─────────────────────────────────────────────────────

/** A connected or connecting socket handle, as `koffi` returns it. */
export type SocketHandle = number | bigint;

/** Destination for {@link Winsock2Api.connect}. */
export interface BluetoothAddress {
	addressFamily: number;
	/** 48-bit device address in the low bytes of a 64-bit field. */
	btAddr: bigint;
	serviceClassId: Uint8Array;
	/** RFCOMM channel. */
	port: number;
}

/**
 * The subset of `ws2_32.dll` this transport needs.
 *
 * An interface rather than direct calls so the adapter can be driven without a radio.
 * The paths worth testing here — a connect that never returns, a short write, a peer that
 * closes mid-exchange — are all ones that are awkward to stage on real hardware and easy
 * to stage on a fake.
 */
export interface Winsock2Api {
	/** Creates an unconnected socket, or an invalid handle on failure. */
	socket(family: number, type: number, protocol: number): SocketHandle;
	/** Switches the socket into or out of non-blocking mode. `0` on success. */
	setNonBlocking(socket: SocketHandle, on: boolean): number;
	/**
	 * Starts a connect to `address`. Synchronous: on a non-blocking socket it returns
	 * {@link SOCKET_ERROR} with {@link WSAEWOULDBLOCK} at once and the connect proceeds in the
	 * stack; {@link connectState} says when it has landed.
	 *
	 * It used to run a blocking connect on a koffi worker thread and abort it by closing the
	 * socket from the main thread. Measured 29.10.2026: closing did not end the blocked call.
	 * After four connects ran into the deadline in one process, every later connect failed
	 * without reaching the radio and the process could not exit (`scripts/bt-threadpool-probe.js`).
	 */
	connect(socket: SocketHandle, address: BluetoothAddress): number;
	/**
	 * Where a non-blocking connect stands, without blocking: `select` with a zero timeout,
	 * once on the write set (connected) and once on the exception set (failed).
	 */
	connectState(socket: SocketHandle): 'pending' | 'connected' | 'failed';
	/** The error a failed non-blocking connect ended with (`SO_ERROR`). */
	socketError(socket: SocketHandle): number;
	/** Sends bytes, returning how many were accepted or {@link SOCKET_ERROR}. */
	send(socket: SocketHandle, data: Uint8Array, length: number): number;
	/** Receives into `buffer`, returning byte count, `0` at end of stream, or {@link SOCKET_ERROR}. */
	recv(socket: SocketHandle, buffer: Uint8Array, length: number): number;
	/** Closes the socket. Also the way to abandon a non-blocking connect still in flight. */
	closesocket(socket: SocketHandle): number;
	/** True when `socket` has bytes waiting. Never blocks. */
	hasPendingData(socket: SocketHandle): number;
	/** Error code of the last failed call on this thread. */
	lastError(): number;
}

// ── Raw calls and their binding ─────────────────────────────────────

/** `fd_set` as Winsock lays it out: a count, then up to 64 sockets. */
export interface FdSet {
	fd_count: number;
	fd_array: number[];
}

/** `timeval`. */
export interface Timeval {
	tv_sec: number;
	tv_usec: number;
}

/**
 * The `ws2_32.dll` calls as koffi exposes them, one to one. {@link bindWinsock2} turns them into
 * {@link Winsock2Api}; the split lets the rules of that turn — what a failed call means, what
 * length native code may be handed — be tested without a radio.
 */
export interface RawWinsock2 {
	socket(family: number, type: number, protocol: number): SocketHandle;
	connect(socket: SocketHandle, address: BluetoothAddress, length: number): number;
	send(socket: SocketHandle, data: Uint8Array, length: number, flags: number): number;
	recv(socket: SocketHandle, buffer: Uint8Array, length: number, flags: number): number;
	closesocket(socket: SocketHandle): number;
	select(nfds: number, read: FdSet | null, write: FdSet | null, except: FdSet | null, timeout: Timeval): number;
	/** `argp` is in-out: one cell. */
	ioctlsocket(socket: SocketHandle, cmd: number, argp: number[]): number;
	/** `value` and `length` are out and in-out: one cell each. */
	getsockopt(socket: SocketHandle, level: number, name: number, value: number[], length: number[]): number;
	WSAGetLastError(): number;
}

// `FIONBIO` is 0x8004667E; as the signed 32-bit `long` the call takes, that is negative.
const FIONBIO = 0x8004667E | 0;
const SOL_SOCKET = 0xffff;
const SO_ERROR = 0x1007;
/** `fd_set` holds 64 sockets; one is used, the rest are zero. */
const FD_SETSIZE = 64;

/**
 * The Winsock calls this transport makes, with the rules the raw calls leave to their caller
 * (review of the Linux socket binding, step 7 U1, where each of these was a defect):
 *
 * - a `select` that itself fails means the connect failed, not that it is still under way — read
 *   as "pending", the open would poll a dead socket to its deadline and call it a timeout;
 * - a `getsockopt` that fails returns why it failed, never an error value it did not write;
 * - a length larger than the buffer (or not a whole, non-negative number) is refused before
 *   native code reads or writes past the end. A view's own length counts, not its backing buffer's.
 */
export function bindWinsock2(raw: RawWinsock2): Winsock2Api {
	const oneSocket = (socket: SocketHandle): FdSet =>
		({ fd_count: 1, fd_array: [Number(socket), ...new Array<number>(FD_SETSIZE - 1).fill(0)] });
	// Zero timeout: poll, never block. The extension host runs on this thread.
	const noWait: Timeval = { tv_sec: 0, tv_usec: 0 };
	const checkLength = (what: string, buffer: Uint8Array, length: number): void => {
		if (!(Number.isInteger(length) && length >= 0 && length <= buffer.length)) {
			throw new RangeError(`${what} of ${length} bytes on a buffer of ${buffer.length}.`);
		}
	};

	return {
		socket: (family, type, protocol) => raw.socket(family, type, protocol),
		setNonBlocking: (socket, on) => raw.ioctlsocket(socket, FIONBIO, [on ? 1 : 0]),
		connect: (socket, address) => raw.connect(socket, address, SOCKADDR_BTH_SIZE),
		connectState: (socket) => {
			const writable = raw.select(0, null, oneSocket(socket), null, noWait);
			if (writable === SOCKET_ERROR) { return 'failed'; }
			if (writable > 0) { return 'connected'; }
			const failed = raw.select(0, null, null, oneSocket(socket), noWait);
			if (failed === SOCKET_ERROR || failed > 0) { return 'failed'; }
			return 'pending';
		},
		socketError: (socket) => {
			const value = [0];
			if (raw.getsockopt(socket, SOL_SOCKET, SO_ERROR, value, [4]) === SOCKET_ERROR) {
				return raw.WSAGetLastError();
			}
			return value[0];
		},
		send: (socket, data, length) => {
			checkLength('A send', data, length);
			return raw.send(socket, data, length, 0);
		},
		recv: (socket, buffer, length) => {
			checkLength('A receive', buffer, length);
			return raw.recv(socket, buffer, length, 0);
		},
		closesocket: (socket) => raw.closesocket(socket),
		hasPendingData: (socket) => raw.select(0, oneSocket(socket), null, null, noWait),
		lastError: () => raw.WSAGetLastError(),
	};
}

// ── Loader ──────────────────────────────────────────────────────────

let cached: Winsock2Api | undefined;
let loadFailure: string | undefined;

interface KoffiLike {
	load(name: string): { func(signature: string): unknown };
	pack(name: string, fields: Record<string, unknown>): unknown;
	struct(name: string, fields: Record<string, unknown>): unknown;
	array(type: string, length: number): unknown;
}

/** Signature of a `koffi` function. */
type KoffiFunc = (...args: unknown[]) => number;

/**
 * Loads the Winsock bindings, or explains why this host cannot have them.
 *
 * Cached both ways. A successful load is a process-wide resource — `WSAStartup` is
 * refcounted and there is no reason to pay for it twice — and a failed one will not
 * start succeeding later in the session, so re-attempting it on every connect would
 * only add an FFI load to the latency of a path that is already falling back.
 *
 * @throws {BackendUnavailableError} On a non-Windows host, or when `koffi` is absent.
 */
export function loadWinsock2(): Winsock2Api {
	if (cached) { return cached; }
	if (loadFailure !== undefined) {
		throw new BackendUnavailableError(loadFailure);
	}

	const fail = (reason: string): never => {
		loadFailure = reason;
		throw new BackendUnavailableError(reason);
	};

	if (os.platform() !== 'win32') {
		return fail(`Winsock2 Bluetooth is Windows-only; this host is ${os.platform()}.`);
	}

	let koffi: KoffiLike;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		koffi = require('koffi') as KoffiLike;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return fail(`Winsock2 Bluetooth transport requires package "koffi". (${detail})`);
	}

	try {
		const lib = koffi.load('ws2_32.dll');

		// Type names are registered process-wide in koffi, and an extension host can hold
		// more than one extension using it. Prefixing keeps a second registration of a
		// well-known Win32 name from throwing on whichever of us loads second.

		// `pack` rather than `struct`: SOCKADDR_BTH is documented as unaligned, and the
		// natural alignment of the 64-bit address would otherwise pad it to 32 bytes and
		// push the channel past where the kernel reads it.
		koffi.pack('COCKPIT_SOCKADDR_BTH', {
			addressFamily: 'uint16',
			btAddr: 'uint64',
			serviceClassId: koffi.array('uint8', 16),
			port: 'uint32',
		});
		koffi.struct('COCKPIT_WSADATA_BTH', {
			wVersion: 'uint16',
			wHighVersion: 'uint16',
			iMaxSockets: 'uint16',
			iMaxUdpDg: 'uint16',
			lpVendorInfo: 'void*',
			szDescription: koffi.array('uint8', 257),
			szSystemStatus: koffi.array('uint8', 129),
		});
		koffi.struct('COCKPIT_TIMEVAL_BTH', { tv_sec: 'int32', tv_usec: 'int32' });
		koffi.struct('COCKPIT_FD_SET_BTH', { fd_count: 'uint32', fd_array: koffi.array('uintptr', 64) });

		const wsaStartup = lib.func('int __stdcall WSAStartup(uint16, COCKPIT_WSADATA_BTH*)') as KoffiFunc;
		const started = wsaStartup(0x0202, {});
		if (started !== 0) {
			return fail(`WSAStartup failed with ${started}.`);
		}

		const rawConnect = lib.func('int __stdcall connect(uintptr, COCKPIT_SOCKADDR_BTH*, int)') as KoffiFunc;
		const rawSocket = lib.func('uintptr __stdcall socket(int, int, int)') as KoffiFunc;
		const rawSend = lib.func('int __stdcall send(uintptr, const uint8*, int, int)') as KoffiFunc;
		const rawRecv = lib.func('int __stdcall recv(uintptr, uint8*, int, int)') as KoffiFunc;
		const rawClose = lib.func('int __stdcall closesocket(uintptr)') as KoffiFunc;
		const rawSelect = lib.func(
			'int __stdcall select(int, COCKPIT_FD_SET_BTH*, COCKPIT_FD_SET_BTH*, COCKPIT_FD_SET_BTH*, COCKPIT_TIMEVAL_BTH*)'
		) as KoffiFunc;
		const rawLastError = lib.func('int __stdcall WSAGetLastError()') as KoffiFunc;
		const rawIoctl = lib.func('int __stdcall ioctlsocket(uintptr, int32, _Inout_ uint32*)') as KoffiFunc;
		const rawGetSockOpt = lib.func(
			'int __stdcall getsockopt(uintptr, int, int, _Out_ int32*, _Inout_ int32*)'
		) as KoffiFunc;

		cached = bindWinsock2({
			socket: (family, type, protocol) => rawSocket(family, type, protocol),
			connect: (socket, address, length) => rawConnect(socket, address, length),
			send: (socket, data, length, flags) => rawSend(socket, data, length, flags),
			recv: (socket, buffer, length, flags) => rawRecv(socket, buffer, length, flags),
			closesocket: (socket) => rawClose(socket),
			select: (nfds, read, write, except, timeout) => rawSelect(nfds, read, write, except, timeout),
			ioctlsocket: (socket, cmd, argp) => rawIoctl(socket, cmd, argp),
			getsockopt: (socket, level, name, value, length) => rawGetSockOpt(socket, level, name, value, length),
			WSAGetLastError: () => rawLastError(),
		});
		return cached;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return fail(`Winsock2 Bluetooth bindings failed to initialise. (${detail})`);
	}
}

/** Forgets a cached load. Test seam; has no effect on an already-created adapter. */
export function resetWinsock2Cache(): void {
	cached = undefined;
	loadFailure = undefined;
}

// ── Address helpers ─────────────────────────────────────────────────

/** Six hex bytes, separated all by colons, all by dashes, or not at all. */
const MAC = /^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}$/i;

/**
 * Converts a MAC address to the 64-bit form `SOCKADDR_BTH` expects.
 *
 * Six hex bytes with one separator throughout — colons, dashes — or none. Anything else is
 * refused rather than mined for twelve hex digits (review of the Linux binding, step 7 U1): a
 * string that happens to hold them is not an address. The bytes keep the order they are written
 * in, which is the order Windows stores them: `00:16:53:f0:0a:0a` becomes `0x001653f00a0a`.
 *
 * @returns The address, or `undefined` if the input is not a MAC address.
 */
export function macToBtAddr(mac: string): bigint | undefined {
	const text = String(mac ?? '');
	if (!MAC.test(text)) { return undefined; }
	const hex = text.replace(/[:-]/g, '').toLowerCase();

	let addr = 0n;
	for (let i = 0; i < 12; i += 2) {
		addr = (addr << 8n) | BigInt(Number.parseInt(hex.slice(i, i + 2), 16));
	}
	return addr;
}

/**
 * Whether `socket()` refused to hand out a handle.
 *
 * `INVALID_SOCKET` is all-ones at the platform's pointer width, and `koffi` may surface a
 * `uintptr` as either a number or a bigint depending on magnitude, so both are checked.
 * Zero counts too: it is not a value Windows returns for a live socket, and treating it as
 * one would mean calling `connect` on nothing.
 */
export function isInvalidSocket(socket: SocketHandle): boolean {
	if (typeof socket === 'bigint') {
		return socket === 0n || socket === 0xFFFFFFFFFFFFFFFFn;
	}
	return !Number.isFinite(socket) || socket === 0 || socket === -1 || socket === 0xFFFFFFFF;
}
