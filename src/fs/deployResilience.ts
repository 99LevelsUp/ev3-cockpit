import { ExtensionError } from '../errors/ExtensionError';

const DEPLOY_TRANSIENT_TRANSPORT_PATTERNS: RegExp[] = [
	/adapter is not open/i,
	/transport is not open/i,
	/send aborted/i,
	/could not read from hid device/i,
	/could not write to hid device/i,
	/device has been disconnected/i,
	/unknown error code 121/i,
	/unknown error code 1256/i,
	/unknown error code 1167/i,
	/econnrefused/i,
	/econnreset/i,
	/econnaborted/i,
	/socket hang up/i,
	/ehostunreach/i,
	/enetunreach/i,
	/tcp connect timeout/i,
	/udp discovery timeout/i,
	/opening com\d+/i,
	/access denied/i,
	/file not found/i
];

const TRANSIENT_ERROR_CODES = new Set<string>([
	'TIMEOUT',
	'EXECUTION_FAILED'
]);

export function isDeployTransientTransportError(message: string): boolean {
	return DEPLOY_TRANSIENT_TRANSPORT_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Detekce přechodné transportní chyby: typový kód má přednost, regex je záloha.
 */
export function isTransientDeployError(error: unknown): boolean {
	if (error instanceof ExtensionError && TRANSIENT_ERROR_CODES.has(error.code)) {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return isDeployTransientTransportError(message);
}

export async function sleepMs(ms: number): Promise<void> {
	if (ms <= 0) {
		return;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

