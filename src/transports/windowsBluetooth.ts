/**
 * `bthprops.cpl` bindings — the Windows Bluetooth device cache, read directly.
 *
 * This is what the testlab used as its primary Bluetooth discovery, and it answers the
 * question discovery actually asks: which Bluetooth devices does this machine know about.
 * The COM-port scan in {@link BtSppBackend} answers a narrower one — which paired devices
 * have an outgoing serial port — and the two stopped being the same question when the
 * runtime moved off serial ports.
 *
 * Nothing here touches the radio unless `issueInquiry` is set. The default enumerates
 * remembered and authenticated peers from the host's own cache, which costs no air time and
 * cannot disturb an open RFCOMM channel.
 */

import * as os from 'os';
import { BackendUnavailableError } from '../errors/CockpitError';

/** One device as Windows knows it. */
export interface BluetoothDeviceInfo {
	/** Address, lower-case hex, no separators. */
	mac: string;
	/** Friendly name as Windows last learned it. Empty when it never did. */
	name: string;
	connected: boolean;
	remembered: boolean;
	authenticated: boolean;
	/** Class of Device. Bits 8–12 hold the major class; the EV3's is 8 (Toy). */
	classOfDevice: number;
}

/** Major device class of the EV3, from its Class of Device word. */
export const BT_MAJOR_CLASS_TOY = 8;

/** A `koffi` function that also offers an off-thread call. */
type KoffiFunc = ((...args: unknown[]) => number) & {
	async(...args: unknown[]): void;
};

interface KoffiLike {
	load(name: string): { func(signature: string): unknown };
	struct(name: string, fields: Record<string, unknown>): unknown;
	array(type: string, length: number): unknown;
}

interface BthpropsApi {
	findFirst(params: unknown, info: unknown): unknown;
	findNext(handle: unknown, info: unknown): number;
	findClose(handle: unknown): number;
	/** Removes a pairing. Takes a pointer to the 64-bit address. */
	removeDevice(address: unknown): number;
	/**
	 * Pairs with a device, resolving `0` on success and a Win32 error otherwise.
	 *
	 * Off the main thread on purpose: with a null window handle Windows puts up its own
	 * pairing dialog and does not return until the user answers it. Called synchronously
	 * that would freeze the extension host for as long as the dialog stands.
	 */
	authenticateDevice(info: unknown): Promise<number>;
}

let cached: BthpropsApi | undefined;
let loadFailure: string | undefined;

/**
 * `sizeof(BLUETOOTH_DEVICE_INFO)` and `sizeof(BLUETOOTH_DEVICE_SEARCH_PARAMS)`.
 *
 * Both structures start with the field Windows uses to tell versions apart, and a wrong
 * value there is not rejected — it is interpreted, and the enumeration walks memory at the
 * wrong stride. The numbers below are for LLP64 with 8-byte pointers, which covers x64 and
 * arm64; 32-bit Windows lays both out differently and is refused rather than guessed at.
 */
const DEVICE_INFO_BYTES = 560;
const SEARCH_PARAMS_BYTES = 40;

/** Length of `szName` in `BLUETOOTH_DEVICE_INFO`, in UTF-16 code units. */
const NAME_LENGTH = 248;

