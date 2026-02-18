import * as dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { isBtSerialCandidate, extractMacFromPnpId, hasLegoMacPrefix } from './bluetoothPortSelection';

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
	friendlyName?: string;
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

// ── Bluetooth discovery ─────────────────────────────────────────────

/** A BT COM port candidate enriched with MAC and display name. */
export interface BluetoothCandidate {
	path: string;
	mac?: string;
	displayName?: string;
	pnpId?: string;
	hasLegoPrefix: boolean;
}

/** Generic tokens stripped from BT friendly names. */
const GENERIC_BT_TOKENS = new Set([
	'bluetooth', 'serial', 'protocol', 'port', 'com', 'spp',
	'standard', 'device', 'service', 'rfcomm', 'incoming',
	'outgoing', 'dev', 'b', 'profile'
]);

/**
 * Enumerate BT COM port candidates from `listSerialCandidates()`,
 * filter for BT ports, extract MAC addresses, and resolve friendly names
 * from the Windows BT registry.
 */
export async function listBluetoothCandidates(): Promise<BluetoothCandidate[]> {
	const [serial, nameMap] = await Promise.all([
		listSerialCandidates(),
		resolveWindowsBluetoothNameMap()
	]);

	return serial
		.filter(isBtSerialCandidate)
		.map((c) => {
			const mac = extractMacFromPnpId(c.pnpId);
			const registryName = mac ? nameMap.get(mac) : undefined;
			const displayName = normalizeBtBrickName(registryName, c.friendlyName, c.manufacturer, mac);
			return {
				path: c.path,
				mac,
				displayName,
				pnpId: c.pnpId,
				hasLegoPrefix: hasLegoMacPrefix(c.pnpId),
			};
		});
}

/** Cache for registry name map (TTL 10 s). */
let nameMapCache: { map: Map<string, string>; ts: number } | undefined;
const NAME_MAP_CACHE_TTL_MS = 10_000;

/**
 * Query the Windows Bluetooth registry for paired device friendly names.
 * Returns a Map of lowercase MAC (12 hex chars) → friendly name.
 * Cached for 10 seconds. Returns empty map on non-Windows or errors.
 */
export async function resolveWindowsBluetoothNameMap(): Promise<Map<string, string>> {
	if (nameMapCache && Date.now() - nameMapCache.ts < NAME_MAP_CACHE_TTL_MS) {
		return nameMapCache.map;
	}

	if (process.platform !== 'win32') {
		const empty = new Map<string, string>();
		nameMapCache = { map: empty, ts: Date.now() };
		return empty;
	}

	try {
		const json = await runPowershell(
			`Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices' -ErrorAction SilentlyContinue | ForEach-Object { $name = (Get-ItemProperty $_.PSPath -Name 'Name' -ErrorAction SilentlyContinue).Name; if ($name) { [PSCustomObject]@{ Mac = $_.PSChildName; Name = [System.Text.Encoding]::UTF8.GetString($name).TrimEnd([char]0) } } } | ConvertTo-Json -Compress`
		);

		const map = new Map<string, string>();
		const parsed = JSON.parse(json);
		const entries = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
		for (const entry of entries) {
			if (entry?.Mac && entry?.Name) {
				map.set(String(entry.Mac).toLowerCase(), String(entry.Name));
			}
		}
		nameMapCache = { map, ts: Date.now() };
		return map;
	} catch {
		const empty = new Map<string, string>();
		nameMapCache = { map: empty, ts: Date.now() };
		return empty;
	}
}

/** @internal Exposed for testing — invalidate the name map cache. */
export function clearBluetoothNameMapCache(): void {
	nameMapCache = undefined;
}

/**
 * Resolve a display name for a BT candidate using the priority chain:
 * 1. Registry friendly name (cleaned)
 * 2. Manufacturer field (if short and not "Microsoft")
 * 3. MAC address suffix (EV3-XXYY)
 */
function normalizeBtBrickName(
	registryName: string | undefined,
	friendlyName: string | undefined,
	manufacturer: string | undefined,
	mac: string | undefined
): string | undefined {
	const cleaned = cleanBtName(registryName) ?? cleanBtName(friendlyName);
	if (cleaned) {
		return cleaned;
	}

	if (manufacturer && manufacturer.length <= 12 && !/^microsoft$/i.test(manufacturer)) {
		return manufacturer;
	}

	if (mac && mac.length >= 4) {
		return `EV3-${mac.slice(-4).toUpperCase()}`;
	}

	return undefined;
}

/** Remove generic BT tokens and `(COMx)` from a friendly name. */
function cleanBtName(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}
	let name = raw
		.replace(/\(COM\d+\)/gi, '')
		.replace(/[^\p{L}\p{N}\s-]/gu, ' ')
		.trim();

	const tokens = name.split(/\s+/).filter((t) => !GENERIC_BT_TOKENS.has(t.toLowerCase()));
	name = tokens.join(' ').trim();

	if (!name || name.length > 24) {
		return undefined;
	}
	return name;
}

function runPowershell(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{ timeout: 5000, maxBuffer: 512 * 1024, windowsHide: true },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(stdout.trim());
			}
		);
	});
}
