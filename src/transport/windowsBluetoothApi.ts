/**
 * Windows-specific Bluetooth API via ffi-napi (BluetoothFindFirstDevice/Next).
 *
 * @packageDocumentation
 */

/* eslint-disable @typescript-eslint/no-var-requires */
import { LEGO_MAC_OUI_PREFIX } from './bluetoothPortSelection';

interface BluetoothDeviceRecord {
	mac: string;
	name?: string;
	connected?: boolean;
	remembered?: boolean;
	authenticated?: boolean;
}

interface BluetoothInquiryOptions {
	returnAuthenticated: boolean;
	returnRemembered: boolean;
	returnUnknown: boolean;
	returnConnected: boolean;
	issueInquiry: boolean;
	timeoutMultiplier: number;
}

interface BluetoothPairResult {
	success: boolean;
	errorCode?: number;
}

let apiInitialized = false;
let ffi: any;
let ref: any;
let StructType: any;
let ArrayType: any;
let bth: any;
let kernel32: any;
let SYSTEMTIME: any;
let WCHAR_ARRAY_248: any;
let BLUETOOTH_DEVICE_INFO: any;
let BLUETOOTH_DEVICE_SEARCH_PARAMS: any;
let BLUETOOTH_FIND_RADIO_PARAMS: any;

function ensureApi(): boolean {
	if (apiInitialized) {
		return Boolean(bth && ref);
	}
	apiInitialized = true;
	try {
		ffi = require('ffi-napi');
		ref = require('ref-napi');
		StructType = require('ref-struct-di')(ref);
		ArrayType = require('ref-array-di')(ref);
	} catch {
		return false;
	}

	SYSTEMTIME = StructType({
		wYear: ref.types.uint16,
		wMonth: ref.types.uint16,
		wDayOfWeek: ref.types.uint16,
		wDay: ref.types.uint16,
		wHour: ref.types.uint16,
		wMinute: ref.types.uint16,
		wSecond: ref.types.uint16,
		wMilliseconds: ref.types.uint16
	});

	WCHAR_ARRAY_248 = ArrayType(ref.types.uint16, 248);
	BLUETOOTH_DEVICE_INFO = StructType({
		dwSize: ref.types.uint32,
		Address: ref.types.uint64,
		ulClassofDevice: ref.types.uint32,
		fConnected: ref.types.int32,
		fRemembered: ref.types.int32,
		fAuthenticated: ref.types.int32,
		stLastSeen: SYSTEMTIME,
		stLastUsed: SYSTEMTIME,
		szName: WCHAR_ARRAY_248
	});

	BLUETOOTH_DEVICE_SEARCH_PARAMS = StructType({
		dwSize: ref.types.uint32,
		fReturnAuthenticated: ref.types.int32,
		fReturnRemembered: ref.types.int32,
		fReturnUnknown: ref.types.int32,
		fReturnConnected: ref.types.int32,
		fIssueInquiry: ref.types.int32,
		cTimeoutMultiplier: ref.types.uint8,
		padding: ref.types.uint8,
		padding2: ref.types.uint16,
		hRadio: ref.refType(ref.types.void)
	});

	BLUETOOTH_FIND_RADIO_PARAMS = StructType({
		dwSize: ref.types.uint32
	});

	bth = ffi.Library('bthprops.cpl', {
		BluetoothFindFirstRadio: ['pointer', [ref.refType(BLUETOOTH_FIND_RADIO_PARAMS), ref.refType(ref.refType(ref.types.void))]],
		BluetoothFindNextRadio: ['bool', ['pointer', ref.refType(ref.refType(ref.types.void))]],
		BluetoothFindRadioClose: ['bool', ['pointer']],
		BluetoothFindFirstDevice: ['pointer', [ref.refType(BLUETOOTH_DEVICE_SEARCH_PARAMS), ref.refType(BLUETOOTH_DEVICE_INFO)]],
		BluetoothFindNextDevice: ['bool', ['pointer', ref.refType(BLUETOOTH_DEVICE_INFO)]],
		BluetoothFindDeviceClose: ['bool', ['pointer']],
		BluetoothGetDeviceInfo: ['uint32', ['pointer', ref.refType(BLUETOOTH_DEVICE_INFO)]],
		BluetoothAuthenticateDevice: ['uint32', ['pointer', 'pointer', ref.refType(BLUETOOTH_DEVICE_INFO), 'string', 'uint32']],
		BluetoothAuthenticateDeviceEx: ['uint32', ['pointer', 'pointer', ref.refType(BLUETOOTH_DEVICE_INFO), 'pointer', 'uint32']],
		BluetoothRemoveDevice: ['uint32', [ref.refType(ref.types.uint64)]]
	});

	kernel32 = ffi.Library('kernel32', {
		CloseHandle: ['bool', ['pointer']]
	});

	return true;
}

function toMac(address: bigint): string {
	const masked = address & 0xffffffffffffn;
	const hex = masked.toString(16).padStart(12, '0');
	return hex.toLowerCase();
}

function readAddress(value: unknown): bigint {
	if (typeof value === 'bigint') {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return BigInt(value);
	}
	if (Buffer.isBuffer(value)) {
		if (typeof value.readBigUInt64LE === 'function') {
			return value.readBigUInt64LE(0);
		}
		let result = 0n;
		for (let i = 7; i >= 0; i -= 1) {
			result = (result << 8n) + BigInt(value[i] ?? 0);
		}
		return result;
	}
	return 0n;
}

