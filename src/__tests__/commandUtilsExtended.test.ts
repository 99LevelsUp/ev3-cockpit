import assert from 'node:assert/strict';
import test from 'node:test';
import { toUserFacingErrorMessage } from '../commands/commandUtils';
import { ExtensionError } from '../errors/ExtensionError';

// --- toUserFacingErrorMessage ---

test('toUserFacingErrorMessage formats ExtensionError with code and message', () => {
	const error = new ExtensionError('E_TRANSPORT', 'Transport not available');
	assert.equal(toUserFacingErrorMessage(error), '[E_TRANSPORT] Transport not available');
});

test('toUserFacingErrorMessage extracts message from standard Error', () => {
	assert.equal(toUserFacingErrorMessage(new Error('something broke')), 'something broke');
});

test('toUserFacingErrorMessage returns string directly', () => {
	assert.equal(toUserFacingErrorMessage('plain string error'), 'plain string error');
});

test('toUserFacingErrorMessage returns generic message for non-string non-Error', () => {
	assert.equal(toUserFacingErrorMessage(42), 'An unexpected error occurred');
	assert.equal(toUserFacingErrorMessage(null), 'An unexpected error occurred');
	assert.equal(toUserFacingErrorMessage(undefined), 'An unexpected error occurred');
	assert.equal(toUserFacingErrorMessage({ key: 'value' }), 'An unexpected error occurred');
});

test('toUserFacingErrorMessage returns empty string for empty string input', () => {
	assert.equal(toUserFacingErrorMessage(''), '');
});

test('toUserFacingErrorMessage preserves ExtensionError with cause', () => {
	const cause = new Error('root cause');
	const error = new ExtensionError('E_CONNECT', 'Connection failed', cause);
	assert.equal(toUserFacingErrorMessage(error), '[E_CONNECT] Connection failed');
});