function loadBthprops(): BthpropsApi {
	if (cached) { return cached; }
	if (loadFailure !== undefined) { throw new BackendUnavailableError(loadFailure); }

	const fail = (reason: string): never => {
		loadFailure = reason;
		throw new BackendUnavailableError(reason);
	};

	if (os.platform() !== 'win32') {
		return fail(`Bluetooth device enumeration via bthprops is Windows-only; this host is ${os.platform()}.`);
	}
	if (process.arch !== 'x64' && process.arch !== 'arm64') {
		return fail(`Bluetooth device enumeration needs 64-bit Windows; this process is ${process.arch}.`);
	}

	let koffi: KoffiLike;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		koffi = require('koffi') as KoffiLike;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return fail(`Bluetooth device enumeration requires package "koffi". (${detail})`);
	}

	try {
		const lib = koffi.load('bthprops.cpl');

		// BLUETOOTH_ADDRESS is a union of a ULONGLONG and six bytes. Declaring it as the
		// 64-bit member is not just convenient: the union's alignment is 8, and that is what
		// puts the four bytes of padding after dwSize which the rest of the layout depends on.
		koffi.struct('COCKPIT_BT_ADDRESS', { ullLong: 'uint64' });
		koffi.struct('COCKPIT_BT_SYSTEMTIME', {
			wYear: 'uint16', wMonth: 'uint16', wDayOfWeek: 'uint16', wDay: 'uint16',
			wHour: 'uint16', wMinute: 'uint16', wSecond: 'uint16', wMilliseconds: 'uint16',
		});
		koffi.struct('COCKPIT_BT_DEVICE_INFO', {
			dwSize: 'uint32',
			Address: 'COCKPIT_BT_ADDRESS',
			ulClassofDevice: 'uint32',
			fConnected: 'int32',
			fRemembered: 'int32',
			fAuthenticated: 'int32',
			stLastSeen: 'COCKPIT_BT_SYSTEMTIME',
			stLastUsed: 'COCKPIT_BT_SYSTEMTIME',
			szName: koffi.array('char16_t', NAME_LENGTH),
		});
		koffi.struct('COCKPIT_BT_SEARCH_PARAMS', {
			dwSize: 'uint32',
			fReturnAuthenticated: 'int32',
			fReturnRemembered: 'int32',
			fReturnUnknown: 'int32',
			fReturnConnected: 'int32',
			fIssueInquiry: 'int32',
			cTimeoutMultiplier: 'uint8',
			_pad: koffi.array('uint8', 3),
			hRadio: 'void*',
		});

		const removeDevice = lib.func('uint32 __stdcall BluetoothRemoveDevice(uint64*)') as KoffiFunc;
		const authenticate = lib.func(
			'uint32 __stdcall BluetoothAuthenticateDeviceEx(void*, void*, _Inout_ COCKPIT_BT_DEVICE_INFO*, void*, uint32)'
		) as KoffiFunc;

		cached = {
			removeDevice: (address) => removeDevice(address),
			authenticateDevice: (info) => new Promise<number>((resolve, reject) => {
				// hwnd null: Windows owns the dialog. radio null: the first available one.
				// The trailing 0 is MITMProtectionNotRequired, which is what a device with a
				// fixed four-digit PIN can offer.
				authenticate.async(null, null, info, null, 0, (error: Error | null, result: number) => {
					if (error) { reject(error); } else { resolve(result); }
				});
			}),
			findFirst: lib.func(
				'void* __stdcall BluetoothFindFirstDevice(COCKPIT_BT_SEARCH_PARAMS*, _Inout_ COCKPIT_BT_DEVICE_INFO*)'
			) as BthpropsApi['findFirst'],
			findNext: lib.func(
				'int __stdcall BluetoothFindNextDevice(void*, _Inout_ COCKPIT_BT_DEVICE_INFO*)'
			) as BthpropsApi['findNext'],
			findClose: lib.func('int __stdcall BluetoothFindDeviceClose(void*)') as BthpropsApi['findClose'],
		};
		return cached;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return fail(`Bluetooth device enumeration bindings failed to initialise. (${detail})`);
	}
}

/** Forgets a cached load. Test seam. */
export function resetBthpropsCache(): void {
	cached = undefined;
	loadFailure = undefined;
}

function emptyDeviceInfo(): Record<string, unknown> {
	const zeroTime = {
		wYear: 0, wMonth: 0, wDayOfWeek: 0, wDay: 0,
		wHour: 0, wMinute: 0, wSecond: 0, wMilliseconds: 0,
	};
	return {
		dwSize: DEVICE_INFO_BYTES,
		Address: { ullLong: 0n },
		ulClassofDevice: 0,
		fConnected: 0,
		fRemembered: 0,
		fAuthenticated: 0,
		stLastSeen: { ...zeroTime },
		stLastUsed: { ...zeroTime },
		szName: new Uint16Array(NAME_LENGTH),
	};
}

/** Renders the 64-bit address field as the hex the rest of the transports use. */
function addressToMac(value: bigint | number | undefined): string {
	const address = BigInt(value ?? 0);
	let mac = '';
	for (let byte = 5; byte >= 0; byte -= 1) {
		mac += Number((address >> BigInt(byte * 8)) & 0xffn).toString(16).padStart(2, '0');
	}
	return mac;
}

/** Reads `szName` up to its terminator. Windows leaves the rest of the buffer untouched. */
function readName(raw: unknown): string {
	if (!(raw instanceof Uint16Array)) { return ''; }
	const units = Array.from(raw);
	const end = units.indexOf(0);
	return String.fromCharCode(...units.slice(0, end >= 0 ? end : units.length)).trim();
}

function toDeviceInfo(raw: Record<string, unknown>): BluetoothDeviceInfo {
	const address = raw.Address as { ullLong: bigint | number } | undefined;
	return {
		mac: addressToMac(address?.ullLong),
		name: readName(raw.szName),
		connected: Boolean(raw.fConnected),
		remembered: Boolean(raw.fRemembered),
		authenticated: Boolean(raw.fAuthenticated),
		classOfDevice: Number(raw.ulClassofDevice ?? 0),
	};
}

/** Options for {@link listBluetoothDevices}. */
export interface ListBluetoothDevicesOptions {
	/**
	 * Run an inquiry, discovering devices this machine has never paired with.
	 *
	 * Off by default, and it should stay off anywhere near a live session: an inquiry
	 * occupies the radio for seconds and is exactly the kind of interference the single
	 * RFCOMM channel cannot absorb.
	 */
	issueInquiry?: boolean;
	/** Inquiry duration in units of 1.28 s, when `issueInquiry` is set. */
	inquiryTimeoutMultiplier?: number;
	/** Include devices seen but never paired (default: true). */
	returnUnknown?: boolean;
}

