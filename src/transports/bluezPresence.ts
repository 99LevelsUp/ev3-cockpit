/**
 * Bluetooth presence on Linux: which bricks are there, found without connecting (step-7 plan, U6,
 * KTD9). The seams are `BtPresenceMonitor`'s `check` and `inquire`; the monitor keeps its
 * intervals, its misses before "not heard" and its hold on the connection queue.
 *
 * The check (owner decision D2) is a short L2CAP connect to PSM 1, SDP, closed at once. Measured on
 * HOSTC (U0, 13.11.2026), visibility off on all three bricks: a brick that is on answers in
 * 2.9–4.1 s and shows nothing; one that is off fails with EHOSTDOWN after 5.12 s. It needs no
 * group and no D-Bus, and opens no session the brick would show.
 *
 * The inquiry is a BR/EDR discovery for one window, and a brick is heard on evidence: a signal
 * carrying its RSSI during the window (`BluezObjectCache.rssiReports`), never a value compared.
 * Our discovery is filtered (Transport=bredr), and under a filtered discovery BlueZ 5.82 reports
 * every result, a same value too (adapter.c, delta 0; the 8 dBm `RSSI_THRESHOLD` is for an
 * unfiltered one). Measured on HOSTC (13.11.2026): a steady brick reported three times in 30 s,
 * alone and with another client discovering. An RSSI BlueZ still holds is no evidence: under
 * another client's discovery it outlives a brick switched off. A report may come from another
 * client's discovery: a real sighting of the brick all the same, just not necessarily ours.
 */

import { BackendUnavailableError } from '../errors/CockpitError';
import type { CallOptions } from './dbus/connection';
import { Variant, type DBusValue } from './dbus/wire';
import type { BluezAdapter, BluezDevice } from './bluezObjects';
import { BLUEZ } from './bluezObjects';
import type { ScannedBrick } from './btPairingHelper';
import { bluezDeviceName, type DiscoveryGate } from './bluezDiscovery';
import { DBusError } from './dbus/connection';
import {
	AF_BLUETOOTH, BTPROTO_L2CAP, ECONNREFUSED, EHOSTDOWN, EHOSTUNREACH, EINPROGRESS, ETIMEDOUT,
	SOCK_CLOEXEC, SOCK_NONBLOCK, SOCK_SEQPACKET,
	loadLinuxBtSocket, macToBdaddr, type LinuxBtSocketApi,
} from './linuxBluetoothSocket';
import { BT } from './transportConstants';

/** SDP's PSM: every Classic device listens on it, and a connect asks the brick nothing. */
export const SDP_PSM = 1;
/** `sizeof(struct sockaddr_l2)`. */
export const SOCKADDR_L2_SIZE = 14;
/** `bdaddr_type` for BR/EDR. */
const BDADDR_BREDR = 0;
/** The kernel has no Bluetooth sockets. */
const EAFNOSUPPORT = 97;

/**
 * What a failed connect says about the brick. Not there: EHOSTDOWN as measured (page timeout),
 * EHOSTUNREACH, ETIMEDOUT. There, if only to refuse: ECONNREFUSED and ECONNRESET, which the brick
 * itself sends once paged. The adapter being down (ENETDOWN, ENETUNREACH) and every local failure
 * say nothing about the brick: the round fails, and nothing counts as its miss.
 */
const ECONNRESET = 104;
const NOT_ANSWERED = new Set([EHOSTDOWN, EHOSTUNREACH, ETIMEDOUT]);
const ANSWERED_TO_REFUSE = new Set([ECONNREFUSED, ECONNRESET]);

/** Whether the brick answered, from a failed connect's errno; throws for anything not about the brick. */
function answeredByErrno(errno: number): boolean {
	if (NOT_ANSWERED.has(errno)) { return false; }
	if (ANSWERED_TO_REFUSE.has(errno)) { return true; }
	throw new Error(`The presence check failed here, not at the brick (errno ${errno}).`);
}

/**
 * `struct sockaddr_l2`: family, PSM (little-endian), `bdaddr_t` (reversed), CID 0, address type.
 *
 * @returns The bytes, or `undefined` for a bad address or PSM.
 */
export function sockaddrL2(mac: string, psm: number): Buffer | undefined {
	const bdaddr = macToBdaddr(mac);
	if (!bdaddr || !Number.isInteger(psm) || psm < 1 || psm > 0xffff) { return undefined; }
	const bytes = Buffer.alloc(SOCKADDR_L2_SIZE);
	bytes.writeUInt16LE(AF_BLUETOOTH, 0);
	bytes.writeUInt16LE(psm, 2);
	Buffer.from(bdaddr).copy(bytes, 4);
	bytes.writeUInt16LE(0, 10);
	bytes.writeUInt8(BDADDR_BREDR, 12);
	return bytes;
}

export interface BluezPresenceCheckOptions {
	/** For tests; default the libc bindings. */
	api?: () => LinuxBtSocketApi;
	/** How long one check may take (default 8 s: a brick that is off fails after 5.12 s). */
	timeoutMs?: number;
	/** How often the connect is looked at (default 50 ms, a zero-timeout poll each). */
	pollMs?: number;
}

/**
 * One presence check: true when the brick answered.
 *
 * @throws {BackendUnavailableError} When this host cannot have Bluetooth sockets at all, so the
 *   monitor stops and says so once. Any other local failure fails the round, not the brick.
 */
