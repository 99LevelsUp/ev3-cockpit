import assert from 'node:assert/strict';
import test from 'node:test';
import {
	classifyBluetoothFailure,
	classifyBluetoothFailurePhase,
	isLikelyDynamicBluetoothAvailabilityFailure,
	isLikelyTransientBluetoothFailure,
	summarizeBluetoothFailures
} from '../transport/bluetoothFailure';

// --- Transport health classification edge cases ---

test('classifyBluetoothFailurePhase returns unknown for unrecognized message', () => {
	assert.equal(classifyBluetoothFailurePhase('Something completely different happened'), 'unknown');
});

test('classifyBluetoothFailurePhase handles empty string', () => {
	assert.equal(classifyBluetoothFailurePhase(''), 'unknown');
});

test('classifyBluetoothFailurePhase identifies session errors', () => {
	assert.equal(classifyBluetoothFailurePhase('Bluetooth transport is not open.'), 'session');
	assert.equal(classifyBluetoothFailurePhase('Serial port closed unexpectedly'), 'session');
	assert.equal(classifyBluetoothFailurePhase('Bluetooth SPP adapter is not open'), 'session');
});

test('classifyBluetoothFailure with default strategy parameter', () => {
	const result = classifyBluetoothFailure('Opening COM4: Unknown error code 121');
	assert.equal(result.phase, 'open');
	assert.equal(result.windowsCode, 121);
	assert.equal(result.likelyTransient, true);
});

test('classifyBluetoothFailure for message without windows error code', () => {
	const result = classifyBluetoothFailure('Bluetooth SPP send aborted.');
	assert.equal(result.phase, 'send');
	assert.equal(result.windowsCode, undefined);
	assert.equal(result.likelyTransient, true);
});

test('classifyBluetoothFailure with legacy-order strategy reduces transient classification', () => {
	const result = classifyBluetoothFailure('Bluetooth SPP send aborted.', 'legacy-order');
	assert.equal(result.likelyTransient, false);
});

// --- Transient failure edge cases ---

test('isLikelyTransientBluetoothFailure rejects non-matching messages', () => {
	assert.equal(isLikelyTransientBluetoothFailure('Probe reply returned status 0x2.', 'ev3-priority'), false);
	assert.equal(isLikelyTransientBluetoothFailure('Connection refused', 'ev3-priority'), false);
});

test('isLikelyTransientBluetoothFailure handles case-insensitive matching', () => {
	assert.equal(isLikelyTransientBluetoothFailure('ACCESS IS DENIED', 'ev3-priority'), true);
	assert.equal(isLikelyTransientBluetoothFailure('access denied', 'ev3-priority'), true);
});

// --- Dynamic availability edge cases ---

test('isLikelyDynamicBluetoothAvailabilityFailure identifies transport session issues', () => {
	assert.equal(isLikelyDynamicBluetoothAvailabilityFailure('Bluetooth transport is not open.'), true);
});

test('isLikelyDynamicBluetoothAvailabilityFailure handles semaphore timeout', () => {
	assert.equal(isLikelyDynamicBluetoothAvailabilityFailure('The semaphore timeout period has expired.'), true);
});

// --- summarizeBluetoothFailures edge cases ---

test('summarizeBluetoothFailures handles empty array', () => {
	const summary = summarizeBluetoothFailures([]);
	assert.equal(summary.total, 0);
	assert.equal(summary.likelyTransientCount, 0);
	assert.equal(summary.likelyDynamicAvailabilityCount, 0);
	assert.deepEqual(summary.windowsCodes, []);
});

test('summarizeBluetoothFailures handles single failure', () => {
	const summary = summarizeBluetoothFailures(['Opening COM5: Unknown error code 1256']);
	assert.equal(summary.total, 1);
	assert.equal(summary.byPhase.open, 1);
	assert.equal(summary.primaryPhase, 'open');
	assert.deepEqual(summary.windowsCodes, [1256]);
});

test('summarizeBluetoothFailures deduplicates windows codes', () => {
	const summary = summarizeBluetoothFailures([
		'Opening COM3: Unknown error code 121',
		'Opening COM4: Unknown error code 121',
		'Opening COM5: Unknown error code 121'
	]);
	assert.deepEqual(summary.windowsCodes, [121]);
	assert.equal(summary.total, 3);
});

test('summarizeBluetoothFailures sorts windows codes', () => {
	const summary = summarizeBluetoothFailures([
		'Opening COM3: Unknown error code 1256',
		'Opening COM4: Unknown error code 121',
		'Opening COM5: Unknown error code 1167'
	]);
	assert.deepEqual(summary.windowsCodes, [121, 1167, 1256]);
});