function decodeWideString(values: number[]): string {
	const bytes = Buffer.alloc(values.length * 2);
	for (let i = 0; i < values.length; i += 1) {
		bytes.writeUInt16LE(values[i], i * 2);
	}
	let end = bytes.length;
	while (end >= 2 && bytes.readUInt16LE(end - 2) === 0) {
		end -= 2;
	}
	if (end <= 0) {
		return '';
	}
	return bytes.subarray(0, end).toString('utf16le').trim();
}

function listRadios(): Buffer[] {
	const radios: Buffer[] = [];
	const findParams = new BLUETOOTH_FIND_RADIO_PARAMS();
	findParams.dwSize = BLUETOOTH_FIND_RADIO_PARAMS.size;
	const radioPtr = ref.alloc(ref.refType(ref.types.void));
	const findHandle = bth.BluetoothFindFirstRadio(findParams.ref(), radioPtr);
	if (!ref.isNull(findHandle)) {
		do {
			const handle = radioPtr.deref();
			if (handle && !ref.isNull(handle)) {
				radios.push(handle);
			}
		} while (bth.BluetoothFindNextRadio(findHandle, radioPtr));
		bth.BluetoothFindRadioClose(findHandle);
	}
	if (radios.length === 0) {
		radios.push(ref.NULL);
	}
	return radios;
}

export function listBluetoothDevices(options: BluetoothInquiryOptions): BluetoothDeviceRecord[] {
	if (!ensureApi()) {
		return [];
	}
	const results: BluetoothDeviceRecord[] = [];
	const radios = listRadios();

	for (const radio of radios) {
		const search = new BLUETOOTH_DEVICE_SEARCH_PARAMS();
		search.dwSize = BLUETOOTH_DEVICE_SEARCH_PARAMS.size;
		search.fReturnAuthenticated = options.returnAuthenticated ? 1 : 0;
		search.fReturnRemembered = options.returnRemembered ? 1 : 0;
		search.fReturnUnknown = options.returnUnknown ? 1 : 0;
		search.fReturnConnected = options.returnConnected ? 1 : 0;
		search.fIssueInquiry = options.issueInquiry ? 1 : 0;
		search.cTimeoutMultiplier = Math.max(1, Math.min(48, Math.floor(options.timeoutMultiplier)));
		search.hRadio = radio;

		const info = new BLUETOOTH_DEVICE_INFO();
		info.dwSize = BLUETOOTH_DEVICE_INFO.size;
		const findHandle = bth.BluetoothFindFirstDevice(search.ref(), info.ref());
		if (ref.isNull(findHandle)) {
			continue;
		}
		do {
			const address = readAddress(info.Address);
			const mac = toMac(address);
			if (mac.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase())) {
				const name = decodeWideString(info.szName);
				results.push({
					mac,
					name,
					connected: Boolean(info.fConnected),
					remembered: Boolean(info.fRemembered),
					authenticated: Boolean(info.fAuthenticated)
				});
			}
			info.dwSize = BLUETOOTH_DEVICE_INFO.size;
		} while (bth.BluetoothFindNextDevice(findHandle, info.ref()));
		bth.BluetoothFindDeviceClose(findHandle);
	}

	for (const radio of radios) {
		if (radio && !ref.isNull(radio)) {
			kernel32.CloseHandle(radio);
		}
	}

	return results;
}

export function pairBluetoothDevice(mac: string, pin?: string): BluetoothPairResult {
	if (!ensureApi()) {
		return { success: false };
	}
	const normalized = mac.replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
	if (normalized.length !== 12 || !normalized.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase())) {
		return { success: false };
	}

	const radios = listRadios();

	const addressValue = BigInt(`0x${normalized}`);
	let code = 0;
	for (const radio of radios) {
		const info = new BLUETOOTH_DEVICE_INFO();
		info.dwSize = BLUETOOTH_DEVICE_INFO.size;
		info.Address = addressValue as any;
		const getResult = bth.BluetoothGetDeviceInfo(radio, info.ref());
		if (getResult !== 0) {
			continue;
		}
		if (pin && pin.length > 0) {
			code = bth.BluetoothAuthenticateDevice(ref.NULL, radio, info.ref(), pin, pin.length);
		} else {
			const authReq = 4; // MITMProtectionNotRequiredGeneralBonding
			code = bth.BluetoothAuthenticateDeviceEx(ref.NULL, radio, info.ref(), ref.NULL, authReq);
		}
		if (code === 0) {
			break;
		}
	}

	for (const radio of radios) {
		if (radio && !ref.isNull(radio)) {
			kernel32.CloseHandle(radio);
		}
	}

	return { success: code === 0, errorCode: code };
}

export function removeBluetoothDevice(mac: string): BluetoothPairResult {
	if (!ensureApi()) {
		return { success: false };
	}
	const normalized = mac.replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
	if (normalized.length !== 12) {
		return { success: false };
	}
	const addressValue = BigInt(`0x${normalized}`);
	const addressBuf = ref.alloc(ref.types.uint64, addressValue as any);
	const code: number = bth.BluetoothRemoveDevice(addressBuf);
	return { success: code === 0, errorCode: code };
}

export function canUseWindowsBluetoothApi(): boolean {
	return ensureApi();
}
