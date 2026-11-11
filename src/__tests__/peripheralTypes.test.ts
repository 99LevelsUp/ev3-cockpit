/**
 * The peripheral vocabulary (step-6 plan, U2; IMPLEMENTATION_PLAN 3.1.4, 3.2.5).
 *
 * A closed vocabulary cannot name a device nobody has heard of, so the raw type code always
 * travels beside the name (DESIGN §9.3). Codes from `bytecodes.h` of firmware 1.09d.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { peripheralTypeOf, typeCodeOf } from '../protocol/peripheralTypes';

describe('Peripheral vocabulary (step-6 U2)', () => {
	it('names the EV3 devices by the firmware\'s codes', () => {
		assert.equal(peripheralTypeOf(7), 'large-motor');
		assert.equal(peripheralTypeOf(8), 'medium-motor');
		assert.equal(peripheralTypeOf(16), 'touch-sensor');
		assert.equal(peripheralTypeOf(29), 'color-sensor');
		assert.equal(peripheralTypeOf(30), 'ultrasonic-sensor');
		assert.equal(peripheralTypeOf(32), 'gyro-sensor');
		assert.equal(peripheralTypeOf(33), 'infrared-sensor');
	});

	it('names the port states the firmware reports instead of a device', () => {
		assert.equal(peripheralTypeOf(124), 'terminal');
		assert.equal(peripheralTypeOf(125), 'identifying');
		assert.equal(peripheralTypeOf(126), 'none');
		assert.equal(peripheralTypeOf(127), 'error');
	});

	it('names a third-party device by its range and anything else as unrecognised, never guessing', () => {
		assert.equal(peripheralTypeOf(50), 'third-party');
		assert.equal(peripheralTypeOf(98), 'third-party');
		assert.equal(peripheralTypeOf(42), 'unrecognised');
		assert.equal(peripheralTypeOf(200), 'unrecognised');
	});

	it('maps every name the mock configuration uses back to a code', () => {
		for (const name of ['large-motor', 'medium-motor', 'touch-sensor', 'color-sensor', 'ultrasonic-sensor'] as const) {
			const code = typeCodeOf(name);
			assert.ok(code !== undefined, `${name} has no code`);
			assert.equal(peripheralTypeOf(code), name);
		}
		assert.equal(typeCodeOf('third-party'), undefined, 'a range is not one code');
	});
});
