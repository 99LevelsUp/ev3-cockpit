import * as dgram from 'node:dgram';
import { LEGO_MAC_OUI_PREFIX, extractMacFromPnpId, hasEv3PnpHint, hasLegoMacPrefix } from './bluetoothPortSelection';
import { listBluetoothDevices } from './windowsBluetoothApi';

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
		const devices = hid.devices();
		let filtered = devices.filter((entry) => entry.vendorId === vendorId && entry.productId === productId);
		if (filtered.length === 0) {
			filtered = devices.filter((entry) => entry.vendorId === vendorId);
		}
		if (filtered.length === 0) {
			filtered = devices.filter((entry) => {
				const product = String(entry.product ?? '');
				const manufacturer = String((entry as { manufacturer?: string }).manufacturer ?? '');
				return /ev3/i.test(product) || /lego/i.test(manufacturer);
			});
		}
		return filtered.map((entry) => ({
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
		return await mod.SerialPort.list();
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
	present?: boolean;
	connectable?: boolean;
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
	const [serial, nameMap, unknownDevices, connectedDevices] = await Promise.all([
		listSerialCandidates(),
		resolveWindowsBluetoothNameMap(),
		resolveWindowsBluetoothUnknownDevices(),
		resolveWindowsBluetoothConnectedDevices()
	]);

	const candidatesById = new Map<string, BluetoothCandidate>();
	const connectedMacs = new Set(connectedDevices.map((device) => device.mac.toLowerCase()));

	for (const serialCandidate of serial) {
		const path = serialCandidate.path.trim();
		if (!isComPath(path)) {
			continue;
		}
		const mac = extractMacFromPnpId(serialCandidate.pnpId);
		if (!isLikelyEv3SerialCandidate(serialCandidate, mac)) {
			continue;
		}
		const registryName = mac ? nameMap.get(mac) : undefined;
		const displayName = normalizeBtBrickName(
			registryName,
			serialCandidate.friendlyName,
			serialCandidate.manufacturer,
			mac
		);
		const key = mac ?? `com:${path.toLowerCase()}`;
		const present = mac ? connectedMacs.has(mac) : undefined;
		candidatesById.set(key, {
			path,
			mac,
			displayName,
			pnpId: serialCandidate.pnpId,
			hasLegoPrefix: hasLegoMacPrefix(serialCandidate.pnpId),
			present,
			connectable: true
		});
	}

	for (const liveDevice of unknownDevices) {
		const mac = liveDevice.mac;
		if (!mac.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase())) {
			continue;
		}
		const existing = candidatesById.get(mac);
		const registryName = nameMap.get(mac);
		const displayName = normalizeBtBrickName(registryName, liveDevice.name, undefined, mac);
		if (existing) {
			if (!existing.displayName && displayName) {
				existing.displayName = displayName;
			}
			existing.present = true;
			continue;
		}
		candidatesById.set(mac, {
			path: `BTADDR-${mac}`,
			mac,
			displayName,
			pnpId: liveDevice.instanceId,
			hasLegoPrefix: true,
			present: true,
			connectable: false
		});
	}

	return Array.from(candidatesById.values());
}

/** Cache for registry name map (TTL 10 s). */
let nameMapCache: { map: Map<string, string>; ts: number } | undefined;
const NAME_MAP_CACHE_TTL_MS = 10_000;
const WINDOWS_BT_DEVICE_REG_PATH = 'SYSTEM/CurrentControlSet/Services/BTHPORT/Parameters/Devices';
const WINAPI_LIVE_BT_CACHE_TTL_MS = 10_000;

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
		const map = readWindowsBluetoothNameMapViaWinApi();
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
		return `EVƎ-${mac.slice(-4).toUpperCase()}`;
	}

	return undefined;
}

interface RegKeyLike {
	openSubKey(name: string): RegKeyLike | null;
	getSubKeyNames(): string[];
	getBinaryValue(name: string): Buffer;
	close(): void;
}

