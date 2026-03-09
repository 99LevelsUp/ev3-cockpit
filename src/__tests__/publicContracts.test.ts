import assert from 'node:assert/strict';
import test from 'node:test';
import * as errorExports from '../errors';
import * as enumExports from '../types/enums';
import { LANE_PRIORITY, type Lane, type SchedulerErrorCode, type SchedulerState } from '../scheduler/types';
import type { TransportAdapter, TransportRequestOptions } from '../transport/transportAdapter';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
		? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
			? true
			: false
		: false;
type Expect<T extends true> = T;

type _LaneContract = Expect<Equal<Lane, 'emergency' | 'high' | 'normal' | 'low'>>;
type _SchedulerStateContract = Expect<Equal<SchedulerState, 'idle' | 'running' | 'orphan-risk' | 'disposed'>>;
type _SchedulerErrorCodeContract = Expect<
	Equal<SchedulerErrorCode, 'TIMEOUT' | 'CANCELLED' | 'DISPOSED' | 'COUNTER_EXHAUSTED' | 'EXECUTION_FAILED' | 'ORPHAN_RISK'>
>;
const laneContract: _LaneContract = true;
const schedulerStateContract: _SchedulerStateContract = true;
const schedulerErrorCodeContract: _SchedulerErrorCodeContract = true;

const transportRequestOptionsContract: TransportRequestOptions = {
	timeoutMs: 250,
	signal: new AbortController().signal
};
const transportAdapterContract: TransportAdapter = {
	async open(): Promise<void> {},
	async close(): Promise<void> {},
	async send(_packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array> {
		assert.equal(typeof options.timeoutMs, 'number');
		assert.ok(options.signal instanceof AbortSignal);
		return new Uint8Array();
	}
};

void transportRequestOptionsContract;
void transportAdapterContract;
void laneContract;
void schedulerStateContract;
void schedulerErrorCodeContract;

test('errors index public exports remain stable', () => {
	assert.deepEqual(Object.keys(errorExports).sort(), [
		'EV3_ERROR_MESSAGES',
		'Ev3Error',
		'ExtensionError',
		'FILESYSTEM_ERROR_MESSAGES',
		'FilesystemError',
		'FilesystemErrorCode',
		'PROTOCOL_ERROR_MESSAGES',
		'ProtocolError',
		'ProtocolErrorCode',
		'SCHEDULER_ERROR_MESSAGES',
		'SchedulerError',
		'SchedulerErrorCode',
		'TRANSPORT_ERROR_MESSAGES',
		'TransportError',
		'TransportErrorCode',
		'getUserFacingMessage',
		'isEv3Error',
		'isExtensionError',
		'isFilesystemError',
		'isProtocolError',
		'isSchedulerError',
		'isTransportError'
	]);
});

test('types enums public exports remain stable', () => {
	assert.deepEqual(Object.keys(enumExports).sort(), [
		'DeployConflictAskFallback',
		'DeployConflictDecision',
		'DeployConflictPolicy',
		'DeployVerifyMode',
		'FsMode',
		'TransportMode',
		'isDeployConflictPolicy',
		'isFsMode',
		'isTransportMode'
	]);
});

test('types enums runtime values remain stable', () => {
	assert.deepEqual(Object.values(enumExports.TransportMode).sort(), ['bt', 'mock', 'tcp', 'usb']);
	assert.deepEqual(Object.values(enumExports.FsMode).sort(), ['full', 'safe']);
	assert.deepEqual(Object.values(enumExports.DeployConflictPolicy).sort(), ['ask', 'overwrite', 'skip']);
	assert.deepEqual(Object.values(enumExports.DeployConflictDecision).sort(), ['overwrite', 'skip']);
	assert.deepEqual(Object.values(enumExports.DeployVerifyMode).sort(), ['md5', 'none', 'size']);
	assert.deepEqual(Object.values(enumExports.DeployConflictAskFallback).sort(), ['overwrite', 'prompt', 'skip']);
});

test('scheduler lane priority order remains stable', () => {
	assert.deepEqual(LANE_PRIORITY, ['emergency', 'high', 'normal', 'low']);
});
