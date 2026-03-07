/**
 * Cross-platform native Bluetooth device discovery using koffi FFI.
 *
 * Windows: persistent PowerShell worker using bthprops.cpl WinAPI
 * Linux:   libbluetooth.so  (BlueZ HCI — hci_inquiry + hci_read_remote_name)
 *
 * macOS is intentionally not supported.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getPreferredWindowsPowerShellCommands } from './windowsPowerShell';

export interface BluetoothDeviceInfo {
	mac: string;          // lowercase 12-digit hex, no separators
	name: string;
	connected: boolean;
	remembered: boolean;
	authenticated: boolean;
}

export interface BluetoothScanOptions {
	returnAuthenticated: boolean;
	returnRemembered: boolean;
	returnUnknown: boolean;
	returnConnected: boolean;
	issueInquiry: boolean;
	/** Windows: inquiry timeout multiplier (units of 1.28 s).
	 *  Linux: hci_inquiry length parameter (same units). */
	timeoutMultiplier: number;
}

// ── Public API ───────────────────────────────────────────────────────────

interface PlatformBackend {
	available: boolean;
	listDevices(opts: BluetoothScanOptions): Promise<BluetoothDeviceInfo[]>;
	/** Look up a single device by MAC address (Windows: BluetoothGetDeviceInfo). */
	lookupDevice?(mac: string): Promise<BluetoothDeviceInfo | undefined>;
	lookupDevices?(macs: readonly string[]): Promise<BluetoothDeviceInfo[]>;
}

let _backend: PlatformBackend | undefined;
let _backendChecked = false;

function getBackend(): PlatformBackend | undefined {
	if (_backendChecked) {
		return _backend;
	}
	_backendChecked = true;

	switch (process.platform) {
		case 'win32':
			_backend = createWindowsBackend();
			break;
		case 'linux':
			_backend = createLinuxBackend();
			break;
	}
	return _backend;
}

export function canUseNativeBluetoothDiscovery(): boolean {
	return getBackend()?.available ?? false;
}

export async function listBluetoothDevicesNative(opts: BluetoothScanOptions): Promise<BluetoothDeviceInfo[]> {
	return await (getBackend()?.listDevices(opts) ?? Promise.resolve([]));
}

/**
 * Look up a single device by MAC address using the platform's persistent
 * device database (Windows: BluetoothGetDeviceInfo).
 *
 * Returns the device info if found, or undefined if the device is unknown
 * to the OS. This works even when the device is NOT in the discovery cache
 * (FindFirstDevice may miss it, but GetDeviceInfo still knows about it).
 */
export async function lookupBluetoothDeviceNative(mac: string): Promise<BluetoothDeviceInfo | undefined> {
	return await (getBackend()?.lookupDevice?.(mac) ?? Promise.resolve(undefined));
}

/**
 * Batch-lookup known MAC addresses. Returns devices that the OS still knows
 * about, even if they've fallen out of the discovery cache.
 */
export async function trackKnownDevicesNative(macs: readonly string[]): Promise<BluetoothDeviceInfo[]> {
	const backend = getBackend();
	if (!backend?.lookupDevice && !backend?.lookupDevices) {
		return [];
	}
	if (backend.lookupDevices) {
		return await backend.lookupDevices(macs);
	}
	const results: BluetoothDeviceInfo[] = [];
	for (const mac of macs) {
		const info = await backend.lookupDevice!(mac);
		if (info) {
			results.push(info);
		}
	}
	return results;
}

// ── koffi type surface ───────────────────────────────────────────────────

interface KoffiModule {
	load(name: string): KoffiLib;
	struct(name: string, fields: Record<string, unknown>): unknown;
	array(type: string, count: number, mode: string): unknown;
	sizeof(type: unknown): number;
	decode(ptr: unknown, type: unknown, count?: number): unknown;
}

interface KoffiLib {
	func(signature: string): (...args: unknown[]) => unknown;
}

