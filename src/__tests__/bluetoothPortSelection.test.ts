import assert from 'node:assert/strict';
import test from 'node:test';
import type { SerialCandidate } from '../transport/discovery';
import {
	buildBluetoothPortPlans,
	extractMacFromPnpId,
	hasLegoMacPrefix,
	isBtSerialCandidate,
	LEGO_MAC_OUI_PREFIX,
	EV3_PNP_HINT,
} from '../transport/bluetoothPortSelection';

// ── helpers ──

function candidate(path: string, overrides: Partial<SerialCandidate> = {}): SerialCandidate {
	return { path, ...overrides };
}

// ── isBtSerialCandidate ──

test('isBtSerialCandidate returns true for BTHENUM pnpId', () => {
	assert.ok(isBtSerialCandidate(candidate('COM5', { pnpId: 'BTHENUM\\{00001101}' })));
});

test('isBtSerialCandidate returns true for COM path without pnpId', () => {
	assert.ok(isBtSerialCandidate(candidate('COM3')));
});

test('isBtSerialCandidate returns false for /dev/ttyUSB0', () => {
	assert.equal(isBtSerialCandidate(candidate('/dev/ttyUSB0')), false);
});

// ── extractMacFromPnpId ──

test('extractMacFromPnpId extracts 12-char hex after backslash', () => {
	assert.equal(
		extractMacFromPnpId('BTHENUM\\{00001101}_LOCALMFG&005D\\001653AABBCC_C00000000'),
		'001653aabbcc'
	);
});

test('extractMacFromPnpId returns undefined for missing pnpId', () => {
	assert.equal(extractMacFromPnpId(undefined), undefined);
});

test('extractMacFromPnpId returns undefined for non-matching string', () => {
	assert.equal(extractMacFromPnpId('USB\\VID_0694&PID_0005'), undefined);
});

// ── hasLegoMacPrefix ──

test('hasLegoMacPrefix returns true for LEGO OUI', () => {
	assert.ok(hasLegoMacPrefix('BTHENUM\\001653AABBCC_'));
});

test('hasLegoMacPrefix returns false for non-LEGO MAC', () => {
	assert.equal(hasLegoMacPrefix('BTHENUM\\AABBCCDDEEFF_'), false);
});

// ── constants ──

test('LEGO_MAC_OUI_PREFIX is 001653', () => {
	assert.equal(LEGO_MAC_OUI_PREFIX, '001653');
});

test('EV3_PNP_HINT is _005D', () => {
	assert.equal(EV3_PNP_HINT, '_005D');
});

// ── buildBluetoothPortPlans ──

test('buildBluetoothPortPlans returns empty for empty input', () => {
	assert.deepEqual(buildBluetoothPortPlans([]), []);
});

test('buildBluetoothPortPlans ranks EV3 hint above plain COM', () => {
	const ports = [
		candidate('COM8'),
		candidate('COM5', { pnpId: 'BTHENUM\\{00001101}_LOCALMFG&005D\\001653AABB00_' }),
	];
	const plans = buildBluetoothPortPlans(ports);
	// ev3-priority plan first: COM5 has _005D hint (score 1), COM8 has score 3
	assert.equal(plans[0].path, 'COM5');
	assert.equal(plans[0].strategy, 'ev3-priority');
});

test('buildBluetoothPortPlans ranks serial number match highest', () => {
	const ports = [
		candidate('COM3', { pnpId: 'BTHENUM\\{00001101}_LOCALMFG&005D\\001653AABB00_' }),
		candidate('COM5', { serialNumber: 'SN-1234' }),
	];
	const plans = buildBluetoothPortPlans(ports, 'SN-1234');
	assert.equal(plans[0].path, 'COM5');
	assert.equal(plans[0].score, 0);
});

test('buildBluetoothPortPlans deduplicates legacy-order entries', () => {
	const ports = [candidate('COM3'), candidate('COM5')];
	const plans = buildBluetoothPortPlans(ports);
	const paths = plans.map((p) => p.path);
	// Each path should appear in ev3-priority and NOT again in legacy-order
	const comThreeCount = paths.filter((p) => p === 'COM3').length;
	const comFiveCount = paths.filter((p) => p === 'COM5').length;
	assert.equal(comThreeCount, 1);
	assert.equal(comFiveCount, 1);
});

test('buildBluetoothPortPlans legacy-order sorts by COM number ascending', () => {
	const ports = [candidate('COM9'), candidate('COM3'), candidate('COM5')];
	// When no EV3 hints, ev3-priority scores are all 3, sorted by COM number
	const plans = buildBluetoothPortPlans(ports);
	const ev3Paths = plans.filter((p) => p.strategy === 'ev3-priority').map((p) => p.path);
	assert.deepEqual(ev3Paths, ['COM3', 'COM5', 'COM9']);
});

test('buildBluetoothPortPlans LEGO MAC ranks above plain COM', () => {
	const ports = [
		candidate('COM9'),
		candidate('COM5', { pnpId: 'BTHENUM\\001653AABBCC_' }),
	];
	const plans = buildBluetoothPortPlans(ports);
	const ev3Plan = plans.filter((p) => p.strategy === 'ev3-priority');
	assert.equal(ev3Plan[0].path, 'COM5');
	assert.equal(ev3Plan[0].score, 2);
});

test('buildBluetoothPortPlans filters out non-BT paths in mixed input', () => {
	const ports = [
		candidate('/dev/ttyUSB0'),
		candidate('COM5', { pnpId: 'BTHENUM\\001653AABBCC_' }),
	];
	const plans = buildBluetoothPortPlans(ports);
	const paths = plans.map((p) => p.path);
	assert.ok(!paths.includes('/dev/ttyUSB0'));
	assert.ok(paths.includes('COM5'));
});