/**
 * Enumerates the Bluetooth devices Windows knows about.
 *
 * @throws {BackendUnavailableError} When the bindings cannot load on this host.
 */
export function listBluetoothDevices(
	options: ListBluetoothDevicesOptions = {}
): BluetoothDeviceInfo[] {
	const api = loadBthprops();
	const issueInquiry = options.issueInquiry === true;

	const searchParams = {
		dwSize: SEARCH_PARAMS_BYTES,
		fReturnAuthenticated: 1,
		fReturnRemembered: 1,
		fReturnUnknown: options.returnUnknown === false ? 0 : 1,
		fReturnConnected: 1,
		fIssueInquiry: issueInquiry ? 1 : 0,
		cTimeoutMultiplier: issueInquiry ? (options.inquiryTimeoutMultiplier ?? 4) : 0,
		_pad: new Uint8Array(3),
		hRadio: null,
	};

	const first = emptyDeviceInfo();
	const handle = api.findFirst(searchParams, first);
	// No handle means no devices, which is an answer rather than a fault: a host with a
	// radio and nothing paired reaches here.
	if (!handle) { return []; }

	const devices: BluetoothDeviceInfo[] = [toDeviceInfo(first)];
	try {
		for (;;) {
			const next = emptyDeviceInfo();
			if (!api.findNext(handle, next)) { break; }
			devices.push(toDeviceInfo(next));
		}
	} finally {
		api.findClose(handle);
	}
	return devices;
}

/**
 * Whether a device looks like an EV3.
 *
 * Three independent signals, because each one alone misses a real brick: a renamed brick
 * defeats the name test, the Class of Device is only populated once Windows has seen the
 * device properly, and the OUI test fails on nothing but is not by itself proof the peer
 * is a brick rather than another LEGO product.
 */
export function isLikelyEv3(device: BluetoothDeviceInfo, legoOui: string): boolean {
	if (/\bev3\b|lego|mindstorms/i.test(device.name)) { return true; }
	if (((device.classOfDevice >> 8) & 0x1f) === BT_MAJOR_CLASS_TOY) { return true; }
	return device.mac.toLowerCase().startsWith(legoOui.toLowerCase());
}

// ── Pairing ──────────────────────────────────────────────────

/** The EV3's fixed pairing PIN. The brick shows it on its own display when asked. */
export const EV3_PAIRING_PIN = '1234';

/** Converts a MAC to the 64-bit form `BLUETOOTH_DEVICE_INFO` expects. */
function macToAddress(mac: string): bigint | undefined {
	const hex = String(mac ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
	if (hex.length !== 12) { return undefined; }

	let address = 0n;
	for (let i = 0; i < 12; i += 2) {
		address = (address << 8n) | BigInt(Number.parseInt(hex.slice(i, i + 2), 16));
	}
	return address;
}

/**
 * Pairs this machine with a Bluetooth device.
 *
 * Windows puts up its own pairing dialog and the user types the brick's PIN, which for
 * every EV3 is {@link EV3_PAIRING_PIN}. The call does not return until they answer, so it
 * runs off the main thread — a dialog left open would otherwise hold the extension host.
 *
 * Pairing only. Whether the brick can then be reached is a separate question, answered by
 * the transport rather than here.
 *
 * @returns Nothing on success; a `reason` when Windows refused or the user cancelled.
 * @throws {BackendUnavailableError} When the bindings cannot load on this host.
 */
export async function pairBluetoothDevice(mac: string): Promise<{ ok: boolean; reason?: string }> {
	const api = loadBthprops();
	const address = macToAddress(mac);
	if (address === undefined) {
		return { ok: false, reason: `Not a MAC address: ${mac}` };
	}

	const info = emptyDeviceInfo();
	(info.Address as { ullLong: bigint }).ullLong = address;

	try {
		const result = await api.authenticateDevice(info);
		// ERROR_CANCELLED is the ordinary outcome of a user closing the dialog, and it is
		// reported rather than thrown: nothing went wrong, they changed their mind.
		return result === 0
			? { ok: true }
			: { ok: false, reason: `Windows refused the pairing (error ${result}).` };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Removes a pairing, so the machine forgets the device entirely.
 *
 * @returns Nothing on success; a `reason` when Windows refused.
 * @throws {BackendUnavailableError} When the bindings cannot load on this host.
 */
export function removeBluetoothDevice(mac: string): { ok: boolean; reason?: string } {
	const api = loadBthprops();
	const address = macToAddress(mac);
	if (address === undefined) {
		return { ok: false, reason: `Not a MAC address: ${mac}` };
	}

	// The signature takes a pointer to the address; koffi marshals a one-element array.
	const result = api.removeDevice([address]);
	return result === 0
		? { ok: true }
		: { ok: false, reason: `Windows refused to remove the pairing (error ${result}).` };
}
