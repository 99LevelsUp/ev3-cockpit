/**
 * Bluetooth discovery from the Windows device cache, with the COM-port scan behind it.
 *
 * The port scan used to be the only source, and it answers a narrower question than
 * discovery asks: not "which bricks does this machine know" but "which paired bricks have
 * an outgoing serial port". Those were the same list while the runtime went through a
 * serial port. Since it goes through a socket, a paired brick whose port Windows never
 * created is invisible to the cockpit and perfectly reachable by the transport.
 *
 * The cache also carries the brick's own name. Over the port scan a brick appears as
 * `EV3 [00:16:53:42:D9:F2]` while the same brick over USB says `CCC`; here it says `CCC`.
 *
 * Both sources run on every scan. The cache decides what exists and what it is called; the
 * port scan still runs because {@link BtSppBackend} builds its adapters from what it saw,
 * and the SPP fallback would have nothing to open otherwise. Neither costs air time.
 */

import { BtDiscoveryDevice } from './btTransportProvider';
import {
	BluetoothDeviceInfo, listBluetoothDevices, isLikelyEv3,
	pairBluetoothDevice, removeBluetoothDevice,
} from './windowsBluetooth';
import { BT } from './transportConstants';
import { formatMac } from './btSppDiscovery';

/** Configuration for {@link BtClassicDiscovery}. */
export interface BtClassicDiscoveryOptions {
	/**
	 * Reads the Windows Bluetooth device cache.
	 *
	 * Injectable because the alternative is a test that only passes on a machine with a
	 * radio and the right bricks paired to it.
	 */
	listDevices?: () => BluetoothDeviceInfo[];
	/**
	 * The COM-port scan, kept as a fallback and to keep the SPP backend's port map fresh.
	 */
	portScan?: () => Promise<BtDiscoveryDevice[]>;
	/** Called when the cache cannot be read, once per scan. */
	onCacheUnavailable?: (reason: string) => void;
	/** Pairs with a device. Injectable for the same reason as {@link listDevices}. */
	pairDevice?: (mac: string) => Promise<{ ok: boolean; reason?: string }>;
	/** Removes a pairing. */
	unpairDevice?: (mac: string) => { ok: boolean; reason?: string };
}

/** Outcome of a pairing operation. */
export interface PairingResult {
	ok: boolean;
	/** Why it did not happen. Absent on success. */
	reason?: string;
}

/**
 * Discovers EV3 bricks over Bluetooth.
 */
export class BtClassicDiscovery {
	private readonly listDevices: () => BluetoothDeviceInfo[];
	private readonly portScan?: () => Promise<BtDiscoveryDevice[]>;
	private readonly onCacheUnavailable?: (reason: string) => void;
	private readonly pairDevice: (mac: string) => Promise<PairingResult>;
	private readonly unpairDevice: (mac: string) => PairingResult;

	constructor(options: BtClassicDiscoveryOptions = {}) {
		this.listDevices = options.listDevices ?? (() => listBluetoothDevices());
		this.portScan = options.portScan;
		this.onCacheUnavailable = options.onCacheUnavailable;
		this.pairDevice = options.pairDevice ?? pairBluetoothDevice;
		this.unpairDevice = options.unpairDevice ?? removeBluetoothDevice;
	}

	/**
	 * Pairs this machine with a brick.
	 *
	 * Pairing belongs here rather than to a command or a view: it is the same question
	 * discovery asks — which bricks does this machine know — and the call sits in the same
	 * DLL, next to the enumeration. Putting it a layer up would mean the same FFI in two
	 * places and a UI that knows about `bthprops.cpl`.
	 *
	 * Windows shows its own dialog and the user types the brick's PIN. Every EV3 uses the
	 * same one, and the brick displays it when asked.
	 */
	pair = async (mac: string): Promise<PairingResult> => {
		try {
			return await this.pairDevice(mac);
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	};

	/**
	 * Removes the pairing, so the machine forgets the brick.
	 *
	 * This is what makes `forget()` mean what its name says. Until now it dropped the
	 * cockpit's own bookkeeping and left the Windows pairing in place, so a forgotten brick
	 * reappeared on the next scan.
	 */
	unpair = (mac: string): PairingResult => {
		try {
			return this.unpairDevice(mac);
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	};

	/**
	 * Bound so it can be handed straight to `BtTransportProvider` as its discovery function.
	 */
	discover = async (): Promise<BtDiscoveryDevice[]> => {
		// Always, and first: the SPP backend learns its port map here, so skipping this on
		// the cache path would leave the fallback backend unable to open anything.
		const scanned = this.portScan ? await this.portScan().catch(() => []) : [];

		let cached: BluetoothDeviceInfo[];
		try {
			cached = this.listDevices();
		} catch (error) {
			this.onCacheUnavailable?.(error instanceof Error ? error.message : String(error));
			return scanned;
		}

		const bricks = cached.filter((device) => isLikelyEv3(device, BT.LEGO_OUI));
		if (!bricks.length) {
			// A cache that lists no brick is not evidence there is none: an inquiry has never
			// run and a brick paired long ago may have aged out. Whatever the ports say stands.
			return scanned;
		}

		const byMac = new Map(scanned.map((device) => [normalise(device.mac), device]));

		return bricks.map((device) => {
			const fromPort = byMac.get(normalise(device.mac));
			return {
				mac: formatMac(normalise(device.mac)),
				// The cache knows the brick's own name; the port scan never did.
				name: device.name || fromPort?.name || '',
				connected: device.connected,
				remembered: device.remembered,
				authenticated: device.authenticated,
			};
		});
	};
}

function normalise(mac: string): string {
	return mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}
