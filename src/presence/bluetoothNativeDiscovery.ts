/**
 * Cross-platform native Bluetooth device discovery using koffi FFI.
 *
 * Windows: bthprops.cpl  (BluetoothFindFirstDevice / Next / Close)
 * Linux:   libbluetooth.so  (BlueZ HCI — hci_inquiry + hci_read_remote_name)
 *
 * macOS is intentionally not supported.
 */

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
	listDevices(opts: BluetoothScanOptions): BluetoothDeviceInfo[];
	/** Look up a single device by MAC address (Windows: BluetoothGetDeviceInfo). */
	lookupDevice?(mac: string): BluetoothDeviceInfo | undefined;
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

export function listBluetoothDevicesNative(opts: BluetoothScanOptions): BluetoothDeviceInfo[] {
	return getBackend()?.listDevices(opts) ?? [];
}

/**
 * Look up a single device by MAC address using the platform's persistent
 * device database (Windows: BluetoothGetDeviceInfo).
 *
 * Returns the device info if found, or undefined if the device is unknown
 * to the OS. This works even when the device is NOT in the discovery cache
 * (FindFirstDevice may miss it, but GetDeviceInfo still knows about it).
 */
export function lookupBluetoothDeviceNative(mac: string): BluetoothDeviceInfo | undefined {
	return getBackend()?.lookupDevice?.(mac);
}

/**
 * Batch-lookup known MAC addresses. Returns devices that the OS still knows
 * about, even if they've fallen out of the discovery cache.
 */
export function trackKnownDevicesNative(macs: readonly string[]): BluetoothDeviceInfo[] {
	const backend = getBackend();
	if (!backend?.lookupDevice) {
		return [];
	}
	const results: BluetoothDeviceInfo[] = [];
	for (const mac of macs) {
		const info = backend.lookupDevice(mac);
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
// Windows backend — bthprops.cpl
// ══════════════════════════════════════════════════════════════════════════

function createWindowsBackend(): PlatformBackend | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const koffi = require('koffi') as KoffiModule;
		const bt = koffi.load('bthprops.cpl');

		const SYSTEMTIME = koffi.struct('EV3_BT_SYSTEMTIME', {
			wYear: 'uint16', wMonth: 'uint16', wDayOfWeek: 'uint16', wDay: 'uint16',
			wHour: 'uint16', wMinute: 'uint16', wSecond: 'uint16', wMilliseconds: 'uint16'
		});

		const DEVICE_INFO = koffi.struct('EV3_BT_DEVICE_INFO', {
			dwSize: 'int',
			Address: 'uint64',
			ulClassofDevice: 'uint32',
			fConnected: 'int',
			fRemembered: 'int',
			fAuthenticated: 'int',
			stLastSeen: SYSTEMTIME,
			stLastUsed: SYSTEMTIME,
			szName: koffi.array('uint16', 248, 'Array')
		});

		const SEARCH_PARAMS = koffi.struct('EV3_BT_SEARCH_PARAMS', {
			dwSize: 'int',
			fReturnAuthenticated: 'int',
			fReturnRemembered: 'int',
			fReturnUnknown: 'int',
			fReturnConnected: 'int',
			fIssueInquiry: 'int',
			cTimeoutMultiplier: 'uint8',
			hRadio: 'void *'
		});

		const FindFirst = bt.func(
			'void *__stdcall BluetoothFindFirstDevice(_Inout_ EV3_BT_SEARCH_PARAMS *, _Inout_ EV3_BT_DEVICE_INFO *)'
		);
		const FindNext = bt.func(
			'int __stdcall BluetoothFindNextDevice(void *, _Inout_ EV3_BT_DEVICE_INFO *)'
		);
		const FindClose = bt.func(
			'int __stdcall BluetoothFindDeviceClose(void *)'
		);

		// BluetoothGetDeviceInfo — looks up a device by MAC address in the
		// OS device database. Works even when the device has fallen out of
		// the FindFirstDevice discovery cache.
		const GetDeviceInfo = bt.func(
			'uint32 __stdcall BluetoothGetDeviceInfo(void *, _Inout_ EV3_BT_DEVICE_INFO *)'
		);

		const sizeofSearch = koffi.sizeof(SEARCH_PARAMS);
		const sizeofInfo = koffi.sizeof(DEVICE_INFO);

		return {
			available: true,

			listDevices(opts: BluetoothScanOptions): BluetoothDeviceInfo[] {
				// CRITICAL: On Windows, fIssueInquiry=1 flushes the "unknown"
				// device cache — non-authenticated bricks that happen to be
				// undiscoverable during the scan window vanish permanently.
				// Always use fIssueInquiry=0 (query cached/known devices only).
				const search = {
					dwSize: sizeofSearch,
					fReturnAuthenticated: opts.returnAuthenticated ? 1 : 0,
					fReturnRemembered: opts.returnRemembered ? 1 : 0,
					fReturnUnknown: opts.returnUnknown ? 1 : 0,
					fReturnConnected: opts.returnConnected ? 1 : 0,
					fIssueInquiry: 0,
					cTimeoutMultiplier: 0,
					hRadio: null,
				};

				const info = winMakeEmptyInfo(sizeofInfo);
				const handle = FindFirst(search, info) as null | object;
				if (!handle) {
					return [];
				}

				const devices: BluetoothDeviceInfo[] = [];
				try {
					do {
						devices.push(winParseInfo(info as unknown as WinDeviceInfoRaw));
						winResetInfo(info as unknown as WinDeviceInfoRaw, sizeofInfo);
					} while (FindNext(handle, info));
				} finally {
					FindClose(handle);
				}
				return devices;
			},

			lookupDevice(mac: string): BluetoothDeviceInfo | undefined {
				const addr = BigInt(`0x${mac}`);
				const info = winMakeEmptyInfo(sizeofInfo);
				(info as Record<string, unknown>).Address = addr;
				const result = GetDeviceInfo(null, info) as number;
				if (result !== 0) {
					return undefined;
				}
				return winParseInfo(info as unknown as WinDeviceInfoRaw);
			}
		};
	} catch {
		return undefined;
	}
}

