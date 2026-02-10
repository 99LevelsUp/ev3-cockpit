import assert from 'node:assert/strict';
import test from 'node:test';
import {
	classifyBluetoothFailure,
	classifyBluetoothFailurePhase,
	isLikelyDynamicBluetoothAvailabilityFailure,
	isLikelyTransientBluetoothFailure,
	summarizeBluetoothFailures
} from '../transport/bluetoothFailure';

test('bluetooth transient classifier handles common Windows COM failures', () => {
	assert.equal(isLikelyTransientBluetoothFailure('Opening COM4: Unknown error code 121', 'ev3-priority'), true);
	assert.equal(isLikelyTransientBluetoothFailure('Opening COM4: Unknown error code 1256', 'ev3-priority'), true);
	assert.equal(isLikelyTransientBluetoothFailure('Opening COM4: Unknown error code 1167', 'ev3-priority'), true);
	assert.equal(
		isLikelyTransientBluetoothFailure('The semaphore timeout period has expired.', 'ev3-priority'),
		true
	);
	assert.equal(isLikelyTransientBluetoothFailure('Opening COM4: Access denied', 'ev3-priority'), true);
	assert.equal(isLikelyTransientBluetoothFailure('Bluetooth SPP send aborted.', 'ev3-priority'), true);
	assert.equal(isLikelyTransientBluetoothFailure('Bluetooth SPP send aborted.', 'legacy-order'), false);
});

test('bluetooth dynamic availability classifier marks re-discovery worthy errors', () => {
	assert.equal(isLikelyDynamicBluetoothAvailabilityFailure('Opening COM4: File not found'), true);
	assert.equal(isLikelyDynamicBluetoothAvailabilityFailure('Bluetooth transport could not resolve any serial COM candidates.'), true);
	assert.equal(isLikelyDynamicBluetoothAvailabilityFailure('Opening COM4: Unknown error code 1167'), true);
	assert.equal(isLikelyDynamicBluetoothAvailabilityFailure('Bluetooth SPP send aborted.'), true);
	assert.equal(isLikelyDynamicBluetoothAvailabilityFailure('Probe reply returned status 0x2.'), false);
});

test('bluetooth failure phase classifier identifies failure stage', () => {
	assert.equal(classifyBluetoothFailurePhase('Bluetooth transport could not resolve any serial COM candidates.'), 'discovery');
	assert.equal(classifyBluetoothFailurePhase('Opening COM4: Unknown error code 121'), 'open');
	assert.equal(classifyBluetoothFailurePhase('Unexpected reply type 0x5 during BT port probe.'), 'probe');
	assert.equal(classifyBluetoothFailurePhase('Bluetooth SPP send aborted.'), 'send');
	assert.equal(classifyBluetoothFailurePhase('Bluetooth transport is not open.'), 'session');
});

test('bluetooth failure classifier extracts windows code and flags', () => {
	const classification = classifyBluetoothFailure('Opening COM7: Unknown error code 1256');
	assert.equal(classification.phase, 'open');
	assert.equal(classification.windowsCode, 1256);
	assert.equal(classification.likelyTransient, true);
	assert.equal(classification.likelyDynamicAvailability, true);
});

test('bluetooth failure summary aggregates phase and windows code diagnostics', () => {
	const summary = summarizeBluetoothFailures([
		'Opening COM4: Unknown error code 121',
		'Opening COM5: Access denied',
		'Unexpected reply type 0x5 during BT port probe.',
		'Bluetooth transport could not resolve any serial COM candidates.'
	]);
	assert.equal(summary.total, 4);
	assert.equal(summary.byPhase.open, 2);
	assert.equal(summary.byPhase.probe, 1);
	assert.equal(summary.byPhase.discovery, 1);
	assert.equal(summary.primaryPhase, 'open');
	assert.deepEqual(summary.windowsCodes, [121]);
	assert.equal(summary.likelyTransientCount >= 2, true);
});
