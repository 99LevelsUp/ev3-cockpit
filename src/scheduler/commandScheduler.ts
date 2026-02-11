import { Logger, NoopLogger } from '../diagnostics/logger';
import { MessageCounter } from './messageCounter';
import {
	ChunkStep,
	CommandExecutionContext,
	CommandRequest,
	CommandResult,
	LANE_PRIORITY,
	Lane,
	RetryPolicy,
	SchedulerError,
	SchedulerErrorCode,
	SchedulerState
} from './types';
import {
	NoopOrphanRecoveryStrategy,
	OrphanRecoveryStrategy,
	OrphanRiskReason
} from './orphanRecovery';

interface CommandSchedulerOptions {
	defaultTimeoutMs?: number;
	logger?: Logger;
	messageCounter?: MessageCounter;
	orphanRecoveryStrategy?: OrphanRecoveryStrategy;
	defaultRetryPolicy?: RetryPolicy;
}

type ScheduledMode = 'single' | 'chunked';

interface ScheduledItem<TReply> {
	requestId: string;
	lane: Lane;
	timeoutMs: number;
	idempotent: boolean;
	enqueuedAt: number;
	externalSignal?: AbortSignal;
	mode: ScheduledMode;
	retryPolicy: NormalizedRetryPolicy;
	executeSingle?: (ctx: CommandExecutionContext) => Promise<TReply>;
	executeChunk?: (ctx: CommandExecutionContext) => Promise<ChunkStep<TReply>>;
	resolve: (value: CommandResult<TReply>) => void;
	reject: (reason: unknown) => void;
	removeQueuedAbortListener?: () => void;
	startedAt?: number;
}

interface NormalizedRetryPolicy {
	maxRetries: number;
	initialBackoffMs: number;
	backoffFactor: number;
	maxBackoffMs: number;
	retryOn: ReadonlySet<SchedulerErrorCode>;
}

/** Default initial retry backoff (ms) when no policy is configured. */
const DEFAULT_INITIAL_BACKOFF_MS = 25;
/** Default maximum retry backoff ceiling (ms). */
const DEFAULT_MAX_BACKOFF_MS = 500;
/** Default exponential backoff multiplier. */
const DEFAULT_BACKOFF_FACTOR = 2;

const DEFAULT_RETRYABLE_CODES: readonly SchedulerErrorCode[] = ['EXECUTION_FAILED', 'TIMEOUT'];

type InvocationOutcome<TReply> =
	| { ok: true; reply: TReply; messageCounter: number }
	| {
			ok: false;
			code: SchedulerErrorCode;
			message?: string;
			error?: unknown;
			orphanRiskReason?: OrphanRiskReason;
	};

type RunStatus = 'completed' | 'preempted' | 'failed';

export class CommandScheduler {
	private readonly defaultTimeoutMs: number;
	private readonly logger: Logger;
	private readonly messageCounter: MessageCounter;
	private readonly orphanRecoveryStrategy: OrphanRecoveryStrategy;
	private readonly defaultRetryPolicy: NormalizedRetryPolicy;
	private readonly queues: Record<Lane, ScheduledItem<unknown>[]> = {
		emergency: [],
		high: [],
		normal: [],
		low: []
	};

	private state: SchedulerState = 'idle';
	private inFlight?: ScheduledItem<unknown>;
	private inFlightAbortController?: AbortController;
	private processScheduled = false;
	private requestSeq = 0;
	private recoveryPromise?: Promise<void>;

	public constructor(options: CommandSchedulerOptions = {}) {
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2_000;
		this.logger = options.logger ?? new NoopLogger();
		this.messageCounter = options.messageCounter ?? new MessageCounter();
		this.orphanRecoveryStrategy = options.orphanRecoveryStrategy ?? new NoopOrphanRecoveryStrategy();
		this.defaultRetryPolicy = this.normalizeRetryPolicy(options.defaultRetryPolicy);
	}

	public getState(): SchedulerState {
		return this.state;
	}

	public getQueueSize(lane?: Lane): number {
		if (lane) {
			return this.queues[lane].length;
		}

		return LANE_PRIORITY.reduce((total, currentLane) => total + this.queues[currentLane].length, 0);
	}

