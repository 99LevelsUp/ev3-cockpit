/**
 * A port has five states (step-6 plan U4, KTD7; IMPLEMENTATION_PLAN 3.1.11; DESIGN §9.1c).
 *
 * The occupancy row reports a type code; the state is what the panel and the API show, and the
 * value is read only when the port is known. Codes from `bytecodes.h` of firmware 1.09d.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { portStateOf } from '../telemetry/portState';
import { peripheralTypeOf } from '../protocol/peripheralTypes';
import { isReadableType } from '../telemetry/telemetryScheduler';

describe('Port state (step-6 U4)', () => {
	it('names the five states by the firmware\'s codes', () => {
		assert.equal(portStateOf(126), 'empty');
		assert.equal(portStateOf(125), 'identifying');
		assert.equal(portStateOf(127), 'error');
		assert.equal(portStateOf(124), 'terminal');
		assert.equal(portStateOf(30), 'known');
		assert.equal(portStateOf(7), 'known');
	});

	it('says a port nothing has reported on yet is unreported, not empty', () => {
		assert.equal(portStateOf(undefined), 'unreported');
	});

	it('shows any other code at or above 124 as not readable rather than guessing', () => {
		assert.equal(portStateOf(128), 'not-readable');
		assert.equal(portStateOf(200), 'not-readable');
	});

	it('treats an IIC device the firmware\'s list does not name (100) as a known device: it stays so (c_input.c 3029-3047)', () => {
		assert.equal(portStateOf(100), 'known');
		assert.equal(peripheralTypeOf(100), 'iic-unlisted');
	});

	it('reads a value only from a known port', () => {
		for (const code of [0, 7, 30, 100, 123]) { assert.equal(isReadableType(code), true, `${code}`); }
		for (const code of [124, 125, 126, 127, 128, 200]) { assert.equal(isReadableType(code), false, `${code}`); }
	});
});