// ══════════════════════════════════════════════════════════════════════════
// Windows backend — persistent PowerShell worker around bthprops.cpl
// ══════════════════════════════════════════════════════════════════════════

interface WindowsBtWorkerRequest {
	cmd: 'list' | 'lookup';
	returnAuthenticated?: boolean;
	returnRemembered?: boolean;
	returnUnknown?: boolean;
	returnConnected?: boolean;
	issueInquiry?: boolean;
	timeoutMultiplier?: number;
	macs?: string[];
}

class WindowsBluetoothWorker {
	private readonly scriptPath = join(tmpdir(), 'ev3-cockpit-bt-worker.ps1');
	private proc: ChildProcessWithoutNullStreams | undefined;
	private startPromise: Promise<void> | undefined;
	private ready = false;
	private current:
		| {
			lines: string[];
			resolve: (value: string) => void;
			reject: (error: Error) => void;
		}
		| undefined;
	private readonly queue: Array<{
		payload: WindowsBtWorkerRequest;
		resolve: (value: string) => void;
		reject: (error: Error) => void;
	}> = [];
	private stdoutBuffer = '';

	public async request(payload: WindowsBtWorkerRequest): Promise<string> {
		await this.ensureStarted();
		return await new Promise<string>((resolve, reject) => {
			this.queue.push({ payload, resolve, reject });
			this.pumpQueue();
		});
	}

	private async ensureStarted(): Promise<void> {
		if (this.ready && this.proc) {
			return;
		}
		if (this.startPromise) {
			return await this.startPromise;
		}
		this.startPromise = this.start();
		try {
			await this.startPromise;
		} finally {
			this.startPromise = undefined;
		}
	}

	private async start(): Promise<void> {
		await fs.writeFile(this.scriptPath, WINDOWS_BT_WORKER_SCRIPT, 'utf8');
		this.proc = await this.spawnShell();

		await new Promise<void>((resolve, reject) => {
			const onLine = (line: string): void => {
				if (line === '___BTREADY___') {
					this.ready = true;
					resolve();
				}
			};

			const onExit = (): void => {
				if (!this.ready) {
					reject(new Error('Windows BT worker exited before signaling readiness.'));
				}
			};

			this.attachProcessHandlers(onLine, onExit, reject);
		});
	}

