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
 * The inquiry is a BR/EDR discovery for one window. A brick counts as heard when BlueZ reports an
 * RSSI for it during the window: a new object, or an RSSI that changed. An RSSI already there
 * when the window opens is an older sighting (another client's discovery), not this one.
 */

import { BackendUnavailableError } from '../errors/CockpitError';
import type { CallOptions } from './dbus/connection';
import { Variant, type DBusValue } from './dbus/wire';
import type { BluezAdapter, BluezDevice } from './bluezObjects';
import { BLUEZ } from './bluezObjects';
import type { ScannedBrick } from './btPairingHelper';
import {
	AF_BLUETOOTH, BTPROTO_L2CAP, EINPROGRESS, SOCK_CLOEXEC, SOCK_NONBLOCK, SOCK_SEQPACKET,
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
			if (api.lastError() !== EINPROGRESS) { return false; }
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, pollMs));
				const { state } = api.connectState(fd);
				if (state === 'connected') { return true; }
				if (state === 'failed') { return false; }
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
}

/** What the inquiry needs of the object cache. */
export interface InquiryCache {
	devices(): BluezDevice[];
	adapter(): BluezAdapter | undefined;
	onChange(handler: () => void): () => void;
}

export interface BluezInquiryOptions {
	bus: InquiryBus;
	cache: InquiryCache;
	/** One window (default `BT.PRESENCE_INQUIRY_SECONDS`). */
	windowMs?: number;
}

const LEGO_OUI = BT.LEGO_OUI.toUpperCase();
const isLego = (mac: string | undefined): mac is string => !!mac && mac.replace(/[:-]/g, '').toUpperCase().startsWith(LEGO_OUI);

/** One inquiry window: every LEGO brick BlueZ heard during it, paired or not. */
export function createBluezInquiry(options: BluezInquiryOptions): () => Promise<ScannedBrick[]> {
	const { bus, cache } = options;
	const windowMs = options.windowMs ?? BT.PRESENCE_INQUIRY_SECONDS * 1000;
	return async () => {
		const adapter = cache.adapter();
		if (!adapter) { throw new Error('This computer has no Bluetooth adapter BlueZ knows.'); }
		const startedAt = Date.now();
		const before = new Map(cache.devices().map((d) => [d.path, d.rssi]));
		const heard = new Map<string, ScannedBrick>();
		const look = (): void => {
			for (const d of cache.devices()) {
				if (!isLego(d.address) || d.rssi === undefined) { continue; }
				if (!heard.has(d.path) && before.has(d.path) && before.get(d.path) === d.rssi) { continue; }
				const known = heard.get(d.path);
				heard.set(d.path, {
					mac: d.address.toUpperCase(),
					name: d.name ?? d.alias ?? '',
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
				await bus.call({ destination: BLUEZ, path: adapter.path, interface: 'org.bluez.Adapter1', member: 'StopDiscovery' }).catch(() => { /* not discovering */ });
			}
		}
	};
}
