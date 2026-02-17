import assert from 'node:assert/strict';
import test from 'node:test';
import { ProtocolError, ProtocolErrorCode, PROTOCOL_ERROR_MESSAGES } from '../errors/ProtocolError.js';

test('ProtocolError extends Error', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.MALFORMED_PACKET,
		message: 'Packet is malformed'
	});

	assert.ok(error instanceof Error);
	assert.ok(error instanceof ProtocolError);
	assert.equal(error.name, 'ProtocolError');
});

test('ProtocolError includes code and message', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.INVALID_REPLY,
		message: 'Invalid reply received'
	});

	assert.equal(error.code, ProtocolErrorCode.INVALID_REPLY);
	assert.equal(error.message, 'Invalid reply received');
});

test('ProtocolError includes operation when provided', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.REPLY_ERROR,
		message: 'Reply error',
		operation: 'readSensor'
	});

	assert.equal(error.operation, 'readSensor');
});

test('ProtocolError includes packet type information', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.UNEXPECTED_REPLY_TYPE,
		message: 'Wrong reply type',
		packetType: 0x05,
		expectedType: 0x03
	});

	assert.equal(error.packetType, 0x05);
	assert.equal(error.expectedType, 0x03);
});

test('ProtocolError stores raw data for debugging', () => {
	const rawData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
	const error = new ProtocolError({
		code: ProtocolErrorCode.MALFORMED_PACKET,
		message: 'Malformed packet',
		rawData
	});

	assert.deepEqual(error.rawData, rawData);
});

test('ProtocolError getRawDataHex formats data as hex string', () => {
	const rawData = new Uint8Array([0x01, 0x0a, 0xff, 0x10]);
	const error = new ProtocolError({
		code: ProtocolErrorCode.MALFORMED_PACKET,
		message: 'Malformed packet',
		rawData
	});

	const hex = error.getRawDataHex();
	assert.equal(hex, '01 0a ff 10');
});

test('ProtocolError getRawDataHex limits to 32 bytes', () => {
	const rawData = new Uint8Array(64).fill(0xaa);
	const error = new ProtocolError({
		code: ProtocolErrorCode.MALFORMED_PACKET,
		message: 'Malformed packet',
		rawData
	});

	const hex = error.getRawDataHex();
	assert.ok(hex);
	const bytes = hex.split(' ');
	assert.equal(bytes.length, 32);
});

test('ProtocolError getRawDataHex returns undefined when no raw data', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.INVALID_HEADER,
		message: 'Invalid header'
	});

	const hex = error.getRawDataHex();
	assert.equal(hex, undefined);
});

test('ProtocolError infers recovery action from code', () => {
	const firmwareError = new ProtocolError({
		code: ProtocolErrorCode.VERSION_MISMATCH,
		message: 'Version mismatch'
	});
	assert.equal(firmwareError.recommendedAction, 'check-firmware');

	const bugError = new ProtocolError({
		code: ProtocolErrorCode.MALFORMED_PACKET,
		message: 'Malformed packet'
	});
	assert.equal(bugError.recommendedAction, 'report-bug');

	const retryError = new ProtocolError({
		code: ProtocolErrorCode.REPLY_ERROR,
		message: 'Reply error'
	});
	assert.equal(retryError.recommendedAction, 'retry');
});

test('ProtocolError allows explicit recovery action', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.UNKNOWN,
		message: 'Unknown error',
		recommendedAction: 'update-extension'
	});

	assert.equal(error.recommendedAction, 'update-extension');
});

test('ProtocolError supports cause chaining', () => {
	const cause = new Error('Underlying error');
	const error = new ProtocolError({
		code: ProtocolErrorCode.DECODING_ERROR,
		message: 'Decoding failed',
		cause
	});

	assert.equal(error.cause, cause);
});

test('PROTOCOL_ERROR_MESSAGES includes all error codes', () => {
	for (const code of Object.values(ProtocolErrorCode)) {
		assert.ok(
			PROTOCOL_ERROR_MESSAGES[code],
			`Missing message for ${code}`
		);
		assert.ok(
			typeof PROTOCOL_ERROR_MESSAGES[code] === 'string',
			`Message for ${code} should be a string`
		);
	}
});

test('ProtocolError handles encoding errors', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.ENCODING_ERROR,
		message: 'Failed to encode payload',
		operation: 'buildCommand'
	});

	assert.equal(error.code, ProtocolErrorCode.ENCODING_ERROR);
	assert.equal(error.operation, 'buildCommand');
});

test('ProtocolError handles decoding errors', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.DECODING_ERROR,
		message: 'Failed to decode reply',
		operation: 'parseReply'
	});

	assert.equal(error.code, ProtocolErrorCode.DECODING_ERROR);
	assert.equal(error.operation, 'parseReply');
});

test('ProtocolError handles checksum failures', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.CHECKSUM_FAILED,
		message: 'Checksum mismatch'
	});

	assert.equal(error.code, ProtocolErrorCode.CHECKSUM_FAILED);
});

test('ProtocolError handles sequence mismatch', () => {
	const error = new ProtocolError({
		code: ProtocolErrorCode.SEQUENCE_MISMATCH,
		message: 'Sequence number mismatch'
	});

	assert.equal(error.code, ProtocolErrorCode.SEQUENCE_MISMATCH);
});
