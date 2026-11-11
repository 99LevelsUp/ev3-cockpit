/**
 * A schedule that changes while the scheduler runs (step-6 plan U4, KTD2).
 *
 * The rows a brick reads and how often come from the claims on them (U5) and the throttler (U7),
 * so both change under a running loop. Replacing the rows keeps the tick counter (phase), the
 * occupancy gate and the retired one-shots; changing the period restarts the timer and nothing
 * else.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TelemetryScheduler } from '../telemetry/telemetryScheduler';
import { RowLifetime, TelemetryRow, withLifetime } from '../telemetry/telemetryRow';
import { createBrickTelemetry } from '../telemetry/brickTelemetry';
import { makeBrickKey, Transport } from '../contracts';
import { cadenceFor } from '../telemetry/telemetryConstants';

const LIBUSB = { maxPacketBytes: 1024 };
const HID = { maxPacketBytes: 64 };

function row(id: string, lifetime: RowLifetime = { kind: 'repeating', divider: 1 }, extra: Partial<TelemetryRow> = {}): TelemetryRow {
	return {
		id, tier: 'sampled', lifetime, result: { bytes: 1, alignment: 1 },
		emit: (slot) => new Uint8Array([0xaa, slot & 0xff]),
		parse: (payload, slot, sampledAt) => ({ rowId: id, value: payload[slot], sampledAt }),
		...extra,
	};
}

function world(rows: TelemetryRow[], limits = LIBUSB, reply: (payload: Uint8Array) => Uint8Array = () => new Uint8Array(64)) {
	const seen: string[][] = [];
	const scheduler = new TelemetryScheduler({
		rows, limits, tickPeriodMs: 10,
		send: (payload) => Promise.resolve(reply(payload)),
		onValues: (values) => { seen.push(values.map((v) => v.rowId).sort()); },
	});
	return { scheduler, seen };
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('scheduler — a schedule that changes while running (step-6 U4)', () => {
	it('keeps the phase when the rows are replaced: the tick counter goes on', async () => {
		const { scheduler, seen } = world([row('a')]);
		await scheduler.runTick();   // tick 0
		await scheduler.runTick();   // tick 1

		scheduler.setRows([row('a'), row('b', { kind: 'repeating', divider: 3 })]);
		await scheduler.runTick();   // tick 2: b (divider 3) does not come up
		await scheduler.runTick();   // tick 3: it does

		assert.deepEqual(seen.slice(2), [['a'], ['a', 'b']]);
	});

	it('does not read a retired one-shot again when the rows are replaced', async () => {
		const once = row('fw', { kind: 'oneShot' });
		const { scheduler, seen } = world([row('a'), once]);
		await scheduler.runTick();

		scheduler.setRows([row('a'), once]);
		await scheduler.runTick();

		assert.deepEqual(seen, [['a', 'fw'], ['a']]);
	});

	it('keeps the occupancy gate when the rows are replaced', async () => {
		const occupancy = row('p1.occupancy', { kind: 'repeating', divider: 5 }, { port: '1', reportsOccupancy: true });
		const value = row('p1.value', { kind: 'repeating', divider: 1 }, { port: '1' });
		const { scheduler, seen } = world([occupancy, value], LIBUSB, () => new Uint8Array(64).fill(126));
		await scheduler.runTick();   // the port reports empty (126)

		scheduler.setRows([occupancy, value]);
		await scheduler.runTick();

		assert.equal(seen.length, 1, 'read an empty port after the rows were replaced');
		assert.equal(scheduler.portState('1'), 'empty');
	});

	it('carries a deferred row over only if it is still wanted, in its new version', async () => {
		// On HID the third wide row does not fit and is carried over.
		const wide = (id: string, divider = 1) => row(id, { kind: 'repeating', divider }, { result: { bytes: 20, alignment: 1 }, emit: (slot) => new Uint8Array([0xaa, slot & 0xff]) });
		const { scheduler, seen } = world([wide('w1'), wide('w2'), wide('w3')], HID);
		await scheduler.runTick();
		assert.equal(scheduler.stats.carriedOver, 1);

		scheduler.setRows([wide('w1', 7), wide('w2', 7)]);   // w3 no longer wanted
		await scheduler.runTick();

		assert.equal(seen.length, 1, 'read a row nobody wants any more');
		assert.equal(scheduler.stats.carriedOver, 0);
	});

	it('refuses a row set with a divider that is not a whole number of ticks, or two rows with one id, and keeps the old set', async () => {
		const { scheduler, seen } = world([row('a')]);

		for (const divider of [0, 1.5, -2, Number.NaN]) {
			assert.throws(() => scheduler.setRows([row('a', { kind: 'repeating', divider })]), /divider/, `accepted ${divider}`);
		}
		assert.throws(() => scheduler.setRows([row('a'), row('a')]), /twice/);
		await scheduler.runTick();

		assert.deepEqual(seen, [['a']]);
	});

	it('changes the period while running without a tick of its own or a reset of the count', async () => {
		const { scheduler } = world([row('a')]);
		scheduler.setPeriod(200);
		scheduler.start();
		await settle(50);
		assert.equal(scheduler.stats.ticks, 0, 'ticked before its period');

		scheduler.setPeriod(10);
		await settle(120);
		scheduler.stop();

		assert.ok(scheduler.stats.ticks >= 4, `only ${scheduler.stats.ticks} ticks at 10 ms`);
		assert.equal(scheduler.tickPeriodMs, 10);
	});

	it('refuses a period that is not a positive number of milliseconds', () => {
		const { scheduler } = world([row('a')]);
		for (const ms of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => scheduler.setPeriod(ms), /period/, `accepted ${ms}`);
		}
	});

	it('gives a row a new lifetime without changing what it reads', () => {
		const original = row('a');
		const slowed = withLifetime(original, { kind: 'repeating', divider: 4 });

		assert.deepEqual(slowed.lifetime, { kind: 'repeating', divider: 4 });
		assert.deepEqual([...slowed.emit(3)], [...original.emit(3)]);
		assert.equal(original.lifetime.kind === 'repeating' && original.lifetime.divider, 1, 'changed the original');
	});

	it('clamps a brick loop\'s period to its transport\'s floor and says what it granted', () => {
		const key = makeBrickKey(Transport.USB, 'X1');
		const telemetry = createBrickTelemetry({ sender: { send: () => Promise.reject(new Error('unused')) }, brickKey: key });

		const granted = telemetry.setPeriod(1);

		assert.equal(granted, cadenceFor(Transport.USB).floorMs);
		assert.equal(telemetry.tickPeriodMs, granted);
		assert.equal(telemetry.setPeriod(400), 400);
		telemetry.dispose();
	});
});
