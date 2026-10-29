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

		const emptyFdArray = new Array<number>(63).fill(0);
		const oneSocket = (socket: SocketHandle) => ({ fd_count: 1, fd_array: [Number(socket), ...emptyFdArray] });
		// Zero timeout: poll, never block. The extension host runs on this thread.
		const noWait = { tv_sec: 0, tv_usec: 0 };
		// `FIONBIO` is 0x8004667E; as the signed 32-bit `long` the call takes, that is negative.
		const FIONBIO = 0x8004667E | 0;
		const SOL_SOCKET = 0xffff;
		const SO_ERROR = 0x1007;

		cached = {
			socket: (family, type, protocol) => rawSocket(family, type, protocol),
			setNonBlocking: (socket, on) => rawIoctl(socket, FIONBIO, [on ? 1 : 0]),
			connect: (socket, address) => rawConnect(socket, address, SOCKADDR_BTH_SIZE),
			connectState: (socket) => {
				if (rawSelect(0, null, oneSocket(socket), null, noWait) > 0) { return 'connected'; }
				if (rawSelect(0, null, null, oneSocket(socket), noWait) > 0) { return 'failed'; }
				return 'pending';
			},
			socketError: (socket) => {
				const value = [0];
				rawGetSockOpt(socket, SOL_SOCKET, SO_ERROR, value, [4]);
				return value[0];
			},
			send: (socket, data, length) => rawSend(socket, data, length, 0),
			recv: (socket, buffer, length) => rawRecv(socket, buffer, length, 0),
			closesocket: (socket) => rawClose(socket),
			hasPendingData: (socket) => rawSelect(0, oneSocket(socket), null, null, noWait),
			lastError: () => rawLastError(),
		};
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

/**
 * Converts a MAC address to the 64-bit form `SOCKADDR_BTH` expects.
 *
 * Accepts any separator, or none. The bytes keep the order they are written in, which is
 * the order Windows stores them: `00:16:53:5d:7e:2d` becomes `0x0016535d7e2d`.
 *
 * @returns The address, or `undefined` if the input is not six hex bytes.
 */
export function macToBtAddr(mac: string): bigint | undefined {
	const hex = String(mac ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
	if (hex.length !== 12) { return undefined; }

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
