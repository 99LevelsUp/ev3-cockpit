import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isPerfEnabled,
	nextCorrelationId,
	withTimingSync,
	withTiming
} from '../diagnostics/perfTiming.js';
import type { Logger } from '../diagnostics/logger';

function createMockLogger(): Logger & {
	logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }>;
} {
	const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
	return {
		logs,
		error: (message, meta) => logs.push({ level: 'error', message, meta }),
		warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
		info: (message, meta) => logs.push({ level: 'info', message, meta }),
		debug: (message, meta) => logs.push({ level: 'debug', message, meta }),
		trace: (message, meta) => logs.push({ level: 'trace', message, meta })
	};
}

test('nextCorrelationId generates unique IDs', () => {
	const id1 = nextCorrelationId();
	const id2 = nextCorrelationId();
	const id3 = nextCorrelationId();

	assert.notEqual(id1, id2);
	assert.notEqual(id2, id3);
	assert.notEqual(id1, id3);

	assert.ok(id1.startsWith('perf-'));
	assert.ok(id2.startsWith('perf-'));
	assert.ok(id3.startsWith('perf-'));
});

test('withTimingSync executes function and returns result', () => {
	const logger = createMockLogger();
	const result = withTimingSync(logger, 'test-step', () => 42);

	assert.equal(result, 42);
});

test('withTimingSync logs timing information when perf is enabled', () => {
	if (!isPerfEnabled()) {
		return; // Skip test if performance monitoring is disabled
	}

	const logger = createMockLogger();
	withTimingSync(logger, 'test-step', () => 42);

	assert.equal(logger.logs.length, 1);
	const log = logger.logs[0];
	assert.equal(log.level, 'info');
	assert.ok(log.message.includes('test-step'));
	assert.ok(log.meta?.durationMs !== undefined);
	assert.ok(typeof log.meta?.durationMs === 'number');
	assert.ok((log.meta?.durationMs as number) >= 0);
});

test('withTimingSync includes correlation ID in metadata', () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	const correlationId = 'test-correlation-123';
	withTimingSync(logger, 'test-step', () => 42, { correlationId });

	const log = logger.logs[0];
	assert.equal(log.meta?.correlationId, correlationId);
});

test('withTimingSync includes custom metadata', () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	withTimingSync(logger, 'test-step', () => 42, { brickId: 'usb-123', port: 'A' });

	const log = logger.logs[0];
	assert.equal(log.meta?.brickId, 'usb-123');
	assert.equal(log.meta?.port, 'A');
});

test('withTimingSync handles errors and logs warning', () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	const error = new Error('Test error');

	assert.throws(() => {
		withTimingSync(logger, 'failing-step', () => {
			throw error;
		});
	}, error);

	assert.equal(logger.logs.length, 1);
	const log = logger.logs[0];
	assert.equal(log.level, 'warn');
	assert.ok(log.message.includes('failing-step'));
	assert.ok(log.message.includes('failed'));
	assert.equal(log.meta?.error, 'Test error');
	assert.ok(log.meta?.durationMs !== undefined);
});

test('withTimingSync handles non-Error exceptions', () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();

	assert.throws(() => {
		withTimingSync(logger, 'failing-step', () => {
			throw 'string error';
		});
	}, /string error/);

	const log = logger.logs[0];
	assert.equal(log.level, 'warn');
	assert.equal(log.meta?.error, 'string error');
});

test('withTiming executes async function and returns result', async () => {
	const logger = createMockLogger();
	const result = await withTiming(logger, 'test-step', async () => 42);

	assert.equal(result, 42);
});

test('withTiming logs timing information when perf is enabled', async () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	await withTiming(logger, 'async-step', async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		return 'done';
	});

	assert.equal(logger.logs.length, 1);
	const log = logger.logs[0];
	assert.equal(log.level, 'info');
	assert.ok(log.message.includes('async-step'));
	assert.ok(log.meta?.durationMs !== undefined);
	assert.ok((log.meta?.durationMs as number) >= 10);
});