interface RegKeyModuleLike {
	hklm?: RegKeyLike;
	disableRegKeyErrors?: (disabled?: boolean) => void;
}

function readWindowsBluetoothNameMapViaWinApi(): Map<string, string> {
	const map = new Map<string, string>();
	let moduleRef: RegKeyModuleLike | undefined;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		moduleRef = require('regkey') as RegKeyModuleLike;
	} catch {
		return map;
	}
	try {
		moduleRef.disableRegKeyErrors?.(true);
	} catch {
		// ignore: library may not expose this helper in older versions
	}

	const root = moduleRef.hklm?.openSubKey(WINDOWS_BT_DEVICE_REG_PATH) ?? null;
	if (!root) {
		return map;
	}
	try {
		for (const subKeyName of root.getSubKeyNames()) {
			const mac = normalizeMacFromRegistrySubKey(subKeyName);
			if (!mac) {
				continue;
			}
			const deviceKey = root.openSubKey(subKeyName);
			if (!deviceKey) {
				continue;
			}
			try {
				const nameRaw = deviceKey.getBinaryValue('Name');
				const decodedName = decodeRegistryUtf8Binary(nameRaw);
				if (decodedName) {
					map.set(mac, decodedName);
				}
			} catch {
				// Value missing or unreadable: ignore this entry.
			} finally {
				try {
					deviceKey.close();
				} catch {
					// ignore close errors
				}
			}
		}
	} finally {
		try {
			root.close();
		} catch {
			// ignore close errors
		}
	}
	return map;
}

function normalizeMacFromRegistrySubKey(subKeyName: string): string | undefined {
	const compact = subKeyName.replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
	return compact.length === 12 ? compact : undefined;
}

function decodeRegistryUtf8Binary(value: Buffer): string | undefined {
	if (!Buffer.isBuffer(value) || value.length === 0) {
		return undefined;
	}
	let end = value.length;
	while (end > 0 && value[end - 1] === 0) {
		end -= 1;
	}
	if (end <= 0) {
		return undefined;
	}
	const decoded = value.subarray(0, end).toString('utf8').trim();
	return decoded || undefined;
}

interface LiveBluetoothDevice {
	mac: string;
	name?: string;
	instanceId?: string;
}

let liveBtUnknownCache:
	| { ts: number; devices: LiveBluetoothDevice[]; inFlight?: Promise<LiveBluetoothDevice[]> }
	| undefined;
let liveBtConnectedCache:
	| { ts: number; devices: LiveBluetoothDevice[]; inFlight?: Promise<LiveBluetoothDevice[]> }
	| undefined;

async function resolveWindowsBluetoothUnknownDevices(): Promise<LiveBluetoothDevice[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	return queryWindowsBluetoothUnknownDevicesViaWinApi().catch(() => []);
}

async function resolveWindowsBluetoothConnectedDevices(): Promise<LiveBluetoothDevice[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	return queryWindowsBluetoothConnectedDevicesViaWinApi().catch(() => []);
}


async function queryWindowsBluetoothUnknownDevicesViaWinApi(): Promise<LiveBluetoothDevice[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	const now = Date.now();
	if (liveBtUnknownCache && !liveBtUnknownCache.inFlight && now - liveBtUnknownCache.ts < WINAPI_LIVE_BT_CACHE_TTL_MS) {
		return liveBtUnknownCache.devices;
	}
	if (liveBtUnknownCache?.inFlight) {
		return liveBtUnknownCache.inFlight;
	}

	const inFlight = (async (): Promise<LiveBluetoothDevice[]> => {
		try {
			const devices: LiveBluetoothDevice[] = listBluetoothDevices({
				returnAuthenticated: false,
				returnRemembered: false,
				returnUnknown: true,
				returnConnected: false,
				issueInquiry: true,
				timeoutMultiplier: 8
			}).map((device) => ({
				mac: device.mac.toLowerCase(),
				name: device.name?.trim() || undefined,
				instanceId: `WINAPI-INQUIRY:${device.mac.toLowerCase()}`
			}));
			const merged = mergeLiveBluetoothDevices(devices);
			liveBtUnknownCache = {
				ts: Date.now(),
				devices: merged
			};
			return merged;
		} catch {
			liveBtUnknownCache = {
				ts: Date.now(),
				devices: []
			};
			return [];
		}
	})();

	liveBtUnknownCache = {
		ts: now,
		devices: liveBtUnknownCache?.devices ?? [],
		inFlight
	};
	try {
		return await inFlight;
	} finally {
		if (liveBtUnknownCache) {
			delete liveBtUnknownCache.inFlight;
		}
	}
}

