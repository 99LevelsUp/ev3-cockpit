/**
 * Unified error taxonomy for EV3 Cockpit extension.
 *
 * Error hierarchy:
 * - ExtensionError (base class for all extension errors)
 *   - TransportError (USB, TCP, Serial communication errors)
 *   - ProtocolError (EV3 protocol violations and malformed packets)
 *   - SchedulerError (Command scheduling and queuing errors)
 *   - FilesystemError (File operations on the brick)
 *   - EV3Error (Device command execution errors)
 *
 * Each specialized error class provides:
 * - Typed error codes (enums)
 * - Structured metadata for diagnostics
 * - Recommended recovery actions
 * - User-facing error messages
 * - Cause chaining for root cause analysis
 */

export { ExtensionError } from './ExtensionError';

export {
	TransportError,
	TransportErrorCode,
	TRANSPORT_ERROR_MESSAGES,
	type TransportType,
	type TransportRecoveryAction
} from './TransportError';

export {
	ProtocolError,
	ProtocolErrorCode,
	PROTOCOL_ERROR_MESSAGES,
	type ProtocolRecoveryAction
} from './ProtocolError';

export {
	SchedulerError,
	SchedulerErrorCode,
	SCHEDULER_ERROR_MESSAGES,
	type SchedulerRecoveryAction
} from './SchedulerError';

export {
	FilesystemError,
	FilesystemErrorCode,
	FILESYSTEM_ERROR_MESSAGES,
	type FilesystemOperation,
	type FilesystemRecoveryAction
} from './FilesystemError';

export {
	EV3Error,
	Ev3Error,
	EV3_ERROR_MESSAGES,
	type Ev3ErrorCode,
	type Ev3RecoveryAction
} from './Ev3Error';

import { ExtensionError as ExtError } from './ExtensionError';
import { TransportError as TError, TRANSPORT_ERROR_MESSAGES as TRANSPORT_MSGS, TransportErrorCode as TCode } from './TransportError';
import { ProtocolError as PError, PROTOCOL_ERROR_MESSAGES as PROTOCOL_MSGS, ProtocolErrorCode as PCode } from './ProtocolError';
import { SchedulerError as SError, SCHEDULER_ERROR_MESSAGES as SCHEDULER_MSGS, SchedulerErrorCode as SCode } from './SchedulerError';
import { FilesystemError as FError, FILESYSTEM_ERROR_MESSAGES as FILESYSTEM_MSGS, FilesystemErrorCode as FCode } from './FilesystemError';
import { EV3Error as E3Error, EV3_ERROR_MESSAGES as EV3_MSGS, Ev3ErrorCode as E3Code } from './Ev3Error';

/**
 * Type guard to check if an error is an ExtensionError.
 */
export function isExtensionError(error: unknown): error is ExtError {
	return error instanceof ExtError;
}

/**
 * Type guard to check if an error is a TransportError.
 */
export function isTransportError(error: unknown): error is TError {
	return error instanceof TError;
}

/**
 * Type guard to check if an error is a ProtocolError.
 */
export function isProtocolError(error: unknown): error is PError {
	return error instanceof PError;
}

/**
 * Type guard to check if an error is a SchedulerError.
 */
export function isSchedulerError(error: unknown): error is SError {
	return error instanceof SError;
}

/**
 * Type guard to check if an error is a FilesystemError.
 */
export function isFilesystemError(error: unknown): error is FError {
	return error instanceof FError;
}

/**
 * Type guard to check if an error is an EV3Error.
 */
export function isEv3Error(error: unknown): error is E3Error {
	return error instanceof E3Error;
}

/**
 * Extract a user-facing error message from any error type.
 */
export function getUserFacingMessage(error: unknown): string {
	if (error instanceof TError) {
		return TRANSPORT_MSGS[error.code as TCode] ?? error.message;
	}
	if (error instanceof PError) {
		return PROTOCOL_MSGS[error.code as PCode] ?? error.message;
	}
	if (error instanceof SError) {
		return SCHEDULER_MSGS[error.code as SCode] ?? error.message;
	}
	if (error instanceof FError) {
		return FILESYSTEM_MSGS[error.code as FCode] ?? error.message;
	}
	if (error instanceof E3Error) {
		const entry = EV3_MSGS[error.code as E3Code];
		return entry?.message ?? error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