test('withTiming includes correlation ID in metadata', async () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	const correlationId = 'async-correlation-456';
	await withTiming(logger, 'async-step', async () => 'done', { correlationId });

	const log = logger.logs[0];
	assert.equal(log.meta?.correlationId, correlationId);
});

test('withTiming includes custom metadata', async () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	await withTiming(logger, 'async-step', async () => 'done', { operation: 'deploy' });

	const log = logger.logs[0];
	assert.equal(log.meta?.operation, 'deploy');
});

test('withTiming handles async errors and logs warning', async () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	const error = new Error('Async error');

	await assert.rejects(
		async () => {
			await withTiming(logger, 'failing-async-step', async () => {
				throw error;
			});
		},
		error
	);

	assert.equal(logger.logs.length, 1);
	const log = logger.logs[0];
	assert.equal(log.level, 'warn');
	assert.ok(log.message.includes('failing-async-step'));
	assert.ok(log.message.includes('failed'));
	assert.equal(log.meta?.error, 'Async error');
});

test('withTiming handles rejected promises', async () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();

	await assert.rejects(
		async () => {
			await withTiming(logger, 'rejected-step', async () => {
				return Promise.reject(new Error('Promise rejected'));
			});
		},
		/Promise rejected/
	);

	const log = logger.logs[0];
	assert.equal(log.level, 'warn');
	assert.equal(log.meta?.error, 'Promise rejected');
});

test('withTimingSync skips logging when perf is disabled', () => {
	if (isPerfEnabled()) {
		return; // Skip test if performance monitoring is enabled
	}

	const logger = createMockLogger();
	const result = withTimingSync(logger, 'test-step', () => 42);

	assert.equal(result, 42);
	assert.equal(logger.logs.length, 0); // No logs when perf is disabled
});

test('withTiming skips logging when perf is disabled', async () => {
	if (isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	const result = await withTiming(logger, 'async-step', async () => 'done');

	assert.equal(result, 'done');
	assert.equal(logger.logs.length, 0); // No logs when perf is disabled
});

test('withTimingSync handles function that returns undefined', () => {
	const logger = createMockLogger();
	const result = withTimingSync(logger, 'void-step', () => undefined);

	assert.equal(result, undefined);
});

test('withTiming handles async function that returns undefined', async () => {
	const logger = createMockLogger();
	const result = await withTiming(logger, 'async-void-step', async () => undefined);

	assert.equal(result, undefined);
});

test('withTimingSync handles function returning complex objects', () => {
	const logger = createMockLogger();
	const complexObj = { data: [1, 2, 3], nested: { value: 'test' } };
	const result = withTimingSync(logger, 'complex-step', () => complexObj);

	assert.deepEqual(result, complexObj);
	assert.strictEqual(result, complexObj); // Same reference
});

test('withTiming handles async function returning complex objects', async () => {
	const logger = createMockLogger();
	const complexObj = { data: [1, 2, 3], nested: { value: 'test' } };
	const result = await withTiming(logger, 'async-complex-step', async () => complexObj);

	assert.deepEqual(result, complexObj);
	assert.strictEqual(result, complexObj); // Same reference
});

test('correlation ID is generated automatically if not provided', () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	withTimingSync(logger, 'auto-correlation-step', () => 42);

	const log = logger.logs[0];
	assert.ok(log.meta?.correlationId);
	assert.ok(typeof log.meta?.correlationId === 'string');
	assert.ok((log.meta?.correlationId as string).startsWith('perf-'));
});

test('withTimingSync preserves metadata when generating correlation ID', () => {
	if (!isPerfEnabled()) {
		return;
	}

	const logger = createMockLogger();
	withTimingSync(logger, 'step', () => 42, { customField: 'value' });

	const log = logger.logs[0];
	assert.equal(log.meta?.customField, 'value');
	assert.ok(log.meta?.correlationId); // Generated automatically
});
