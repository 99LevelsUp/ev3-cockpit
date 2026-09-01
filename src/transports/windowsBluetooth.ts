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
	union(fields: Record<string, unknown>): unknown;
	array(type: string, length: number): unknown;
	proto(signature: string): unknown;
	register(callback: (...args: unknown[]) => unknown, type: string): unknown;
	unregister(registered: unknown): void;
	decode(pointer: unknown, type: string): unknown;
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
	/** Registers a callback for `deviceInfo`'s pairing events. `[out]` handle in a 1-box array. */
	registerAuth(deviceInfo: unknown, regHandleOut: unknown[], callback: unknown, param: unknown): number;
	/** Answers a pending pairing request with the filled `BLUETOOTH_AUTHENTICATE_RESPONSE`. */
	sendAuthResponse(radio: unknown, response: unknown): number;
	/** Releases a handle from {@link registerAuth}. */
	unregisterAuth(regHandle: unknown): number;
}

let cached: BthpropsApi | undefined;
let loadFailure: string | undefined;
/** The `koffi` module itself, kept for {@link registerLegacyPinResponder}'s own calls. */
let koffiRef: KoffiLike | undefined;

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

		// BLUETOOTH_AUTHENTICATE_RESPONSE and BLUETOOTH_AUTHENTICATION_CALLBACK_PARAMS, for
		// answering a legacy-PIN pairing request programmatically (see
		// registerLegacyPinResponder below). No #pragma pack surrounds either in the real
		// header, so natural alignment applies -- the same as every struct above.
		koffi.struct('COCKPIT_BT_PIN_INFO', {
			pin: koffi.array('uint8', 16),
			pinLength: 'uint8',
		});
		koffi.struct('COCKPIT_BT_OOB_INFO', {
			C: koffi.array('uint8', 16),
			R: koffi.array('uint8', 16),
		});
		koffi.struct('COCKPIT_BT_NUMERIC_COMPARISON_INFO', { NumericValue: 'uint32' });
		koffi.struct('COCKPIT_BT_PASSKEY_INFO', { passkey: 'uint32' });
		koffi.struct('COCKPIT_BT_AUTH_RESPONSE', {
			bthAddressRemote: 'COCKPIT_BT_ADDRESS',
			authMethod: 'uint32',
			// Anonymous union in the real struct; naming it here only changes how this file
			// addresses it (`.variant.pinInfo`), not the byte layout. All four members are
			// declared, not just the one this file fills, because the union's size is the
			// largest of them (oobInfo, at 32 bytes) -- declaring only pinInfo would model a
			// smaller, wrong-sized struct and desync every field that follows.
			variant: koffi.union({
				pinInfo: 'COCKPIT_BT_PIN_INFO',
				oobInfo: 'COCKPIT_BT_OOB_INFO',
				numericCompInfo: 'COCKPIT_BT_NUMERIC_COMPARISON_INFO',
				passkeyInfo: 'COCKPIT_BT_PASSKEY_INFO',
			}),
			negativeResponse: 'uint8',
		});
		koffi.struct('COCKPIT_BT_AUTH_CALLBACK_PARAMS', {
			deviceInfo: 'COCKPIT_BT_DEVICE_INFO',
			authenticationMethod: 'uint32',
			ioCapability: 'uint32',
			authenticationRequirements: 'uint32',
			valueUnion: koffi.union({ Numeric_Value: 'uint32', Passkey: 'uint32' }),
		});
		// Callback pointer args do not auto-decode to structs (unlike a function's own
		// _Out_/_Inout_ struct pointers) -- declared `void*` here and decoded explicitly
		// with koffi.decode() inside the callback, the same way Koffi's own qsort example
		// handles an opaque callback pointer argument.
		koffi.proto('int __stdcall CockpitBtAuthCallback(void *pvParam, void *pAuthCallbackParams)');

		const removeDevice = lib.func('uint32 __stdcall BluetoothRemoveDevice(uint64*)') as KoffiFunc;
		const authenticate = lib.func(
			'uint32 __stdcall BluetoothAuthenticateDeviceEx(void*, void*, _Inout_ COCKPIT_BT_DEVICE_INFO*, void*, uint32)'
		) as KoffiFunc;
		const registerAuth = lib.func(
			'uint32 __stdcall BluetoothRegisterForAuthenticationEx'
			+ '(COCKPIT_BT_DEVICE_INFO*, _Out_ void**, CockpitBtAuthCallback*, void*)'
		) as KoffiFunc;
		const sendAuthResponse = lib.func(
			'uint32 __stdcall BluetoothSendAuthenticationResponseEx(void*, COCKPIT_BT_AUTH_RESPONSE*)'
		) as KoffiFunc;
		const unregisterAuth = lib.func(
			'int __stdcall BluetoothUnregisterAuthentication(void*)'
		) as KoffiFunc;

		koffiRef = koffi;
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
			registerAuth: (deviceInfo, regHandleOut, callback, param) => (
				registerAuth(deviceInfo, regHandleOut, callback, param)
			),
			sendAuthResponse: (radio, response) => sendAuthResponse(radio, response),
			unregisterAuth: (regHandle) => unregisterAuth(regHandle),
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

