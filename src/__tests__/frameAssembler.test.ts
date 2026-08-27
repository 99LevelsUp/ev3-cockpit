/**
 * The frame assembler: offsets, budgets, and what happens to what does not fit.
 *
 * Each case here is something the multi-engine review of 27.08.2026 found the design got
 * wrong, or something measured on a brick that a plausible implementation would miss:
 *
 *  - a 32-bit result on an unaligned offset makes `opINPUT_READSI` reject the whole command
 *    and answer DIRECT_REPLY_ERROR carrying the previous payload (measured 3/3);
 *  - the reply is always *declared* globals + 5 bytes, so the declaration is a budget of its
 *    own and alignment padding can breach it before the instruction count binds;
 *  - truncation that drops rather than defers starves the losing rows for good.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	assembleFrame,
	assertNoModeConflict,
	buildTelemetryFrame,
	bytecodeBudgetFor,
	globalBudgetFor,
	globalRefBytes,
	MAX_USABLE_GLOBAL_BYTES,
	parseFrame,
	validateRow,
	FrameAssemblyError,
} from '../telemetry/frameAssembler';
import { TelemetryRow } from '../telemetry/telemetryRow';
import { readFloat32le } from '../protocol/ev3Bytecode';

const HID = { maxPacketBytes: 64 };
const LIBUSB = { maxPacketBytes: 1024 };

/**
 * A row whose emitted bytecode records the slot it was given, so a test can assert the
 * layout from the wire bytes rather than only from the returned structure.
 */
function row(options: {
	id: string;
	bytes: number;
	alignment: 1 | 2 | 4;
	port?: string;
	mode?: number;
	/** Extra bytecode bytes beyond the one-byte marker and the global reference. */
	padBytes?: number;
}): TelemetryRow {
	const { id, bytes, alignment, port, mode, padBytes = 0 } = options;
	return {
		id,
		tier: 'sampled',
		lifetime: { kind: 'repeating', divider: 1 },
		result: { bytes, alignment },
		port,
		mode,
		emit: (slot) => new Uint8Array([0xaa, ...new Array(padBytes).fill(0), slot & 0xff]),
		parse: (payload, slot, sampledAt) => ({
			rowId: id,
			value: bytes === 4 ? readFloat32le(payload, slot) : payload[slot],
			sampledAt,
		}),
	};
}

describe('frame assembler — budgets', () => {
	it('caps the reply at what fits inside MAX_MSG_SIZE, not at MAX_COMMAND_GLOBALS', () => {
		// The firmware validates globals <= 1021 on the way in and never re-checks the reply,
		// which is globals + 5. A 1024-byte link therefore tops out at 1019, not 1021.
		assert.equal(globalBudgetFor(LIBUSB), MAX_USABLE_GLOBAL_BYTES);
		assert.equal(MAX_USABLE_GLOBAL_BYTES, 1019);
	});

	it('gives the request 7 fewer bytes than the packet and the reply 5 fewer', () => {
		assert.equal(bytecodeBudgetFor(HID), 57);
		assert.equal(globalBudgetFor(HID), 59);
	});

	it('refuses a row whose result can never come back on this link', () => {
		const tooWide = row({ id: 'wide', bytes: 60, alignment: 4 });
		assert.throws(() => validateRow(tooWide, HID), FrameAssemblyError);
		// The same row is fine over libusb, so this is a property of the link.
		assert.doesNotThrow(() => validateRow(tooWide, LIBUSB));
	});

	it('refuses a row whose byte count cannot tile its own alignment', () => {
		assert.throws(
			() => validateRow(row({ id: 'odd', bytes: 3, alignment: 4 }), LIBUSB),
			FrameAssemblyError,
		);
	});
});

