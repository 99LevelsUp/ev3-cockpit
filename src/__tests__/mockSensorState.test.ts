import assert from 'node:assert/strict';
import test from 'node:test';
import { MockSensorState } from '../mock/state/mockSensorState';
import { EV3_SENSOR_TYPE } from '../device/sensorTypes';
import type { MockSensorConfig } from '../mock/mockTypes';

function makeSensors(configs: MockSensorConfig[]): MockSensorState {
	return new MockSensorState(configs);
}

test('empty config gives EMPTY type on all ports', () => {
	const s = makeSensors([]);
	for (const port of [0, 1, 2, 3] as const) {
		assert.equal(s.getTypeCode(port), EV3_SENSOR_TYPE.EMPTY);
		assert.equal(s.readValue(port), 0);
	}
});

test('constant generator returns fixed value', () => {
	const s = makeSensors([
		{ port: 0, typeCode: EV3_SENSOR_TYPE.EV3_TOUCH, mode: 0, generator: { kind: 'constant', value: 1 } }
	]);
	assert.equal(s.readValue(0), 1);
	s.tick(1000);
	assert.equal(s.readValue(0), 1);
});

test('sine generator oscillates between min and max', () => {
	const s = makeSensors([
		{ port: 1, typeCode: EV3_SENSOR_TYPE.EV3_COLOR, mode: 0,
			generator: { kind: 'sine', min: 0, max: 100, periodMs: 1000 } }
	]);
	// At t=0, sin(0)=0, value = 50 + 50*0 = 50
	assert.ok(Math.abs(s.readValue(1) - 50) < 1, `initial value ~50, got ${s.readValue(1)}`);

	// At t=250ms (quarter period), sin(π/2)=1, value = 50 + 50*1 = 100
	s.tick(250);
	assert.ok(Math.abs(s.readValue(1) - 100) < 1, `quarter value ~100, got ${s.readValue(1)}`);

	// At t=500ms (half period), sin(π)≈0, value = ~50
	s.tick(250);
	assert.ok(Math.abs(s.readValue(1) - 50) < 1, `half value ~50, got ${s.readValue(1)}`);

	// At t=750ms (3/4 period), sin(3π/2)=-1, value = 50 + 50*(-1) = 0
	s.tick(250);
	assert.ok(Math.abs(s.readValue(1) - 0) < 1, `3/4 value ~0, got ${s.readValue(1)}`);
});

test('randomWalk generator stays within bounds', () => {
	const s = makeSensors([
		{ port: 2, typeCode: EV3_SENSOR_TYPE.EV3_ULTRASONIC, mode: 0,
			generator: { kind: 'randomWalk', min: 0, max: 100, stepSize: 5 } }
	]);
	for (let i = 0; i < 200; i++) {
		s.tick(10);
		const val = s.readValue(2);
		assert.ok(val >= 0 && val <= 100, `value ${val} in bounds [0, 100]`);
	}
});

test('step generator cycles through values', () => {
	const s = makeSensors([
		{ port: 3, typeCode: EV3_SENSOR_TYPE.EV3_GYRO, mode: 0,
			generator: { kind: 'step', values: [10, 20, 30], intervalMs: 100 } }
	]);
	assert.equal(s.readValue(3), 10);

	s.tick(100);
	assert.equal(s.readValue(3), 20);

	s.tick(100);
	assert.equal(s.readValue(3), 30);

	s.tick(100);
	assert.equal(s.readValue(3), 10); // wraps
});

test('setMode updates port type and mode', () => {
	const s = makeSensors([
		{ port: 0, typeCode: EV3_SENSOR_TYPE.EV3_COLOR, mode: 0, generator: { kind: 'constant', value: 5 } }
	]);
	assert.equal(s.getTypeCode(0), EV3_SENSOR_TYPE.EV3_COLOR);
	assert.equal(s.getMode(0), 0);

	s.setMode(0, EV3_SENSOR_TYPE.EV3_COLOR, 2);
	assert.equal(s.getTypeCode(0), EV3_SENSOR_TYPE.EV3_COLOR);
	assert.equal(s.getMode(0), 2);
});

test('tick does not advance EMPTY ports', () => {
	const s = makeSensors([]);
	s.tick(5000);
	// Should not throw and value stays 0
	assert.equal(s.readValue(0), 0);
});