/** Fills a `BLUETOOTH_PIN_INFO` for `pin`, zero-padded to its fixed 16-byte field. */
function buildPinInfo(pin: string): { pin: Uint8Array; pinLength: number } {
	const bytes = new Uint8Array(16);
	const encoded = Buffer.from(pin, 'ascii');
	const length = Math.min(encoded.length, bytes.length);
	encoded.copy(bytes, 0, 0, length);
	return { pin: bytes, pinLength: length };
}

/** `BLUETOOTH_AUTHENTICATION_METHOD_LEGACY` — the EV3 supports no other. */
const AUTH_METHOD_LEGACY = 1;

/** A registration this file can later undo. */
interface AuthResponder {
	ok: boolean;
	reason?: string;
	dispose(): void;
}

/**
 * Registers a callback that answers a legacy-PIN pairing request for `deviceInfo` with
 * `pin`, so {@link pairBluetoothDevice} can complete without anything on this host to
 * answer the PIN prompt.
 *
 * Confirmed necessary on hardware, 30.08.2026: with no callback registered, the brick's own
 * screen accepted the pairing and its pre-filled PIN, and `BluetoothAuthenticateDeviceEx`
 * still failed with `ERROR_ACCESS_DENIED` — nothing on this side ever answers the legacy-PIN
 * half of the exchange. Windows raises no dialog of its own for this either: the docstring
 * this replaced assumed one appeared, and none did, on this host or the two others tested.
 *
 * Needed koffi 2.16.3+ (this repo moved to 3.1.6): koffi 2.15.1's registered callbacks
 * crashed the process on exit, reproduced down to `koffi.register()` alone with no native
 * call involved at all — see plan 1.11.13.
 *
 * Scoped to one address (`BluetoothRegisterForAuthenticationEx`'s `pbtdiIn`), so this does
 * not answer for any other device's pairing attempt.
 *
 * @returns `ok: false` with a reason if registration itself failed; otherwise `dispose()`
 *   must be called exactly once, win or lose, to release the callback slot and the OS handle.
 */
function registerLegacyPinResponder(
	api: BthpropsApi, deviceInfo: Record<string, unknown>, pin: string
): AuthResponder {
	if (!koffiRef) {
		return { ok: false, reason: 'koffi not loaded.', dispose: () => { /* nothing to release */ } };
	}
	const koffi = koffiRef;

	const onAuthenticationEvent = (_pvParam: unknown, paramsPtr: unknown): number => {
		try {
			const params = koffi.decode(paramsPtr, 'COCKPIT_BT_AUTH_CALLBACK_PARAMS') as {
				deviceInfo: { Address: { ullLong: bigint } };
				authenticationMethod: number;
			};
			const isLegacy = params.authenticationMethod === AUTH_METHOD_LEGACY;
			api.sendAuthResponse(null, {
				bthAddressRemote: params.deviceInfo.Address,
				authMethod: params.authenticationMethod,
				variant: { pinInfo: buildPinInfo(isLegacy ? pin : '') },
				// Only a legacy PIN request is answered; anything else (numeric comparison,
				// passkey) is refused rather than left to time out unanswered.
				negativeResponse: isLegacy ? 0 : 1,
			});
			return isLegacy ? 1 : 0;
		} catch {
			// A decode or response failure here leaves the request unanswered, the same
			// outcome as never having registered at all -- nothing further to do.
			return 0;
		}
	};

	const registeredCallback = koffi.register(onAuthenticationEvent, 'CockpitBtAuthCallback*');
	const regHandleOut: unknown[] = [null];
	const result = api.registerAuth(deviceInfo, regHandleOut, registeredCallback, null);
	if (result !== 0) {
		koffi.unregister(registeredCallback);
		return {
			ok: false,
			reason: `BluetoothRegisterForAuthenticationEx failed (error ${result}).`,
			dispose: () => { /* registration never took */ },
		};
	}

	const regHandle = regHandleOut[0];
	return {
		ok: true,
		dispose: () => {
			api.unregisterAuth(regHandle);
			koffi.unregister(registeredCallback);
		},
	};
}

/**
 * Pairs this machine with a Bluetooth device.
 *
 * The brick shows its own accept-and-PIN screen and the user confirms it there, PIN
 * {@link EV3_PAIRING_PIN} pre-filled. This host answers the matching legacy-PIN request
 * automatically via {@link registerLegacyPinResponder} — without it, pairing fails with
 * `ERROR_ACCESS_DENIED` even after the brick's own screen accepts, because nothing supplies
 * this side of the PIN exchange. `authenticateDevice` itself runs off the main thread: it
 * does not return until the peer answers, and the brick's own screen is what the user is
 * waiting on, not anything Windows shows.
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

	const responder = registerLegacyPinResponder(api, info, EV3_PAIRING_PIN);
	if (!responder.ok) {
		return { ok: false, reason: responder.reason };
	}

	try {
		const result = await api.authenticateDevice(info);
		// ERROR_CANCELLED is the ordinary outcome of a user closing the dialog, and it is
		// reported rather than thrown: nothing went wrong, they changed their mind.
		return result === 0
			? { ok: true }
			: { ok: false, reason: `Windows refused the pairing (error ${result}).` };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	} finally {
		responder.dispose();
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
