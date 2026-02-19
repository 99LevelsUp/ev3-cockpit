import * as dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { EV3_PNP_HINT, LEGO_MAC_OUI_PREFIX, extractMacFromPnpId, hasLegoMacPrefix } from './bluetoothPortSelection';

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
			return listSerialCandidatesFromWindowsPnp();
		}
		const listed = await mod.SerialPort.list();
		if (listed.length > 0) {
			return listed;
		}
		return listSerialCandidatesFromWindowsPnp();
	} catch {
		return listSerialCandidatesFromWindowsPnp();
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
	const [serial, nameMap, liveDevices] = await Promise.all([
		listSerialCandidates(),
		resolveWindowsBluetoothNameMap(),
		resolveWindowsLiveBluetoothDevices()
	]);

	const candidatesById = new Map<string, BluetoothCandidate>();

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
		candidatesById.set(key, {
			path,
			mac,
			displayName,
			pnpId: serialCandidate.pnpId,
			hasLegoPrefix: hasLegoMacPrefix(serialCandidate.pnpId),
			present: true,
			connectable: true
		});
	}

	for (const liveDevice of liveDevices) {
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
const PWSH_COMMAND_TIMEOUT_MS = 12_000;
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
		return `EV3-${mac.slice(-4).toUpperCase()}`;
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

interface WindowsPnpRow {
	name?: string;
	instanceId?: string;
	manufacturer?: string;
}

let liveBtWinApiCache:
	| { ts: number; devices: LiveBluetoothDevice[]; inFlight?: Promise<LiveBluetoothDevice[]> }
	| undefined;

async function resolveWindowsLiveBluetoothDevices(): Promise<LiveBluetoothDevice[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	try {
		const [pnpRows, inquiryDevices] = await Promise.all([
			queryWindowsBluetoothRowsViaPnp().catch(() => [] as WindowsPnpRow[]),
			queryWindowsLiveBluetoothDevicesViaWinApi().catch(() => [] as LiveBluetoothDevice[])
		]);
		const pnpDevices = toLiveBluetoothDevices(pnpRows);
		if (pnpDevices.length > 0) {
			return mergeLiveBluetoothDevices(pnpDevices, inquiryDevices);
		}
		const cimRows = await queryWindowsBluetoothRowsViaCim().catch(() => [] as WindowsPnpRow[]);
		return mergeLiveBluetoothDevices(toLiveBluetoothDevices(cimRows), inquiryDevices);
	} catch {
		return [];
	}
}

async function queryWindowsBluetoothRowsViaPnp(): Promise<WindowsPnpRow[]> {
	const json = await runPwsh(
		`$rows = @(); if (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue) { $rows += Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ Name = $_.FriendlyName; InstanceId = $_.InstanceId; Manufacturer = $_.Manufacturer } }; $rows += Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'BTH' } | ForEach-Object { [PSCustomObject]@{ Name = $_.FriendlyName; InstanceId = $_.InstanceId; Manufacturer = $_.Manufacturer } } }; $rows | Sort-Object InstanceId -Unique | ConvertTo-Json -Compress`
	);
	return parseWindowsPnpRows(json);
}

async function queryWindowsBluetoothRowsViaCim(): Promise<WindowsPnpRow[]> {
	const json = await runPwsh(
		`if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.DeviceID -match 'BTH' } | ForEach-Object { [PSCustomObject]@{ Name = $_.Name; InstanceId = $_.DeviceID; Manufacturer = $_.Manufacturer } } | Sort-Object InstanceId -Unique | ConvertTo-Json -Compress }`
	);
	return parseWindowsPnpRows(json);
}

async function queryWindowsLiveBluetoothDevicesViaWinApi(): Promise<LiveBluetoothDevice[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	const now = Date.now();
	if (liveBtWinApiCache && !liveBtWinApiCache.inFlight && now - liveBtWinApiCache.ts < WINAPI_LIVE_BT_CACHE_TTL_MS) {
		return liveBtWinApiCache.devices;
	}
	if (liveBtWinApiCache?.inFlight) {
		return liveBtWinApiCache.inFlight;
	}

	const inFlight = (async (): Promise<LiveBluetoothDevice[]> => {
		try {
			const json = await runPwsh(buildWinApiBluetoothInquiryScript());
			const devices: LiveBluetoothDevice[] = [];
			for (const entry of parsePwshJsonArray(json)) {
				const row = asRecord(entry);
				const mac = typeof row?.Mac === 'string' ? row.Mac.toLowerCase().trim() : '';
				if (!/^[0-9a-f]{12}$/.test(mac)) {
					continue;
				}
				const name = typeof row?.Name === 'string' ? row.Name.trim() : undefined;
				devices.push({
					mac,
					name,
					instanceId: `WINAPI-INQUIRY:${mac}`
				});
			}
			const merged = mergeLiveBluetoothDevices(devices);
			liveBtWinApiCache = {
				ts: Date.now(),
				devices: merged
			};
			return merged;
		} catch {
			liveBtWinApiCache = {
				ts: Date.now(),
				devices: []
			};
			return [];
		}
	})();

	liveBtWinApiCache = {
		ts: now,
		devices: liveBtWinApiCache?.devices ?? [],
		inFlight
	};
	try {
		return await inFlight;
	} finally {
		if (liveBtWinApiCache) {
			delete liveBtWinApiCache.inFlight;
		}
	}
}

function buildWinApiBluetoothInquiryScript(): string {
	return [
		`if (-not ('Ev3CockpitBtApi' -as [type])) {`,
		`$typeDef = @'`,
		`using System;`,
		`using System.Runtime.InteropServices;`,
		`public static class Ev3CockpitBtApi {`,
		`    [StructLayout(LayoutKind.Sequential)]`,
		`    public struct SYSTEMTIME {`,
		`        public ushort wYear;`,
		`        public ushort wMonth;`,
		`        public ushort wDayOfWeek;`,
		`        public ushort wDay;`,
		`        public ushort wHour;`,
		`        public ushort wMinute;`,
		`        public ushort wSecond;`,
		`        public ushort wMilliseconds;`,
		`    }`,
		`    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]`,
		`    public struct BLUETOOTH_DEVICE_INFO {`,
		`        public int dwSize;`,
		`        public ulong Address;`,
		`        public uint ulClassofDevice;`,
		`        [MarshalAs(UnmanagedType.Bool)] public bool fConnected;`,
		`        [MarshalAs(UnmanagedType.Bool)] public bool fRemembered;`,
		`        [MarshalAs(UnmanagedType.Bool)] public bool fAuthenticated;`,
		`        public SYSTEMTIME stLastSeen;`,
		`        public SYSTEMTIME stLastUsed;`,
		`        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)]`,
		`        public string szName;`,
		`    }`,
		`    [StructLayout(LayoutKind.Sequential)]`,
		`    public struct BLUETOOTH_DEVICE_SEARCH_PARAMS {`,
		`        public int dwSize;`,
		`        [MarshalAs(UnmanagedType.Bool)] public bool fReturnAuthenticated;`,
		`        [MarshalAs(UnmanagedType.Bool)] public bool fReturnRemembered;`,
		`        [MarshalAs(UnmanagedType.Bool)] public bool fReturnUnknown;`,
		`        [MarshalAs(UnmanagedType.Bool)] public bool fReturnConnected;`,
		`        [MarshalAs(UnmanagedType.Bool)] public bool fIssueInquiry;`,
		`        public byte cTimeoutMultiplier;`,
		`        public IntPtr hRadio;`,
		`    }`,
		`    [StructLayout(LayoutKind.Sequential)]`,
		`    public struct BLUETOOTH_FIND_RADIO_PARAMS {`,
		`        public int dwSize;`,
		`    }`,
		`    [DllImport("bthprops.cpl", SetLastError = true)]`,
		`    public static extern IntPtr BluetoothFindFirstDevice(ref BLUETOOTH_DEVICE_SEARCH_PARAMS searchParams, ref BLUETOOTH_DEVICE_INFO deviceInfo);`,
		`    [DllImport("bthprops.cpl", SetLastError = true)]`,
		`    [return: MarshalAs(UnmanagedType.Bool)]`,
		`    public static extern bool BluetoothFindNextDevice(IntPtr hFind, ref BLUETOOTH_DEVICE_INFO deviceInfo);`,
		`    [DllImport("bthprops.cpl", SetLastError = true)]`,
		`    [return: MarshalAs(UnmanagedType.Bool)]`,
		`    public static extern bool BluetoothFindDeviceClose(IntPtr hFind);`,
		`    [DllImport("bthprops.cpl", SetLastError = true)]`,
		`    public static extern IntPtr BluetoothFindFirstRadio(ref BLUETOOTH_FIND_RADIO_PARAMS p, out IntPtr hRadio);`,
		`    [DllImport("bthprops.cpl", SetLastError = true)]`,
		`    [return: MarshalAs(UnmanagedType.Bool)]`,
		`    public static extern bool BluetoothFindNextRadio(IntPtr hFind, out IntPtr hRadio);`,
		`    [DllImport("bthprops.cpl", SetLastError = true)]`,
		`    [return: MarshalAs(UnmanagedType.Bool)]`,
		`    public static extern bool BluetoothFindRadioClose(IntPtr hFind);`,
		`    [DllImport("kernel32.dll", SetLastError = true)]`,
		`    [return: MarshalAs(UnmanagedType.Bool)]`,
		`    public static extern bool CloseHandle(IntPtr hObject);`,
		`}`,
		`'@`,
		`Add-Type -TypeDefinition $typeDef -Language CSharp`,
		`}`,
		`$radios = @()`,
		`$findParams = New-Object Ev3CockpitBtApi+BLUETOOTH_FIND_RADIO_PARAMS`,
		`$findParams.dwSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'Ev3CockpitBtApi+BLUETOOTH_FIND_RADIO_PARAMS')`,
		`$radioHandle = [IntPtr]::Zero`,
		`$findRadio = [Ev3CockpitBtApi]::BluetoothFindFirstRadio([ref]$findParams, [ref]$radioHandle)`,
		`if ($findRadio -ne [IntPtr]::Zero) {`,
		`    do {`,
		`        if ($radioHandle -ne [IntPtr]::Zero) {`,
		`            $radios += $radioHandle`,
		`        }`,
		`        $radioHandle = [IntPtr]::Zero`,
		`    } while ([Ev3CockpitBtApi]::BluetoothFindNextRadio($findRadio, [ref]$radioHandle))`,
		`    [Ev3CockpitBtApi]::BluetoothFindRadioClose($findRadio) | Out-Null`,
		`}`,
		`if ($radios.Count -eq 0) {`,
		`    $radios += [IntPtr]::Zero`,
		`}`,
		`$rows = @()`,
		`foreach ($radio in $radios) {`,
		`    $search = New-Object Ev3CockpitBtApi+BLUETOOTH_DEVICE_SEARCH_PARAMS`,
		`    $search.dwSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'Ev3CockpitBtApi+BLUETOOTH_DEVICE_SEARCH_PARAMS')`,
		`    $search.fReturnAuthenticated = $true`,
		`    $search.fReturnRemembered = $true`,
		`    $search.fReturnUnknown = $true`,
		`    $search.fReturnConnected = $true`,
		`    $search.fIssueInquiry = $true`,
		`    $search.cTimeoutMultiplier = 8`,
		`    $search.hRadio = $radio`,
		`    $device = New-Object Ev3CockpitBtApi+BLUETOOTH_DEVICE_INFO`,
		`    $device.dwSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'Ev3CockpitBtApi+BLUETOOTH_DEVICE_INFO')`,
		`    $findHandle = [Ev3CockpitBtApi]::BluetoothFindFirstDevice([ref]$search, [ref]$device)`,
		`    if ($findHandle -eq [IntPtr]::Zero) { continue }`,
		`    do {`,
		`        $mac = ('{0:X12}' -f ($device.Address -band 0xFFFFFFFFFFFF)).ToLower()`,
		`        $rows += [PSCustomObject]@{ Mac = $mac; Name = $device.szName }`,
		`        $device = New-Object Ev3CockpitBtApi+BLUETOOTH_DEVICE_INFO`,
		`        $device.dwSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'Ev3CockpitBtApi+BLUETOOTH_DEVICE_INFO')`,
		`    } while ([Ev3CockpitBtApi]::BluetoothFindNextDevice($findHandle, [ref]$device))`,
		`    [Ev3CockpitBtApi]::BluetoothFindDeviceClose($findHandle) | Out-Null`,
		`}`,
		`foreach ($radio in $radios) {`,
		`    if ($radio -ne [IntPtr]::Zero) { [Ev3CockpitBtApi]::CloseHandle($radio) | Out-Null }`,
		`}`,
		`$rows | Sort-Object Mac -Unique | ConvertTo-Json -Compress`
	].join('\n');
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

function toLiveBluetoothDevices(rows: WindowsPnpRow[]): LiveBluetoothDevice[] {
	const byMac = new Map<string, LiveBluetoothDevice>();
	for (const row of rows) {
		const instanceId = row.instanceId?.trim();
		if (!instanceId) {
			continue;
		}
		const mac = extractMacFromWindowsInstanceId(instanceId);
		if (!mac) {
			continue;
		}
		const existing = byMac.get(mac);
		const name = row.name?.trim();
		if (existing) {
			if (!existing.name && name) {
				existing.name = name;
			}
			continue;
		}
		byMac.set(mac, { mac, name, instanceId });
	}
	return Array.from(byMac.values());
}

function extractMacFromWindowsInstanceId(instanceId: string): string | undefined {
	const devMatch = /DEV_([0-9A-F]{12})/i.exec(instanceId);
	if (devMatch?.[1]) {
		return devMatch[1].toLowerCase();
	}
	const tailMatch = /\\([0-9A-F]{12})(?:[_\\]|$)/i.exec(instanceId);
	if (tailMatch?.[1]) {
		return tailMatch[1].toLowerCase();
	}
	const genericMatch = /(?:^|[_\\&])([0-9A-F]{12})(?:[_\\]|$)/i.exec(instanceId);
	if (genericMatch?.[1]) {
		return genericMatch[1].toLowerCase();
	}
	const separatedMatch = /([0-9A-F]{2}(?:[:-][0-9A-F]{2}){5})/i.exec(instanceId);
	if (separatedMatch?.[1]) {
		return separatedMatch[1].replace(/[:-]/g, '').toLowerCase();
	}
	return undefined;
}

function parseWindowsPnpRows(json: string): WindowsPnpRow[] {
	const rows: WindowsPnpRow[] = [];
	for (const entry of parsePwshJsonArray(json)) {
		const record = asRecord(entry);
		if (!record) {
			continue;
		}
		const instanceId = typeof record.InstanceId === 'string' ? record.InstanceId.trim() : undefined;
		if (!instanceId) {
			continue;
		}
		rows.push({
			name: typeof record.Name === 'string' ? record.Name.trim() : undefined,
			instanceId,
			manufacturer: typeof record.Manufacturer === 'string' ? record.Manufacturer.trim() : undefined
		});
	}
	return rows;
}

async function listSerialCandidatesFromWindowsPnp(): Promise<SerialCandidate[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	try {
		const pnpRows = await queryWindowsComRowsViaPnp();
		const pnpCandidates = toSerialCandidates(pnpRows);
		if (pnpCandidates.length > 0) {
			return pnpCandidates;
		}
		const cimRows = await queryWindowsComRowsViaCim();
		return toSerialCandidates(cimRows);
	} catch {
		return [];
	}
}

async function queryWindowsComRowsViaPnp(): Promise<WindowsPnpRow[]> {
	const json = await runPwsh(
		`$rows = @(); if (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue) { $rows += Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ Name = $_.FriendlyName; InstanceId = $_.InstanceId; Manufacturer = $_.Manufacturer } }; $rows += Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'BTHENUM' -or $_.FriendlyName -match '\\(COM\\d+\\)' } | ForEach-Object { [PSCustomObject]@{ Name = $_.FriendlyName; InstanceId = $_.InstanceId; Manufacturer = $_.Manufacturer } } }; $rows | Sort-Object InstanceId -Unique | ConvertTo-Json -Compress`
	);
	return parseWindowsPnpRows(json);
}

async function queryWindowsComRowsViaCim(): Promise<WindowsPnpRow[]> {
	const json = await runPwsh(
		`if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\\(COM\\d+\\)' -or $_.DeviceID -match 'BTHENUM' } | ForEach-Object { [PSCustomObject]@{ Name = $_.Name; InstanceId = $_.DeviceID; Manufacturer = $_.Manufacturer } } | Sort-Object InstanceId -Unique | ConvertTo-Json -Compress }`
	);
	return parseWindowsPnpRows(json);
}

function toSerialCandidates(rows: WindowsPnpRow[]): SerialCandidate[] {
	const byPath = new Map<string, SerialCandidate>();
	for (const row of rows) {
		const path = extractComPath(row.name) ?? extractComPath(row.instanceId);
		if (!path || !isComPath(path)) {
			continue;
		}
		const normalizedPath = path.toUpperCase();
		const existing = byPath.get(normalizedPath);
		if (!existing) {
			byPath.set(normalizedPath, {
				path: normalizedPath,
				manufacturer: row.manufacturer,
				pnpId: row.instanceId,
				friendlyName: row.name
			});
			continue;
		}
		if (!existing.manufacturer && row.manufacturer) {
			existing.manufacturer = row.manufacturer;
		}
		if (!existing.pnpId && row.instanceId) {
			existing.pnpId = row.instanceId;
		}
		if (!existing.friendlyName && row.name) {
			existing.friendlyName = row.name;
		}
	}
	return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function extractComPath(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const match = /\b(COM\d+)\b/i.exec(value);
	return match?.[1]?.toUpperCase();
}

function isLikelyEv3SerialCandidate(candidate: SerialCandidate, mac?: string): boolean {
	if (!isComPath(candidate.path)) {
		return false;
	}
	if (mac?.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase())) {
		return true;
	}
	const pnpId = candidate.pnpId ?? '';
	if (pnpId.length > 0 && new RegExp(EV3_PNP_HINT, 'i').test(pnpId)) {
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

function parsePwshJsonArray(json: string): unknown[] {
	if (!json) {
		return [];
	}
	const payload = extractJsonPayload(json);
	if (!payload) {
		return [];
	}
	const parsed = JSON.parse(payload);
	if (Array.isArray(parsed)) {
		return parsed;
	}
	return parsed ? [parsed] : [];
}

function extractJsonPayload(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		return trimmed;
	}
	const firstIndex = Math.min(
		...['{', '[']
			.map((token) => trimmed.indexOf(token))
			.filter((index) => index >= 0)
	);
	if (!Number.isFinite(firstIndex) || firstIndex < 0) {
		return undefined;
	}
	const lastObject = trimmed.lastIndexOf('}');
	const lastArray = trimmed.lastIndexOf(']');
	const lastIndex = Math.max(lastObject, lastArray);
	if (lastIndex <= firstIndex) {
		return undefined;
	}
	return trimmed.slice(firstIndex, lastIndex + 1).trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function runPwsh(script: string): Promise<string> {
	const executables = Array.from(new Set([
		process.env.PWSH_PATH,
		'pwsh',
		'pwsh.exe',
		'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
	].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)));

	const tryExec = (index: number): Promise<string> => {
		if (index >= executables.length) {
			return Promise.reject(new Error('pwsh executable not found'));
		}
		return new Promise<string>((resolve, reject) => {
			execFile(
				executables[index],
				['-NoProfile', '-NonInteractive', '-Command', script],
				{ timeout: PWSH_COMMAND_TIMEOUT_MS, maxBuffer: 512 * 1024, windowsHide: true },
				(error, stdout, stderr) => {
					if (error) {
						reject(error);
						return;
					}
					const out = typeof stdout === 'string' ? stdout.trim() : '';
					const err = typeof stderr === 'string' ? stderr.trim() : '';
					resolve(out.length > 0 ? out : err);
				}
			);
		}).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (/not found|enoent|cannot find/i.test(message)) {
				return tryExec(index + 1);
			}
			throw error;
		});
	};

	return tryExec(0);
}