	public enqueue<TReply>(request: CommandRequest<TReply>): Promise<CommandResult<TReply>> {
		if (this.state === 'disposed') {
			const requestId = request.id ?? 'unknown';
			return Promise.reject(
				new SchedulerError('DISPOSED', requestId, 'Scheduler is disposed; cannot enqueue new request.')
			);
		}

		const requestId = request.id ?? this.nextRequestId();
		const lane = request.lane ?? 'normal';
		const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
		const idempotent = request.idempotent ?? false;
		const retryPolicy = this.normalizeRetryPolicy(request.retry);
		const enqueuedAt = Date.now();

		if (request.signal?.aborted) {
			return Promise.reject(
				new SchedulerError('CANCELLED', requestId, 'Request was aborted before it reached scheduler.')
			);
		}

		return new Promise<CommandResult<TReply>>((resolve, reject) => {
			const item: ScheduledItem<TReply> =
				request.kind === 'chunked'
					? {
							requestId,
							lane,
							timeoutMs,
							idempotent,
							enqueuedAt,
							externalSignal: request.signal,
							mode: 'chunked',
							retryPolicy,
							executeChunk: request.executeChunk,
							resolve,
							reject
					}
					: {
							requestId,
							lane,
							timeoutMs,
							idempotent,
							enqueuedAt,
							externalSignal: request.signal,
							mode: 'single',
							retryPolicy,
							executeSingle: request.execute,
							resolve,
							reject
					};

			if (request.signal) {
				const onAbort = () => {
					if (this.inFlight === (item as ScheduledItem<unknown>)) {
						return;
					}

					const removed = this.removeFromQueues(item as ScheduledItem<unknown>);
					if (removed) {
						item.removeQueuedAbortListener?.();
						reject(
							new SchedulerError(
								'CANCELLED',
								requestId,
								'Request was aborted while waiting in scheduler queue.'
							)
						);
					}
				};

				request.signal.addEventListener('abort', onAbort, { once: true });
				item.removeQueuedAbortListener = () => request.signal?.removeEventListener('abort', onAbort);
			}

			this.queues[lane].push(item as ScheduledItem<unknown>);
			this.logger.debug('Request enqueued', {
				requestId,
				lane,
				timeoutMs,
				idempotent,
				mode: item.mode,
				maxRetries: retryPolicy.maxRetries,
				queueSize: this.getQueueSize()
			});

			this.scheduleProcess();
		});
	}

	public dispose(): void {
		if (this.state === 'disposed') {
			return;
		}

		this.state = 'disposed';
		this.inFlightAbortController?.abort(new Error('scheduler-disposed'));
		this.rejectAllQueued('DISPOSED', 'Scheduler disposed before request execution.');
	}

	private nextRequestId(): string {
		this.requestSeq += 1;
		return `req-${this.requestSeq}`;
	}

	private scheduleProcess(): void {
		if (this.processScheduled || this.state === 'disposed' || this.state === 'orphan-risk') {
			return;
		}

		this.processScheduled = true;
		queueMicrotask(() => {
			this.processScheduled = false;
			void this.processNext();
		});
	}

	private async processNext(): Promise<void> {
		if (this.state === 'disposed' || this.state === 'orphan-risk' || this.inFlight) {
			return;
		}

		const item = this.dequeueNext();
		if (!item) {
			this.state = 'idle';
			return;
		}

		item.removeQueuedAbortListener?.();
		this.inFlight = item;
		this.state = 'running';
		item.startedAt = Date.now();

		let status: RunStatus;
		if (item.mode === 'chunked') {
			status = await this.runChunked(item);
		} else {
			status = await this.runSingle(item);
		}

		this.finishInFlight();
		if (status === 'preempted') {
			this.scheduleProcess();
		}
	}

