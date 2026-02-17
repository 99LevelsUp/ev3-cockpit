import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeployTransientTransportError, isTransientDeployError, sleepMs } from '../fs/deployResilience';
import { ExtensionError } from '../errors/ExtensionError';

test('isDeployTransientTransportError detects adapter not open', () => {
	assert.equal(isDeployTransientTransportError('adapter is not open'), true);
	assert.equal(isDeployTransientTransportError('Adapter Is Not Open'), true);
	assert.equal(isDeployTransientTransportError('ADAPTER IS NOT OPEN'), true);
});

test('isDeployTransientTransportError detects transport not open', () => {
	assert.equal(isDeployTransientTransportError('transport is not open'), true);
	assert.equal(isDeployTransientTransportError('Transport Is Not Open'), true);
});

test('isDeployTransientTransportError detects send aborted', () => {
	assert.equal(isDeployTransientTransportError('send aborted'), true);
	assert.equal(isDeployTransientTransportError('Send Aborted'), true);
});

test('isDeployTransientTransportError detects HID errors', () => {
	assert.equal(isDeployTransientTransportError('could not read from hid device'), true);
	assert.equal(isDeployTransientTransportError('could not write to hid device'), true);
	assert.equal(isDeployTransientTransportError('device has been disconnected'), true);
});

test('isDeployTransientTransportError detects Windows error codes', () => {
	assert.equal(isDeployTransientTransportError('unknown error code 121'), true);
	assert.equal(isDeployTransientTransportError('unknown error code 1256'), true);
	assert.equal(isDeployTransientTransportError('unknown error code 1167'), true);
});

test('isDeployTransientTransportError detects TCP errors', () => {
	assert.equal(isDeployTransientTransportError('ECONNREFUSED'), true);
	assert.equal(isDeployTransientTransportError('ECONNRESET'), true);
	assert.equal(isDeployTransientTransportError('ECONNABORTED'), true);
	assert.equal(isDeployTransientTransportError('socket hang up'), true);
	assert.equal(isDeployTransientTransportError('EHOSTUNREACH'), true);
	assert.equal(isDeployTransientTransportError('ENETUNREACH'), true);
	assert.equal(isDeployTransientTransportError('tcp connect timeout'), true);
	assert.equal(isDeployTransientTransportError('udp discovery timeout'), true);
});

test('isDeployTransientTransportError detects serial port errors', () => {
	assert.equal(isDeployTransientTransportError('opening COM3'), true);
	assert.equal(isDeployTransientTransportError('Opening COM10'), true);
	assert.equal(isDeployTransientTransportError('access denied'), true);
	assert.equal(isDeployTransientTransportError('file not found'), true);
});

test('isDeployTransientTransportError returns false for unknown errors', () => {
	assert.equal(isDeployTransientTransportError('syntax error'), false);
	assert.equal(isDeployTransientTransportError('null pointer exception'), false);
	assert.equal(isDeployTransientTransportError(''), false);
});

test('isTransientDeployError recognizes ExtensionError with TIMEOUT code', () => {
	const error = new ExtensionError('TIMEOUT', 'Operation timed out');
	assert.equal(isTransientDeployError(error), true);
});

test('isTransientDeployError recognizes ExtensionError with EXECUTION_FAILED code', () => {
	const error = new ExtensionError('EXECUTION_FAILED', 'Execution failed');
	assert.equal(isTransientDeployError(error), true);
});

test('isTransientDeployError fallback to message pattern for ExtensionError', () => {
	const error = new ExtensionError('UNKNOWN_CODE', 'adapter is not open');
	assert.equal(isTransientDeployError(error), true);
});

test('isTransientDeployError recognizes regular Error with transient message', () => {
	const error = new Error('transport is not open');
	assert.equal(isTransientDeployError(error), true);
});

test('isTransientDeployError recognizes string error', () => {
	assert.equal(isTransientDeployError('ECONNREFUSED'), true);
	assert.equal(isTransientDeployError('syntax error'), false);
});

test('isTransientDeployError returns false for non-transient ExtensionError', () => {
	const error = new ExtensionError('INVALID_INPUT', 'Invalid input provided');
	assert.equal(isTransientDeployError(error), false);
});

test('isTransientDeployError returns false for non-transient Error', () => {
	const error = new Error('Division by zero');
	assert.equal(isTransientDeployError(error), false);
});

test('sleepMs waits for specified duration', async () => {
	const start = Date.now();
	await sleepMs(50);
	const elapsed = Date.now() - start;
	assert.ok(elapsed >= 45, `Expected at least 45ms, got ${elapsed}ms`);
	assert.ok(elapsed < 100, `Expected less than 100ms, got ${elapsed}ms`);
});

test('sleepMs handles zero duration', async () => {
	const start = Date.now();
	await sleepMs(0);
	const elapsed = Date.now() - start;
	assert.ok(elapsed < 10, `Expected less than 10ms for zero sleep, got ${elapsed}ms`);
});

test('sleepMs handles negative duration', async () => {
	const start = Date.now();
	await sleepMs(-100);
	const elapsed = Date.now() - start;
	assert.ok(elapsed < 10, `Expected less than 10ms for negative sleep, got ${elapsed}ms`);
});
