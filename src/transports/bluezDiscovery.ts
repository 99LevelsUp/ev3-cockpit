/**
 * The Linux answers to the synchronous seams `BtClassicDiscovery` takes (step-7 plan, U4):
 * `listDevices` and `radioName`, from the BlueZ object cache.
 */

import type { BluetoothDeviceInfo } from './windowsBluetooth';
import type { BluezObjectCache } from './bluezObjects';

/**
 * Lists what BlueZ knows in the shape the Windows device cache has, so `BtClassicDiscovery`
 * filters and names bricks the same way on both platforms. A paired device counts as remembered
 * and authenticated, as Windows' record of a paired device does.
 *
 * @throws Before the cache has read BlueZ: discovery reports that once, rather than show an empty
 *   list as though there were no bricks.
 */
export function bluezListDevices(cache: BluezObjectCache): () => BluetoothDeviceInfo[] {
	return () => {
		if (!cache.ready) { throw new Error('BlueZ is not ready: its objects have not been read.'); }
		const devices: BluetoothDeviceInfo[] = [];
		for (const device of cache.devices()) {
			const hex = device.address?.replace(/:/g, '').toLowerCase();
			if (!hex || !/^[0-9a-f]{12}$/.test(hex)) { continue; }
			devices.push({
				mac: hex,
				name: device.name ?? device.alias ?? '',
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
export function bluezRadioName(cache: BluezObjectCache): () => string | undefined {
	return () => cache.adapter()?.alias || undefined;
}
