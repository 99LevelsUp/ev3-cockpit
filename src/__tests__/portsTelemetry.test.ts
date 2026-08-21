/**
 * The ports command and its parser, verified against three real bricks.
 *
 * Everything asserted here was wrong in the shipped code until it was checked against
 * hardware, and none of it was visible to the tests that existed: those checked the global
 * byte count and the length of the returned arrays, which stay correct however wrong the
 * opcode and the type names are.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCommand } from '../protocol/ev3Commands';
import { parseResponse } from '../protocol/ev3Responses';
import { EV3_OPCODE, EV3_REPLY } from '../protocol';
import { PortState, PortsResponse } from '../contracts';

/** A ports reply: 8 bytes sensor type/mode, 8 motor, 16 sensor SI, 16 tacho. */
function portsPayload(options: {
	sensorTypes?: number[];
	motorTypes?: number[];
	sensorValues?: number[];
	tachos?: number[];
}): Uint8Array {
	const payload = Buffer.alloc(48, 0);
	const sensorTypes = options.sensorTypes ?? [126, 126, 126, 126];
	const motorTypes = options.motorTypes ?? [126, 126, 126, 126];
	for (let i = 0; i < 4; i += 1) {
		payload[i * 2] = sensorTypes[i];
		payload[8 + i * 2] = motorTypes[i];
		payload.writeFloatLE(options.sensorValues?.[i] ?? 0, 16 + i * 4);
		payload.writeInt32LE(options.tachos?.[i] ?? 0, 32 + i * 4);
	}
	return new Uint8Array(payload);
}

function parsePorts(payload: Uint8Array): PortsResponse {
	return parseResponse(
		{ kind: 'ports' },
		{ messageCounter: 1, type: EV3_REPLY.DIRECT_REPLY, payload },
	) as PortsResponse;
}

describe('ports command', () => {
	it('reads sensors with opINPUT_READSI, not opINPUT_READ', () => {
		// 0x9A is opINPUT_READ, whose output parameter is PAR8 — a single percent byte.
		// The parser reads four bytes as a float, so with the wrong opcode three of them
		// are whatever the previous command left in the brick's global buffer. On hardware
		// that showed up as legible ASCII where a distance should have been.
		const payload = buildCommand({ kind: 'ports' }).payload;
		assert.ok(
			payload.includes(EV3_OPCODE.INPUT_READ_SI),
			'the ports command must contain the SI read opcode'
		);
		assert.equal(EV3_OPCODE.INPUT_READ_SI, 0x9d, 'opINPUT_READSI per the firmware opcode table');
		assert.ok(
			!payload.includes(0x9a),
			'0x9A is opINPUT_READ and returns one byte, not a float'
		);
	});
});

describe('ports response — device types', () => {
	it('names the codes the bricks actually report', () => {
		// 16 was named 'color' and 29 'color-v2', so a brick with a touch sensor plugged in
		// reported a colour sensor and no touch sensor anywhere. All six were verified by
		// moving each device and watching the value change.
		const result = parsePorts(portsPayload({ sensorTypes: [16, 29, 30, 32] }));
		assert.deepEqual(
			result.sensorPorts.map((p: PortState) => p.peripheralType),
			['touch', 'color', 'ultrasonic', 'gyro']
		);
	});

	it('separates the NXT touch sensor from the EV3 one', () => {
		// Both exist and they are different codes; calling code 1 plain 'touch' invited
		// exactly the confusion above.
		const result = parsePorts(portsPayload({ sensorTypes: [1, 33, 126, 126] }));
		assert.equal(result.sensorPorts[0].peripheralType, 'nxt-touch');
		assert.equal(result.sensorPorts[1].peripheralType, 'infrared');
	});

	it('names both motor types', () => {
		const result = parsePorts(portsPayload({ motorTypes: [7, 8, 126, 126] }));
		assert.deepEqual(
			result.motorPorts.map((p: PortState) => p.peripheralType),
			['large-motor', 'medium-motor', undefined, undefined]
		);
	});

	it('reports an unrecognised code rather than hiding it', () => {
		const result = parsePorts(portsPayload({ sensorTypes: [99, 126, 126, 126] }));
		assert.equal(result.sensorPorts[0].peripheralType, 'sensor-99');
	});
});

describe('ports response — a port status is not a reading', () => {
	it('distinguishes a device that is still identifying itself from an empty port', () => {
		// 125 is TYPE_UNKNOWN: "port not empty but type has not been determined". Every
		// sensor plugged in while running passes through it for a second or two, so it is
		// the normal case during a hot-plug rather than an oddity.
		const result = parsePorts(portsPayload({
			sensorTypes: [125, 126, 127, 30],
			sensorValues: [42, 42, 42, 17.5],
			motorTypes: [125, 126, 127, 7],
			tachos: [42, 42, 42, -66],
		}));

		assert.equal(result.sensorPorts[0].peripheralType, 'unknown');
		assert.equal(result.sensorPorts[1].peripheralType, undefined, 'empty port has no type');
		assert.equal(result.sensorPorts[2].peripheralType, 'error');

		// A motor hot-plugged mid-session passes through the same states, and the fix reached
		// the sensor table first — without this the motor side reports `motor-125`.
		assert.equal(result.motorPorts[0].peripheralType, 'unknown');
		assert.equal(result.motorPorts[0].value, undefined);
		assert.equal(result.motorPorts[2].peripheralType, 'error');
		assert.equal(result.motorPorts[2].value, undefined);
		assert.equal(result.motorPorts[3].value, -66, 'a real motor keeps its tacho');

		// None of the three has a usable reading, and the slot behind it holds whatever the
		// last command left there — the firmware does not clear the global buffer.
		assert.equal(result.sensorPorts[0].value, undefined);
		assert.equal(result.sensorPorts[1].value, undefined);
		assert.equal(result.sensorPorts[2].value, undefined);
		assert.equal(result.sensorPorts[3].value, 17.5, 'a real device keeps its reading');
	});

	it('drops a NaN reading instead of passing it on', () => {
		// DATAF_NAN is defined as 0/0, so a device with nothing to say yet arrives as a
		// real NaN. Switching a UART sensor's mode produces one, verified on hardware.
		const payload = Buffer.from(portsPayload({ sensorTypes: [29, 126, 126, 126] }));
		payload.writeFloatLE(NaN, 16);
		const result = parsePorts(new Uint8Array(payload));

		assert.equal(result.sensorPorts[0].peripheralType, 'color', 'the device is still there');
		assert.equal(result.sensorPorts[0].value, undefined);
	});

	it('drops a DATA32_NAN tacho and the unit with it', () => {
		const result = parsePorts(portsPayload({
			motorTypes: [7, 8, 126, 126],
			tachos: [-2147483648, -66, 0, 0],
		}));

		assert.equal(result.motorPorts[0].value, undefined);
		assert.equal(result.motorPorts[0].unit, undefined, 'no reading means no unit either');
		assert.equal(result.motorPorts[1].value, -66, 'a negative tacho is a real position');
		assert.equal(result.motorPorts[1].unit, 'deg');
	});

	it('never reports a value for an empty port', () => {
		// The trap this whole exercise exposed: zero is not absence. A brick with no motors
		// at all returned four tacho zeros, and they were stale bytes rather than readings.
		const result = parsePorts(portsPayload({
			sensorValues: [1, 2, 3, 4],
			tachos: [10, 20, 30, 40],
		}));

		for (const port of [...result.sensorPorts, ...result.motorPorts]) {
			assert.equal(port.peripheralType, undefined);
			assert.equal(port.value, undefined);
		}
	});
});
