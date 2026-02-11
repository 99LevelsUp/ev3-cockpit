import { ExtensionError } from './ExtensionError';

/**
 * Error codes for EV3 device command failures.
 */
export type Ev3ErrorCode =
	| 'DIRECT_REPLY_ERROR'
	| 'SYSTEM_ERROR'
	| 'TIMEOUT'
	| 'TRANSPORT_CLOSED'
	| 'INVALID_PORT'
	| 'INVALID_ARGUMENT'
	| 'DEVICE_BUSY'
	| 'UNKNOWN';

/**
 * Recommended user-facing action for recovery.
 */
export type Ev3RecoveryAction =
	| 'retry'
	| 'reconnect'
	| 'check-port'
	| 'check-firmware'
	| 'none';

/**
 * Unified error class for EV3 device command failures.
 * Carries structured context for diagnostics and user-facing messages.
 */
export class Ev3Error extends ExtensionError {
	public readonly op: string;
	public readonly brickId?: string;
	public readonly recommendedAction: Ev3RecoveryAction;

	public constructor(options: {
		code: Ev3ErrorCode;
		message: string;
		op: string;
		brickId?: string;
		recommendedAction?: Ev3RecoveryAction;
		cause?: unknown;
	}) {
		super(options.code, options.message, options.cause);
		this.name = 'Ev3Error';
		this.op = options.op;
		this.brickId = options.brickId;
		this.recommendedAction = options.recommendedAction ?? 'none';
	}
}

/**
 * Map an Ev3ErrorCode to a user-friendly message and recommended action.
 */
export const EV3_ERROR_MESSAGES: Record<Ev3ErrorCode, { message: string; action: Ev3RecoveryAction }> = {
	DIRECT_REPLY_ERROR: {
		message: 'The EV3 brick rejected the command. The operation or port may be invalid.',
		action: 'check-port'
	},
	SYSTEM_ERROR: {
		message: 'A system-level error occurred on the brick (file operation or firmware issue).',
		action: 'check-firmware'
	},
	TIMEOUT: {
		message: 'The command timed out. The brick may be busy or the connection may be slow.',
		action: 'retry'
	},
	TRANSPORT_CLOSED: {
		message: 'The connection to the brick was lost.',
		action: 'reconnect'
	},
	INVALID_PORT: {
		message: 'The specified port does not exist or has no device connected.',
		action: 'check-port'
	},
	INVALID_ARGUMENT: {
		message: 'An invalid argument was provided to the command.',
		action: 'none'
	},
	DEVICE_BUSY: {
		message: 'The device is currently busy processing another command.',
		action: 'retry'
	},
	UNKNOWN: {
		message: 'An unexpected error occurred while communicating with the brick.',
		action: 'reconnect'
	}
};
