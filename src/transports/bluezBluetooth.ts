/**
 * Bluetooth on Linux, put together (step-7 plan, U8, KTD8): one system-bus connection, BlueZ's
 * owner tracked, its objects kept, and every seam the Windows backend fills — the RFCOMM backend,
 * discovery's device list and radio name, pairing, forgetting and its residue, presence.
 *
 * The runtime wires it on `linux` only (see the wiring note in the step-7 plan); nothing here is
 * loaded on Windows. Creating it touches nothing: `start()` opens the bus.
 *
 * BlueZ's unique bus name is tracked with `GetNameOwner` and `NameOwnerChanged` (U4 review #9,
 * #10; U5 review #8). The object cache and the pairing agent take signals and calls from that
 * name only, and from nobody while it is unknown. When BlueZ goes (a daemon restart) the cache is
 * dropped and its listeners told; when it comes back a new cache reads a fresh snapshot.
 */

import * as os from 'os';

import { BackendUnavailableError } from '../errors/CockpitError';
import type { ForgetResidue } from '../contracts';
import { DBusConnection, DBusError, type CallOptions, type ExportedMethod } from './dbus/connection';
import type { DBusMessage } from './dbus/message';
import type { DBusValue } from './dbus/wire';
import { BluezObjectCache, type BluezAdapter, type BluezDevice, type BusLike } from './bluezObjects';
import { bluezListDevices, bluezRadioName, DiscoveryGate } from './bluezDiscovery';
import { createBluezPairing } from './bluezPairing';
import { createBluezUnpair, bluezForgetResidue } from './bluezForget';
import { createBluezPresenceCheck, createBluezInquiry } from './bluezPresence';
import { isBluezAccessDenied, manualGroupCommand } from './bluezAccess';
import { BtBluezAdapter } from './btBluezAdapter';
import type { BtAdapterFactory, BtBackend, UnpairResult } from './btTransportProvider';
import type { BtPairingEvent, HelperPairingResult, ScannedBrick } from './btPairingHelper';
import type { BluetoothDeviceInfo } from './windowsBluetooth';

const BLUEZ_NAME = 'org.bluez';
const DBUS_NAME = 'org.freedesktop.DBus';
const NAME_HAS_NO_OWNER = 'org.freedesktop.DBus.Error.NameHasNoOwner';
/** The first reconnect after the bus closed under us (ms); doubled each failed try, up to the cap. */
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** What the factory needs of a bus connection; `DBusConnection` in production, a fake in tests. */
export interface BluezBus extends BusLike {
	exportObject(path: string, iface: string, methods: Record<string, ExportedMethod>): () => void;
	close(): void;
}

export interface BluezBluetoothOptions {
	log: { info(message: string): void; warn(message: string): void };
	/** Told when the bus policy keeps this user from BlueZ, with the command that fixes it (D4). */
	onAccessDenied?: (command: string) => void;
	/** For tests; default `DBusConnection.open()` on the system bus. */
	openBus?: () => Promise<BluezBus>;
	/** For tests; default this host's. */
	platform?: NodeJS.Platform;
	/** For tests; default `os.userInfo().username`. */
	username?: () => string;
	/** For tests: the inquiry window and the pairing search. */
	inquiryWindowMs?: number;
	searchMs?: number;
	/** For tests: the first reconnect's delay after the bus closed (default 1 s, doubling to 30 s). */
	reconnectMs?: number;
}

export interface BluezBluetooth {
	/** The RFCOMM backend, for `BtTransportProvider`. */
	readonly backends: Map<BtBackend, BtAdapterFactory>;
	/** For `BtClassicDiscovery`: throws until BlueZ's objects are read, so discovery says so once. */
	readonly listDevices: () => BluetoothDeviceInfo[];
	readonly radioName: () => string | undefined;
	readonly pairDevice: (mac: string, onEvent?: (event: BtPairingEvent) => void, signal?: AbortSignal) => Promise<HelperPairingResult>;
	readonly unpairDevice: (mac: string) => Promise<UnpairResult>;
	readonly forgetResidue: (mac: string) => ForgetResidue[];
	/** For `BtPresenceMonitor`. */
	readonly presenceCheck: (mac: string) => Promise<boolean>;
	readonly inquire: () => Promise<ScannedBrick[]>;
	/** Told whenever what BlueZ holds changes, BlueZ going and coming included. */
	onChange(handler: () => void): () => void;
	/** Opens the bus and reads BlueZ. Never rejects: what went wrong is logged, and the seams say not ready. */
	start(): Promise<void>;
	/** Starts again from a fresh bus, as after the user joined the bluetooth group (D4). */
	retry(): Promise<void>;
	dispose(): void;
}

/**
 * The object cache of the moment, behind one stable face: the seams hold this, and it follows
 * BlueZ across restarts.
 */
class LiveCache {
	current: BluezObjectCache | undefined;
	private readonly handlers = new Set<() => void>();
	private detach: (() => void) | undefined;