async function queryWindowsBluetoothConnectedDevicesViaWinApi(): Promise<LiveBluetoothDevice[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	const now = Date.now();
	if (liveBtConnectedCache && !liveBtConnectedCache.inFlight && now - liveBtConnectedCache.ts < WINAPI_LIVE_BT_CACHE_TTL_MS) {
		return liveBtConnectedCache.devices;
	}
	if (liveBtConnectedCache?.inFlight) {
		return liveBtConnectedCache.inFlight;
	}

	const inFlight = (async (): Promise<LiveBluetoothDevice[]> => {
		try {
			const devices: LiveBluetoothDevice[] = listBluetoothDevices({
				returnAuthenticated: true,
				returnRemembered: false,
				returnUnknown: false,
				returnConnected: true,
				issueInquiry: true,
				timeoutMultiplier: 6
			}).map((device) => ({
				mac: device.mac.toLowerCase(),
				name: device.name?.trim() || undefined,
				instanceId: `WINAPI-CONNECTED:${device.mac.toLowerCase()}`
			}));
			const merged = mergeLiveBluetoothDevices(devices);
			liveBtConnectedCache = {
				ts: Date.now(),
				devices: merged
			};
			return merged;
		} catch {
			liveBtConnectedCache = {
				ts: Date.now(),
				devices: []
			};
			return [];
		}
	})();

	liveBtConnectedCache = {
		ts: now,
		devices: liveBtConnectedCache?.devices ?? [],
		inFlight
	};
	try {
		return await inFlight;
	} finally {
		if (liveBtConnectedCache) {
			delete liveBtConnectedCache.inFlight;
		}
	}
}

function mergeLiveBluetoothDevices(...sources: LiveBluetoothDevice[][]): LiveBluetoothDevice[] {
	const byMac = new Map<string, LiveBluetoothDevice>();
	for (const source of sources) {
		for (const device of source) {
			const mac = device.mac.toLowerCase().trim();
			if (!/^[0-9a-f]{12}$/.test(mac)) {
				continue;
			}
			const existing = byMac.get(mac);
			if (!existing) {
				byMac.set(mac, {
					mac,
					name: device.name?.trim() || undefined,
					instanceId: device.instanceId
				});
				continue;
			}
			if (!existing.name && device.name) {
				existing.name = device.name.trim();
			}
			if ((!existing.instanceId || existing.instanceId.startsWith('WINAPI-INQUIRY:')) && device.instanceId) {
				existing.instanceId = device.instanceId;
			}
		}
	}
	return Array.from(byMac.values());
}

function isLikelyEv3SerialCandidate(candidate: SerialCandidate, mac?: string): boolean {
	if (!isComPath(candidate.path)) {
		return false;
	}
	if (mac?.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase())) {
		return true;
	}
	if (hasEv3PnpHint(candidate.pnpId)) {
		return true;
	}
	const manufacturer = candidate.manufacturer ?? '';
	if (/lego/i.test(manufacturer)) {
		return true;
	}
	const friendlyName = candidate.friendlyName ?? '';
	return /\bev3\b/i.test(friendlyName);
}

function isComPath(path: string): boolean {
	return /^COM\d+$/i.test(path.trim());
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
