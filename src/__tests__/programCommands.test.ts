/**
 * The program and shell direct commands (step-5 plan, U1), pinned byte for byte.
 *
 * The bytes follow the firmware's own example of a PC loading and starting a program
 * (`c_com.h` 820–843: `opFILE, LC0(LOAD_IMAGE), LC0(USER_SLOT), LCS "…", …, opPROGRAM_START,
 * LC0(USER_SLOT), …, LC0(0)`), with global variables in place of its local ones so the reply
 * carries the loaded image's size. Opcode and subcode values from `bytecodes.h`: opFILE 0xC0 /
 * LOAD_IMAGE 8, opPROGRAM_START 0x03, opPROGRAM_STOP 0x02, opPROGRAM_INFO 0x0C / GET_STATUS 22,
 * opSYSTEM 0x60, opINPUT_DEVICE 0x99 / STOP_ALL 13; slots USER 1, DEBUG 4.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { buildCommand } from '../protocol/ev3Commands';
import { parseResponse } from '../protocol/ev3Responses';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import type { BrickCommand } from '../contracts';

const PATH = '../prjs/Demo/Demo.rbf';
/** LCS: 0x84, the bytes, a terminating zero. */
const lcs = (text: string): number[] => [0x84, ...Buffer.from(text, 'utf8'), 0x00];
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const reply = (payload: number[]) => ({ messageCounter: 1, type: EV3_REPLY.DIRECT_REPLY, payload: new Uint8Array(payload) });

describe('Program and shell direct commands (step-5 U1)', () => {
	it('loads an image into the user slot and starts it there, the reply carrying the size', () => {
		const encoded = buildCommand({ kind: 'program:run', path: PATH });

		assert.equal(encoded.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
		assert.equal(hex(encoded.payload), hex(new Uint8Array([
			0x08, 0x00,                                   // 8 global bytes, no locals
			0xc0, 0x08, 0x01, ...lcs(PATH), 0x60, 0x64,  // FILE LOAD_IMAGE USER_SLOT name → GV0(0) size, GV0(4) address
			0x03, 0x01, 0x60, 0x64, 0x00,                 // PROGRAM_START USER_SLOT size address debug 0
		])));
	});

	it('reads the size of the loaded image: 0 when the file is not on the brick', () => {
		const command: BrickCommand = { kind: 'program:run', path: PATH };

		assert.deepEqual(parseResponse(command, reply([0x2c, 0x01, 0, 0, 0x10, 0x20, 0, 0])), { kind: 'program:run', imageBytes: 300 });
		assert.deepEqual(parseResponse(command, reply([0, 0, 0, 0, 0, 0, 0, 0])), { kind: 'program:run', imageBytes: 0 });
	});

	it('refuses an empty path before anything is sent', () => {
		assert.throws(() => buildCommand({ kind: 'program:run', path: '' }));
	});

	it('stops the user slot only, never slot 0 (all slots, the brick UI too)', () => {
		const encoded = buildCommand({ kind: 'program:stop' });

		assert.equal(hex(encoded.payload), hex(new Uint8Array([0x00, 0x00, 0x02, 0x01])));
	});

	it('asks for the user slot\'s status and reads running (0x10) or stopped (0x40)', () => {
		const command: BrickCommand = { kind: 'program:status' };

		assert.equal(hex(buildCommand(command).payload), hex(new Uint8Array([0x01, 0x00, 0x0c, 0x16, 0x01, 0x60])));
		assert.deepEqual(parseResponse(command, reply([0x10])), { kind: 'program:status', running: true, status: 0x10 });
		assert.deepEqual(parseResponse(command, reply([0x40])), { kind: 'program:status', running: false, status: 0x40 });
	});

	it('stops in an emergency as the brick\'s own power-off does: user slot, debug slot, every motor', () => {
		const encoded = buildCommand({ kind: 'program:emergencyStop' });

		assert.equal(hex(encoded.payload), hex(new Uint8Array([
			0x00, 0x00,
			0x02, 0x01,        // PROGRAM_STOP USER_SLOT
			0x02, 0x04,        // PROGRAM_STOP DEBUG_SLOT
			0x99, 0x0d, 0x3f,  // INPUT_DEVICE STOP_ALL layer -1 (every brick in a chain)
		])));
	});

	it('runs a shell command and reads its exit status', () => {
		const command: BrickCommand = { kind: 'system:run', command: 'echo hi' };

		assert.equal(hex(buildCommand(command).payload), hex(new Uint8Array([0x04, 0x00, 0x60, ...lcs('echo hi'), 0x60])));
		assert.deepEqual(parseResponse(command, reply([0x00, 0x01, 0x00, 0x00])), { kind: 'system:run', status: 256 });
	});

	it('refuses an empty shell command before anything is sent', () => {
		assert.throws(() => buildCommand({ kind: 'system:run', command: '  ' }));
	});
});
