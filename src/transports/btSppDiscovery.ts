/**
 * Finds bricks the host has already paired over Bluetooth, and opens SPP ports to them.
 *
 * `BtTransportProvider` knows how to run a session but was constructed with no backends and
 * no discovery function, so `discover()` returned empty and connecting threw "No BT backends
 * configured" (plan 3.1.4d). This is the missing half.
 *
 * Windows exposes a paired SPP peer as an outgoing COM port whose PnP id carries the peer's
 * address, so one enumeration answers both questions at once: which bricks are paired, and
 * which port reaches each. That coupling is why discovery and the adapter factory live in one
 * module and share a cache — the factory is handed only a MAC, and without the map built by
 * the most recent scan it has no way to turn that into a port.
 *
 * What this deliberately does **not** do is pair anything. Pairing is the user's action on
 * their own machine; discovery reports what they have already set up.
 */

import { BT } from './transportConstants';
import { TransportAdapter } from './transportAdapter';
import { BtSppAdapter } from './btSppAdapter';
import { BtDiscoveryDevice } from './btTransportProvider';
import { TransportError } from '../errors/CockpitError';

/** One paired brick and the serial port that reaches it. */
export interface SppPeer {
	readonly mac: string;
	readonly name: string;
	readonly portPath: string;
}

/** The shape of a `SerialPort.list()` entry, duck-typed so `serialport` stays optional. */
interface SerialPortInfo {
	path: string;
	manufacturer?: string;
	friendlyName?: string;
	pnpId?: string;
}

type ListPorts = () => Promise<SerialPortInfo[]>;

/** Loads `serialport` lazily, so a host without it still runs everything else. */
function loadListPorts(): ListPorts {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('serialport') as { SerialPort?: { list?: ListPorts } };
		const list = mod.SerialPort?.list;
		if (typeof list !== 'function') {
			throw new Error('serialport exports no SerialPort.list');
		}
		return list.bind(mod.SerialPort);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new TransportError(
			`BT discovery requires package "serialport". (${detail})`
		);
	}
}

const LEGO_OUI = BT.LEGO_OUI.replace(/[:-]/g, '').toUpperCase();

/**
 * Pulls a Bluetooth address out of a Windows PnP id.
 *
 * The id looks like `BTHENUM\{...}_LOCALMFG&0000\7&abc&0&001653AABBCC_C00000000`, so the
 * address is a run of twelve hex digits. Matching the LEGO OUI rather than any run keeps a
 * GUID or an instance number from being mistaken for an address — several of those are also
 * long hex runs, which is why the OUI is part of the pattern and not a filter applied after.
 */
export function macFromPnpId(pnpId: string | undefined): string | undefined {
	if (!pnpId) { return undefined; }
	const flattened = pnpId.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
	const match = new RegExp(`(${LEGO_OUI}[0-9A-F]{6})`).exec(flattened);
	return match ? match[1] : undefined;
}

/** Formats a bare twelve-digit address the way the rest of the transports spell one. */
export function formatMac(bare: string): string {
	return (bare.match(/.{2}/g) ?? []).join(':').toUpperCase();
}

/**
 * Discovery and the adapter factory, sharing the map that connects them.
 *
 * Create one per provider. `discover` refreshes the map; `adapterFor` uses it. A MAC that
 * has never appeared in a scan fails loudly rather than guessing a port, because a wrong
 * port opens *something* — on this machine the only other Bluetooth serial device is a
 * headset — and a session that half-works is harder to diagnose than one that refuses.
 */
export class BtSppBackend {
	private readonly portByMac = new Map<string, SppPeer>();
	private readonly listPorts: ListPorts;

	constructor(listPorts?: ListPorts) {
		this.listPorts = listPorts ?? loadListPorts();
	}

	/** Everything currently paired, as the provider's discovery function expects it. */
	discover = async (): Promise<BtDiscoveryDevice[]> => {
		const ports = await this.listPorts();
		this.portByMac.clear();

		const devices: BtDiscoveryDevice[] = [];
		for (const port of ports) {
			const bare = macFromPnpId(port.pnpId);
			if (!bare) { continue; }
			const mac = formatMac(bare);
			const name = friendlyNameOf(port) ?? `EV3 [${mac}]`;
			this.portByMac.set(mac, { mac, name, portPath: port.path });
			devices.push({
				mac,
				name,
				// A paired outgoing port exists whether or not a link is up, and opening it is
				// what establishes one. So the port list can say "remembered" honestly and
				// cannot say "connected" — claiming otherwise would make presence lie.
				connected: false,
				remembered: true,
				authenticated: true,
			});
		}
		return devices;
	};

	/** The serial port reaching a MAC, if the last scan saw it. */
	peerFor(mac: string): SppPeer | undefined {
		return this.portByMac.get(formatMac(mac.replace(/[:-]/g, '')));
	}

	/** Adapter factory for {@link BtTransportProvider}'s `spp` backend. */
	adapterFor = (mac: string): TransportAdapter => {
		const peer = this.peerFor(mac);
		if (!peer) {
			throw new TransportError(
				`No Bluetooth serial port for ${mac}. Pair the brick with this computer first, `
				+ 'then run discovery again.'
			);
		}
		return new BtSppAdapter({ portPath: peer.portPath });
	};
}

function friendlyNameOf(port: SerialPortInfo): string | undefined {
	// friendlyName reads like "Standard Serial over Bluetooth link (COM5)" for a generic
	// pairing, which names the mechanism rather than the brick. Prefer it anyway when it
	// carries something else — some stacks put the peer's own name there.
	const raw = port.friendlyName ?? port.manufacturer;
	if (!raw) { return undefined; }
	if (/serial over bluetooth/i.test(raw)) { return undefined; }
	return raw.replace(/\s*\([^)]*\)\s*$/, '').trim() || undefined;
}