export function createBluezPresenceCheck(options: BluezPresenceCheckOptions = {}): (mac: string) => Promise<boolean> {
	const load = options.api ?? (() => loadLinuxBtSocket());
	const timeoutMs = options.timeoutMs ?? 8_000;
	const pollMs = options.pollMs ?? 50;
	return async (mac) => {
		const address = sockaddrL2(mac, SDP_PSM);
		if (!address) { return false; }
		const api = load();
		const fd = api.socket(AF_BLUETOOTH, SOCK_SEQPACKET | SOCK_NONBLOCK | SOCK_CLOEXEC, BTPROTO_L2CAP);
		if (fd < 0) {
			const errno = api.lastError();
			if (errno === EAFNOSUPPORT) { throw new BackendUnavailableError('This kernel has no Bluetooth sockets (EAFNOSUPPORT).'); }
			throw new Error(`Could not open a Bluetooth socket for the presence check (errno ${errno}).`);
		}
		try {
			if (api.connect(fd, address) === 0) { return true; }
			const errno = api.lastError();
			if (errno !== EINPROGRESS) { return answeredByErrno(errno); }
			// Monotonic: a wall clock set back must not stretch the check.
			const deadline = performance.now() + timeoutMs;
			while (performance.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, pollMs));
				const { state, error } = api.connectState(fd);
				if (state === 'connected') { return true; }
				if (state === 'failed') { return answeredByErrno(error); }
			}
			return false;
		} finally {
			// Closing also abandons a connect still in flight.
			api.close(fd);
		}
	};
}

/** What the inquiry needs of the bus. */
export interface InquiryBus {
	call(options: CallOptions): Promise<DBusValue[]>;
	/** The connection of this moment, held for one window, so its StopDiscovery goes where it started (U8 review #6). */
	pin?(): InquiryBus;
}

/** What the inquiry needs of the object cache. */
export interface InquiryCache {
	devices(): BluezDevice[];
	adapter(): BluezAdapter | undefined;
	onChange(handler: () => void): () => void;
	/** RSSI-bearing signals so far for a device. */
	rssiReports(path: string): number;
}

export interface BluezInquiryOptions {
	bus: InquiryBus;
	cache: InquiryCache;
	/** One window (default {@link DEFAULT_INQUIRY_WINDOW_MS}). */
	windowMs?: number;
	/** Told when the discovery may not have stopped. */
	log?: (message: string) => void;
	/** Shared with the pairing search: a window starts only once no discovery waits to be stopped (U8 review #5). */
	discoveryGate?: DiscoveryGate;
}

const LEGO_OUI = BT.LEGO_OUI.toUpperCase();
const isLego = (mac: string | undefined): mac is string => !!mac && mac.replace(/[:-]/g, '').toUpperCase().startsWith(LEGO_OUI);

/**
 * One inquiry window on Linux (ms). Longer than the 8–14 s between a brick's reports measured on
 * HOSTC while another client was discovering (13.11.2026), so a window holds at least one report.
 * The cost: the Bluetooth queue is held 15 s of every minute. Not `BT.PRESENCE_INQUIRY_SECONDS`,
 * which the Windows helper's inquiry uses.
 */
export const DEFAULT_INQUIRY_WINDOW_MS = 15_000;

/** One inquiry window: every LEGO brick BlueZ heard during it, paired or not. */
export function createBluezInquiry(options: BluezInquiryOptions): () => Promise<ScannedBrick[]> {
	const { cache } = options;
	const windowMs = options.windowMs ?? DEFAULT_INQUIRY_WINDOW_MS;
	return async () => {
		// A pairing search's late StopDiscovery would end this window: let it go out first. The
		// adapter and the connection are read after the wait, together (U8 confirmation #2).
		await options.discoveryGate?.idle();
		const adapter = cache.adapter();
		if (!adapter) { throw new Error('This computer has no Bluetooth adapter BlueZ knows.'); }
		const bus = options.bus.pin?.() ?? options.bus;
		const startedAt = Date.now();
		const before = new Map(cache.devices().map((d) => [d.path, cache.rssiReports(d.path)]));
		const heard = new Map<string, ScannedBrick>();
		const look = (): void => {
			for (const d of cache.devices()) {
				if (!isLego(d.address) || d.rssi === undefined) { continue; }
				// Heard only on a report during the window.
				if (cache.rssiReports(d.path) <= (before.get(d.path) ?? 0)) { continue; }
				const known = heard.get(d.path);
				heard.set(d.path, {
					mac: d.address.toUpperCase(),
					name: bluezDeviceName(d),
					paired: d.paired,
					signal: d.rssi,
					atMs: known?.atMs ?? Date.now() - startedAt,
				});
			}
		};
		const stopListening = cache.onChange(look);
		let attempted = false;
		try {
			await bus.call({ destination: BLUEZ, path: adapter.path, interface: 'org.bluez.Adapter1', member: 'SetDiscoveryFilter', signature: 'a{sv}', body: [new Map([['Transport', new Variant('s', 'bredr')]])] });
			attempted = true;
			await bus.call({ destination: BLUEZ, path: adapter.path, interface: 'org.bluez.Adapter1', member: 'StartDiscovery' });
			await new Promise((resolve) => setTimeout(resolve, windowMs));
			return [...heard.values()];
		} finally {
			stopListening();
			if (attempted) {
				await bus.call({ destination: BLUEZ, path: adapter.path, interface: 'org.bluez.Adapter1', member: 'StopDiscovery' }).catch((error: unknown) => {
					const notDiscovering = error instanceof DBusError && error.dbusName === 'org.bluez.Error.Failed' && /No discovery started/.test(error.detail);
					if (!notDiscovering) {
						const what = error instanceof DBusError ? `${error.dbusName}: ${error.detail}` : String(error);
						options.log?.(`StopDiscovery failed; the radio may still be discovering. ${what}`);
					}
				});
			}
		}
	};
}
