import assert from 'node:assert/strict';
import test from 'node:test';
import { MockMotorState } from '../mock/state/mockMotorState';
import { EV3_SENSOR_TYPE } from '../device/sensorTypes';

test('empty config gives EMPTY type on all ports', () => {
	const m = new MockMotorState([]);
	for (const port of ['A', 'B', 'C', 'D'] as const) {
		assert.equal(m.getTypeCode(port), EV3_SENSOR_TYPE.EMPTY);
		assert.equal(m.readTacho(port), 0);
		assert.equal(m.isRunning(port), false);
	}
});

test('configured motor has correct type code', () => {
	const m = new MockMotorState([
		{ port: 'A', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 0 }
	]);
	assert.equal(m.getTypeCode('A'), EV3_SENSOR_TYPE.EV3_LARGE_MOTOR);
	assert.equal(m.getTypeCode('B'), EV3_SENSOR_TYPE.EMPTY);
});

test('initial position is set from config', () => {
	const m = new MockMotorState([
		{ port: 'C', typeCode: EV3_SENSOR_TYPE.EV3_MEDIUM_MOTOR, initialPosition: 360 }
	]);
	assert.equal(m.readTacho('C'), 360);
});

test('setSpeed + start + tick accumulates tacho', () => {
	const m = new MockMotorState([
		{ port: 'A', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 0 }
	]);
	m.setSpeed('A', 50);
	m.start('A');

	// 50% speed → 500 °/s → in 1000ms → 500°
	m.tick(1000);
	assert.equal(m.readTacho('A'), 500);
});

test('stopped motor does not accumulate tacho', () => {
	const m = new MockMotorState([
		{ port: 'A', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 0 }
	]);
	m.setSpeed('A', 100);
	// Not started, so tick should not change position
	m.tick(1000);
	assert.equal(m.readTacho('A'), 0);
});

test('negative speed moves tacho backward', () => {
	const m = new MockMotorState([
		{ port: 'B', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 1000 }
	]);
	m.setSpeed('B', -100);
	m.start('B');
	// -100% → -1000 °/s → in 500ms → -500°
	m.tick(500);
	assert.equal(m.readTacho('B'), 500);
});

test('stop with brake zeroes speed', () => {
	const m = new MockMotorState([
		{ port: 'A', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 0 }
	]);
	m.setSpeed('A', 80);
	m.start('A');
	m.stop('A', true);
	assert.equal(m.isRunning('A'), false);
	assert.equal(m.getSpeed('A'), 0);
});

test('stop with coast keeps speed', () => {
	const m = new MockMotorState([
		{ port: 'A', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 0 }
	]);
	m.setSpeed('A', 80);
	m.start('A');
	m.stop('A', false);
	assert.equal(m.isRunning('A'), false);
	assert.equal(m.getSpeed('A'), 80);
});

test('resetTacho zeroes position', () => {
	const m = new MockMotorState([
		{ port: 'A', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 500 }
	]);
	assert.equal(m.readTacho('A'), 500);
	m.resetTacho('A');
	assert.equal(m.readTacho('A'), 0);
});

test('speed is clamped to -100..100', () => {
	const m = new MockMotorState([
		{ port: 'A', typeCode: EV3_SENSOR_TYPE.EV3_LARGE_MOTOR, initialPosition: 0 }
	]);
	m.setSpeed('A', 200);
	assert.equal(m.getSpeed('A'), 100);
	m.setSpeed('A', -150);
	assert.equal(m.getSpeed('A'), -100);
});