	private async spawnShell(): Promise<ChildProcessWithoutNullStreams> {
		const candidates = await getPreferredWindowsPowerShellCommands();

		let lastError: unknown;
		for (const shell of candidates) {
			try {
				const proc = spawn(shell, ['-NoProfile', '-NonInteractive', '-File', this.scriptPath], {
					stdio: 'pipe',
					windowsHide: true
				});
				await new Promise<void>((resolve, reject) => {
					proc.once('spawn', () => resolve());
					proc.once('error', reject);
				});
				return proc;
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error(`Unable to start Windows BT worker: ${String(lastError)}`);
	}

	private attachProcessHandlers(
		onLine: (line: string) => void,
		onEarlyExit: () => void,
		onEarlyError: (error: Error) => void
	): void {
		if (!this.proc) {
			onEarlyError(new Error('Windows BT worker is not running.'));
			return;
		}

		this.proc.stdout.on('data', (chunk: Buffer | string) => {
			this.stdoutBuffer += chunk.toString();
			let newlineIndex = this.stdoutBuffer.indexOf('\n');
			while (newlineIndex >= 0) {
				const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
				this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
				if (!this.ready) {
					onLine(line);
				} else {
					this.handleWorkerLine(line);
				}
				newlineIndex = this.stdoutBuffer.indexOf('\n');
			}
		});

		this.proc.once('error', (error) => {
			this.failWorker(new Error(`Windows BT worker error: ${error.message}`));
			onEarlyError(error);
		});
		this.proc.once('exit', () => {
			this.failWorker(new Error('Windows BT worker exited unexpectedly.'));
			onEarlyExit();
		});
	}

	private pumpQueue(): void {
		if (!this.proc || !this.ready || this.current || this.queue.length === 0) {
			return;
		}
		const next = this.queue.shift()!;
		this.current = {
			lines: [],
			resolve: next.resolve,
			reject: next.reject
		};
		const payload = Buffer.from(JSON.stringify(next.payload), 'utf8').toString('base64');
		this.proc.stdin.write(`${payload}\n`);
	}

	private handleWorkerLine(line: string): void {
		if (!this.current) {
			return;
		}
		if (line === '___BTDONE___') {
			const output = this.current.lines.join('\n');
			this.current.resolve(output);
			this.current = undefined;
			this.pumpQueue();
			return;
		}
		this.current.lines.push(line);
	}

	private failWorker(error: Error): void {
		this.ready = false;
		this.proc = undefined;
		if (this.current) {
			this.current.reject(error);
			this.current = undefined;
		}
		while (this.queue.length > 0) {
			this.queue.shift()!.reject(error);
		}
	}
}

const windowsBtWorker = new WindowsBluetoothWorker();

const WINDOWS_BT_WORKER_SCRIPT = String.raw`
if (-not ('Ev3CockpitBtApi' -as [type])) {
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Ev3CockpitBtApi {
    [StructLayout(LayoutKind.Sequential)]
    public struct SYSTEMTIME { public ushort wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct BLUETOOTH_DEVICE_INFO {
        public int dwSize; public ulong Address; public uint ulClassofDevice;
        [MarshalAs(UnmanagedType.Bool)] public bool fConnected;
        [MarshalAs(UnmanagedType.Bool)] public bool fRemembered;
        [MarshalAs(UnmanagedType.Bool)] public bool fAuthenticated;
        public SYSTEMTIME stLastSeen; public SYSTEMTIME stLastUsed;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=248)] public string szName;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct BLUETOOTH_DEVICE_SEARCH_PARAMS {
        public int dwSize;
        [MarshalAs(UnmanagedType.Bool)] public bool fReturnAuthenticated;
        [MarshalAs(UnmanagedType.Bool)] public bool fReturnRemembered;
        [MarshalAs(UnmanagedType.Bool)] public bool fReturnUnknown;
        [MarshalAs(UnmanagedType.Bool)] public bool fReturnConnected;
        [MarshalAs(UnmanagedType.Bool)] public bool fIssueInquiry;
        public byte cTimeoutMultiplier;
        public IntPtr hRadio;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct BLUETOOTH_FIND_RADIO_PARAMS { public int dwSize; }
    [DllImport("bthprops.cpl", SetLastError=true)] public static extern IntPtr BluetoothFindFirstDevice(ref BLUETOOTH_DEVICE_SEARCH_PARAMS s, ref BLUETOOTH_DEVICE_INFO d);
    [DllImport("bthprops.cpl", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool BluetoothFindNextDevice(IntPtr h, ref BLUETOOTH_DEVICE_INFO d);
    [DllImport("bthprops.cpl", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool BluetoothFindDeviceClose(IntPtr h);
    [DllImport("bthprops.cpl", SetLastError=true)] public static extern IntPtr BluetoothFindFirstRadio(ref BLUETOOTH_FIND_RADIO_PARAMS p, out IntPtr r);
    [DllImport("bthprops.cpl", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool BluetoothFindNextRadio(IntPtr h, out IntPtr r);
    [DllImport("bthprops.cpl", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool BluetoothFindRadioClose(IntPtr h);
    [DllImport("bthprops.cpl", SetLastError=true)] public static extern uint BluetoothGetDeviceInfo(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO d);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool CloseHandle(IntPtr h);
}
'@
}

function Get-Ev3BtRadios {
    $radios = @()
    $params = New-Object Ev3CockpitBtApi+BLUETOOTH_FIND_RADIO_PARAMS
    $params.dwSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'Ev3CockpitBtApi+BLUETOOTH_FIND_RADIO_PARAMS')
    $radio = [IntPtr]::Zero
    $findHandle = [Ev3CockpitBtApi]::BluetoothFindFirstRadio([ref]$params, [ref]$radio)
    if ($findHandle -ne [IntPtr]::Zero) {
        try {
            do {
                if ($radio -ne [IntPtr]::Zero) { $radios += $radio }
                $radio = [IntPtr]::Zero
            } while ([Ev3CockpitBtApi]::BluetoothFindNextRadio($findHandle, [ref]$radio))
        } finally {
            [Ev3CockpitBtApi]::BluetoothFindRadioClose($findHandle) | Out-Null
        }
    }
    if ($radios.Count -eq 0) { $radios += [IntPtr]::Zero }
    return $radios
}

function Convert-Ev3BtRow([Ev3CockpitBtApi+BLUETOOTH_DEVICE_INFO] $device) {
    $masked = $device.Address -band 0xFFFFFFFFFFFF
    return [PSCustomObject]@{
        Mac = ('{0:X12}' -f $masked).ToLower()
        Name = [string]$device.szName
        Connected = [bool]$device.fConnected
        Remembered = [bool]$device.fRemembered
        Authenticated = [bool]$device.fAuthenticated
    }
}

function New-Ev3BtDeviceInfo {
    $device = New-Object Ev3CockpitBtApi+BLUETOOTH_DEVICE_INFO
    $device.dwSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'Ev3CockpitBtApi+BLUETOOTH_DEVICE_INFO')
    return $device
}

function Get-Ev3BtDevices($request) {
    $rows = @()
    $radios = Get-Ev3BtRadios
    try {
        foreach ($radio in $radios) {
            $search = New-Object Ev3CockpitBtApi+BLUETOOTH_DEVICE_SEARCH_PARAMS
            $search.dwSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'Ev3CockpitBtApi+BLUETOOTH_DEVICE_SEARCH_PARAMS')
            $search.fReturnAuthenticated = [bool]$request.returnAuthenticated
            $search.fReturnRemembered = [bool]$request.returnRemembered
            $search.fReturnUnknown = [bool]$request.returnUnknown
            $search.fReturnConnected = [bool]$request.returnConnected
            $search.fIssueInquiry = [bool]$request.issueInquiry
            $timeout = [Math]::Floor([double]$request.timeoutMultiplier)
            if ($timeout -lt 1) { $timeout = 1 }
            if ($timeout -gt 48) { $timeout = 48 }
            $search.cTimeoutMultiplier = [byte]$timeout
            $search.hRadio = $radio

            $device = New-Ev3BtDeviceInfo
            $findHandle = [Ev3CockpitBtApi]::BluetoothFindFirstDevice([ref]$search, [ref]$device)
            if ($findHandle -eq [IntPtr]::Zero) { continue }
            try {
                do {
                    $rows += Convert-Ev3BtRow $device
                    $device = New-Ev3BtDeviceInfo
                } while ([Ev3CockpitBtApi]::BluetoothFindNextDevice($findHandle, [ref]$device))
            } finally {
                [Ev3CockpitBtApi]::BluetoothFindDeviceClose($findHandle) | Out-Null
            }
        }
    } finally {
        foreach ($radio in $radios) {
            if ($radio -ne [IntPtr]::Zero) {
                [Ev3CockpitBtApi]::CloseHandle($radio) | Out-Null
            }
        }
    }
    return $rows | Sort-Object Mac -Unique
}

function Find-Ev3BtKnownDevices($request) {
    $rows = @()
    $radios = Get-Ev3BtRadios
    try {
        foreach ($mac in @($request.macs)) {
            if ($mac -notmatch '^[0-9A-Fa-f]{12}$') { continue }
            $address = [UInt64]::Parse($mac, [System.Globalization.NumberStyles]::HexNumber)
            foreach ($radio in $radios) {
                $device = New-Ev3BtDeviceInfo
                $device.Address = $address
                $result = [Ev3CockpitBtApi]::BluetoothGetDeviceInfo($radio, [ref]$device)
                if ($result -eq 0) {
                    $rows += Convert-Ev3BtRow $device
                    break
                }
            }
        }
    } finally {
        foreach ($radio in $radios) {
            if ($radio -ne [IntPtr]::Zero) {
                [Ev3CockpitBtApi]::CloseHandle($radio) | Out-Null
            }
        }
    }
    return $rows | Sort-Object Mac -Unique
}

Write-Output '___BTREADY___'
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line -eq 'EXIT') { break }
    try {
        $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
        $request = $payload | ConvertFrom-Json
        if ($request.cmd -eq 'list') {
            Get-Ev3BtDevices $request | ConvertTo-Json -Compress
        } elseif ($request.cmd -eq 'lookup') {
            Find-Ev3BtKnownDevices $request | ConvertTo-Json -Compress
        } else {
            Write-Output '[]'
        }
    } catch {
        Write-Output '[]'
    }
    Write-Output '___BTDONE___'
    [Console]::Out.Flush()
}
`;

function parseWindowsWorkerRows(raw: string): BluetoothDeviceInfo[] {
	if (!raw.trim()) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as
			| { Mac?: unknown; Name?: unknown; Connected?: unknown; Remembered?: unknown; Authenticated?: unknown }
			| Array<{ Mac?: unknown; Name?: unknown; Connected?: unknown; Remembered?: unknown; Authenticated?: unknown }>;
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		return rows
			.map((row) => ({
				mac: String(row.Mac ?? '').toLowerCase(),
				name: String(row.Name ?? '').trim(),
				connected: Boolean(row.Connected),
				remembered: Boolean(row.Remembered),
				authenticated: Boolean(row.Authenticated)
			}))
			.filter((row) => /^[0-9a-f]{12}$/.test(row.mac));
	} catch {
		return [];
	}
}

function createWindowsBackend(): PlatformBackend | undefined {
	return {
		available: true,
		async listDevices(opts: BluetoothScanOptions): Promise<BluetoothDeviceInfo[]> {
			const raw = await windowsBtWorker.request({
				cmd: 'list',
				returnAuthenticated: opts.returnAuthenticated,
				returnRemembered: opts.returnRemembered,
				returnUnknown: opts.returnUnknown,
				returnConnected: opts.returnConnected,
				issueInquiry: opts.issueInquiry,
				timeoutMultiplier: opts.timeoutMultiplier
			});
			return parseWindowsWorkerRows(raw);
		},
		async lookupDevice(mac: string): Promise<BluetoothDeviceInfo | undefined> {
			const raw = await windowsBtWorker.request({ cmd: 'lookup', macs: [mac] });
			return parseWindowsWorkerRows(raw)[0];
		},
		async lookupDevices(macs: readonly string[]): Promise<BluetoothDeviceInfo[]> {
			if (macs.length === 0) {
				return [];
			}
			const raw = await windowsBtWorker.request({ cmd: 'lookup', macs: [...macs] });
			return parseWindowsWorkerRows(raw);
		}
	};
}

// ══════════════════════════════════════════════════════════════════════════
// Linux backend — libbluetooth.so (BlueZ HCI)
// ══════════════════════════════════════════════════════════════════════════

/** BlueZ IREQ_CACHE_FLUSH — force fresh inquiry, don't reuse kernel cache. */
const IREQ_CACHE_FLUSH = 0x0001;
/** Maximum name length that hci_read_remote_name can return. */
const BT_NAME_MAX = 248;

function createLinuxBackend(): PlatformBackend | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const koffi = require('koffi') as KoffiModule;

