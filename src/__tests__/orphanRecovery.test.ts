import assert from 'node:assert/strict';
import test from 'node:test';
import { NoopOrphanRecoveryStrategy } from '../scheduler/orphanRecovery';

test('NoopOrphanRecoveryStrategy recover resolves without side effects', async () => {
	const strategy = new NoopOrphanRecoveryStrategy();
	await assert.doesNotReject(async () => {
		await strategy.recover({
			requestId: 'req-1',
			lane: 'high',
			reason: 'timeout'
		});
	});
});
