import assert from 'node:assert/strict';
import test from 'node:test';
import { SchedulerError, SchedulerErrorCode, SCHEDULER_ERROR_MESSAGES } from '../errors/SchedulerError.js';

test('SchedulerError extends Error', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.TIMEOUT,
		message: 'Command timed out'
	});

	assert.ok(error instanceof Error);
	assert.ok(error instanceof SchedulerError);
	assert.equal(error.name, 'SchedulerError');
});

test('SchedulerError includes code and message', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.QUEUE_FULL,
		message: 'Queue is full'
	});

	assert.equal(error.code, SchedulerErrorCode.QUEUE_FULL);
	assert.equal(error.message, 'Queue is full');
});

test('SchedulerError includes command ID when provided', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.TIMEOUT,
		message: 'Command timed out',
		commandId: 'cmd-123'
	});

	assert.equal(error.commandId, 'cmd-123');
});

test('SchedulerError includes lane when provided', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.INVALID_LANE,
		message: 'Invalid lane',
		lane: 'high'
	});

	assert.equal(error.lane, 'high');
});

test('SchedulerError includes queue size when provided', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.QUEUE_FULL,
		message: 'Queue is full',
		queueSize: 100
	});

	assert.equal(error.queueSize, 100);
});

test('SchedulerError infers recovery action from code', () => {
	const retryError = new SchedulerError({
		code: SchedulerErrorCode.TIMEOUT,
		message: 'Timeout'
	});
	assert.equal(retryError.recommendedAction, 'retry');

	const waitError = new SchedulerError({
		code: SchedulerErrorCode.QUEUE_FULL,
		message: 'Queue full'
	});
	assert.equal(waitError.recommendedAction, 'wait-and-retry');

	const checkError = new SchedulerError({
		code: SchedulerErrorCode.NOT_RUNNING,
		message: 'Not running'
	});
	assert.equal(checkError.recommendedAction, 'check-connection');

	const noneError = new SchedulerError({
		code: SchedulerErrorCode.CANCELLED,
		message: 'Cancelled'
	});
	assert.equal(noneError.recommendedAction, 'none');
});

test('SchedulerError allows explicit recovery action', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.UNKNOWN,
		message: 'Unknown error',
		recommendedAction: 'reduce-load'
	});

	assert.equal(error.recommendedAction, 'reduce-load');
});

test('SchedulerError supports cause chaining', () => {
	const cause = new Error('Transport error');
	const error = new SchedulerError({
		code: SchedulerErrorCode.ABORTED,
		message: 'Command aborted',
		cause
	});

	assert.equal(error.cause, cause);
});

test('SCHEDULER_ERROR_MESSAGES includes all error codes', () => {
	for (const code of Object.values(SchedulerErrorCode)) {
		assert.ok(
			SCHEDULER_ERROR_MESSAGES[code],
			`Missing message for ${code}`
		);
		assert.ok(
			typeof SCHEDULER_ERROR_MESSAGES[code] === 'string',
			`Message for ${code} should be a string`
		);
	}
});

test('SchedulerError handles command rejected', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.COMMAND_REJECTED,
		message: 'Command rejected',
		commandId: 'cmd-abc'
	});

	assert.equal(error.code, SchedulerErrorCode.COMMAND_REJECTED);
	assert.equal(error.commandId, 'cmd-abc');
});

test('SchedulerError handles cancelled commands', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.CANCELLED,
		message: 'Command cancelled',
		commandId: 'cmd-xyz'
	});

	assert.equal(error.code, SchedulerErrorCode.CANCELLED);
	assert.equal(error.commandId, 'cmd-xyz');
});

test('SchedulerError handles dropped commands', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.DROPPED,
		message: 'Command dropped',
		lane: 'low'
	});

	assert.equal(error.code, SchedulerErrorCode.DROPPED);
	assert.equal(error.lane, 'low');
});

test('SchedulerError handles payload too large', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.PAYLOAD_TOO_LARGE,
		message: 'Payload exceeds limit',
		commandId: 'cmd-large'
	});

	assert.equal(error.code, SchedulerErrorCode.PAYLOAD_TOO_LARGE);
});

test('SchedulerError handles duplicate ID', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.DUPLICATE_ID,
		message: 'Duplicate command ID',
		commandId: 'cmd-dup'
	});

	assert.equal(error.code, SchedulerErrorCode.DUPLICATE_ID);
	assert.equal(error.commandId, 'cmd-dup');
});

test('SchedulerError handles aborted commands', () => {
	const error = new SchedulerError({
		code: SchedulerErrorCode.ABORTED,
		message: 'Command aborted due to transport failure'
	});

	assert.equal(error.code, SchedulerErrorCode.ABORTED);
	assert.equal(error.recommendedAction, 'retry');
});
