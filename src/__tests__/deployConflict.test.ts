import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDeployConflictDecision } from '../fs/deployConflict';

test('deployConflict overwrite policy always overwrites', () => {
	const resolved = resolveDeployConflictDecision({
		policy: 'overwrite',
		bulkDecision: 'skip',
		promptChoice: 'Skip All'
	});
	assert.equal(resolved.decision, 'overwrite');
	assert.equal(resolved.nextBulkDecision, 'skip');
});

test('deployConflict skip policy always skips', () => {
	const resolved = resolveDeployConflictDecision({
		policy: 'skip',
		bulkDecision: 'overwrite',
		promptChoice: 'Overwrite All'
	});
	assert.equal(resolved.decision, 'skip');
	assert.equal(resolved.nextBulkDecision, 'overwrite');
});

test('deployConflict ask policy respects existing bulk decision', () => {
	const resolved = resolveDeployConflictDecision({
		policy: 'ask',
		bulkDecision: 'overwrite'
	});
	assert.equal(resolved.decision, 'overwrite');
	assert.equal(resolved.nextBulkDecision, 'overwrite');
});

test('deployConflict ask policy maps prompt choice and updates bulk decision', () => {
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: 'ask',
			promptChoice: 'Overwrite'
		}),
		{
			decision: 'overwrite'
		}
	);
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: 'ask',
			promptChoice: 'Overwrite All'
		}),
		{
			decision: 'overwrite',
			nextBulkDecision: 'overwrite'
		}
	);
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: 'ask',
			promptChoice: 'Skip'
		}),
		{
			decision: 'skip'
		}
	);
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: 'ask',
			promptChoice: 'Skip All'
		}),
		{
			decision: 'skip',
			nextBulkDecision: 'skip'
		}
	);
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: 'ask'
		}),
		{
			decision: 'skip'
		}
	);
});

