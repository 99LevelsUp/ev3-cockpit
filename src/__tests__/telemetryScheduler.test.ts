/**
 * The base-tick scheduler, and the three properties the due-list it replaced did not have.
 *
 * The stalled-brick case is the one that matters most. A wall-clock scheduler against a
 * serial queue lets frames pile up while the brick is busy, and the heartbeat then misses its
 * window and trips reconnect on a brick that was only slow. Nothing about that is a corner
 * case: one unsettled sensor holds a frame for up to 1.2 s, and Bluetooth sustains 10.7
 * commands a second.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TelemetryScheduler, isReadableType } from '../telemetry/telemetryScheduler';
import { RowLifetime, TelemetryRow } from '../telemetry/telemetryRow';

const LIBUSB = { maxPacketBytes: 1024 };
const HID = { maxPacketBytes: 64 };

function row(options: {
	id: string;
	lifetime?: RowLifetime;
	bytes?: number;
	port?: string;
	mode?: number;
	reportsOccupancy?: true;
}): TelemetryRow {
	const {
		id,
		lifetime = { kind: 'repeating', divider: 1 } as RowLifetime,
		bytes = 1,
		port,
		mode,
		reportsOccupancy,
	} = options;
	return {
		id,
		tier: 'sampled',
		lifetime,
		result: { bytes, alignment: bytes === 4 ? 4 : 1 },
		port,
		mode,
		reportsOccupancy,
		emit: (slot) => new Uint8Array([0xaa, slot & 0xff]),
		parse: (payload, slot, sampledAt) => ({ rowId: id, value: payload[slot], sampledAt }),
	};
}

/** A sender that records what it was given and answers with a caller-supplied payload. */
function recordingSender(reply: (payload: Uint8Array) => Uint8Array = () => new Uint8Array(64)) {
	const sent: Uint8Array[] = [];
	return {
		sent,
		send: (payload: Uint8Array) => {
			sent.push(payload);
			return Promise.resolve(reply(payload));
		},
	};
}

describe('scheduler — dividers', () => {
	it('includes a divider-1 row on every tick and a divider-3 row on every third', () => {
		const seen: string[][] = [];
		const rows = [
			row({ id: 'fast', lifetime: { kind: 'repeating', divider: 1 } }),
			row({ id: 'slow', lifetime: { kind: 'repeating', divider: 3 } }),
		];
		const sender = recordingSender();
		const scheduler = new TelemetryScheduler({
			rows, limits: LIBUSB, send: sender.send, tickPeriodMs: 10,
			onValues: (values) => seen.push(values.map((v) => v.rowId)),
		});

		return (async () => {
			for (let i = 0; i < 6; i += 1) { await scheduler.runTick(); }
			assert.deepEqual(seen.map((ids) => ids.slice().sort()), [
				['fast', 'slow'],   // tick 0
				['fast'],           // 1
				['fast'],           // 2
				['fast', 'slow'],   // 3
				['fast'],           // 4
				['fast'],           // 5
			]);
		})();
	});

	it('never schedules a divider-0 row', async () => {
		const sender = recordingSender();
		const scheduler = new TelemetryScheduler({
			rows: [row({ id: 'off', lifetime: { kind: 'off' } })],
			limits: LIBUSB, send: sender.send, tickPeriodMs: 10,
		});

		for (let i = 0; i < 5; i += 1) { await scheduler.runTick(); }

		assert.equal(sender.sent.length, 0);
		assert.equal(scheduler.stats.ticksEmpty, 5);
	});

	it('reads a one-shot row once and then retires it', async () => {
		const seen: string[] = [];
		const sender = recordingSender();
		const scheduler = new TelemetryScheduler({
			rows: [
				row({ id: 'once', lifetime: { kind: 'oneShot' } }),
				row({ id: 'always' }),
			],
			limits: LIBUSB, send: sender.send, tickPeriodMs: 10,
			onValues: (values) => seen.push(...values.map((v) => v.rowId)),
		});

		for (let i = 0; i < 4; i += 1) { await scheduler.runTick(); }

		assert.equal(seen.filter((id) => id === 'once').length, 1,
			'a one-shot row is read exactly once, not on every tick and not never');
		assert.equal(seen.filter((id) => id === 'always').length, 4);
	});
});