describe('frame assembler — layout', () => {
	it('puts 32-bit results first so alignment costs no padding', () => {
		const frame = assembleFrame([
			row({ id: 'byte.a', bytes: 1, alignment: 1 }),
			row({ id: 'float.a', bytes: 4, alignment: 4 }),
			row({ id: 'byte.b', bytes: 1, alignment: 1 }),
			row({ id: 'float.b', bytes: 4, alignment: 4 }),
		], LIBUSB);

		assert.deepEqual(
			frame.placed.map((p) => [p.row.id, p.slot]),
			[['float.a', 0], ['float.b', 4], ['byte.a', 8], ['byte.b', 9]],
		);
		// No padding anywhere: the declaration is exactly the sum of the results.
		assert.equal(frame.globalBytes, 10);
	});

	it('never places a 32-bit result on an offset the brick would reject', () => {
		// Three single bytes then a float: naive sequential layout would put the float at 3.
		const frame = assembleFrame([
			row({ id: 'b0', bytes: 1, alignment: 1 }),
			row({ id: 'b1', bytes: 1, alignment: 1 }),
			row({ id: 'b2', bytes: 1, alignment: 1 }),
			row({ id: 'f', bytes: 4, alignment: 4 }),
		], LIBUSB);

		for (const { row: r, slot } of frame.placed) {
			assert.equal(slot % r.result.alignment, 0, `${r.id} landed on ${slot}`);
		}
	});

	it('preserves the caller order within one alignment class, because that is the priority', () => {
		const frame = assembleFrame([
			row({ id: 'first', bytes: 1, alignment: 1 }),
			row({ id: 'second', bytes: 1, alignment: 1 }),
			row({ id: 'third', bytes: 1, alignment: 1 }),
		], LIBUSB);

		assert.deepEqual(frame.placed.map((p) => p.row.id), ['first', 'second', 'third']);
	});

	it('spends a second byte on a global reference past offset 31', () => {
		assert.equal(globalRefBytes(31), 1);
		assert.equal(globalRefBytes(32), 2);
	});

	it('keeps every slot aligned and spends no padding, over many shapes', () => {
		// Two independent protections produce this: wide results are laid out first, and
		// alignUp would pad if they were not. Asserting both properties at once means a
		// change that removes either one is caught — the first clause by a slot landing
		// wrong, the second by the declaration growing past the sum of the results.
		const shapes: Array<[number, 1 | 2 | 4]> = [[1, 1], [2, 2], [4, 4], [8, 4], [2, 1]];
		for (let seed = 0; seed < 40; seed += 1) {
			const rows = Array.from({ length: 6 }, (_, i) => {
				const [bytes, alignment] = shapes[(seed * 7 + i * 3) % shapes.length];
				return row({ id: `s${seed}.r${i}`, bytes, alignment });
			});

			const frame = assembleFrame(rows, LIBUSB);

			for (const { row: r, slot } of frame.placed) {
				assert.equal(slot % r.result.alignment, 0,
					`seed ${seed}: ${r.id} (align ${r.result.alignment}) landed on ${slot}`);
			}
			const sumOfResults = frame.placed.reduce((n, p) => n + p.row.result.bytes, 0);
			assert.equal(frame.globalBytes, sumOfResults,
				`seed ${seed}: ${frame.globalBytes - sumOfResults} bytes went to padding`);
		}
	});
});

describe('frame assembler — truncation', () => {
	it('defers what does not fit instead of dropping it', () => {
		// Each row costs 2 bytecode bytes and 4 result bytes. On HID the reply budget of 59
		// binds first: 14 rows fit (56 bytes), the 15th does not.
		const rows = Array.from({ length: 20 }, (_, i) =>
			row({ id: `r${i}`, bytes: 4, alignment: 4 }));

		const frame = assembleFrame(rows, HID);

		assert.equal(frame.placed.length + frame.deferred.length, 20,
			'every row is either placed or deferred — none vanishes');
		assert.ok(frame.globalBytes <= globalBudgetFor(HID));
		assert.ok(frame.bytecode.length <= bytecodeBudgetFor(HID));
		// Deferred rows keep their order, so the scheduler can put them at the front of the
		// next tick and the loser of this tick wins the next one.
		assert.deepEqual(
			frame.deferred.map((r) => r.id),
			rows.slice(frame.placed.length).map((r) => r.id),
		);
	});

	it('lets the declaration bind before the instruction count', () => {
		// One bytecode byte each, four result bytes each: 59/4 = 14 rows by declaration,
		// while the 57-byte bytecode budget would have allowed far more.
		const rows = Array.from({ length: 30 }, (_, i) =>
			row({ id: `r${i}`, bytes: 4, alignment: 4 }));

		const frame = assembleFrame(rows, HID);

		assert.ok(frame.deferred.length > 0, 'something was deferred');
		assert.ok(
			frame.bytecode.length < bytecodeBudgetFor(HID),
			'the bytecode budget still had room, so the reply budget is what bound',
		);
	});

	it('takes everything when the link is wide', () => {
		const rows = Array.from({ length: 20 }, (_, i) =>
			row({ id: `r${i}`, bytes: 4, alignment: 4 }));

		const frame = assembleFrame(rows, LIBUSB);

		assert.equal(frame.deferred.length, 0);
		assert.equal(frame.placed.length, 20);
	});

	it('refuses rather than emitting a frame that can carry nothing', () => {
		assert.throws(
			() => assembleFrame([row({ id: 'huge', bytes: 4, alignment: 4, padBytes: 80 })], HID),
			FrameAssemblyError,
		);
	});
});

