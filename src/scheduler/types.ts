import { ExtensionError } from '../errors/ExtensionError';

/**
 * Priority lane for command scheduling. Commands in higher-priority lanes
 * are processed before lower-priority ones.
 */
export type Lane = 'emergency' | 'high' | 'normal' | 'low';

/** Lanes ordered from highest to lowest priority. */
export const LANE_PRIORITY: readonly Lane[] = ['emergency', 'high', 'normal', 'low'];

/** Current lifecycle state of a {@link CommandScheduler} instance. */
export type SchedulerState = 'idle' | 'running' | 'orphan-risk' | 'disposed';

/** Error codes produced by the command scheduler. */
export type SchedulerErrorCode =
	| 'TIMEOUT'
	| 'CANCELLED'
	| 'DISPOSED'
	| 'COUNTER_EXHAUSTED'
	| 'EXECUTION_FAILED'
	| 'ORPHAN_RISK';

/**
 * Execution context provided to command callbacks when the scheduler
 * dequeues and runs a command.
 */
export interface CommandExecutionContext {
	/** Allocated EV3 message counter for this command. */
	messageCounter: number;
	/** Timeout in ms for this execution attempt. */
	timeoutMs: number;
	/** Abort signal that fires on timeout or cancellation. */
	signal: AbortSignal;
	/** Timestamp (ms since epoch) when the command was enqueued. */
	enqueuedAt: number;
}

/**
 * Return value from a chunked command's `executeChunk` callback.
 *
 * @typeParam TReply - Type of the final reply value
 */
export type ChunkStep<TReply> = { done: false } | { done: true; reply: TReply };

/** Base options shared by single and chunked command requests. */
interface CommandRequestBase {
	/** Optional human-readable request ID for logging. */
	id?: string;
	/** Priority lane (defaults to `'normal'`). */
	lane?: Lane;
	/** Per-request timeout override in milliseconds. */
	timeoutMs?: number;
	/** Whether the command is safe to retry on failure. */
	idempotent?: boolean;
	/** External abort signal for cooperative cancellation. */
	signal?: AbortSignal;
	/** Retry policy for automatic retries on transient failures. */
	retry?: RetryPolicy;
}

/**
 * A single-shot command request executed in one scheduler tick.
 *
 * @typeParam TReply - Type of the reply value
 */
export interface SingleCommandRequest<TReply> extends CommandRequestBase {
	kind?: 'single';
	/** Callback invoked by the scheduler to execute the command. */
	execute: (ctx: CommandExecutionContext) => Promise<TReply>;
}

/**
 * A multi-step (chunked) command request that may span multiple scheduler ticks.
 *
 * @remarks
 * The `executeChunk` callback is called repeatedly until it returns `{ done: true }`.
 * Useful for large file transfers that must be split into multiple packets.
 *
 * @typeParam TReply - Type of the final reply value
 */
export interface ChunkedCommandRequest<TReply> extends CommandRequestBase {
	kind: 'chunked';
	/** Callback invoked repeatedly until it signals completion. */
	executeChunk: (ctx: CommandExecutionContext) => Promise<ChunkStep<TReply>>;
}

/** Union of single and chunked command requests. */
export type CommandRequest<TReply> = SingleCommandRequest<TReply> | ChunkedCommandRequest<TReply>;

/**
 * Result returned by the scheduler after a command completes successfully.
 *
 * @typeParam TReply - Type of the reply value
 */
export interface CommandResult<TReply> {
	/** Request ID assigned to this command. */
	requestId: string;
	/** EV3 message counter used for this command. */
	messageCounter: number;
	/** The reply value produced by the command callback. */
	reply: TReply;
	/** Timestamp when the command was enqueued. */
	enqueuedAt: number;
	/** Timestamp when execution started. */
	startedAt: number;
	/** Timestamp when execution finished. */
	finishedAt: number;
	/** Wall-clock duration in milliseconds. */
	durationMs: number;
}

/**
 * Configurable retry policy for automatic command retries.
 *
 * @remarks
 * When a command fails with a retryable error code, the scheduler can
 * automatically re-enqueue it with exponential backoff.
 */
export interface RetryPolicy {
	/** Maximum number of retry attempts. @defaultValue 0 */
	maxRetries?: number;
	/** Initial delay before the first retry in ms. @defaultValue 100 */
	initialBackoffMs?: number;
	/** Multiplicative factor applied to backoff after each retry. @defaultValue 2 */
	backoffFactor?: number;
	/** Maximum backoff delay in ms. @defaultValue 5000 */
	maxBackoffMs?: number;
	/** Error codes that trigger a retry (if omitted, all codes are retryable). */
	retryOn?: SchedulerErrorCode[];
}

/**
 * Error thrown by the command scheduler for queuing and execution failures.
 *
 * @see {@link ../errors/SchedulerError | errors/SchedulerError} for the richer version
 *   used by higher-level code
 */
export class SchedulerError extends ExtensionError {
	/** ID of the request that failed. */
	public readonly requestId: string;

	/**
	 * @param code - Scheduler-specific error code
	 * @param requestId - ID of the failed request
	 * @param message - Human-readable error description
	 * @param cause - Optional root-cause error
	 */
	public constructor(code: SchedulerErrorCode, requestId: string, message: string, cause?: unknown) {
		super(code, message, cause);
		this.name = 'SchedulerError';
		this.requestId = requestId;
	}
}