	private async runSingle(item: ScheduledItem<unknown>): Promise<RunStatus> {
		if (!item.executeSingle) {
			this.rejectOutcome(item, {
				ok: false,
				code: 'EXECUTION_FAILED',
				message: 'Single request missing execute function.'
			});
			return 'failed';
		}

		const outcome = await this.executeWithRetry(item, item.executeSingle);
		if (!outcome.ok) {
			this.rejectOutcome(item, outcome);
			return 'failed';
		}

		const finishedAt = Date.now();
		item.resolve({
			requestId: item.requestId,
			messageCounter: outcome.messageCounter,
			reply: outcome.reply,
			enqueuedAt: item.enqueuedAt,
			startedAt: item.startedAt ?? finishedAt,
			finishedAt,
			durationMs: finishedAt - (item.startedAt ?? finishedAt)
		});

		this.logger.debug('Request executed', {
			requestId: item.requestId,
			lane: item.lane,
			mode: item.mode,
			messageCounter: outcome.messageCounter,
			durationMs: finishedAt - (item.startedAt ?? finishedAt)
		});
		return 'completed';
	}

	private async runChunked(item: ScheduledItem<unknown>): Promise<RunStatus> {
		if (!item.executeChunk) {
			this.rejectOutcome(item, {
				ok: false,
				code: 'EXECUTION_FAILED',
				message: 'Chunked request missing executeChunk function.'
			});
			return 'failed';
		}

		let chunkIndex = 0;
		while (chunkIndex < Number.MAX_SAFE_INTEGER) {
			chunkIndex += 1;
			const outcome = await this.executeWithRetry(item, item.executeChunk);
			if (!outcome.ok) {
				this.rejectOutcome(item, outcome);
				return 'failed';
			}

			if (outcome.reply.done) {
				const finishedAt = Date.now();
				item.resolve({
					requestId: item.requestId,
					messageCounter: outcome.messageCounter,
					reply: outcome.reply.reply,
					enqueuedAt: item.enqueuedAt,
					startedAt: item.startedAt ?? finishedAt,
					finishedAt,
					durationMs: finishedAt - (item.startedAt ?? finishedAt)
				});

				this.logger.debug('Chunked request completed', {
					requestId: item.requestId,
					lane: item.lane,
					chunks: chunkIndex,
					messageCounter: outcome.messageCounter,
					durationMs: finishedAt - (item.startedAt ?? finishedAt)
				});
				return 'completed';
			}

			if (this.shouldPreemptForEmergency(item.lane)) {
				this.requeueFront(item);
				this.logger.info('Chunked request preempted for emergency lane', {
					requestId: item.requestId,
					lane: item.lane,
					chunkIndex
				});
				return 'preempted';
			}
		}

		this.rejectOutcome(item, {
			ok: false,
			code: 'EXECUTION_FAILED',
			message: 'Chunked request exceeded internal safety iteration limit.'
		});
		return 'failed';
	}

	private async executeWithRetry<TReply>(
		item: ScheduledItem<unknown>,
		operation: (ctx: CommandExecutionContext) => Promise<TReply>
	): Promise<InvocationOutcome<TReply>> {
		let attempt = 0;
		while (attempt <= item.retryPolicy.maxRetries) {
			const outcome = await this.invokeItemOperation(item, operation);
			if (outcome.ok) {
				return outcome;
			}

			if (outcome.orphanRiskReason) {
				await this.enterOrphanRisk(item, outcome.orphanRiskReason, outcome.error);
			}

			if (!this.shouldRetry(item, outcome, attempt)) {
				return outcome;
			}

			const delayMs = this.computeRetryDelay(item.retryPolicy, attempt);
			this.logger.warn('Retrying request operation', {
				requestId: item.requestId,
				lane: item.lane,
				attempt: attempt + 1,
				maxRetries: item.retryPolicy.maxRetries,
				delayMs,
				code: outcome.code
			});
			if (delayMs > 0) {
				await this.sleep(delayMs);
			}
			attempt += 1;
		}

		return {
			ok: false,
			code: 'EXECUTION_FAILED',
			message: 'Request exceeded retry attempts.'
		};
	}