	get ready(): boolean { return this.current?.ready ?? false; }
	devices(): BluezDevice[] { return this.current?.devices() ?? []; }
	adapter(): BluezAdapter | undefined { return this.current?.adapter(); }
	rssiReports(path: string): number { return this.current?.rssiReports(path) ?? 0; }
	onChange(handler: () => void): () => void {
		this.handlers.add(handler);
		return () => { this.handlers.delete(handler); };
	}

	replace(next: BluezObjectCache | undefined): void {
		this.detach?.();
		this.detach = undefined;
		this.current?.dispose();
		this.current = next;
		if (next) { this.detach = next.onChange(() => this.notify()); }
		this.notify();
	}

	notify(): void {
		for (const handler of [...this.handlers]) {
			try { handler(); } catch { /* one listener's fault */ }
		}
	}
}

export function createBluezBluetooth(options: BluezBluetoothOptions): BluezBluetooth {
	const platform = options.platform ?? os.platform();
	if (platform !== 'linux') {
		throw new BackendUnavailableError(`The BlueZ Bluetooth backend is Linux-only; this host is ${platform}.`);
	}
	const { log } = options;
	const openBus = options.openBus ?? (() => DBusConnection.open() as Promise<BluezBus>);
	const username = options.username ?? (() => os.userInfo().username);

	const live = new LiveCache();
	const gate = new DiscoveryGate();
	let bus: BluezBus | undefined;
	/** `bus` for the object caches: each match rule added once per connection (U8 review #9). */
	let cacheBus: BusLike | undefined;
	let owner: string | undefined;
	let generation = 0;
	let disposed = false;
	let busRemovers: (() => void)[] = [];
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectTries = 0;
	const reconnectFirstMs = options.reconnectMs ?? RECONNECT_FIRST_MS;

	const notConnected = (): Error => new Error('Not connected to the system bus.');
	/** One connection, held for one operation: its cleanup goes where it started (U8 review #6). */
	const pinned = (connection: BluezBus | undefined): Pick<BluezBus, 'call' | 'exportObject'> => ({
		call(callOptions: CallOptions): Promise<DBusValue[]> {
			return connection ? connection.call(callOptions) : Promise.reject(notConnected());
		},
		exportObject(path: string, iface: string, methods: Record<string, ExportedMethod>): () => void {
			if (!connection) { throw notConnected(); }
			return connection.exportObject(path, iface, methods);
		},
	});
	// The bus of the moment for single calls; `pin()` for an operation that cleans up after itself.
	const liveBus = {
		call(callOptions: CallOptions): Promise<DBusValue[]> { return pinned(bus).call(callOptions); },
		exportObject(path: string, iface: string, methods: Record<string, ExportedMethod>): () => void { return pinned(bus).exportObject(path, iface, methods); },
		pin: () => pinned(bus),
	};
	const bluezOwner = (): string | undefined => owner;

	const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

	/** D4: the bus policy keeps this user from BlueZ. */
	function accessDenied(): void {
		const command = manualGroupCommand(username());
		log.warn(`BlueZ refused this user: on many systems only members of the "bluetooth" group may use it. To join it: ${command}`);
		options.onAccessDenied?.(command);
	}

	/** A fresh cache under the current owner; a stale one (an older generation) is dropped. */
	async function readBluez(): Promise<void> {
		const mine = generation;
		const connection = cacheBus;
		if (!connection || !owner) { live.replace(undefined); return; }
		const cache = new BluezObjectCache(connection, { bluezOwner });
		try {
			await cache.start();
		} catch (error) {
			if (mine !== generation) { return; }
			live.replace(undefined);
			if (isBluezAccessDenied(error)) {
				accessDenied();
			} else {
				log.warn(`Could not read BlueZ's devices: ${describe(error)}`);
			}
			return;
		}
		if (mine !== generation || disposed) { cache.dispose(); return; }
		live.replace(cache);
		log.info(`BlueZ ready: ${cache.devices().length} device(s) known, adapter ${cache.adapter() ? 'present' : 'missing'}`);
	}

	function onOwnerChanged(message: DBusMessage): void {
		if (message.sender !== DBUS_NAME || message.interface !== DBUS_NAME || message.member !== 'NameOwnerChanged') { return; }
		const [name, , next] = message.body;
		if (name !== BLUEZ_NAME || typeof next !== 'string') { return; }
		generation += 1;
		// Nothing of the old daemon stays, even while the new one is read (U8 review #3).
		live.replace(undefined);
		if (!next) {
			owner = undefined;
			log.warn('BlueZ stopped; Bluetooth waits for it to come back.');
			return;
		}
		owner = next;
		log.info('BlueZ started; reading its devices again.');
		void readBluez();
	}

	function closeBus(): void {
		for (const remove of busRemovers.splice(0)) { remove(); }
		const connection = bus;
		bus = undefined;
		cacheBus = undefined;
		owner = undefined;
		connection?.close();
	}

	function cancelReconnect(): void {
		if (reconnectTimer) { clearTimeout(reconnectTimer); }
		reconnectTimer = undefined;
		reconnectTries = 0;
	}

	/** After the bus closed under us: try again, 1 s, 2 s, 4 s … up to 30 s apart (U8 review #2). */
	function scheduleReconnect(): void {
		if (disposed || reconnectTimer) { return; }
		const delay = Math.min(reconnectFirstMs * 2 ** reconnectTries, RECONNECT_MAX_MS);
		reconnectTries += 1;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			void connect(true);
		}, delay);
	}

	/** Each match rule once on this connection, however many caches BlueZ's restarts bring. */
	function onceEach(connection: BluezBus): BusLike {
		const added = new Map<string, Promise<void>>();
		return {
			call: (callOptions) => connection.call(callOptions),
			addMatch: (rule) => {
				let pending = added.get(rule);
				if (!pending) {
					pending = connection.addMatch(rule);
					added.set(rule, pending);
					pending.catch(() => { added.delete(rule); });
				}
				return pending;
			},
			onSignal: (handler) => connection.onSignal(handler),
			onClose: (handler) => connection.onClose(handler),
		};
	}

	async function connect(reconnecting: boolean): Promise<void> {
		// One bus at a time: a second start while one is held opens nothing (U8 review #1).
		if (disposed || bus) { return; }
		generation += 1;
		const mine = generation;
		let connection: BluezBus;
		try {
			connection = await openBus();
		} catch (error) {
			if (disposed || mine !== generation) { return; }
			log.warn(`Bluetooth unavailable: cannot reach the system bus (${describe(error)}).`);
			if (reconnecting) { scheduleReconnect(); }
			return;
		}
		if (disposed || mine !== generation || bus) { connection.close(); return; }
		reconnectTries = 0;
		bus = connection;
		cacheBus = onceEach(connection);
		busRemovers = [
			connection.onSignal(onOwnerChanged),
			connection.onClose(() => {
				if (bus !== connection) { return; }
				busRemovers.splice(0);
				bus = undefined;
				cacheBus = undefined;
				owner = undefined;
				generation += 1;
				live.replace(undefined);
				log.warn('The system bus connection closed; Bluetooth is not ready until it is back.');
				scheduleReconnect();
			}),
		];
		try {
			await connection.addMatch(`type='signal',sender='${DBUS_NAME}',interface='${DBUS_NAME}',member='NameOwnerChanged',arg0='${BLUEZ_NAME}'`);
		} catch (error) {
			if (mine !== generation) { return; }
			if (isBluezAccessDenied(error)) { accessDenied(); return; }
			log.warn(`Bluetooth unavailable: the system bus refused to watch BlueZ (${describe(error)}).`);
			return;
		}
		try {
			const [name] = await connection.call({ destination: DBUS_NAME, path: '/org/freedesktop/DBus', interface: DBUS_NAME, member: 'GetNameOwner', signature: 's', body: [BLUEZ_NAME] });
			if (mine === generation) { owner = typeof name === 'string' && name ? name : undefined; }
		} catch (error) {
			if (mine !== generation) { return; }
			// Only "nobody owns the name" means BlueZ is not running (U8 review #4).
			if (isBluezAccessDenied(error)) { accessDenied(); return; }
			if (!(error instanceof DBusError && error.dbusName === NAME_HAS_NO_OWNER)) {
				log.warn(`Bluetooth unavailable: could not ask the bus who BlueZ is (${describe(error)}).`);
				return;
			}
		}
		if (mine !== generation) { return; }
		if (!owner) {
			log.warn('BlueZ is not running; Bluetooth waits for it to start.');
			return;
		}
		await readBluez();
	}

	return {
		backends: new Map<BtBackend, BtAdapterFactory>([['bluez', (mac) => new BtBluezAdapter({ mac })]]),
		listDevices: bluezListDevices(live),
		radioName: bluezRadioName(live),
		pairDevice: createBluezPairing({ bus: liveBus, cache: live, bluezOwner, searchMs: options.searchMs, discoveryGate: gate }),
		unpairDevice: createBluezUnpair({ bus: liveBus, cache: live }),
		forgetResidue: bluezForgetResidue(live),
		presenceCheck: createBluezPresenceCheck(),
		inquire: createBluezInquiry({ bus: liveBus, cache: live, windowMs: options.inquiryWindowMs, log: (message) => log.warn(message), discoveryGate: gate }),
		onChange: (handler) => live.onChange(handler),
		start: () => connect(false),
		async retry(): Promise<void> {
			if (disposed) { return; }
			cancelReconnect();
			live.replace(undefined);
			closeBus();
			await connect(false);
		},
		dispose(): void {
			if (disposed) { return; }
			disposed = true;
			generation += 1;
			cancelReconnect();
			live.replace(undefined);
			closeBus();
		},
	};
}
