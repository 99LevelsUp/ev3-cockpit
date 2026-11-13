/**
 * Whether a program runs, as a telemetry row (step-6 plan U9; owner decisions D5, D8, D11).
 *
 * The program service used to poll `program:status` with a command of its own. As a row it rides
 * in the frame every read brick already sends (D8), and the telemetry service can slow the loop
 * while a program runs (D11). The encoding is the `program:status` command's, already verified on
 * bricks, so it is compared against that rather than written from the specification again.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { makeBrickKey, Transport } from '../contracts';
import { MockTransportProvider } from '../mock/mockTransportProvider';
import { buildCommand } from '../protocol/ev3Commands';
import { EV3_OPCODE, PROGRAM_INFO_SUB, PROGRAM_SLOT, PROGRAM_STATUS } from '../protocol/ev3Packet';
import { concatBytes, gv0, lc0, uint16le } from '../protocol/ev3Bytecode';
import { assembleFrame, buildTelemetryFrame, parseFrame } from '../telemetry/frameAssembler';
import { createEv3RowRegistry } from '../telemetry/rowRegistry';

const ROW = 'program.user.running';
const KEY = makeBrickKey(Transport.Mock, 'M1');
const PRG = '/home/root/lms2012/prjs/Demo/Demo.rbf';

const rowOf = () => {
	const row = createEv3RowRegistry().get(ROW);
	assert.ok(row, `no row ${ROW}`);
	return row;
};

describe('The program row (step-6 U9)', () => {
	it('is an event row of one byte that every read brick carries', () => {
		const row = rowOf();
		assert.equal(row.tier, 'event');
		assert.deepEqual(row.result, { bytes: 1, alignment: 1 });
	});

	it('asks what the program:status command asks, into its own global slot', () => {
		const status = buildCommand({ kind: 'program:status' });
		// The command's bytecode follows its two-byte globals/locals header; its global is slot 0.
		assert.deepEqual([...rowOf().emit(0)], [...status.payload.slice(2)]);
	});

	it('reads running only from RUNNING, and anything else as not running', () => {
		const row = rowOf();
		const read = (status: number) => row.parse(new Uint8Array([status]), 0, 5).value;
		assert.equal(read(PROGRAM_STATUS.RUNNING), true);
		assert.equal(read(PROGRAM_STATUS.STOPPED), false);
		assert.equal(read(0x20), false, 'a halted or unknown slot is not a running program');
	});

	it('is answered by the mock from its own program state', async () => {
		const mock = new MockTransportProvider({
			transport: Transport.Mock,
			bricks: [{
				id: 'M1', displayName: 'M1', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
				filesystem: [{ path: PRG, content: 'LEGO-rbf-image' }],
			}],
		} as never);
		await mock.connect(KEY);
		const frame = assembleFrame([rowOf()], { maxPacketBytes: 1024 });
		const read = async () => {
			const reply = await mock.executeCommand(KEY, { kind: 'telemetry:frame', payload: buildTelemetryFrame(frame) });
			return parseFrame(frame, (reply as { payload: Uint8Array }).payload, 1)[0]?.value;
		};
		try {
			assert.equal(await read(), false);
			await mock.executeCommand(KEY, { kind: 'program:run', path: PRG });
			assert.equal(await read(), true);
			// The debug slot runs nothing: the mock answers per slot, as the firmware does.
			const debug = concatBytes(uint16le(1), new Uint8Array([EV3_OPCODE.PROGRAM_INFO]),
				lc0(PROGRAM_INFO_SUB.GET_STATUS), lc0(PROGRAM_SLOT.DEBUG), gv0(0));
			const reply = await mock.executeCommand(KEY, { kind: 'telemetry:frame', payload: debug });
			assert.equal((reply as { payload: Uint8Array }).payload[0], PROGRAM_STATUS.STOPPED);
			await mock.executeCommand(KEY, { kind: 'program:stop' });
			assert.equal(await read(), false);
		} finally {
			mock.dispose();
		}
	});
});