describe('scheduler — one frame in flight', () => {
	it('skips a tick that arrives while the previous frame is outstanding', async () => {
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		let sends = 0;

		const scheduler = new TelemetryScheduler({
			rows: [row({ id: 'r' })],
			limits: LIBUSB,
			tickPeriodMs: 10,
			send: async () => {
				sends += 1;
				await blocked;
				return new Uint8Array(8);
			},
		});

		// First tick starts a send and does not resolve.
		const first = scheduler.runTick();
		// Four more ticks arrive while it is outstanding. None may send.
		for (let i = 0; i < 4; i += 1) { await scheduler.runTick(); }
		assert.equal(sends, 1, 'the stalled brick received exactly one frame');
		assert.equal(scheduler.stats.ticksSkipped, 4);

		release?.();
		await first;

		// Once the reply lands, the next tick sends again.
		await scheduler.runTick();
		assert.equal(sends, 2);
	});

	it('keeps counting ticks while it stands down, so phase follows wall-clock', async () => {
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const seen: string[][] = [];

		const scheduler = new TelemetryScheduler({
			rows: [row({ id: 'slow', lifetime: { kind: 'repeating', divider: 3 } })],
			limits: LIBUSB,
			tickPeriodMs: 10,
			onValues: (values) => seen.push(values.map((v) => v.rowId)),
			send: async () => { await blocked; return new Uint8Array(8); },
		});

		const first = scheduler.runTick();          // tick 0: sends, blocks
		for (let i = 0; i < 3; i += 1) { await scheduler.runTick(); }  // ticks 1,2,3 skipped
		release?.();
		await first;

		assert.equal(scheduler.stats.ticks, 4);
		// Tick 6 is the next multiple of 3 that will actually get to send. A scheduler that
		// froze its counter while blocked would fire the slow row again immediately.
		await scheduler.runTick();   // tick 4 — not a multiple of 3
		assert.equal(seen.length, 1, 'the slow row did not come up again on tick 4');
	});

	it('releases the in-flight flag when a send fails', async () => {
		let attempts = 0;
		const errors: unknown[] = [];
		const scheduler = new TelemetryScheduler({
			rows: [row({ id: 'r' })],
			limits: LIBUSB,
			tickPeriodMs: 10,
			onError: (error) => errors.push(error),
			send: () => {
				attempts += 1;
				return Promise.reject(new Error('link went away'));
			},
		});

		await scheduler.runTick();
		await scheduler.runTick();

		assert.equal(attempts, 2, 'a failed frame must not wedge the scheduler shut');
		assert.equal(errors.length, 2);
		assert.equal(scheduler.stats.framesFailed, 2);
	});
});

describe('scheduler — rotating truncation', () => {
	it('gives a row deferred by one tick the front of the next', async () => {
		// Twelve 4-byte rows against HID's 59-byte reply budget: fourteen would fit, so make
		// the rows wide enough that only some do.
		const rows = Array.from({ length: 20 }, (_, i) => row({ id: `r${i}`, bytes: 4 }));
		const seen: string[][] = [];
		const sender = recordingSender(() => new Uint8Array(64));

		const scheduler = new TelemetryScheduler({
			rows, limits: HID, send: sender.send, tickPeriodMs: 10,
			onValues: (values) => seen.push(values.map((v) => v.rowId)),
		});

		await scheduler.runTick();
		const firstTick = seen[0];
		assert.ok(firstTick.length < 20, 'HID could not carry every row');

		await scheduler.runTick();
		const secondTick = seen[1];

		// The rows that lost the first tick must appear in the second, at its front.
		const losers = rows.map((r) => r.id).filter((id) => !firstTick.includes(id));
		for (const id of losers.slice(0, secondTick.length)) {
			assert.ok(secondTick.includes(id), `${id} lost twice in a row`);
		}
	});

	it('serves every row within a few ticks rather than starving the losers', async () => {
		const rows = Array.from({ length: 20 }, (_, i) => row({ id: `r${i}`, bytes: 4 }));
		const everSeen = new Set<string>();
		const sender = recordingSender(() => new Uint8Array(64));

		const scheduler = new TelemetryScheduler({
			rows, limits: HID, send: sender.send, tickPeriodMs: 10,
			onValues: (values) => values.forEach((v) => everSeen.add(v.rowId)),
		});

		for (let i = 0; i < 5; i += 1) { await scheduler.runTick(); }

		assert.equal(everSeen.size, 20,
			`only ${everSeen.size} of 20 rows were ever read; static priority starves the rest`);
	});
});