	private async invokeItemOperation<TReply>(
		item: ScheduledItem<unknown>,
		operation: (ctx: CommandExecutionContext) => Promise<TReply>
	): Promise<InvocationOutcome<TReply>> {
		let messageCounter: number;
		try {
			messageCounter = this.messageCounter.allocate();
		} catch (error) {
			return {
				ok: false,
				code: 'COUNTER_EXHAUSTED',
				message: 'Unable to allocate messageCounter for request.',
				error
			};
		}

		const abortController = new AbortController();
		this.inFlightAbortController = abortController;
		const detachExternalAbort = this.linkExternalAbort(item.externalSignal, abortController);
		let timeoutTriggered = false;
		const timeoutHandle = setTimeout(() => {
			timeoutTriggered = true;
			abortController.abort(new Error('scheduler-timeout'));
		}, item.timeoutMs);

		try {
			const reply = await operation({
				messageCounter,
				timeoutMs: item.timeoutMs,
				signal: abortController.signal,
				enqueuedAt: item.enqueuedAt
			});

			if (abortController.signal.aborted) {
				throw new Error('request-aborted-after-execute');
			}

			return {
				ok: true,
				reply,
				messageCounter
			};
		} catch (error) {
			if (this.state === 'disposed') {
				return {
					ok: false,
					code: 'DISPOSED',
					message: 'Scheduler disposed during request execution.',
					error
				};
			}

			if (timeoutTriggered) {
				return {
					ok: false,
					code: 'TIMEOUT',
					message: `Request timed out after ${item.timeoutMs}ms.`,
					error,
					orphanRiskReason: 'timeout'
				};
			}

			if (abortController.signal.aborted) {
				return {
					ok: false,
					code: 'CANCELLED',
					message: 'Request execution cancelled.',
					error,
					orphanRiskReason: 'cancelled'
				};
			}

			return {
				ok: false,
				code: 'EXECUTION_FAILED',
				message: error instanceof Error ? `Request execution failed: ${error.message}` : 'Request execution failed.',
				error
			};
		} finally {
			clearTimeout(timeoutHandle);
			detachExternalAbort();
			this.messageCounter.release(messageCounter);
		}
	}

	private rejectOutcome(item: ScheduledItem<unknown>, outcome: Extract<InvocationOutcome<unknown>, { ok: false }>): void {
		const error = new SchedulerError(
			outcome.code,
			item.requestId,
			outcome.message ?? 'Scheduler request failed.',
			outcome.error
		);
		item.reject(error);

		this.logger.warn('Request failed', {
			requestId: item.requestId,
			lane: item.lane,
			mode: item.mode,
			code: outcome.code
		});
	}

	private async enterOrphanRisk(
		item: ScheduledItem<unknown>,
		reason: OrphanRiskReason,
		error: unknown
	): Promise<void> {
		if (this.state === 'disposed') {
			return;
		}

		this.state = 'orphan-risk';
		this.rejectQueuedLowerPriority(item.lane, item.requestId);

		if (!this.recoveryPromise) {
			this.recoveryPromise = (async () => {
				await this.orphanRecoveryStrategy.recover({
					requestId: item.requestId,
					lane: item.lane,
					reason,
					error
				});
			})();
		}

		try {
			await this.recoveryPromise;
			this.logger.info('Orphan-risk recovery completed', {
				requestId: item.requestId,
				reason
			});
		} catch (recoveryError) {
			this.logger.error('Orphan-risk recovery failed', {
				requestId: item.requestId,
				reason,
				error: String(recoveryError)
			});
			this.rejectAllQueued(
				'ORPHAN_RISK',
				`Scheduler recovery failed after ${reason}; pending requests were dropped.`
			);
		} finally {
			this.recoveryPromise = undefined;
			if (!this.isDisposed()) {
				this.state = 'idle';
			}
		}
	}

	private rejectQueuedLowerPriority(failedLane: Lane, requestId: string): void {
		const failedPriority = LANE_PRIORITY.indexOf(failedLane);
		for (let i = failedPriority + 1; i < LANE_PRIORITY.length; i++) {
			const lane = LANE_PRIORITY[i];
			const queue = this.queues[lane];
			while (queue.length > 0) {
				const queued = queue.shift();
				if (!queued) {
					break;
				}
				queued.removeQueuedAbortListener?.();
				queued.reject(
					new SchedulerError(
						'ORPHAN_RISK',
						queued.requestId,
						`Dropped because scheduler entered orphan-risk after request ${requestId}.`
					)
				);
			}
		}
	}

