/**
 * BlueZ's objects, kept in memory (step-7 plan, U4, KTD4).
 *
 * One `GetManagedObjects`, then `InterfacesAdded`, `InterfacesRemoved` and `PropertiesChanged`
 * keep it current. The seams the Windows backend defined are synchronous — `listDevices`,
 * `radioName` — and on Linux they answer from here, never from a bus round trip. BlueZ holds a
 * paired brick's name while it is not connected (HOSTC, 13.11.2026), unlike Windows.
 */

import { DBusValue, Variant } from './dbus/wire';
import type { DBusMessage } from './dbus/message';
import type { DBusConnection } from './dbus/connection';

export const BLUEZ = 'org.bluez';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const DEVICE = 'org.bluez.Device1';
const ADAPTER = 'org.bluez.Adapter1';

/** What the cache needs of a bus connection; a fake in tests. */
export type BusLike = Pick<DBusConnection, 'call' | 'addMatch' | 'onSignal' | 'onClose'>;

/** One device BlueZ knows. */
export interface BluezDevice {
	path: string;
	address: string | undefined;
	name: string | undefined;
	alias: string | undefined;
	classOfDevice: number | undefined;
	paired: boolean;
	bonded: boolean;
	trusted: boolean;
	connected: boolean;
	/** Only while a discovery hears it. */
	rssi: number | undefined;
}

export interface BluezAdapter {
	path: string;
	address: string | undefined;
	/** The name this computer's radio gives itself; what a brick lists it under. */
	alias: string | undefined;
	powered: boolean;
	discovering: boolean;
}

export interface BluezObjectCacheOptions {
	/**
	 * The unique name that owns `org.bluez`, to check each signal's sender against. Without it the
	 * match rules' `sender='org.bluez'` is the filter: the bus delivers only BlueZ's signals.
	 */
	bluezOwner?: () => string | undefined;
}

type Properties = Map<string, DBusValue>;

export class BluezObjectCache {
	private readonly objects = new Map<string, Map<string, Properties>>();
	private readonly changeHandlers = new Set<() => void>();
	private _ready = false;

	constructor(private readonly bus: BusLike, private readonly options: BluezObjectCacheOptions = {}) {}

	get ready(): boolean {
		return this._ready;
	}

	/**
	 * Subscribes, then reads everything: subscribing first means no change falls between the read
	 * and the subscription.
	 *
	 * @throws The bus's refusal (an `AccessDenied` where the policy keeps this user from BlueZ).
	 */
	async start(): Promise<void> {
		this.bus.onSignal((message) => this.onSignal(message));
		this.bus.onClose(() => { this._ready = false; this.objects.clear(); });
		await this.bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${OBJECT_MANAGER}'`);
		await this.bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${PROPERTIES}',member='PropertiesChanged'`);
		const [managed] = await this.bus.call({ destination: BLUEZ, path: '/', interface: OBJECT_MANAGER, member: 'GetManagedObjects' });
		if (!(managed instanceof Map)) { throw new Error('BlueZ answered GetManagedObjects with something that is not a map.'); }
		for (const [path, interfaces] of managed) {
			this.addInterfaces(path, interfaces);
		}
		this._ready = true;
	}

	/** Every device BlueZ knows: paired, and heard by a discovery. */
	devices(): BluezDevice[] {
		const devices: BluezDevice[] = [];
		for (const [path, interfaces] of this.objects) {
			const props = interfaces.get(DEVICE);
			if (!props) { continue; }
			devices.push({
				path,
				address: text(props.get('Address')),
				name: text(props.get('Name')),
				alias: text(props.get('Alias')),
				classOfDevice: integer(props.get('Class')),
				paired: props.get('Paired') === true,
				bonded: props.get('Bonded') === true,
				trusted: props.get('Trusted') === true,
				connected: props.get('Connected') === true,
				rssi: integer(props.get('RSSI')),
			});
		}
		return devices;
	}

	/** The first adapter, `hci0` on HOSTC; a second radio is out of scope (plan, Risks). */
	adapter(): BluezAdapter | undefined {
		for (const [path, interfaces] of [...this.objects].sort(([a], [b]) => a.localeCompare(b))) {
			const props = interfaces.get(ADAPTER);
			if (!props) { continue; }
			return {
				path,
				address: text(props.get('Address')),
				alias: text(props.get('Alias')),
				powered: props.get('Powered') === true,
				discovering: props.get('Discovering') === true,
			};
		}
		return undefined;
	}

	/** Told after each change to the cache. */
	onChange(handler: () => void): () => void {
		this.changeHandlers.add(handler);
		return () => { this.changeHandlers.delete(handler); };
	}

	// ── Internal ────────────────────────────────────────────────────

	private onSignal(message: DBusMessage): void {
		const owner = this.options.bluezOwner?.();
		if (owner !== undefined && message.sender !== owner) { return; }
		const [a, b, c] = message.body;
		let changed = false;
		if (message.interface === OBJECT_MANAGER && message.member === 'InterfacesAdded') {
			if (typeof a === 'string' && b instanceof Map) { changed = this.addInterfaces(a, b); }
		} else if (message.interface === OBJECT_MANAGER && message.member === 'InterfacesRemoved') {
			if (typeof a === 'string' && Array.isArray(b)) { changed = this.removeInterfaces(a, b); }
		} else if (message.interface === PROPERTIES && message.member === 'PropertiesChanged') {
			if (message.path && typeof a === 'string' && b instanceof Map && Array.isArray(c)) {
				changed = this.changeProperties(message.path, a, b, c);
			}
		}
		if (changed) { this.notify(); }
	}

	private addInterfaces(path: DBusValue, interfaces: DBusValue): boolean {
		if (typeof path !== 'string' || !(interfaces instanceof Map)) { return false; }
		const held = this.objects.get(path) ?? new Map<string, Properties>();
		for (const [name, props] of interfaces) {
			if (typeof name !== 'string' || !(props instanceof Map)) { continue; }
			held.set(name, unwrap(props));
		}
		this.objects.set(path, held);
		return true;
	}

	private removeInterfaces(path: string, names: DBusValue[]): boolean {
		const held = this.objects.get(path);
		if (!held) { return false; }
		for (const name of names) { if (typeof name === 'string') { held.delete(name); } }
		if (held.size === 0) { this.objects.delete(path); }
		return true;
	}

	private changeProperties(path: string, iface: string, changed: Map<DBusValue, DBusValue>, invalidated: DBusValue[]): boolean {
		// Only objects the cache already holds: a PropertiesChanged does not make an object up.
		const props = this.objects.get(path)?.get(iface);
		if (!props) { return false; }
		for (const [key, value] of unwrap(changed)) { props.set(key, value); }
		for (const key of invalidated) { if (typeof key === 'string') { props.delete(key); } }
		return true;
	}

	private notify(): void {
		for (const handler of [...this.changeHandlers]) {
			try { handler(); } catch { /* one listener's fault is not the cache's */ }
		}
	}
}

/** `a{sv}` as plain values. */
function unwrap(props: Map<DBusValue, DBusValue>): Properties {
	const plain: Properties = new Map();
	for (const [key, value] of props) {
		if (typeof key !== 'string') { continue; }
		plain.set(key, value instanceof Variant ? value.value : value);
	}
	return plain;
}

function text(value: DBusValue | undefined): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function integer(value: DBusValue | undefined): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
