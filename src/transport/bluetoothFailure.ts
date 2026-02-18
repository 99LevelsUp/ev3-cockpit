/**
 * Bluetooth failure classification for Windows COM port errors.
 *
 * Classifies error messages from BT SPP operations into phases and
 * transient/permanent categories to support retry decisions.
 */

/** Phase in which the BT failure occurred. */
export type BluetoothFailurePhase =
	| 'discovery'
	| 'open'
	| 'probe'
	| 'send'
	| 'session'
	| 'unknown';

/** Result of classifying a BT error message. */
export interface BluetoothFailureClassification {
	/** Phase where the failure occurred. */
	phase: BluetoothFailurePhase;
	/** Whether the error is transient and the operation may be retried. */
	transient: boolean;
	/** Matched Windows error code, if any. */
	winErrorCode?: number;
}

/**
 * Known Windows error codes encountered on BT COM port operations.
 * All are considered transient because they reflect temporary hardware
 * or driver conditions that may resolve on retry.
 */
const WIN_ERROR_MAP: ReadonlyMap<number, string> = new Map([
	[121, 'ERROR_SEM_TIMEOUT'],
	[1167, 'ERROR_DEVICE_NOT_CONNECTED'],
	[1256, 'ERROR_CONNECTION_ABORTED'],
	[2, 'ERROR_FILE_NOT_FOUND'],
	[5, 'ERROR_ACCESS_DENIED'],
]);

/** Regex to extract a Windows error code from a serialport/Node error message. */
const WIN_ERROR_CODE_REGEX = /(?:error code|errno[: ]|win32[: ]|code[: ])\s*(\d+)/i;

/** Regex to match generic access-denied phrasing. */
const ACCESS_DENIED_REGEX = /access.denied|permission.denied|EACCES/i;

/** Phase-detection patterns applied in order; first match wins. */
const PHASE_PATTERNS: ReadonlyArray<{ pattern: RegExp; phase: BluetoothFailurePhase }> = [
	{ pattern: /\bopen(?:ing)?\b|opening serial|cannot open/i, phase: 'open' },
	{ pattern: /\bprobe\b|verifyEv3/i, phase: 'probe' },
	{ pattern: /\bsend\b|write\b|dispatch/i, phase: 'send' },
	{ pattern: /\bdiscover/i, phase: 'discovery' },
	{ pattern: /\bsession\b|closed.*while/i, phase: 'session' },
];

/**
 * Classify a BT error message into a phase and transient flag.
 *
 * @param message - The error `.message` string.
 * @param phase - Optional explicit phase override. If omitted, inferred from the message text.
 */
export function classifyBluetoothFailure(
	message: string,
	phase?: BluetoothFailurePhase
): BluetoothFailureClassification {
	const detectedPhase = phase ?? inferPhase(message);
	const winResult = extractWinErrorCode(message);

	if (winResult !== undefined) {
		return {
			phase: detectedPhase,
			transient: true,
			winErrorCode: winResult,
		};
	}

	// Access-denied without a numeric code is also transient on Windows BT.
	if (ACCESS_DENIED_REGEX.test(message)) {
		return { phase: detectedPhase, transient: true, winErrorCode: 5 };
	}

	return { phase: detectedPhase, transient: false };
}

/**
 * Returns `true` when the error message indicates a transient BT failure
 * that should be retried.
 */
export function isTransientBluetoothError(message: string): boolean {
	return classifyBluetoothFailure(message).transient;
}

// ── internal ────────────────────────────────────────────────────────

function inferPhase(message: string): BluetoothFailurePhase {
	for (const { pattern, phase } of PHASE_PATTERNS) {
		if (pattern.test(message)) {
			return phase;
		}
	}
	return 'unknown';
}

function extractWinErrorCode(message: string): number | undefined {
	const match = WIN_ERROR_CODE_REGEX.exec(message);
	if (!match) {
		return undefined;
	}
	const code = Number(match[1]);
	return WIN_ERROR_MAP.has(code) ? code : undefined;
}
