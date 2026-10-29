/**
 * Bluetooth discovery from the Windows device cache, with the COM-port scan behind it.
 *
 * The port scan used to be the only source, and it answers a narrower question than
 * discovery asks: not "which bricks does this machine know" but "which paired bricks have
 * an outgoing serial port". Those were the same list while the runtime went through a
 * serial port. Since it goes through a socket, a paired brick whose port Windows never
 * created is invisible to the cockpit and perfectly reachable by the transport.
 *
 * It does **not** solve the naming problem, which this file claimed for a few hours before
 * anyone ran it against the real DLL. `szName` is populated only for devices Windows is
 * currently connected to; for a remembered brick it comes back empty, measured on all three
 * bricks on 28.08.2026. A brick still shows as `EV3 [00:16:53:42:D9:F2]` until something
 * asks the brick itself. See plan 2.8.13.
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
import type { BtConnectionQueue } from './btConnectionQueue';
import type { BtPairingEvent } from './btPairingHelper';

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
	/**
	 * Pairs with a device. Injectable for the same reason as {@link listDevices}.
	 *
	 * `onEvent` carries the progress of this one pairing; a binding without progress events
	 * (the legacy `bthprops.cpl` path) simply ignores it.
	 */
	pairDevice?: (mac: string, onEvent?: (event: BtPairingEvent) => void) => Promise<{ ok: boolean; reason?: string }>;
	/** Removes a pairing. */
	unpairDevice?: (mac: string) => { ok: boolean; reason?: string };
	/**
	 * The shared RFCOMM queue, so pairing takes the radio slot rather than racing a connect
	 * for it.
	 *
	 * Belongs here rather than at the call site: Windows carries exactly one RFCOMM channel
	 * and pairing uses it like any connect does. Wrapping the queue around `pair()` somewhere
	 * up in the composition root would leave the invariant true only for whoever remembered
	 * to wrap, and the next caller would find out the hard way.
	 *
	 * Consequence worth knowing rather than working around: the queue's inter-connection
	 * cooldown applies, so the first connect after a pairing waits it out. That is correct —
	 * they are the same radio — but it does make that one connect look slow.
	 */
	connectionQueue?: Pick<BtConnectionQueue, 'enqueue'>;
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
	private readonly pairDevice: (mac: string, onEvent?: (event: BtPairingEvent) => void) => Promise<PairingResult>;
	private readonly unpairDevice: (mac: string) => PairingResult;
	private readonly connectionQueue?: Pick<BtConnectionQueue, 'enqueue'>;

	constructor(options: BtClassicDiscoveryOptions = {}) {
		this.listDevices = options.listDevices ?? (() => listBluetoothDevices());
		this.portScan = options.portScan;
		this.onCacheUnavailable = options.onCacheUnavailable;
		this.pairDevice = options.pairDevice ?? pairBluetoothDevice;
		this.unpairDevice = options.unpairDevice ?? removeBluetoothDevice;
		this.connectionQueue = options.connectionQueue;
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
	 *
	 * @param onEvent Progress of this pairing only, so the caller can prompt the user at the
	 *   right moment without sharing a listener with any other pairing in flight.
	 */
	pair = async (mac: string, onEvent?: (event: BtPairingEvent) => void): Promise<PairingResult> => {
		const failed = (error: unknown): PairingResult =>
			({ ok: false, reason: error instanceof Error ? error.message : String(error) });

		const attempt = async (): Promise<PairingResult> => {
			try {
				return await this.pairDevice(mac, onEvent);
			} catch (error) {
				// Includes the helper being missing entirely, which arrives as a
				// BackendUnavailableError and is an install fault rather than a refusal — the
				// message says so, and `pair` stays a function that answers instead of throwing.
				return failed(error);
			}
		};

		if (!this.connectionQueue) { return attempt(); }
		try {
			return await this.connectionQueue.enqueue(mac, attempt);
		} catch (error) {
			// The queue itself can refuse before the attempt ever runs: no slot within its
			// acquire timeout (a connected Bluetooth brick holds the only one), or a disposed
			// queue. Same contract as above — an answer, not a throw.
			return failed(error);
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
				// Usually empty: Windows fills szName only while it is connected to the
				// device. The port scan's `EV3 [address]` is what a user normally sees.
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
