/**
 * Forgetting a brick through BlueZ (step-7 plan, U7, KTD6, KTD7): the Linux answers to
 * `BtTransportProvider`'s `unpairDevice` and `forgetResidue`.
 *
 * Measured on HOSTC (U0, 13.11.2026): `Adapter1.RemoveDevice` drops the device directory, link
 * key included; BlueZ keeps only its name cache, `/var/lib/bluetooth/<adapter>/cache/<brick>`,
 * owned by root. It is reported, never removed, as Windows' residue is (step-3 plan, KD3).
 */

import { DBusError, type CallOptions } from './dbus/connection';
import type { DBusValue } from './dbus/wire';
import type { BluezAdapter, BluezDevice } from './bluezObjects';
import { BLUEZ } from './bluezObjects';
import { macToBdaddr } from './linuxBluetoothSocket';
import type { ForgetResidue } from '../contracts';
import type { UnpairResult } from './btTransportProvider';

/** What forgetting needs of the bus. */
export interface UnpairBus {
	call(options: CallOptions): Promise<DBusValue[]>;
}

/** What forgetting needs of the object cache. */
export interface UnpairCache {
	devices(): BluezDevice[];
	adapter(): BluezAdapter | undefined;
}

/** `00:16:53:F0:0A:0A`, as BlueZ spells an address, or undefined for something that is not one. */
function canonical(mac: string): string | undefined {
	const bdaddr = macToBdaddr(mac);
	if (!bdaddr) { return undefined; }
	return Array.from(bdaddr).reverse().map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/**
 * Removes BlueZ's record of the brick, link key included. A brick BlueZ does not hold is already
 * forgotten, which is what the caller asked for, as Windows counts `ERROR_NOT_FOUND`.
 */
export function createBluezUnpair(options: { bus: UnpairBus; cache: UnpairCache }): (mac: string) => Promise<UnpairResult> {
	const { bus, cache } = options;
	return async (mac) => {
		const address = canonical(mac);
		if (!address) { return { ok: false, reason: `Not a MAC address: ${mac}` }; }
		const adapter = cache.adapter();
		if (!adapter) { return { ok: false, reason: 'This computer has no Bluetooth adapter BlueZ knows.' }; }
		// The cache holds every adapter's objects; only this adapter's device can be removed through it.
		const held = cache.devices().filter((d) => d.address?.toUpperCase() === address);
		const device = held.find((d) => d.path.startsWith(`${adapter.path}/`));
		if (!device) {
			if (held.length > 0) {
				return { ok: false, reason: `BlueZ holds this brick under another adapter; the cockpit forgets through ${adapter.path} only.` };
			}
			return { ok: true };
		}
		try {
			await bus.call({ destination: BLUEZ, path: adapter.path, interface: 'org.bluez.Adapter1', member: 'RemoveDevice', signature: 'o', body: [device.path] });
			return { ok: true };
		} catch (error) {
			if (error instanceof DBusError && error.dbusName === 'org.bluez.Error.DoesNotExist') { return { ok: true }; }
			const what = error instanceof DBusError ? `${error.dbusName}: ${error.detail}` : (error instanceof Error ? error.message : String(error));
			return { ok: false, reason: `BlueZ refused to remove the pairing (${what}).` };
		}
	};
}

/** What BlueZ keeps of a brick after `RemoveDevice`: its name cache. */
export function bluezForgetResidue(cache: Pick<UnpairCache, 'adapter'>): (mac: string) => ForgetResidue[] {
	return (mac) => {
		const address = canonical(mac) ?? mac;
		const adapter = cache.adapter()?.address?.toUpperCase() ?? '<adapter>';
		return [{
			location: `/var/lib/bluetooth/${adapter}/cache/${address}`,
			reason: 'BlueZ keeps the brick\'s name here after unpairing; it is owned by root and the cockpit does not change it.',
		}];
	};
}
