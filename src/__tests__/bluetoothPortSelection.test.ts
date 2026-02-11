import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBluetoothPortSelectionPlans } from '../transport/bluetoothPortSelection';
import type { SerialCandidate } from '../transport/discovery';

// --- Empty port lists ---

test('bluetooth port selection returns empty plans for empty candidates and no preferred port', () => {
	const plans = buildBluetoothPortSelectionPlans(undefined, []);
	assert.equal(plans.length, 0);
});

test('bluetooth port selection returns single plan when only preferred port is given', () => {
	const plans = buildBluetoothPortSelectionPlans('COM3', []);
	assert.equal(plans.length, 1);
	assert.equal(plans[0].name, 'ev3-priority');
	assert.deepEqual(plans[0].ports, ['COM3']);
});

// --- Invalid COM port patterns ---

test('bluetooth port selection ignores non-COM paths in candidates', () => {
	const candidates: SerialCandidate[] = [
		{ path: '/dev/ttyS0' },
		{ path: 'not-a-port' },
		{ path: '' }
	];
	const plans = buildBluetoothPortSelectionPlans(undefined, candidates);
	assert.equal(plans.length, 0);
});

test('bluetooth port selection ignores invalid preferred port format', () => {
	const plans = buildBluetoothPortSelectionPlans('NOTAPORT', [
		{ path: 'COM3', pnpId: 'X' }
	]);
	assert.equal(plans.length >= 1, true);
	for (const plan of plans) {
		assert.equal(plan.ports.includes('NOTAPORT'), false);
	}
});

// --- Preferred port normalization ---

test('bluetooth port selection normalizes preferred port case', () => {
	const plans = buildBluetoothPortSelectionPlans('com7', [
		{ path: 'COM7', pnpId: 'X' }
	]);
	assert.equal(plans.length, 1);
	assert.deepEqual(plans[0].ports, ['COM7']);
});

test('bluetooth port selection handles whitespace in preferred port', () => {
	const plans = buildBluetoothPortSelectionPlans('  COM4  ', []);
	assert.equal(plans.length, 1);
	assert.deepEqual(plans[0].ports, ['COM4']);
});

// --- Duplicate handling ---

test('bluetooth port selection deduplicates identical candidate paths', () => {
	const candidates: SerialCandidate[] = [
		{ path: 'COM3', pnpId: 'A' },
		{ path: 'COM3', pnpId: 'B' },
		{ path: 'COM3', pnpId: 'C' }
	];
	const plans = buildBluetoothPortSelectionPlans(undefined, candidates);
	for (const plan of plans) {
		const unique = new Set(plan.ports);
		assert.equal(unique.size, plan.ports.length, `Duplicates found in plan ${plan.name}`);
	}
});

// --- EV3 hint scoring ---

test('bluetooth port selection prioritizes EV3 hint (_005D) candidates', () => {
	const candidates: SerialCandidate[] = [
		{ path: 'COM8', pnpId: 'GENERIC_DEVICE' },
		{ path: 'COM3', pnpId: 'BTHENUM_LOCALMFG&005D' }
	];
	const plans = buildBluetoothPortSelectionPlans(undefined, candidates);
	const ev3Plan = plans.find((p) => p.name === 'ev3-priority');
	assert.ok(ev3Plan);
	assert.equal(ev3Plan.ports[0], 'COM3');
});

test('bluetooth port selection ranks serial number match above EV3 hint', () => {
	const candidates: SerialCandidate[] = [
		{ path: 'COM3', pnpId: 'BTHENUM_LOCALMFG&005D' },
		{ path: 'COM5', pnpId: 'BTHENUM_SERIAL123_LOCALMFG&005D' }
	];
	const plans = buildBluetoothPortSelectionPlans(undefined, candidates, 'SERIAL123');
	const ev3Plan = plans.find((p) => p.name === 'ev3-priority');
	assert.ok(ev3Plan);
	assert.equal(ev3Plan.ports[0], 'COM5');
});

// --- Multiple candidates without EV3 hints ---

test('bluetooth port selection falls back to port index ordering when no EV3 hints', () => {
	const candidates: SerialCandidate[] = [
		{ path: 'COM10', pnpId: 'GENERIC' },
		{ path: 'COM2', pnpId: 'GENERIC' },
		{ path: 'COM5', pnpId: 'GENERIC' }
	];
	const plans = buildBluetoothPortSelectionPlans(undefined, candidates);
	assert.ok(plans.length >= 1);
	const ev3Plan = plans.find((p) => p.name === 'ev3-priority');
	assert.ok(ev3Plan);
	assert.equal(ev3Plan.ports[0], 'COM2');
	assert.equal(ev3Plan.ports[1], 'COM5');
	assert.equal(ev3Plan.ports[2], 'COM10');
});

// --- Legacy order plan ---

test('bluetooth port selection legacy plan preserves discovery order', () => {
	const candidates: SerialCandidate[] = [
		{ path: 'COM9' },
		{ path: 'COM1' },
		{ path: 'COM6' }
	];
	const plans = buildBluetoothPortSelectionPlans(undefined, candidates);
	const legacyPlan = plans.find((p) => p.name === 'legacy-order');
	assert.ok(legacyPlan);
	assert.deepEqual(legacyPlan.ports, ['COM9', 'COM1', 'COM6']);
});

// --- Single candidate ---

test('bluetooth port selection with single candidate omits duplicate legacy plan', () => {
	const candidates: SerialCandidate[] = [
		{ path: 'COM4', pnpId: 'GENERIC' }
	];
	const plans = buildBluetoothPortSelectionPlans(undefined, candidates);
	assert.equal(plans.length, 1);
});

// --- Empty preferred serial ---

test('bluetooth port selection handles empty preferred serial number gracefully', () => {
	const candidates: SerialCandidate[] = [
		{ path: 'COM3', pnpId: 'BTHENUM_005D' }
	];
	const plans = buildBluetoothPortSelectionPlans(undefined, candidates, '');
	assert.ok(plans.length >= 1);
	assert.deepEqual(plans[0].ports, ['COM3']);
});
