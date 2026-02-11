import * as dgram from 'node:dgram';

export interface UsbHidCandidate {
	path: string;
	vendorId?: number;
	productId?: number;
	product?: string;
	serialNumber?: string;
}

export interface SerialCandidate {
	path: string;
	manufacturer?: string;
	serialNumber?: string;
	pnpId?: string;
}

export interface TcpDiscoveryCandidate {
	ip: string;
	port: number;
	serialNumber: string;
	protocol: string;
	name: string;
}

/** Default EV3 UDP discovery broadcast port. */
const DEFAULT_TCP_DISCOVERY_PORT = 3015;
/** Discovery window for collecting EV3 UDP beacons in UI scans. */
const DEFAULT_TCP_DISCOVERY_SCAN_TIMEOUT_MS = 1_500;

export async function listUsbHidCandidates(vendorId = 0x0694, productId = 0x0005): Promise<UsbHidCandidate[]> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const hid = require('node-hid') as {
			devices: (vid?: number, pid?: number) => UsbHidCandidate[];
		};
		return hid.devices(vendorId, productId).map((entry) => ({
			path: entry.path,
			vendorId: entry.vendorId,
			productId: entry.productId,
			product: entry.product,
			serialNumber: entry.serialNumber
		}));
	} catch {
		return [];
	}
}

export async function listSerialCandidates(): Promise<SerialCandidate[]> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('serialport') as {
			SerialPort?: { list: () => Promise<SerialCandidate[]> };
		};
		if (!mod.SerialPort || typeof mod.SerialPort.list !== 'function') {
			return [];
		}

		return mod.SerialPort.list();
	} catch {
		return [];
	}
}

interface ParsedTcpBeacon {
	port: number;
	serialNumber: string;
	protocol: string;
	name: string;
}

function parseTcpBeacon(message: string): ParsedTcpBeacon | undefined {
	const lines = message
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const map = new Map<string, string>();
	for (const line of lines) {
		const index = line.indexOf(':');
		if (index < 0) {
			continue;
		}
		const key = line.slice(0, index).trim().toLowerCase();
		const value = line.slice(index + 1).trim();
		map.set(key, value);
	}

	const portRaw = map.get('port') ?? '';
	const port = Number.parseInt(portRaw, 10);
	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		return undefined;
	}

	return {
		port,
		serialNumber: map.get('serial-number') ?? '',
		protocol: map.get('protocol') ?? 'WiFi',
		name: map.get('name') ?? ''
	};
}

export async function listTcpDiscoveryCandidates(
	discoveryPort = DEFAULT_TCP_DISCOVERY_PORT,
	timeoutMs = DEFAULT_TCP_DISCOVERY_SCAN_TIMEOUT_MS,
	hostFilter?: string
): Promise<TcpDiscoveryCandidate[]> {
	const effectiveTimeoutMs = Math.max(100, Math.floor(timeoutMs));
	return new Promise<TcpDiscoveryCandidate[]>((resolve) => {
		const candidates = new Map<string, TcpDiscoveryCandidate>();
		const socket = dgram.createSocket('udp4');
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			socket.removeAllListeners('error');
			socket.removeAllListeners('message');
			socket.close();
			resolve(Array.from(candidates.values()));
		};

		socket.on('error', () => {
			finish();
		});
		socket.on('message', (msg, rinfo) => {
			if (hostFilter && rinfo.address !== hostFilter) {
				return;
			}
			const parsed = parseTcpBeacon(msg.toString('utf8'));
			if (!parsed) {
				return;
			}
			const key = `${rinfo.address}:${parsed.port}:${parsed.serialNumber}:${parsed.name}`;
			if (candidates.has(key)) {
				return;
			}
			candidates.set(key, {
				ip: rinfo.address,
				port: parsed.port,
				serialNumber: parsed.serialNumber,
				protocol: parsed.protocol,
				name: parsed.name
			});
		});
		socket.bind(discoveryPort, () => {
			timer = setTimeout(finish, effectiveTimeoutMs);
			timer.unref?.();
		});
	});
}
