import assert from 'node:assert/strict';
import test from 'node:test';
import { TransportError, TransportErrorCode, TRANSPORT_ERROR_MESSAGES } from '../errors/TransportError.js';

test('TransportError extends Error', () => {
	const error = new TransportError({
		code: TransportErrorCode.CONNECT_FAILED,
		message: 'Failed to connect',
		transportType: 'usb'
	});

	assert.ok(error instanceof Error);
	assert.ok(error instanceof TransportError);
	assert.equal(error.name, 'TransportError');
});

test('TransportError includes code and message', () => {
	const error = new TransportError({
		code: TransportErrorCode.TIMEOUT,
		message: 'Connection timed out',
		transportType: 'tcp'
	});

	assert.equal(error.code, TransportErrorCode.TIMEOUT);
	assert.equal(error.message, 'Connection timed out');
});

test('TransportError includes transport type', () => {
	const error = new TransportError({
		code: TransportErrorCode.DEVICE_DISCONNECTED,
		message: 'Device disconnected',
		transportType: 'bt'
	});

	assert.equal(error.transportType, 'bt');
});

test('TransportError includes device ID when provided', () => {
	const error = new TransportError({
		code: TransportErrorCode.CONNECTION_LOST,
		message: 'Connection lost',
		transportType: 'usb',
		deviceId: 'usb-12345'
	});

	assert.equal(error.deviceId, 'usb-12345');
});

test('TransportError infers recovery action from code', () => {
	const reconnectError = new TransportError({
		code: TransportErrorCode.CONNECT_FAILED,
		message: 'Failed to connect',
		transportType: 'usb'
	});
	assert.equal(reconnectError.recommendedAction, 'reconnect');

	const retryError = new TransportError({
		code: TransportErrorCode.TIMEOUT,
		message: 'Timeout',
		transportType: 'tcp'
	});
	assert.equal(retryError.recommendedAction, 'retry');

	const permissionsError = new TransportError({
		code: TransportErrorCode.ACCESS_DENIED,
		message: 'Access denied',
		transportType: 'serial'
	});
	assert.equal(permissionsError.recommendedAction, 'check-permissions');
});

test('TransportError allows explicit recovery action', () => {
	const error = new TransportError({
		code: TransportErrorCode.UNKNOWN,
		message: 'Unknown error',
		transportType: 'usb',
		recommendedAction: 'check-connection'
	});

	assert.equal(error.recommendedAction, 'check-connection');
});

test('TransportError marks transient errors correctly', () => {
	const transientCodes = [
		TransportErrorCode.TIMEOUT,
		TransportErrorCode.SEND_ABORTED,
		TransportErrorCode.CONNECTION_LOST,
		TransportErrorCode.ADAPTER_NOT_OPEN,
		TransportErrorCode.HID_ERROR
	];

	for (const code of transientCodes) {
		const error = new TransportError({
			code,
			message: 'Test',
			transportType: 'usb'
		});
		assert.ok(error.isTransient, `${code} should be transient`);
	}

	const nonTransientError = new TransportError({
		code: TransportErrorCode.INVALID_CONFIG,
		message: 'Invalid config',
		transportType: 'usb'
	});
	assert.equal(nonTransientError.isTransient, false);
});

test('TransportError allows explicit isTransient flag', () => {
	const error = new TransportError({
		code: TransportErrorCode.UNKNOWN,
		message: 'Unknown error',
		transportType: 'usb',
		isTransient: true
	});

	assert.ok(error.isTransient);
});

test('TransportError supports cause chaining', () => {
	const cause = new Error('Underlying error');
	const error = new TransportError({
		code: TransportErrorCode.SEND_FAILED,
		message: 'Send failed',
		transportType: 'usb',
		cause
	});

	assert.equal(error.cause, cause);
});

test('TRANSPORT_ERROR_MESSAGES includes all error codes', () => {
	for (const code of Object.values(TransportErrorCode)) {
		assert.ok(
			TRANSPORT_ERROR_MESSAGES[code],
			`Missing message for ${code}`
		);
		assert.ok(
			typeof TRANSPORT_ERROR_MESSAGES[code] === 'string',
			`Message for ${code} should be a string`
		);
	}
});

test('TransportError handles USB transport type', () => {
	const error = new TransportError({
		code: TransportErrorCode.HID_ERROR,
		message: 'HID error',
		transportType: 'usb'
	});

	assert.equal(error.transportType, 'usb');
});

test('TransportError handles BT transport type', () => {
	const error = new TransportError({
		code: TransportErrorCode.CONNECT_FAILED,
		message: 'BT connect failed',
		transportType: 'bt'
	});

	assert.equal(error.transportType, 'bt');
});

test('TransportError handles TCP transport type', () => {
	const error = new TransportError({
		code: TransportErrorCode.TIMEOUT,
		message: 'TCP timeout',
		transportType: 'tcp'
	});

	assert.equal(error.transportType, 'tcp');
});

test('TransportError handles serial transport type', () => {
	const error = new TransportError({
		code: TransportErrorCode.ACCESS_DENIED,
		message: 'Serial access denied',
		transportType: 'serial'
	});

	assert.equal(error.transportType, 'serial');
});

test('TransportError handles mock transport type', () => {
	const error = new TransportError({
		code: TransportErrorCode.UNKNOWN,
		message: 'Mock error',
		transportType: 'mock'
	});

	assert.equal(error.transportType, 'mock');
});
