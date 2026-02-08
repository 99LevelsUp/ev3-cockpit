import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { SchedulerError } from '../scheduler/types';
import { OrphanRecoveryContext, OrphanRecoveryStrategy } from '../scheduler/orphanRecovery';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test('CommandScheduler executes by lane priority', async () => {
	const scheduler = new CommandScheduler();
	const startOrder: string[] = [];

	const pNormal = scheduler.enqueue({
		id: 'normal-1',
		lane: 'normal',
		execute: async () => {
			startOrder.push('normal-1');
			return 'normal-1';
		}
	});

	const pEmergency = scheduler.enqueue({
		id: 'emergency-1',
		lane: 'emergency',
		execute: async () => {
			startOrder.push('emergency-1');
			return 'emergency-1';
		}
	});

	const pLow = scheduler.enqueue({
		id: 'low-1',
		lane: 'low',
		execute: async () => {
			startOrder.push('low-1');
			return 'low-1';
		}
	});

	await Promise.all([pNormal, pEmergency, pLow]);
	assert.deepEqual(startOrder, ['emergency-1', 'normal-1', 'low-1']);
	scheduler.dispose();
});

test('CommandScheduler enforces max in-flight = 1', async () => {
	const scheduler = new CommandScheduler();
	let inFlight = 0;
	let maxInFlight = 0;

	const makeRequest = (id: string) =>
		scheduler.enqueue({
			id,
			lane: 'normal',
			execute: async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await sleep(25);
				inFlight -= 1;
				return id;
			}
		});

	await Promise.all([makeRequest('a'), makeRequest('b'), makeRequest('c')]);
	assert.equal(maxInFlight, 1);
	scheduler.dispose();
});

test('CommandScheduler times out request and rejects with SchedulerError(TIMEOUT)', async () => {
	const scheduler = new CommandScheduler({ defaultTimeoutMs: 30 });

	const failingPromise = scheduler.enqueue({
		id: 'timeout-1',
		lane: 'normal',
		execute: async ({ signal }) =>
			new Promise<never>((_resolve, reject) => {
				const onAbort = () => reject(new Error('aborted'));
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener('abort', onAbort, { once: true });
			})
	});

	await assert.rejects(failingPromise, (error: unknown) => {
		assert.ok(error instanceof SchedulerError);
		assert.equal(error.code, 'TIMEOUT');
		assert.equal(error.requestId, 'timeout-1');
		return true;
	});

	scheduler.dispose();
});

test('CommandScheduler rejects queued request cancelled before execution', async () => {
	const scheduler = new CommandScheduler();
	const controller = new AbortController();

	const blocker = scheduler.enqueue({
		id: 'blocker',
		lane: 'normal',
		execute: async () => {
			await sleep(40);
			return 'blocker';
		}
	});

	const cancelled = scheduler.enqueue({
		id: 'cancelled-queued',
		lane: 'normal',
		signal: controller.signal,
		execute: async () => 'should-not-run'
	});

	const cancelledAssertion = assert.rejects(cancelled, (error: unknown) => {
		assert.ok(error instanceof SchedulerError);
		assert.equal(error.code, 'CANCELLED');
		assert.equal(error.requestId, 'cancelled-queued');
		return true;
	});

	controller.abort();
	await blocker;
	await cancelledAssertion;

	scheduler.dispose();
});

test('CommandScheduler preempts chunked low lane request for emergency lane', async () => {
	const scheduler = new CommandScheduler();
	const events: string[] = [];
	let emergencyPromise: Promise<unknown> | undefined;
	let chunk = 0;

	const chunkedLow = scheduler.enqueue({
		id: 'chunked-low',
		lane: 'low',
		kind: 'chunked',
		executeChunk: async () => {
			chunk += 1;
			events.push(`chunk-${chunk}`);
			if (chunk === 1) {
				emergencyPromise = scheduler.enqueue({
					id: 'emergency-stop',
					lane: 'emergency',
					execute: async () => {
						events.push('emergency');
						return 'stopped';
					}
				});
			}

			await sleep(5);
			if (chunk >= 3) {
				return { done: true, reply: 'low-done' } as const;
			}
			return { done: false } as const;
		}
	});

	const lowResult = await chunkedLow;
	if (emergencyPromise) {
		await emergencyPromise;
	}

	assert.equal(lowResult.reply, 'low-done');
	assert.deepEqual(events, ['chunk-1', 'emergency', 'chunk-2', 'chunk-3']);
	scheduler.dispose();
});

