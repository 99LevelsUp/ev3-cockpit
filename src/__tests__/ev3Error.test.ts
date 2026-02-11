import assert from 'node:assert/strict';
import test from 'node:test';
import { Ev3Error, EV3_ERROR_MESSAGES } from '../errors/Ev3Error';
import type { Ev3ErrorCode } from '../errors/Ev3Error';

test('Ev3Error carries structured context fields', () => {
	const error = new Ev3Error({
		code: 'DIRECT_REPLY_ERROR',
		message: 'Motor start failed on port A',
		op: 'setSpeedAndStart',
		brickId: 'brick-1',
		recommendedAction: 'check-port'
	});

	assert.equal(error.code, 'DIRECT_REPLY_ERROR');
	assert.equal(error.op, 'setSpeedAndStart');
	assert.equal(error.brickId, 'brick-1');
	assert.equal(error.recommendedAction, 'check-port');
	assert.equal(error.name, 'Ev3Error');
	assert.ok(error instanceof Error);
	assert.ok(error.message.includes('Motor start failed'));
});

test('Ev3Error defaults recommendedAction to none', () => {
	const error = new Ev3Error({
		code: 'UNKNOWN',
		message: 'Something went wrong',
		op: 'readSensor'
	});

	assert.equal(error.recommendedAction, 'none');
	assert.equal(error.brickId, undefined);
});

test('Ev3Error preserves cause chain', () => {
	const cause = new Error('Transport closed');
	const error = new Ev3Error({
		code: 'TRANSPORT_CLOSED',
		message: 'Connection lost',
		op: 'probePort',
		cause
	});

	assert.equal(error.cause, cause);
});

test('EV3_ERROR_MESSAGES covers all error codes', () => {
	const codes: Ev3ErrorCode[] = [
		'DIRECT_REPLY_ERROR', 'SYSTEM_ERROR', 'TIMEOUT',
		'TRANSPORT_CLOSED', 'INVALID_PORT', 'INVALID_ARGUMENT',
		'DEVICE_BUSY', 'UNKNOWN'
	];

	for (const code of codes) {
		const entry = EV3_ERROR_MESSAGES[code];
		assert.ok(entry, `Missing message for code: ${code}`);
		assert.ok(entry.message.length > 0, `Empty message for code: ${code}`);
		assert.ok(entry.action, `Missing action for code: ${code}`);
	}
});

test('EV3_ERROR_MESSAGES action values are valid recovery actions', () => {
	const validActions = new Set(['retry', 'reconnect', 'check-port', 'check-firmware', 'none']);

	for (const [code, entry] of Object.entries(EV3_ERROR_MESSAGES)) {
		assert.ok(validActions.has(entry.action), `Invalid action "${entry.action}" for code: ${code}`);
	}
});
