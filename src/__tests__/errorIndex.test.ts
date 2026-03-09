import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ExtensionError,
	TransportError,
	TransportErrorCode,
	ProtocolError,
	ProtocolErrorCode,
	SchedulerError,
	SchedulerErrorCode,
	FilesystemError,
	FilesystemErrorCode,
	EV3Error,
	isExtensionError,
	isTransportError,
	isProtocolError,
	isSchedulerError,
	isFilesystemError,
	isEv3Error,
	getUserFacingMessage
} from '../errors/index.js';

test('isExtensionError type guard works', () => {
	const extensionErr = new ExtensionError('TEST', 'Test error');
	const regularErr = new Error('Regular error');
	const notError = { message: 'Not an error' };

	assert.ok(isExtensionError(extensionErr));
	assert.equal(isExtensionError(regularErr), false);
	assert.equal(isExtensionError(notError), false);
	assert.equal(isExtensionError(null), false);
	assert.equal(isExtensionError(undefined), false);
});

test('isTransportError type guard works', () => {
	const transportErr = new TransportError({
		code: TransportErrorCode.TIMEOUT,
		message: 'Timeout',
		transportType: 'usb'
	});
	const extensionErr = new ExtensionError('TEST', 'Test');
	const regularErr = new Error('Regular');

	assert.ok(isTransportError(transportErr));
	assert.equal(isTransportError(extensionErr), false);
	assert.equal(isTransportError(regularErr), false);
});

test('isProtocolError type guard works', () => {
	const protocolErr = new ProtocolError({
		code: ProtocolErrorCode.MALFORMED_PACKET,
		message: 'Malformed'
	});
	const extensionErr = new ExtensionError('TEST', 'Test');
	const regularErr = new Error('Regular');

	assert.ok(isProtocolError(protocolErr));
	assert.equal(isProtocolError(extensionErr), false);
	assert.equal(isProtocolError(regularErr), false);
});

test('isSchedulerError type guard works', () => {
	const schedulerErr = new SchedulerError({
		code: SchedulerErrorCode.TIMEOUT,
		message: 'Timeout'
	});
	const extensionErr = new ExtensionError('TEST', 'Test');
	const regularErr = new Error('Regular');

	assert.ok(isSchedulerError(schedulerErr));
	assert.equal(isSchedulerError(extensionErr), false);
	assert.equal(isSchedulerError(regularErr), false);
});

test('isFilesystemError type guard works', () => {
	const fsErr = new FilesystemError({
		code: FilesystemErrorCode.NOT_FOUND,
		message: 'Not found',
		operation: 'read'
	});
	const extensionErr = new ExtensionError('TEST', 'Test');
	const regularErr = new Error('Regular');

	assert.ok(isFilesystemError(fsErr));
	assert.equal(isFilesystemError(extensionErr), false);
	assert.equal(isFilesystemError(regularErr), false);
});

test('isEv3Error type guard works', () => {
	const ev3Err = new EV3Error({
		code: 'TIMEOUT',
		message: 'Timeout',
		op: 'readSensor'
	});
	const extensionErr = new ExtensionError('TEST', 'Test');
	const regularErr = new Error('Regular');

	assert.ok(isEv3Error(ev3Err));
	assert.equal(isEv3Error(extensionErr), false);
	assert.equal(isEv3Error(regularErr), false);
});

test('getUserFacingMessage extracts message from TransportError', () => {
	const error = new TransportError({
		code: TransportErrorCode.TIMEOUT,
		message: 'Connection timed out',
		transportType: 'tcp'
	});

	const message = getUserFacingMessage(error);
	assert.ok(message.includes('timed out') || message.includes('timeout'));
});

test('getUserFacingMessage extracts message from ProtocolError', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.MALFORMED_PACKET,
		message: 'Packet is malformed'
	});

	const message = getUserFacingMessage(error);
	assert.ok(message.includes('malformed') || message.includes('Malformed'));
});

test('getUserFacingMessage extracts message from SchedulerError', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.QUEUE_FULL,
		message: 'Queue is full'
	});

	const message = getUserFacingMessage(error);
	assert.ok(message.includes('queue') || message.includes('Queue'));
});

test('getUserFacingMessage extracts message from FilesystemError', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.NOT_FOUND,
		message: 'File not found',
		operation: 'read'
	});

	const message = getUserFacingMessage(error);
	assert.ok(message.includes('not found') || message.includes('Not found'));
});

test('getUserFacingMessage extracts message from EV3Error', () => {
	const error = new EV3Error({
		code: 'TIMEOUT',
		message: 'Command timed out',
		op: 'readSensor'
	});

	const message = getUserFacingMessage(error);
	assert.ok(message.length > 0);
});

test('getUserFacingMessage extracts message from regular Error', () => {
	const error = new Error('Regular error message');
	const message = getUserFacingMessage(error);
	assert.equal(message, 'Regular error message');
});

test('getUserFacingMessage handles string errors', () => {
	const message = getUserFacingMessage('String error');
	assert.equal(message, 'String error');
});

test('getUserFacingMessage handles non-Error objects', () => {
	const message = getUserFacingMessage({ toString: () => 'Custom error' });
	assert.equal(message, 'Custom error');
});

test('getUserFacingMessage handles null and undefined', () => {
	assert.equal(getUserFacingMessage(null), 'null');
	assert.equal(getUserFacingMessage(undefined), 'undefined');
});

test('TransportError is instance of ExtensionError', () => {
	const error = new TransportError({
		code: TransportErrorCode.CONNECT_FAILED,
		message: 'Connect failed',
		transportType: 'usb'
	});

	assert.ok(error instanceof ExtensionError);
	assert.ok(error instanceof TransportError);
});

test('ProtocolError is instance of ExtensionError', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.INVALID_REPLY,
		message: 'Invalid reply'
	});

	assert.ok(error instanceof ExtensionError);
	assert.ok(error instanceof ProtocolError);
});

test('SchedulerError is instance of ExtensionError', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.TIMEOUT,
		message: 'Timeout'
	});

	assert.ok(error instanceof ExtensionError);
	assert.ok(error instanceof SchedulerError);
});

test('FilesystemError is instance of ExtensionError', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.NOT_FOUND,
		message: 'Not found',
		operation: 'read'
	});

	assert.ok(error instanceof ExtensionError);
	assert.ok(error instanceof FilesystemError);
});

test('EV3Error is instance of ExtensionError', () => {
	const error = new EV3Error({
		code: 'TIMEOUT',
		message: 'Timeout',
		op: 'readSensor'
	});

	assert.ok(error instanceof ExtensionError);
	assert.ok(error instanceof EV3Error);
});

test('All error types have proper inheritance chain', () => {
	const errors = [
		new TransportError({ code: TransportErrorCode.TIMEOUT, message: 'Test', transportType: 'usb' }),
		new ProtocolError({ code: ProtocolErrorCode.MALFORMED_PACKET, message: 'Test' }),
		new SchedulerError({ code: SchedulerErrorCode.TIMEOUT, message: 'Test' }),
		new FilesystemError({ code: FilesystemErrorCode.NOT_FOUND, message: 'Test', operation: 'read' }),
		new EV3Error({ code: 'TIMEOUT', message: 'Test', op: 'test' })
	];

	for (const error of errors) {
		assert.ok(error instanceof Error, `${error.name} should extend Error`);
		assert.ok(error instanceof ExtensionError, `${error.name} should extend ExtensionError`);
		assert.ok(error.message, `${error.name} should have message`);
		assert.ok(error.name, `${error.name} should have name`);
		assert.ok(error.code, `${error.name} should have code`);
	}
});
