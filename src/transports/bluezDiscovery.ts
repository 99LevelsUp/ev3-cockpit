/**
 * The Linux answers to the synchronous seams `BtClassicDiscovery` takes (step-7 plan, U4):
 * `listDevices` and `radioName`, from the BlueZ object cache.
 */

import type { BluetoothDeviceInfo } from './windowsBluetooth';
import type { BluezDevice, BluezObjectCache } from './bluezObjects';

/**
 * Lists what BlueZ knows in the shape the Windows device cache has, so `BtClassicDiscovery`
 * filters and names bricks the same way on both platforms. A paired device counts as remembered
 * and authenticated, as Windows' record of a paired device does.
 *
 * @throws Before the cache has read BlueZ: discovery reports that once, rather than show an empty
 *   list as though there were no bricks.
 */
export function bluezListDevices(cache: Pick<BluezObjectCache, 'ready' | 'devices'>): () => BluetoothDeviceInfo[] {
	return () => {
		if (!cache.ready) { throw new Error('BlueZ is not ready: its objects have not been read.'); }
		const devices: BluetoothDeviceInfo[] = [];
		for (const device of cache.devices()) {
			const hex = device.address?.replace(/:/g, '').toLowerCase();
			if (!hex || !/^[0-9a-f]{12}$/.test(hex)) { continue; }
			devices.push({
				mac: hex,
				name: bluezDeviceName(device),
				connected: device.connected,
				remembered: device.paired,
				authenticated: device.paired || device.bonded,
				classOfDevice: device.classOfDevice ?? 0,
			});
		}
		return devices;
	};
}

/** This computer's Bluetooth name: the adapter's `Alias`, which BlueZ defaults to the host name. */
export function bluezRadioName(cache: Pick<BluezObjectCache, 'adapter'>): () => string | undefined {
	return () => cache.adapter()?.alias || undefined;
}

/** A device's Name, or a user's own Alias; never the dashed address BlueZ puts in Alias without a Name. */
export function bluezDeviceName(device: Pick<BluezDevice, 'name' | 'alias'>): string {
	return device.name ?? (device.alias && !isAddressAlias(device.alias) ? device.alias : '');
}

/** BlueZ's default Alias for a device without a Name: its address, dashed. */
function isAddressAlias(alias: string): boolean {
	return /^([0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}$/.test(alias);
}

/**
 * The radio's discovery as one resource, between the pairing search and the inquiry (U8 review
 * #5). A pairing search that gives up before its `StartDiscovery` settles stops that discovery
 * later, when it does; the caller (and its turn in the Bluetooth queue) is gone by then. Whoever
 * starts the next discovery waits here first, so that late `StopDiscovery` cannot end it.
 */
export class DiscoveryGate {
	private readonly pending = new Set<Promise<void>>();

	/** A discovery's end that outlives its caller. */
	track(settled: Promise<unknown>): void {
		const done: Promise<void> = settled.then(() => undefined, () => undefined).finally(() => { this.pending.delete(done); });
		this.pending.add(done);
	}

	/** Settles once no discovery's end is outstanding. */
	async idle(): Promise<void> {
		while (this.pending.size > 0) { await Promise.all([...this.pending]); }
	}
}