// ── Windows helpers ──────────────────────────────────────────────────────

interface WinDeviceInfoRaw {
	dwSize: number;
	Address: bigint;
	fConnected: number;
	fRemembered: number;
	fAuthenticated: number;
	szName: number[];
}

function winMakeEmptyInfo(dwSize: number): Record<string, unknown> {
	return {
		dwSize, Address: 0n, ulClassofDevice: 0,
		fConnected: 0, fRemembered: 0, fAuthenticated: 0,
		stLastSeen: {}, stLastUsed: {},
		szName: new Array(248).fill(0)
	};
}

function winResetInfo(info: WinDeviceInfoRaw, dwSize: number): void {
	info.dwSize = dwSize;
	info.Address = 0n;
	info.fConnected = 0;
	info.fRemembered = 0;
	info.fAuthenticated = 0;
	info.szName = new Array(248).fill(0);
}

function winParseInfo(info: WinDeviceInfoRaw): BluetoothDeviceInfo {
	const addr = info.Address;
	const mac = (typeof addr === 'bigint' ? addr : BigInt(addr))
		.toString(16).padStart(12, '0').toLowerCase();

	let name = '';
	for (let i = 0; i < info.szName.length; i += 1) {
		if (info.szName[i] === 0) {
			break;
		}
		name += String.fromCharCode(info.szName[i]);
	}

	return {
		mac,
		name: name.trim(),
		connected: Boolean(info.fConnected),
		remembered: Boolean(info.fRemembered),
		authenticated: Boolean(info.fAuthenticated),
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
			listDevices(opts: BluetoothScanOptions): BluetoothDeviceInfo[] {
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