test('CommandScheduler runs newly queued high lane before older normal lane after in-flight low completes', async () => {
	const scheduler = new CommandScheduler();
	const events: string[] = [];
	let releaseLow: (() => void) | undefined;
	let notifyLowStarted: (() => void) | undefined;
	const lowGate = new Promise<void>((resolve) => {
		releaseLow = resolve;
	});
	const lowStarted = new Promise<void>((resolve) => {
		notifyLowStarted = resolve;
	});

	const lowRequest = scheduler.enqueue({
		id: 'low-blocking',
		lane: 'low',
		execute: async () => {
			events.push('low-start');
			notifyLowStarted?.();
			await lowGate;
			events.push('low-end');
			return 'low';
		}
	});

	await lowStarted;

	const normalRequest = scheduler.enqueue({
		id: 'normal-queued-first',
		lane: 'normal',
		execute: async () => {
			events.push('normal');
			return 'normal';
		}
	});

	const highRequest = scheduler.enqueue({
		id: 'high-queued-later',
		lane: 'high',
		execute: async () => {
			events.push('high');
			return 'high';
		}
	});

	releaseLow?.();
	await Promise.all([lowRequest, normalRequest, highRequest]);
	assert.deepEqual(events, ['low-start', 'low-end', 'high', 'normal']);
	scheduler.dispose();
});

test('CommandScheduler handles chunked preemption with emergency and pending high interference', async () => {
	const scheduler = new CommandScheduler();
	const events: string[] = [];
	let emergencyPromise: Promise<unknown> | undefined;
	let highPromise: Promise<unknown> | undefined;
	let chunk = 0;

	const chunkedLow = scheduler.enqueue({
		id: 'chunked-low-interference',
		lane: 'low',
		kind: 'chunked',
		executeChunk: async () => {
			chunk += 1;
			events.push(`low-chunk-${chunk}`);
			if (chunk === 1) {
				emergencyPromise = scheduler.enqueue({
					id: 'emergency-interference',
					lane: 'emergency',
					execute: async () => {
						events.push('emergency');
						return 'emergency-ok';
					}
				});
				highPromise = scheduler.enqueue({
					id: 'high-interference',
					lane: 'high',
					execute: async () => {
						events.push('high');
						return 'high-ok';
					}
				});
			}

			await sleep(5);
			if (chunk >= 3) {
				return { done: true, reply: 'low-done' } as const;
			}
			return { done: false } as const;
		}
	});

	const lowResult = await chunkedLow;
	if (emergencyPromise) {
		await emergencyPromise;
	}
	if (highPromise) {
		await highPromise;
	}

	assert.equal(lowResult.reply, 'low-done');
	assert.deepEqual(events, ['low-chunk-1', 'emergency', 'high', 'low-chunk-2', 'low-chunk-3']);
	scheduler.dispose();
});

test('CommandScheduler enters orphan-risk on timeout, drops lower lanes, keeps higher lanes', async () => {
	class RecoveryProbe implements OrphanRecoveryStrategy {
		public readonly calls: OrphanRecoveryContext[] = [];

		public async recover(context: OrphanRecoveryContext): Promise<void> {
			this.calls.push(context);
			await sleep(10);
		}
	}

	const recovery = new RecoveryProbe();
	const scheduler = new CommandScheduler({
		defaultTimeoutMs: 25,
		orphanRecoveryStrategy: recovery
	});

	const timeoutRequest = scheduler.enqueue({
		id: 'timeout-normal',
		lane: 'normal',
		execute: async ({ signal }) =>
			new Promise<never>((_resolve, reject) => {
				const onAbort = () => reject(new Error('aborted'));
				signal.addEventListener('abort', onAbort, { once: true });
			})
	});

	const highRequest = scheduler.enqueue({
		id: 'high-survives',
		lane: 'high',
		execute: async () => 'high-ok'
	});

	const lowRequest = scheduler.enqueue({
		id: 'low-dropped',
		lane: 'low',
		execute: async () => 'low-should-not-run'
	});

	const timeoutAssertion = assert.rejects(timeoutRequest, (error: unknown) => {
		assert.ok(error instanceof SchedulerError);
		assert.equal(error.code, 'TIMEOUT');
		assert.equal(error.requestId, 'timeout-normal');
		return true;
	});

	const lowAssertion = assert.rejects(lowRequest, (error: unknown) => {
		assert.ok(error instanceof SchedulerError);
		assert.equal(error.code, 'ORPHAN_RISK');
		assert.equal(error.requestId, 'low-dropped');
		return true;
	});

	await timeoutAssertion;
	await lowAssertion;
	const highResult = await highRequest;

	assert.equal(highResult.reply, 'high-ok');
	assert.equal(recovery.calls.length, 1);
	assert.equal(recovery.calls[0].requestId, 'timeout-normal');
	assert.equal(recovery.calls[0].reason, 'timeout');
	scheduler.dispose();
});

