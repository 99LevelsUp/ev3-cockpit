import assert from 'node:assert/strict';
import test from 'node:test';
import {
	classifyBluetoothFailure,
	isTransientBluetoothError,
} from '../transport/bluetoothFailure';

// ── Windows error code classification ──

test('classifyBluetoothFailure recognizes WIN32 error 121 (semaphore timeout)', () => {
	const r = classifyBluetoothFailure('Opening COM5: error code 121');
	assert.equal(r.transient, true);
	assert.equal(r.winErrorCode, 121);
	assert.equal(r.phase, 'open');
});

test('classifyBluetoothFailure recognizes WIN32 error 1167 (device not connected)', () => {
	const r = classifyBluetoothFailure('Write failed, errno: 1167');
	assert.equal(r.transient, true);
	assert.equal(r.winErrorCode, 1167);
	assert.equal(r.phase, 'send');
});

test('classifyBluetoothFailure recognizes WIN32 error 1256 (connection aborted)', () => {
	const r = classifyBluetoothFailure('send failed win32: 1256');
	assert.equal(r.transient, true);
	assert.equal(r.winErrorCode, 1256);
	assert.equal(r.phase, 'send');
});

test('classifyBluetoothFailure recognizes WIN32 error 2 (file not found)', () => {
	const r = classifyBluetoothFailure('Cannot open COM3, error code 2');
	assert.equal(r.transient, true);
	assert.equal(r.winErrorCode, 2);
	assert.equal(r.phase, 'open');
});

test('classifyBluetoothFailure recognizes WIN32 error 5 (access denied)', () => {
	const r = classifyBluetoothFailure('opening serial port failed, code: 5');
	assert.equal(r.transient, true);
	assert.equal(r.winErrorCode, 5);
	assert.equal(r.phase, 'open');
});

test('classifyBluetoothFailure treats access-denied text as transient with code 5', () => {
	const r = classifyBluetoothFailure('Access denied to COM7');
	assert.equal(r.transient, true);
	assert.equal(r.winErrorCode, 5);
});

test('classifyBluetoothFailure treats EACCES as transient with code 5', () => {
	const r = classifyBluetoothFailure('EACCES: permission denied');
	assert.equal(r.transient, true);
	assert.equal(r.winErrorCode, 5);
});

// ── Unknown/non-transient errors ──

test('classifyBluetoothFailure marks unknown error as non-transient', () => {
	const r = classifyBluetoothFailure('Something completely unexpected happened');
	assert.equal(r.transient, false);
	assert.equal(r.winErrorCode, undefined);
	assert.equal(r.phase, 'unknown');
});

test('classifyBluetoothFailure ignores unrecognized numeric codes', () => {
	const r = classifyBluetoothFailure('error code 9999');
	assert.equal(r.transient, false);
	assert.equal(r.winErrorCode, undefined);
});

// ── Phase inference ──

test('classifyBluetoothFailure infers open phase', () => {
	const r = classifyBluetoothFailure('Cannot open port');
	assert.equal(r.phase, 'open');
});

test('classifyBluetoothFailure infers probe phase', () => {
	const r = classifyBluetoothFailure('probe timed out');
	assert.equal(r.phase, 'probe');
});

test('classifyBluetoothFailure infers send phase', () => {
	const r = classifyBluetoothFailure('send failed');
	assert.equal(r.phase, 'send');
});

test('classifyBluetoothFailure infers discovery phase', () => {
	const r = classifyBluetoothFailure('discovery scan error');
	assert.equal(r.phase, 'discovery');
});

test('classifyBluetoothFailure infers session phase', () => {
	const r = classifyBluetoothFailure('BT transport closed while waiting for reply');
	assert.equal(r.phase, 'session');
});

test('classifyBluetoothFailure accepts explicit phase override', () => {
	const r = classifyBluetoothFailure('something happened', 'probe');
	assert.equal(r.phase, 'probe');
});

// ── isTransientBluetoothError convenience ──

test('isTransientBluetoothError returns true for known Win error codes', () => {
	assert.equal(isTransientBluetoothError('error code 121'), true);
	assert.equal(isTransientBluetoothError('errno: 1167'), true);
	assert.equal(isTransientBluetoothError('Access denied'), true);
});

test('isTransientBluetoothError returns false for unrecognized errors', () => {
	assert.equal(isTransientBluetoothError('file is locked'), false);
	assert.equal(isTransientBluetoothError('error code 9999'), false);
});