	private rejectAllQueued(code: SchedulerErrorCode, message: string): void {
		for (const lane of LANE_PRIORITY) {
			const queue = this.queues[lane];
			while (queue.length > 0) {
				const item = queue.shift();
				if (!item) {
					break;
				}
				item.removeQueuedAbortListener?.();
				item.reject(new SchedulerError(code, item.requestId, message));
			}
		}
	}

	private shouldPreemptForEmergency(currentLane: Lane): boolean {
		return currentLane !== 'emergency' && this.queues.emergency.length > 0;
	}

	private requeueFront(item: ScheduledItem<unknown>): void {
		this.queues[item.lane].unshift(item);
	}

	private finishInFlight(): void {
		this.inFlight = undefined;
		this.inFlightAbortController = undefined;
		if (this.state === 'running') {
			this.state = 'idle';
			this.scheduleProcess();
		}
	}

	private dequeueNext(): ScheduledItem<unknown> | undefined {
		for (const lane of LANE_PRIORITY) {
			const next = this.queues[lane].shift();
			if (next) {
				return next;
			}
		}

		return undefined;
	}

	private removeFromQueues(item: ScheduledItem<unknown>): boolean {
		for (const lane of LANE_PRIORITY) {
			const queue = this.queues[lane];
			const index = queue.indexOf(item);
			if (index >= 0) {
				queue.splice(index, 1);
				return true;
			}
		}
		return false;
	}

	private linkExternalAbort(signal: AbortSignal | undefined, target: AbortController): () => void {
		if (!signal) {
			return () => undefined;
		}

		if (signal.aborted) {
			target.abort(signal.reason);
			return () => undefined;
		}

		const onAbort = () => {
			target.abort(signal.reason);
		};

		signal.addEventListener('abort', onAbort, { once: true });
		return () => signal.removeEventListener('abort', onAbort);
	}

	private shouldRetry(
		item: ScheduledItem<unknown>,
		outcome: Extract<InvocationOutcome<unknown>, { ok: false }>,
		attempt: number
	): boolean {
		if (!item.idempotent) {
			return false;
		}
		if (attempt >= item.retryPolicy.maxRetries) {
			return false;
		}
		if (this.isDisposed()) {
			return false;
		}
		return item.retryPolicy.retryOn.has(outcome.code);
	}

	private computeRetryDelay(policy: NormalizedRetryPolicy, attempt: number): number {
		const scaled = policy.initialBackoffMs * Math.pow(policy.backoffFactor, attempt);
		const bounded = Math.min(policy.maxBackoffMs, scaled);
		return Math.max(0, Math.floor(bounded));
	}

	private normalizeRetryPolicy(retry?: RetryPolicy): NormalizedRetryPolicy {
		const base = this.defaultRetryPolicy ?? {
			maxRetries: 0,
			initialBackoffMs: DEFAULT_INITIAL_BACKOFF_MS,
			backoffFactor: DEFAULT_BACKOFF_FACTOR,
			maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
			retryOn: new Set<SchedulerErrorCode>(DEFAULT_RETRYABLE_CODES)
		};

		const maxRetries = Math.max(0, retry?.maxRetries ?? base.maxRetries);
		const initialBackoffMs = Math.max(0, retry?.initialBackoffMs ?? base.initialBackoffMs);
		const backoffFactor = Math.max(1, retry?.backoffFactor ?? base.backoffFactor);
		const maxBackoffMs = Math.max(initialBackoffMs, retry?.maxBackoffMs ?? base.maxBackoffMs);
		const retryOn = new Set<SchedulerErrorCode>(retry?.retryOn ?? Array.from(base.retryOn));

		return {
			maxRetries,
			initialBackoffMs,
			backoffFactor,
			maxBackoffMs,
			retryOn
		};
	}

	private async sleep(ms: number): Promise<void> {
		if (ms <= 0) {
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, ms));
	}

	private isDisposed(): boolean {
		return this.state === 'disposed';
	}
}
