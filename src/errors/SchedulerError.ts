import { ExtensionError } from './ExtensionError';

/**
 * Error codes for command scheduler failures.
 */
export enum SchedulerErrorCode {
	/** Command was rejected (duplicate or policy violation) */
	COMMAND_REJECTED = 'COMMAND_REJECTED',
	/** Command timed out in scheduler */
	TIMEOUT = 'TIMEOUT',
	/** Command was cancelled by user or system */
	CANCELLED = 'CANCELLED',
	/** Command was aborted due to transport failure */
	ABORTED = 'ABORTED',
	/** Queue is full and cannot accept more commands */
	QUEUE_FULL = 'QUEUE_FULL',
	/** Invalid lane specified */
	INVALID_LANE = 'INVALID_LANE',
	/** Command exceeds maximum allowed payload size */
	PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
	/** Command was dropped due to priority or policy */
	DROPPED = 'DROPPED',
	/** Scheduler is not running or has been disposed */
	NOT_RUNNING = 'NOT_RUNNING',
	/** Duplicate command ID detected */
	DUPLICATE_ID = 'DUPLICATE_ID',
	/** Unknown scheduler error */
	UNKNOWN = 'UNKNOWN'
}

/**
 * Recovery action recommendation for scheduler errors.
 */
export type SchedulerRecoveryAction =
	| 'retry'
	| 'wait-and-retry'
	| 'check-connection'
	| 'reduce-load'
	| 'none';

/**
 * Specialized error for command scheduler and queuing issues.
 * Used when commands fail to queue, timeout in the scheduler, or are rejected.
 */
export class SchedulerError extends ExtensionError {
	public readonly commandId?: string;
	public readonly lane?: string;
	public readonly queueSize?: number;
	public readonly recommendedAction: SchedulerRecoveryAction;

	public constructor(options: {
		code: SchedulerErrorCode;
		message: string;
		commandId?: string;
		lane?: string;
		queueSize?: number;
		recommendedAction?: SchedulerRecoveryAction;
		cause?: unknown;
	}) {
		super(options.code, options.message, options.cause);
		this.name = 'SchedulerError';
		this.commandId = options.commandId;
		this.lane = options.lane;
		this.queueSize = options.queueSize;
		this.recommendedAction = options.recommendedAction ?? inferRecoveryAction(options.code);
	}
}

/**
 * Infer recovery action from error code.
 */
function inferRecoveryAction(code: SchedulerErrorCode): SchedulerRecoveryAction {
	switch (code) {
		case SchedulerErrorCode.TIMEOUT:
		case SchedulerErrorCode.ABORTED:
			return 'retry';
		case SchedulerErrorCode.QUEUE_FULL:
		case SchedulerErrorCode.DROPPED:
			return 'wait-and-retry';
		case SchedulerErrorCode.NOT_RUNNING:
			return 'check-connection';
		case SchedulerErrorCode.CANCELLED:
		case SchedulerErrorCode.COMMAND_REJECTED:
		case SchedulerErrorCode.DUPLICATE_ID:
			return 'none';
		default:
			return 'retry';
	}
}

/**
 * User-facing error messages for scheduler errors.
 */
export const SCHEDULER_ERROR_MESSAGES: Record<SchedulerErrorCode, string> = {
	[SchedulerErrorCode.COMMAND_REJECTED]: 'Command was rejected by the scheduler.',
	[SchedulerErrorCode.TIMEOUT]: 'Command timed out while waiting in queue.',
	[SchedulerErrorCode.CANCELLED]: 'Command was cancelled.',
	[SchedulerErrorCode.ABORTED]: 'Command was aborted due to transport failure.',
	[SchedulerErrorCode.QUEUE_FULL]: 'Command queue is full. Please wait and try again.',
	[SchedulerErrorCode.INVALID_LANE]: 'Invalid priority lane specified.',
	[SchedulerErrorCode.PAYLOAD_TOO_LARGE]: 'Command payload exceeds maximum size.',
	[SchedulerErrorCode.DROPPED]: 'Command was dropped due to priority policy.',
	[SchedulerErrorCode.NOT_RUNNING]: 'Scheduler is not running. Connection may be lost.',
	[SchedulerErrorCode.DUPLICATE_ID]: 'Duplicate command ID detected.',
	[SchedulerErrorCode.UNKNOWN]: 'Unknown scheduler error occurred.'
};
