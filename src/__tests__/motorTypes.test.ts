import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isMotorPort,
	motorPortIndex,
	MOTOR_PORTS,
	MOTOR_PORT_MASK
} from '../device/motorTypes';

test('isMotorPort accepts valid ports A-D', () => {
	for (const port of ['A', 'B', 'C', 'D']) {
		assert.equal(isMotorPort(port), true, `Port ${port} should be valid`);
	}
});

test('isMotorPort rejects invalid values', () => {
	for (const invalid of ['E', 'a', '1', '', 'AB']) {
		assert.equal(isMotorPort(invalid), false, `Value "${invalid}" should be invalid`);
	}
});

test('motorPortIndex returns 0-based index', () => {
	assert.equal(motorPortIndex('A'), 0);
	assert.equal(motorPortIndex('B'), 1);
	assert.equal(motorPortIndex('C'), 2);
	assert.equal(motorPortIndex('D'), 3);
});

test('MOTOR_PORTS contains all four ports', () => {
	assert.deepEqual([...MOTOR_PORTS], ['A', 'B', 'C', 'D']);
});

test('MOTOR_PORT_MASK maps to correct bitmask values', () => {
	assert.equal(MOTOR_PORT_MASK.A, 0x01);
	assert.equal(MOTOR_PORT_MASK.B, 0x02);
	assert.equal(MOTOR_PORT_MASK.C, 0x04);
	assert.equal(MOTOR_PORT_MASK.D, 0x08);
	assert.equal(MOTOR_PORT_MASK.ALL, 0x0f);
});
