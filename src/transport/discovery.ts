import * as dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export interface WindowsBluetoothLiveDevice {
	address: string;
	displayName?: string;
}

export interface WindowsBluetoothPairedDevice {
	address: string;
	displayName?: string;
	lastSeenAtIso?: string;
	lastConnectedAtIso?: string;
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
		const candidates = await mod.SerialPort.list();
		const btNames = await resolveWindowsBluetoothNameMap();
		if (btNames.size > 0) {
			for (const candidate of candidates) {
				const mac = extractBluetoothAddressFromPnpId(candidate.pnpId);
				if (!mac) {
					continue;
				}
				const name = btNames.get(mac);
				if (!name) {
					continue;
				}
				candidate.friendlyName = name;
			}
		}
		return candidates;
	} catch {
		return [];
	}
}

let cachedBtNames: { ts: number; map: Map<string, string> } | undefined;
let cachedBtPresentAddresses: { ts: number; set: Set<string> } | undefined;
let cachedBtLiveDevices: { ts: number; devices: WindowsBluetoothLiveDevice[] } | undefined;

const BT_NAME_CACHE_MS = 10_000;
const BT_PRESENT_CACHE_MS = 2_000;
const BT_LIVE_CACHE_MS = 2_000;

export function extractBluetoothAddressFromPnpId(pnpId?: string): string | undefined {
	const normalized = (pnpId ?? '').toUpperCase();
	if (!normalized) {
		return undefined;
	}
	const patterns = [
		/(?:^|[^0-9A-F])(001653[0-9A-F]{6})(?=$|[^0-9A-F])/i,
		/(?:^|[\\&_])([0-9A-F]{12})(?=$|[\\&_])/i
	];
	for (const pattern of patterns) {
		const match = normalized.match(pattern);
		if (!match) {
			continue;
		}
		const mac = match[1].toUpperCase();
		if (mac === '000000000000') {
			continue;
		}
		return mac;
	}
	return undefined;
}

async function resolveWindowsBluetoothNameMap(): Promise<Map<string, string>> {
	if (process.platform !== 'win32') {
		return new Map();
	}
	const now = Date.now();
	if (cachedBtNames && now - cachedBtNames.ts < BT_NAME_CACHE_MS) {
		return cachedBtNames.map;
	}
	try {
		const { stdout } = await execFileAsync('pwsh', [
			'-NoProfile',
			'-Command',
			[
				'Get-ChildItem',
				'\'HKLM:\\\\SYSTEM\\\\CurrentControlSet\\\\Services\\\\BTHPORT\\\\Parameters\\\\Devices\'',
				'| ForEach-Object {',
				'$mac = $_.PSChildName.ToUpper();',
				'$nameBytes = (Get-ItemProperty $_.PsPath -Name Name -ErrorAction SilentlyContinue).Name;',
				'if ($nameBytes) {',
				'$name = [System.Text.Encoding]::UTF8.GetString($nameBytes);',
				'[PSCustomObject]@{ Mac = $mac; Name = $name }',
				'}',
				'} | ConvertTo-Json -Compress'
			].join(' ')
		]);
		const raw = stdout.trim();
		if (!raw) {
			return new Map();
		}
		const parsed = JSON.parse(raw) as { Mac?: string; Name?: string } | Array<{ Mac?: string; Name?: string }>;
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		const map = new Map<string, string>();
		for (const entry of entries) {
			const friendlyName = entry.Name?.replace(/\u0000/g, '').trim() ?? '';
			const mac = entry.Mac?.replace(/[^0-9A-F]/gi, '').toUpperCase() ?? '';
			if (!mac || mac.length !== 12 || !friendlyName) {
				continue;
			}
			map.set(mac, friendlyName.trim());
		}
		cachedBtNames = { ts: now, map };
		return map;
	} catch {
		return new Map();
	}
}

export async function isWindowsBluetoothDevicePresent(address: string): Promise<boolean> {
	if (process.platform !== 'win32') {
		return false;
	}
	const normalizedAddress = address.replace(/[^0-9A-F]/gi, '').toUpperCase();
	if (normalizedAddress.length !== 12) {
		return false;
	}
	const present = await resolveWindowsBluetoothPresentAddressSet();
	return present.has(normalizedAddress);
}

export async function listWindowsBluetoothLiveDevices(): Promise<WindowsBluetoothLiveDevice[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	const now = Date.now();
	if (cachedBtLiveDevices && now - cachedBtLiveDevices.ts < BT_LIVE_CACHE_MS) {
		return cachedBtLiveDevices.devices;
	}
	try {
		const { stdout } = await execFileAsync('pwsh', [
			'-NoProfile',
			'-Command',
			[
				'Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue',
				'| ForEach-Object {',
				'$instance = $_.InstanceId;',
				'if ($instance -match \'DEV_([0-9A-F]{12})\') {',
				'[PSCustomObject]@{ Mac = $Matches[1].ToUpper(); Status = $_.Status; FriendlyName = $_.FriendlyName }',
				'}',
				'} | ConvertTo-Json -Compress'
			].join(' ')
		]);
		const raw = stdout.trim();
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw) as
			| { Mac?: string; Status?: string; FriendlyName?: string }
			| Array<{ Mac?: string; Status?: string; FriendlyName?: string }>;
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		const names = await resolveWindowsBluetoothNameMap();
		const byAddress = new Map<string, WindowsBluetoothLiveDevice>();
		for (const entry of entries) {
			const address = entry.Mac?.replace(/[^0-9A-F]/gi, '').toUpperCase() ?? '';
			const status = entry.Status?.trim().toUpperCase() ?? '';
			if (!address || address.length !== 12 || address === '000000000000') {
				continue;
			}
			if (status && status !== 'OK') {
				continue;
			}
			const pnpName = entry.FriendlyName?.trim() || undefined;
			const registryName = names.get(address);
			byAddress.set(address, {
				address,
				displayName: registryName || pnpName
			});
		}
		const devices = [...byAddress.values()].sort((left, right) => left.address.localeCompare(right.address));
		cachedBtLiveDevices = { ts: now, devices };
		return devices;
	} catch {
		return [];
	}
}

