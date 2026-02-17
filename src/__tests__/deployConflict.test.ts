import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDeployConflictDecision } from '../fs/deployConflict';
import { DeployConflictPolicy, DeployConflictDecision } from '../types/enums';

test('deployConflict overwrite policy always overwrites', () => {
	const resolved = resolveDeployConflictDecision({
		policy: DeployConflictPolicy.OVERWRITE,
		bulkDecision: DeployConflictDecision.SKIP,
		promptChoice: 'Skip All'
	});
	assert.equal(resolved.decision, DeployConflictDecision.OVERWRITE);
	assert.equal(resolved.nextBulkDecision, DeployConflictDecision.SKIP);
});

test('deployConflict skip policy always skips', () => {
	const resolved = resolveDeployConflictDecision({
		policy: DeployConflictPolicy.SKIP,
		bulkDecision: DeployConflictDecision.OVERWRITE,
		promptChoice: 'Overwrite All'
	});
	assert.equal(resolved.decision, DeployConflictDecision.SKIP);
	assert.equal(resolved.nextBulkDecision, DeployConflictDecision.OVERWRITE);
});

test('deployConflict ask policy respects existing bulk decision', () => {
	const resolved = resolveDeployConflictDecision({
		policy: DeployConflictPolicy.ASK,
		bulkDecision: DeployConflictDecision.OVERWRITE
	});
	assert.equal(resolved.decision, DeployConflictDecision.OVERWRITE);
	assert.equal(resolved.nextBulkDecision, DeployConflictDecision.OVERWRITE);
});

test('deployConflict ask policy maps prompt choice and updates bulk decision', () => {
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: DeployConflictPolicy.ASK,
			promptChoice: 'Overwrite'
		}),
		{
			decision: DeployConflictDecision.OVERWRITE
		}
	);
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: DeployConflictPolicy.ASK,
			promptChoice: 'Overwrite All'
		}),
		{
			decision: DeployConflictDecision.OVERWRITE,
			nextBulkDecision: DeployConflictDecision.OVERWRITE
		}
	);
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: DeployConflictPolicy.ASK,
			promptChoice: 'Skip'
		}),
		{
			decision: DeployConflictDecision.SKIP
		}
	);
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: DeployConflictPolicy.ASK,
			promptChoice: 'Skip All'
		}),
		{
			decision: DeployConflictDecision.SKIP,
			nextBulkDecision: DeployConflictDecision.SKIP
		}
	);
	assert.deepEqual(
		resolveDeployConflictDecision({
			policy: DeployConflictPolicy.ASK
		}),
		{
			decision: DeployConflictDecision.SKIP
		}
	);
});

