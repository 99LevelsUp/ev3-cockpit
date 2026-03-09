import assert from 'node:assert/strict';
import test from 'node:test';
import type { Logger } from '../diagnostics/logger.js';
import { createFlowLogger } from '../diagnostics/flowLogger.js';

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

test('createFlowLogger emits structured lifecycle logs', () => {
	const logger = createMockLogger();
	const flow = createFlowLogger(logger, 'deploy.project', { correlationId: 'corr-1', brickId: 'tcp-a' });

	flow.started({ previewOnly: true });
	flow.completed({ filesUploaded: 3 });
	flow.cancelled();
	flow.failed(new Error('boom'), { step: 'verify' });
	flow.debug('retrying', { attempt: 2 });

	assert.equal(logger.logs.length, 5);
	assert.deepEqual(
		logger.logs.map((entry) => entry.message),
		[
			'deploy.project started',
			'deploy.project completed',
			'deploy.project cancelled',
			'deploy.project failed',
			'deploy.project retrying'
		]
	);
	assert.equal(logger.logs[0]?.meta?.flow, 'deploy.project');
	assert.equal(logger.logs[0]?.meta?.correlationId, 'corr-1');
	assert.equal(logger.logs[0]?.meta?.brickId, 'tcp-a');
	assert.equal(logger.logs[0]?.meta?.previewOnly, true);
	assert.equal(logger.logs[3]?.meta?.error, 'boom');
	assert.equal(logger.logs[4]?.meta?.attempt, 2);
});

