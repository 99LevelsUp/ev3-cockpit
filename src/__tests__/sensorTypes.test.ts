import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isSensorPort,
	sensorPortLabel,
	sensorTypeName,
	isSensorConnected,
	EV3_SENSOR_TYPE,
	SENSOR_PORTS
} from '../device/sensorTypes';

test('isSensorPort accepts valid ports 0-3', () => {
	for (const port of [0, 1, 2, 3]) {
		assert.equal(isSensorPort(port), true, `Port ${port} should be valid`);
	}
});

test('isSensorPort rejects invalid values', () => {
	for (const invalid of [-1, 4, 0.5, NaN]) {
		assert.equal(isSensorPort(invalid), false, `Value ${invalid} should be invalid`);
	}
});

test('sensorPortLabel formats 1-based labels', () => {
	assert.equal(sensorPortLabel(0), 'Port 1');
	assert.equal(sensorPortLabel(3), 'Port 4');
});

test('SENSOR_PORTS contains all four ports', () => {
	assert.deepEqual([...SENSOR_PORTS], [0, 1, 2, 3]);
});

test('sensorTypeName maps known type codes', () => {
	assert.equal(sensorTypeName(EV3_SENSOR_TYPE.EV3_TOUCH), 'EV3 TOUCH');
	assert.equal(sensorTypeName(EV3_SENSOR_TYPE.EV3_COLOR), 'EV3 COLOR');
	assert.equal(sensorTypeName(EV3_SENSOR_TYPE.NONE), 'NONE');
	assert.equal(sensorTypeName(EV3_SENSOR_TYPE.EMPTY), 'EMPTY');
});

test('sensorTypeName returns fallback for unknown codes', () => {
	assert.equal(sensorTypeName(99), 'Unknown (99)');
});

test('isSensorConnected returns true for real sensors', () => {
	assert.equal(isSensorConnected(EV3_SENSOR_TYPE.EV3_TOUCH), true);
	assert.equal(isSensorConnected(EV3_SENSOR_TYPE.EV3_COLOR), true);
	assert.equal(isSensorConnected(EV3_SENSOR_TYPE.NXT_TOUCH), true);
	assert.equal(isSensorConnected(EV3_SENSOR_TYPE.EV3_LARGE_MOTOR), true);
});

test('isSensorConnected returns false for empty/error/init slots', () => {
	assert.equal(isSensorConnected(EV3_SENSOR_TYPE.NONE), false);
	assert.equal(isSensorConnected(EV3_SENSOR_TYPE.EMPTY), false);
	assert.equal(isSensorConnected(EV3_SENSOR_TYPE.INITIALIZING), false);
	assert.equal(isSensorConnected(EV3_SENSOR_TYPE.ERROR), false);
	assert.equal(isSensorConnected(EV3_SENSOR_TYPE.UNKNOWN), false);
});
