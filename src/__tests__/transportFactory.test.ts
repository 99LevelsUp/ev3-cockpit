import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBluetoothPortSelectionPlans } from '../transport/bluetoothPortSelection';

test('bluetooth port selection builds EV3-priority and legacy fallback plans', () => {
	const plans = buildBluetoothPortSelectionPlans(undefined, [
		{
			path: 'COM3',
			pnpId: 'BTHENUM\\...\\00000008'
		},
		{
			path: 'COM5',
			pnpId: 'BTHENUM\\...\\00000009'
		},
		{
			path: 'COM6',
			pnpId: 'BTHENUM\\...\\0000000A'
		},
		{
			path: 'COM4',
			pnpId: 'BTHENUM\\...\\0016535D7E2D_C00000000_LOCALMFG&005D'
		}
	], '0016535D7E2D');

	assert.equal(plans.length, 2);
	assert.equal(plans[0].name, 'ev3-priority');
	assert.deepEqual(plans[0].ports, ['COM4']);
	assert.equal(plans[1].name, 'legacy-order');
	assert.deepEqual(plans[1].ports, ['COM3', 'COM5', 'COM6', 'COM4']);
});

test('bluetooth port selection injects preferred port at front and deduplicates', () => {
	const plans = buildBluetoothPortSelectionPlans('com5', [
		{
			path: 'COM3',
			pnpId: 'X'
		},
		{
			path: 'COM5',
			pnpId: 'Y'
		},
		{
			path: 'COM4',
			pnpId: 'Z_LOCALMFG_005D'
		}
	]);

	assert.equal(plans.length, 2);
	assert.deepEqual(plans[0].ports, ['COM5', 'COM4']);
	assert.deepEqual(plans[1].ports, ['COM5', 'COM3', 'COM4']);
});

test('bluetooth port selection omits duplicate fallback when plans are identical', () => {
	const plans = buildBluetoothPortSelectionPlans(undefined, [
		{
			path: 'COM4',
			pnpId: 'BTHENUM\\...\\0016535D7E2D_LOCALMFG&005D'
		}
	], '0016535D7E2D');

	assert.equal(plans.length, 1);
	assert.equal(plans[0].name, 'ev3-priority');
	assert.deepEqual(plans[0].ports, ['COM4']);
});
