import assert from 'node:assert/strict';
import test from 'node:test';
import { toUserFacingErrorMessage } from '../commands/commandUtils';
import { isTransientDeployError, sleepMs } from '../fs/deployResilience';
import { ExtensionError } from '../errors/ExtensionError';

// --- toUserFacingErrorMessage (used in batch command error reporting) ---

test('batchCommands toUserFacingErrorMessage formats ExtensionError with code', () => {
	const error = new ExtensionError('TIMEOUT', 'Connection timed out');
	assert.equal(toUserFacingErrorMessage(error), '[TIMEOUT] Connection timed out');
});

test('batchCommands toUserFacingErrorMessage extracts message from plain Error', () => {
	assert.equal(toUserFacingErrorMessage(new Error('brick disconnected')), 'brick disconnected');
});

test('batchCommands toUserFacingErrorMessage returns string directly', () => {
	assert.equal(toUserFacingErrorMessage('deploy failed'), 'deploy failed');
});

test('batchCommands toUserFacingErrorMessage returns fallback for non-standard values', () => {
	assert.equal(toUserFacingErrorMessage(42), 'An unexpected error occurred');
	assert.equal(toUserFacingErrorMessage(null), 'An unexpected error occurred');
	assert.equal(toUserFacingErrorMessage(undefined), 'An unexpected error occurred');
	assert.equal(toUserFacingErrorMessage({ key: 'value' }), 'An unexpected error occurred');
});

// --- isTransientDeployError (used in batch retry decisions) ---

test('batchCommands isTransientDeployError detects ExtensionError with TIMEOUT code', () => {
	const error = new ExtensionError('TIMEOUT', 'Some timeout message');
	assert.equal(isTransientDeployError(error), true);
});

test('batchCommands isTransientDeployError detects ExtensionError with EXECUTION_FAILED code', () => {
	const error = new ExtensionError('EXECUTION_FAILED', 'Command failed');
	assert.equal(isTransientDeployError(error), true);
});

test('batchCommands isTransientDeployError does not match ExtensionError with non-transient code', () => {
	const error = new ExtensionError('PATH_POLICY', 'Path outside safe roots');
	assert.equal(isTransientDeployError(error), false);
});

test('batchCommands isTransientDeployError detects transient pattern from plain Error', () => {
	assert.equal(isTransientDeployError(new Error('ECONNRESET occurred')), true);
	assert.equal(isTransientDeployError(new Error('socket hang up')), true);
});

test('batchCommands isTransientDeployError rejects non-transient plain Error', () => {
	assert.equal(isTransientDeployError(new Error('file too large to upload')), false);
});

test('batchCommands isTransientDeployError handles string errors', () => {
	assert.equal(isTransientDeployError('ECONNREFUSED 192.168.1.1:5555'), true);
	assert.equal(isTransientDeployError('normal logic error'), false);
});

// --- sleepMs edge cases ---

test('batchCommands sleepMs resolves immediately for zero', async () => {
	const start = Date.now();
	await sleepMs(0);
	assert.ok(Date.now() - start < 50);
});

test('batchCommands sleepMs resolves immediately for negative', async () => {
	const start = Date.now();
	await sleepMs(-100);
	assert.ok(Date.now() - start < 50);
});
