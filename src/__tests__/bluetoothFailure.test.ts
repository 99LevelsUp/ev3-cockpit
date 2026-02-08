import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isLikelyDynamicBluetoothAvailabilityFailure,
	isLikelyTransientBluetoothFailure
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
