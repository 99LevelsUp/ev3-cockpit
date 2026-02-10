import assert from 'node:assert/strict';
import test from 'node:test';
import { toErrorMessage, withBrickOperation } from '../commands/commandUtils';

// --- toErrorMessage ---

test('toErrorMessage extracts message from Error instance', () => {
	assert.equal(toErrorMessage(new Error('something broke')), 'something broke');
});

test('toErrorMessage converts string to itself', () => {
	assert.equal(toErrorMessage('plain string'), 'plain string');
});

test('toErrorMessage converts number to string', () => {
	assert.equal(toErrorMessage(42), '42');
});

test('toErrorMessage converts null to string', () => {
	assert.equal(toErrorMessage(null), 'null');
});

test('toErrorMessage converts undefined to string', () => {
	assert.equal(toErrorMessage(undefined), 'undefined');
});

test('toErrorMessage converts object to string', () => {
	assert.equal(toErrorMessage({ key: 'value' }), '[object Object]');
});

// --- withBrickOperation ---

test('withBrickOperation reports started and completed on success', async () => {
	const log: string[] = [];
	const result = await withBrickOperation(
		'brick-1',
		'deploy',
		(brickId, operation) => log.push(`${brickId}:${operation}`),
		async () => 'ok'
	);
	assert.equal(result, 'ok');
	assert.deepEqual(log, ['brick-1:deploy started', 'brick-1:deploy completed']);
});

test('withBrickOperation reports started and failed on error', async () => {
	const log: string[] = [];
	await assert.rejects(
		() =>
			withBrickOperation(
				'brick-2',
				'upload',
				(brickId, operation) => log.push(`${brickId}:${operation}`),
				async () => {
					throw new Error('transport error');
				}
			),
		{ message: 'transport error' }
	);
	assert.deepEqual(log, ['brick-2:upload started', 'brick-2:upload failed']);
});

test('withBrickOperation returns the value from the async function', async () => {
	const result = await withBrickOperation(
		'brick-3',
		'read',
		() => {},
		async () => ({ files: ['a.rbf', 'b.rbf'] })
	);
	assert.deepEqual(result, { files: ['a.rbf', 'b.rbf'] });
});