describe('scheduler — the occupancy gate', () => {
	it('stops reading a value once its port reports a still-identifying device', async () => {
		const occupancy = row({
			id: 'ports.sensor.1.occupancy', port: '1', bytes: 1, reportsOccupancy: true,
		});
		const valueRow = row({ id: 'ports.sensor.1.value', port: '1', mode: 0, bytes: 4 });

		// Fill the whole reply with the type code rather than writing it at a guessed offset.
		// A test that hard-codes a slot is making the same mistake the design warns about, and
		// it breaks the moment the assembler reorders rows — which it does, wide results first.
		const sender = recordingSender(() => new Uint8Array(16).fill(125));
		const seen: string[][] = [];
		const scheduler = new TelemetryScheduler({
			rows: [valueRow, occupancy], limits: LIBUSB, send: sender.send, tickPeriodMs: 10,
			onValues: (values) => seen.push(values.map((v) => v.rowId)),
		});

		await scheduler.runTick();
		assert.ok(seen[0].includes('ports.sensor.1.value'),
			'nothing was known yet, so the value was read');

		await scheduler.runTick();
		assert.ok(!seen[1].includes('ports.sensor.1.value'),
			'a port reporting 125 must not have its value read: the read blocks for up to 1.2 s');
		assert.ok(seen[1].includes('ports.sensor.1.occupancy'),
			'the occupancy row itself is never gated, or the port could never be seen to refill');
	});

	it('reads the value again once the device finishes identifying', async () => {
		const occupancy = row({
			id: 'ports.sensor.1.occupancy', port: '1', bytes: 1, reportsOccupancy: true,
		});
		const valueRow = row({ id: 'ports.sensor.1.value', port: '1', mode: 0, bytes: 4 });

		let reported = 125;
		const sender = recordingSender(() => new Uint8Array(16).fill(reported));
		const seen: string[][] = [];
		const scheduler = new TelemetryScheduler({
			rows: [valueRow, occupancy], limits: LIBUSB, send: sender.send, tickPeriodMs: 10,
			onValues: (values) => seen.push(values.map((v) => v.rowId)),
		});

		await scheduler.runTick();   // nothing known: value read, occupancy says 125
		await scheduler.runTick();   // gated out
		assert.ok(!seen[1].includes('ports.sensor.1.value'));

		reported = 33;               // an infrared sensor finished identifying
		await scheduler.runTick();   // occupancy alone, now reports 33
		await scheduler.runTick();

		assert.ok(seen[3].includes('ports.sensor.1.value'),
			'the gate must reopen, or a hot-plugged sensor never reports again');
	});

	it('classifies the port type codes the firmware defines', () => {
		assert.equal(isReadableType(33), true, 'infrared');
		assert.equal(isReadableType(7), true, 'large motor');
		assert.equal(isReadableType(124), false, 'TYPE_TERMINAL: a console, not a peripheral');
		assert.equal(isReadableType(125), false, 'TYPE_UNKNOWN: still identifying, read blocks');
		assert.equal(isReadableType(126), false, 'TYPE_NONE: empty');
		assert.equal(isReadableType(127), false, 'TYPE_ERROR: faulty');
	});
});