describe('frame assembler — mode ownership', () => {
	it('refuses two modes of one port', () => {
		assert.throws(() => assertNoModeConflict([
			row({ id: 'p1.mode0', bytes: 4, alignment: 4, port: '1', mode: 0 }),
			row({ id: 'p1.mode2', bytes: 4, alignment: 4, port: '1', mode: 2 }),
		]), FrameAssemblyError);
	});

	it('allows several reads of the same mode, as LEGOev3 does', () => {
		// SI, RAW and PCT off one port in one frame — measured working on a brick.
		assert.doesNotThrow(() => assertNoModeConflict([
			row({ id: 'p1.si', bytes: 4, alignment: 4, port: '1', mode: 0 }),
			row({ id: 'p1.raw', bytes: 4, alignment: 4, port: '1', mode: 0 }),
			row({ id: 'p1.pct', bytes: 1, alignment: 1, port: '1', mode: 0 }),
		]));
	});

	it('allows different modes on different ports', () => {
		assert.doesNotThrow(() => assertNoModeConflict([
			row({ id: 'p1', bytes: 4, alignment: 4, port: '1', mode: 0 }),
			row({ id: 'p2', bytes: 4, alignment: 4, port: '2', mode: 3 }),
		]));
	});
});

describe('frame assembler — the wire and back', () => {
	it('declares the globals word the firmware reads', () => {
		const frame = assembleFrame([row({ id: 'f', bytes: 4, alignment: 4 })], LIBUSB);
		const payload = buildTelemetryFrame(frame);

		// [globals:u16le] then the bytecode. Locals are zero: a frame computes nothing.
		assert.equal(payload[0], 4);
		assert.equal(payload[1], 0);
		assert.deepEqual(payload.slice(2), frame.bytecode);
	});

	it('parses each row from the recorded slot, not from a guessed one', () => {
		const frame = assembleFrame([
			row({ id: 'b', bytes: 1, alignment: 1 }),
			row({ id: 'f', bytes: 4, alignment: 4 }),
		], LIBUSB);

		// Layout is float at 0, byte at 4 — the reverse of the caller's order, which is
		// exactly why the parser must be told rather than left to infer.
		const payload = new Uint8Array(5);
		new DataView(payload.buffer).setFloat32(0, 12.5, true);
		payload[4] = 99;

		const values = parseFrame(frame, payload, 1000);
		const byId = new Map(values.map((v) => [v.rowId, v.value]));
		assert.equal(byId.get('f'), 12.5);
		assert.equal(byId.get('b'), 99);
	});

	it('stamps every value with the tick it came from', () => {
		const frame = assembleFrame([row({ id: 'f', bytes: 4, alignment: 4 })], LIBUSB);
		const values = parseFrame(frame, new Uint8Array(4), 4242);
		assert.equal(values[0].sampledAt, 4242);
	});

	it('refuses to declare more globals than can come back', () => {
		assert.throws(() => buildTelemetryFrame({
			bytecode: new Uint8Array(2),
			globalBytes: MAX_USABLE_GLOBAL_BYTES + 1,
			placed: [],
			deferred: [],
		}), FrameAssemblyError);
	});
});
