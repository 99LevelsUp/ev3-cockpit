/**
 * Programmatic Bluetooth pairing on Windows via BluetoothAuthenticateDeviceEx.
 *
 * @packageDocumentation
 */

import { LEGO_MAC_OUI_PREFIX } from './bluetoothPortSelection';
import { pairBluetoothDevice, removeBluetoothDevice } from './windowsBluetoothApi';

export interface BluetoothPairingResult {
	success: boolean;
	method: 'silent' | 'pin' | 'none';
	errorCode?: number;
	errorMessage?: string;
}

export interface BluetoothForgetResult {
	success: boolean;
	errorCode?: number;
	errorMessage?: string;
}

export interface BluetoothPairingOptions {
	allowedOuis?: string[];
	pinCandidates?: string[];
}

function normalizeMac(mac: string): string | undefined {
	const compact = mac.replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
	return compact.length === 12 ? compact : undefined;
}

function isAllowedMac(mac: string, allowedOuis?: string[]): boolean {
	const ouis = (allowedOuis && allowedOuis.length > 0)
		? allowedOuis
		: [LEGO_MAC_OUI_PREFIX];
	return ouis.some((prefix) => mac.startsWith(prefix.toLowerCase()));
}

function normalizePin(pin: string): string | undefined {
	const trimmed = pin.trim();
	if (!/^\d{1,16}$/.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

export async function pairWindowsBluetoothDevice(
	mac: string,
	options?: BluetoothPairingOptions
): Promise<BluetoothPairingResult> {
	const normalized = normalizeMac(mac);
	if (!normalized) {
		return { success: false, method: 'none', errorMessage: 'Invalid MAC address.' };
	}
	if (!isAllowedMac(normalized, options?.allowedOuis)) {
		return { success: false, method: 'none', errorMessage: 'Target MAC not allowed.' };
	}

	const pinCandidates = (options?.pinCandidates ?? ['1234', '0000'])
		.map((pin) => normalizePin(pin))
		.filter((pin): pin is string => Boolean(pin));

	const silent = pairBluetoothDevice(normalized);
	if (silent.success) {
		return { success: true, method: 'silent', errorCode: silent.errorCode };
	}
	for (const pin of pinCandidates) {
		const pinResult = pairBluetoothDevice(normalized, pin);
		if (pinResult.success) {
			return { success: true, method: 'pin', errorCode: pinResult.errorCode };
		}
	}
	return { success: false, method: 'none', errorCode: silent.errorCode };
}

export async function forgetWindowsBluetoothDevice(mac: string): Promise<BluetoothForgetResult> {
	const normalized = normalizeMac(mac);
	if (!normalized) {
		return { success: false, errorMessage: 'Invalid MAC address.' };
	}
	const result = removeBluetoothDevice(normalized);
	return { success: result.success, errorCode: result.errorCode };
}