		// libbluetooth — try versioned first (runtime package), then unversioned (-dev)
		let bt: KoffiLib;
		try {
			bt = koffi.load('libbluetooth.so.3');
		} catch {
			bt = koffi.load('libbluetooth.so');
		}

		// libc — for free()
		let libc: KoffiLib;
		try {
			libc = koffi.load('libc.so.6');
		} catch {
			libc = koffi.load('libc.so');
		}

		// ── BlueZ struct definitions ─────────────────────────────────

		const bdaddr_t = koffi.struct('ev3_bdaddr_t', {
			b: koffi.array('uint8', 6, 'Array')
		});

		// inquiry_info is packed — all uint8 fields + one uint16 at a
		// naturally even offset (12), so no padding regardless of packing.
		koffi.struct('ev3_inquiry_info', {
			bdaddr: bdaddr_t,
			pscan_rep_mode: 'uint8',
			pscan_period_mode: 'uint8',
			pscan_mode: 'uint8',
			dev_class: koffi.array('uint8', 3, 'Array'),
			clock_offset: 'uint16'
		});

		// ── BlueZ function bindings ──────────────────────────────────

		const hci_get_route = bt.func('int hci_get_route(void *)');
		const hci_open_dev = bt.func('int hci_open_dev(int)');
		const hci_close_dev = bt.func('int hci_close_dev(int)');

