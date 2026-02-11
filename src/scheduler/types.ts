import { ExtensionError } from '../errors/ExtensionError';

export type Lane = 'emergency' | 'high' | 'normal' | 'low';

export const LANE_PRIORITY: readonly Lane[] = ['emergency', 'high', 'normal', 'low'];

export type SchedulerState = 'idle' | 'running' | 'orphan-risk' | 'disposed';

export type SchedulerErrorCode =
	| 'TIMEOUT'
	| 'CANCELLED'
	| 'DISPOSED'
	| 'COUNTER_EXHAUSTED'
	| 'EXECUTION_FAILED'
	| 'ORPHAN_RISK';

export interface CommandExecutionContext {
	messageCounter: number;
	timeoutMs: number;
	signal: AbortSignal;
	enqueuedAt: number;
}

export type ChunkStep<TReply> = { done: false } | { done: true; reply: TReply };

interface CommandRequestBase {
	id?: string;
	lane?: Lane;
	timeoutMs?: number;
	idempotent?: boolean;
	signal?: AbortSignal;
	retry?: RetryPolicy;
}

export interface SingleCommandRequest<TReply> extends CommandRequestBase {
	kind?: 'single';
	execute: (ctx: CommandExecutionContext) => Promise<TReply>;
}

export interface ChunkedCommandRequest<TReply> extends CommandRequestBase {
	kind: 'chunked';
	executeChunk: (ctx: CommandExecutionContext) => Promise<ChunkStep<TReply>>;
}

export type CommandRequest<TReply> = SingleCommandRequest<TReply> | ChunkedCommandRequest<TReply>;

export interface CommandResult<TReply> {
	requestId: string;
	messageCounter: number;
	reply: TReply;
	enqueuedAt: number;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
}

export interface RetryPolicy {
	maxRetries?: number;
	initialBackoffMs?: number;
	backoffFactor?: number;
	maxBackoffMs?: number;
	retryOn?: SchedulerErrorCode[];
}

export class SchedulerError extends ExtensionError {
	public readonly requestId: string;

	public constructor(code: SchedulerErrorCode, requestId: string, message: string, cause?: unknown) {
		super(code, message, cause);
		this.name = 'SchedulerError';
		this.requestId = requestId;
	}
}