export async function listWindowsBluetoothPairedDevices(): Promise<WindowsBluetoothPairedDevice[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	try {
		const { stdout } = await execFileAsync('pwsh', [
			'-NoProfile',
			'-Command',
			[
				'Get-ChildItem',
				'\'HKLM:\\\\SYSTEM\\\\CurrentControlSet\\\\Services\\\\BTHPORT\\\\Parameters\\\\Devices\'',
				'| ForEach-Object {',
				'$mac = $_.PSChildName.ToUpper();',
				'$props = Get-ItemProperty $_.PsPath;',
				'$nameBytes = $props.Name;',
				'$name = if ($nameBytes) { [System.Text.Encoding]::UTF8.GetString($nameBytes) } else { $null };',
				'$lastSeen = if ($null -ne $props.LastSeen) { [string]$props.LastSeen } else { $null };',
				'$lastConnected = if ($null -ne $props.LastConnected) { [string]$props.LastConnected } else { $null };',
				'[PSCustomObject]@{ Mac = $mac; Name = $name; LastSeen = $lastSeen; LastConnected = $lastConnected }',
				'} | ConvertTo-Json -Compress'
			].join(' ')
		]);
		const raw = stdout.trim();
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw) as
			| { Mac?: string; Name?: string; LastSeen?: string; LastConnected?: string }
			| Array<{ Mac?: string; Name?: string; LastSeen?: string; LastConnected?: string }>;
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		const devices: WindowsBluetoothPairedDevice[] = [];
		for (const entry of entries) {
			const address = entry.Mac?.replace(/[^0-9A-F]/gi, '').toUpperCase() ?? '';
			if (!address || address.length !== 12 || address === '000000000000') {
				continue;
			}
			const displayName = entry.Name?.replace(/\u0000/g, '').trim() || undefined;
			devices.push({
				address,
				displayName,
				lastSeenAtIso: parseWindowsFileTimeToIso(entry.LastSeen),
				lastConnectedAtIso: parseWindowsFileTimeToIso(entry.LastConnected)
			});
		}
		return devices.sort((left, right) => left.address.localeCompare(right.address));
	} catch {
		return [];
	}
}

function parseWindowsFileTimeToIso(rawValue: string | undefined): string | undefined {
	if (typeof rawValue !== 'string') {
		return undefined;
	}
	const trimmed = rawValue.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const fileTime = BigInt(trimmed);
		if (fileTime <= 0n) {
			return undefined;
		}
		const unixMsBigInt = (fileTime - 116444736000000000n) / 10000n;
		const unixMs = Number(unixMsBigInt);
		if (!Number.isFinite(unixMs) || unixMs <= 0) {
			return undefined;
		}
		return new Date(unixMs).toISOString();
	} catch {
		return undefined;
	}
}

async function resolveWindowsBluetoothPresentAddressSet(): Promise<Set<string>> {
	if (process.platform !== 'win32') {
		return new Set();
	}
	const now = Date.now();
	if (cachedBtPresentAddresses && now - cachedBtPresentAddresses.ts < BT_PRESENT_CACHE_MS) {
		return cachedBtPresentAddresses.set;
	}
	try {
		const { stdout } = await execFileAsync('pwsh', [
			'-NoProfile',
			'-Command',
			[
				'Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue',
				'| ForEach-Object {',
				'$instance = $_.InstanceId;',
				'if ($instance -match \'DEV_([0-9A-F]{12})\') {',
				'[PSCustomObject]@{ Mac = $Matches[1].ToUpper(); Status = $_.Status }',
				'}',
				'} | ConvertTo-Json -Compress'
			].join(' ')
		]);
		const raw = stdout.trim();
		if (!raw) {
			return new Set();
		}
		const parsed = JSON.parse(raw) as { Mac?: string; Status?: string } | Array<{ Mac?: string; Status?: string }>;
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		const set = new Set<string>();
		for (const entry of entries) {
			const mac = entry.Mac?.replace(/[^0-9A-F]/gi, '').toUpperCase() ?? '';
			const status = entry.Status?.trim().toUpperCase() ?? '';
			if (!mac || mac.length !== 12) {
				continue;
			}
			if (status && status !== 'OK') {
				continue;
			}
			set.add(mac);
		}
		cachedBtPresentAddresses = { ts: now, set };
		return set;
	} catch {
		return new Set();
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