		// hci_inquiry allocates *ii via malloc — caller must free().
		// The _Out_ void** pattern lets koffi write the pointer back to
		// a JavaScript [null] holder array.
		const hci_inquiry_fn = bt.func(
			'int hci_inquiry(int, int, int, void *, _Out_ void **, long)'
		);

		// Output name buffer is a plain void* — we pass a Node Buffer.
		const hci_read_remote_name_fn = bt.func(
			'int hci_read_remote_name(int, const ev3_bdaddr_t *, int, void *, int)'
		);

		const free_fn = libc.func('void free(void *)');

		return {
			available: true,
			async listDevices(opts: BluetoothScanOptions): Promise<BluetoothDeviceInfo[]> {
				const devId = hci_get_route(null) as number;
				if (devId < 0) {
					return [];
				}

				const dd = hci_open_dev(devId) as number;
				if (dd < 0) {
					return [];
				}

				try {
					const flags = opts.issueInquiry ? IREQ_CACHE_FLUSH : 0;
					// len = inquiry duration in 1.28-second units (min 1)
					const len = Math.max(opts.issueInquiry ? opts.timeoutMultiplier : 1, 1);
					const maxRsp = 255;

					const iiHolder: [unknown] = [null];
					const count = hci_inquiry_fn(devId, len, maxRsp, null, iiHolder, flags) as number;
					if (count <= 0 || !iiHolder[0]) {
						return [];
					}

					const devices: BluetoothDeviceInfo[] = [];
					try {
						const infos = koffi.decode(iiHolder[0], 'ev3_inquiry_info', count) as LinuxInquiryInfo[];

						for (const info of infos) {
							const mac = linuxBdaddrToMac(info.bdaddr.b);

							// Read remote device name — may take up to 5 s per device.
							const nameBuf = Buffer.alloc(BT_NAME_MAX);
							const nameOk = (hci_read_remote_name_fn(
								dd, info.bdaddr, BT_NAME_MAX, nameBuf, 5000
							) as number) >= 0;
							const name = nameOk
								? nameBuf.toString('utf8').split('\0')[0].trim()
								: '';

							devices.push({
								mac,
								name: name || `BT ${mac.slice(-4).toUpperCase()}`,
								connected: false,   // HCI inquiry has no connection flag
								remembered: false,
								authenticated: false,
							});
						}
					} finally {
						free_fn(iiHolder[0]);
					}

					return devices;
				} finally {
					hci_close_dev(dd);
				}
			}
		};
	} catch {
		return undefined;
	}
}

// ── Linux helpers ────────────────────────────────────────────────────────

interface LinuxInquiryInfo {
	bdaddr: { b: number[] };
	dev_class: number[];
}

/** Convert BlueZ bdaddr_t (reverse byte order) to lowercase 12-hex MAC. */
function linuxBdaddrToMac(b: number[]): string {
	return [b[5], b[4], b[3], b[2], b[1], b[0]]
		.map((v) => v.toString(16).padStart(2, '0'))
		.join('');
}