test('CommandScheduler retries idempotent request with backoff and then succeeds', async () => {
	const scheduler = new CommandScheduler();
	let attempts = 0;

	const result = await scheduler.enqueue({
		id: 'retry-idempotent',
		lane: 'normal',
		idempotent: true,
		retry: {
			maxRetries: 2,
			initialBackoffMs: 1,
			backoffFactor: 1
		},
		execute: async () => {
			attempts += 1;
			if (attempts < 3) {
				throw new Error('transient failure');
			}
			return 'ok';
		}
	});

	assert.equal(result.reply, 'ok');
	assert.equal(attempts, 3);
	scheduler.dispose();
});

test('CommandScheduler does not retry non-idempotent request', async () => {
	const scheduler = new CommandScheduler();
	let attempts = 0;

	const failingPromise = scheduler.enqueue({
		id: 'retry-non-idempotent',
		lane: 'normal',
		idempotent: false,
		retry: {
			maxRetries: 3,
			initialBackoffMs: 1,
			backoffFactor: 1
		},
		execute: async () => {
			attempts += 1;
			throw new Error('always fail');
		}
	});

	await assert.rejects(failingPromise, (error: unknown) => {
		assert.ok(error instanceof SchedulerError);
		assert.equal(error.code, 'EXECUTION_FAILED');
		assert.equal(error.requestId, 'retry-non-idempotent');
		return true;
	});

	assert.equal(attempts, 1);
	scheduler.dispose();
});

test('CommandScheduler respects retryOn filter for idempotent requests', async () => {
	const scheduler = new CommandScheduler();
	let attempts = 0;

	const failingPromise = scheduler.enqueue({
		id: 'retry-filter-timeout',
		lane: 'normal',
		idempotent: true,
		timeoutMs: 20,
		retry: {
			maxRetries: 3,
			initialBackoffMs: 1,
			backoffFactor: 1,
			retryOn: ['EXECUTION_FAILED']
		},
		execute: async ({ signal }) =>
			new Promise<never>((_resolve, reject) => {
				attempts += 1;
				const onAbort = () => reject(new Error('aborted'));
				signal.addEventListener('abort', onAbort, { once: true });
			})
	});

	await assert.rejects(failingPromise, (error: unknown) => {
		assert.ok(error instanceof SchedulerError);
		assert.equal(error.code, 'TIMEOUT');
		assert.equal(error.requestId, 'retry-filter-timeout');
		return true;
	});

	assert.equal(attempts, 1);
	scheduler.dispose();
});

test('CommandScheduler applies defaultRetryPolicy from constructor', async () => {
	const scheduler = new CommandScheduler({
		defaultRetryPolicy: {
			maxRetries: 2,
			initialBackoffMs: 1,
			backoffFactor: 1,
			retryOn: ['EXECUTION_FAILED']
		}
	});

	let attempts = 0;
	const result = await scheduler.enqueue({
		id: 'retry-default-policy',
		lane: 'normal',
		idempotent: true,
		execute: async () => {
			attempts += 1;
			if (attempts < 3) {
				throw new Error('transient');
			}
			return 'ok';
		}
	});

	assert.equal(result.reply, 'ok');
	assert.equal(attempts, 3);
	scheduler.dispose();
});
