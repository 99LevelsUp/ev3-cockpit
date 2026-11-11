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

import { TelemetryScheduler, SETTLE_LIMIT_MS } from '../telemetry/telemetryScheduler';
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

		// b is a divider-3 row, so it rides in the slow command of tick 3 (KTD3).
		assert.deepEqual(seen.slice(2), [['a'], ['a'], ['b']]);
	});

	it('does not read a retired one-shot again when the rows are replaced', async () => {
		const once = row('fw', { kind: 'oneShot' });
		const { scheduler, seen } = world([row('a'), once]);
		await scheduler.runTick();

		scheduler.setRows([row('a'), once]);
		await scheduler.runTick();

		// The one-shot goes in tick 0's slow command (KTD3), and not again.
		assert.deepEqual(seen, [['a'], ['fw'], ['a']]);
	});

	it('reads a one-shot added after the first tick on the next tick, once', async () => {
		const { scheduler, seen } = world([row('a')]);
		await scheduler.runTick();
		await scheduler.runTick();

		scheduler.setRows([row('a'), row('fw', { kind: 'oneShot' })]);
		await scheduler.runTick();
		await scheduler.runTick();

		// Read in the next tick's slow command (KTD3), then retired.
		assert.deepEqual(seen.slice(2), [['a'], ['fw'], ['a']]);
	});

	it('keeps the occupancy gate when the rows are replaced', async () => {
		const occupancy = row('p1.occupancy', { kind: 'repeating', divider: 5 }, { port: '1', reportsOccupancy: true });
		const value = row('p1.value', { kind: 'repeating', divider: 1 }, { port: '1' });
		const { scheduler, seen } = world([occupancy, value], LIBUSB, () => new Uint8Array(64).fill(126));
		await scheduler.runTick();   // the port reports empty (126), in tick 0's slow command
		const before = seen.length;

		scheduler.setRows([occupancy, value]);
		await scheduler.runTick();

		assert.equal(seen.length, before, 'read an empty port after the rows were replaced');
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

describe('scheduler — one mode per port, and a settle after a switch (step-6 U4, 3.1.4b)', () => {
	const sensor = (id: string, mode: number) => row(id, { kind: 'repeating', divider: 1 }, {
		port: '1', mode, result: { bytes: 4, alignment: 4 },
		parse: (payload, slot, sampledAt) => ({ rowId: id, value: new DataView(payload.buffer).getFloat32(slot, true), sampledAt }),
	});
	const floats = (...values: number[]) => {
		let i = 0;
		return () => { const b = new Uint8Array(64); new DataView(b.buffer).setFloat32(0, values[Math.min(i++, values.length - 1)], true); return b; };
	};
	const valuesOf = (seen: { rowId: string; value: unknown }[][]) => seen.map((vs) => vs.map((v) => v.value));

	it('refuses two modes of one port in the active rows, and keeps the old set', () => {
		const { scheduler } = world([sensor('a', 0)]);

		assert.throws(() => scheduler.setRows([sensor('a', 0), sensor('b', 1)]), /mode/);
		assert.doesNotThrow(() => scheduler.setRows([sensor('a', 0), sensor('c', 0)]), 'two reads of one mode are fine');
	});

	it('refuses two modes of one port when built', () => {
		assert.throws(() => new TelemetryScheduler({ rows: [sensor('a', 0), sensor('b', 1)], limits: LIBUSB, tickPeriodMs: 10, send: () => Promise.resolve(new Uint8Array(64)) }), /mode/);
	});

	it('withholds a port\'s readings after a mode switch until one comes back as a number', async () => {
		const seen: { rowId: string; value: unknown }[][] = [];
		const scheduler = new TelemetryScheduler({
			rows: [sensor('a', 0)], limits: LIBUSB, tickPeriodMs: 10,
			send: ((r) => () => Promise.resolve(r()))(floats(1, NaN, NaN, 7, 8)),
			onValues: (values) => { seen.push(values.map((v) => ({ rowId: v.rowId, value: v.value }))); },
		});
		await scheduler.runTick();                  // 1, mode 0

		scheduler.setRows([sensor('b', 1)]);         // switch to mode 1
		for (let i = 0; i < 4; i += 1) { await scheduler.runTick(); }   // NaN, NaN, 7, 8

		assert.deepEqual(valuesOf(seen), [[1], [7], [8]]);
	});

	it('does not settle a port whose mode did not change', async () => {
		const seen: { rowId: string; value: unknown }[][] = [];
		const scheduler = new TelemetryScheduler({
			rows: [sensor('a', 0)], limits: LIBUSB, tickPeriodMs: 10,
			send: ((r) => () => Promise.resolve(r()))(floats(1, NaN, 3)),
			onValues: (values) => { seen.push(values.map((v) => ({ rowId: v.rowId, value: v.value }))); },
		});
		await scheduler.runTick();
		scheduler.setRows([sensor('a', 0)]);   // the same mode: the next reading, NaN, passes as it is
		await scheduler.runTick();

		assert.equal(seen.length, 2, 'withheld a reading although the mode stayed');
	});
});

describe('scheduler — the slow tier in its own command (step-6 U4, KTD3, DESIGN §9.1b)', () => {
	function recording(rows: TelemetryRow[], limits = LIBUSB, fail: (n: number) => boolean = () => false) {
		const frames: string[][] = [];
		let n = 0;
		const scheduler = new TelemetryScheduler({
			rows, limits, tickPeriodMs: 10,
			send: () => { n += 1; return fail(n) ? Promise.reject(new Error('lost')) : Promise.resolve(new Uint8Array(64)); },
			onValues: (values) => { frames.push(values.map((v) => v.rowId).sort()); },
		});
		return { scheduler, frames };
	}

	it('sends divider-1 rows in one command and every other row in a second, on the ticks they come up', async () => {
		const { scheduler, frames } = recording([row('fast'), row('slow', { kind: 'repeating', divider: 2 }), row('fw', { kind: 'oneShot' })]);

		await scheduler.runTick();   // tick 0: fast, then slow + fw
		await scheduler.runTick();   // tick 1: fast only

		assert.deepEqual(frames, [['fast'], ['fw', 'slow'], ['fast']]);
		assert.equal(scheduler.stats.framesSent, 3);
	});

	it('sends only the slow command on a tick with no fast row', async () => {
		const { scheduler, frames } = recording([row('slow', { kind: 'repeating', divider: 2 })]);

		await scheduler.runTick();
		await scheduler.runTick();

		assert.deepEqual(frames, [['slow']]);
		assert.equal(scheduler.stats.ticksEmpty, 1);
	});

	it('classifies by the divider in force, so a row slowed by setRows moves to the slow command', async () => {
		const { scheduler, frames } = recording([row('a'), row('b')]);
		await scheduler.runTick();

		scheduler.setRows([row('a'), withLifetime(row('b'), { kind: 'repeating', divider: 2 })]);
		await scheduler.runTick();   // tick 1: b does not come up
		await scheduler.runTick();   // tick 2: it does, in the slow command

		assert.deepEqual(frames, [['a', 'b'], ['a'], ['a'], ['b']]);
	});

	it('does not send the slow command when the fast one failed that tick', async () => {
		const { scheduler, frames } = recording([row('fast'), row('slow', { kind: 'repeating', divider: 1 }), row('fw', { kind: 'oneShot' })], LIBUSB, (n) => n === 1);

		await scheduler.runTick();

		assert.deepEqual(frames, []);
		assert.equal(scheduler.stats.framesFailed, 1);
		assert.equal(scheduler.stats.framesSent, 0);
	});

	it('carries a slow row truncated on HID into the next slow command, not into the fast frame', async () => {
		const wide = (id: string, lifetime: RowLifetime) => row(id, lifetime, { result: { bytes: 20, alignment: 1 } });
		const { scheduler, frames } = recording([
			wide('f1', { kind: 'repeating', divider: 1 }),
			wide('s1', { kind: 'oneShot' }), wide('s2', { kind: 'oneShot' }), wide('s3', { kind: 'oneShot' }),
		], HID);

		await scheduler.runTick();   // fast: f1; slow: s1, s2 (s3 deferred)
		await scheduler.runTick();   // fast: f1; slow: s3

		assert.deepEqual(frames, [['f1'], ['s1', 's2'], ['f1'], ['s3']]);
	});

	it('holds one frame in flight across both commands of a tick', async () => {
		let release: () => void = () => undefined;
		let calls = 0;
		const scheduler = new TelemetryScheduler({
			rows: [row('fast'), row('fw', { kind: 'oneShot' })], limits: LIBUSB, tickPeriodMs: 10,
			send: () => { calls += 1; return calls === 2 ? new Promise((resolve) => { release = () => resolve(new Uint8Array(64)); }) : Promise.resolve(new Uint8Array(64)); },
		});

		const first = scheduler.runTick();
		await settle(5);              // the slow command of tick 0 is outstanding
		await scheduler.runTick();    // tick 1 must stand down
		release();
		await first;

		assert.equal(scheduler.stats.ticksSkipped, 1);
	});
});

describe('scheduler — review of U4, round 1 (codex, 11.11.2026)', () => {
	type Held = { release: () => void };
	/** A sender whose n-th call can be held, failed or answered with a float at offset 0. */
	function driver(rows: TelemetryRow[], options: { limits?: { maxPacketBytes: number }; hold?: number[]; fail?: number[]; floats?: number[]; period?: number } = {}) {
		let clock = 0;
		let calls = 0;
		const held: Held[] = [];
		const delivered: string[][] = [];
		const floats = options.floats ?? [];
		const answer = (): Uint8Array => {
			const b = new Uint8Array(64);
			new DataView(b.buffer).setFloat32(0, floats.length ? floats[Math.min(calls - 1, floats.length - 1)] : 0, true);
			return b;
		};
		const scheduler = new TelemetryScheduler({
			rows, limits: options.limits ?? LIBUSB, tickPeriodMs: options.period ?? 10, now: () => clock,
			send: () => {
				calls += 1;
				if (options.fail?.includes(calls)) { return Promise.reject(new Error('lost')); }
				const reply = answer();
				if (options.hold?.includes(calls)) { return new Promise((resolve) => { held.push({ release: () => resolve(reply) }); }); }
				return Promise.resolve(reply);
			},
			onValues: (values) => { delivered.push(values.map((v) => `${v.rowId}=${String(v.value)}`).sort()); },
		});
		return { scheduler, held, delivered, calls: () => calls, setClock: (ms: number) => { clock = ms; } };
	}
	const sensor = (id: string, mode: number, lifetime: RowLifetime = { kind: 'repeating', divider: 1 }) => row(id, lifetime, {
		port: '1', mode, result: { bytes: 4, alignment: 4 },
		parse: (payload, slot, sampledAt) => ({ rowId: id, value: new DataView(payload.buffer).getFloat32(slot, true), sampledAt }),
	});
	const flush = () => settle(5);

	it('applies a row set given during a tick in flight only after that tick: no obsolete slow command', async () => {
		const d = driver([row('f'), row('s', { kind: 'oneShot' })], { hold: [1] });
		const tick = d.scheduler.runTick();
		await flush();
		d.scheduler.setRows([row('f')]);   // s no longer wanted
		d.held[0].release();
		await tick;
		await d.scheduler.runTick();

		assert.equal(d.calls(), 2, 'sent the slow command of a row set that was replaced');
	});

	it('does not resurrect a carried-over row removed while its tick was in flight', async () => {
		const wide = (id: string) => row(id, { kind: 'repeating', divider: 1 }, { result: { bytes: 20, alignment: 1 } });
		const d = driver([wide('w1'), wide('w2'), wide('w3')], { limits: HID, hold: [1] });
		const tick = d.scheduler.runTick();
		await flush();
		d.scheduler.setRows([wide('w1'), wide('w2')]);
		d.held[0].release();
		await tick;

		assert.equal(d.scheduler.stats.carriedOver, 0);
	});

	it('starts the settle when a command really switches the mode, and times it by the clock', async () => {
		const d = driver([sensor('a', 0)], { floats: [1, NaN], period: 1000 });
		await d.scheduler.runTick();                     // mode 0, reads 1
		d.scheduler.setRows([sensor('b', 1, { kind: 'repeating', divider: 3 })]);
		d.setClock(5000);
		await d.scheduler.runTick(); await d.scheduler.runTick();   // b not due
		await d.scheduler.runTick();                     // tick 3: mode 1 goes out now, reads NaN

		assert.deepEqual(d.delivered, [['a=1']], 'published the NaN of a switch that had only just happened');
	});

	it('ends the settle by elapsed time, whatever the period does meanwhile', async () => {
		const d = driver([sensor('a', 0)], { floats: [1, NaN] });
		await d.scheduler.runTick();
		d.scheduler.setRows([sensor('b', 1)]);
		await d.scheduler.runTick();                     // NaN, withheld
		d.scheduler.setPeriod(1000);
		d.setClock(SETTLE_LIMIT_MS + 1);
		await d.scheduler.runTick();                     // the limit has passed: NaN is published

		assert.deepEqual(d.delivered, [['a=1'], ['b=NaN']]);
	});

	it('does not let a reply in the old mode end the new mode\'s settle', async () => {
		const d = driver([sensor('a', 0)], { floats: [1, 2, NaN], hold: [2] });
		await d.scheduler.runTick();                     // mode 0: 1
		const tick = d.scheduler.runTick();              // mode 0 again, held
		await flush();
		d.scheduler.setRows([sensor('b', 1)]);
		d.held[0].release();                             // mode 0: 2 comes back
		await tick;
		await d.scheduler.runTick();                     // mode 1: NaN must be withheld

		assert.deepEqual(d.delivered, [['a=1'], ['a=2']]);
	});

	it('retires a one-shot only once its reading was delivered, not when the settle withheld it', async () => {
		const d = driver([sensor('a', 0)], { floats: [1, NaN, 5] });
		await d.scheduler.runTick();
		d.scheduler.setRows([sensor('b', 1, { kind: 'oneShot' })]);
		await d.scheduler.runTick();                     // NaN, withheld: not retired
		await d.scheduler.runTick();                     // 5: delivered and retired
		await d.scheduler.runTick();                     // nothing

		assert.deepEqual(d.delivered, [['a=1'], ['b=5']]);
		assert.equal(d.calls(), 3);
	});

	it('never sends a row switched off, even one carried over', async () => {
		const wide = (id: string, lifetime: RowLifetime = { kind: 'repeating', divider: 1 }) => row(id, lifetime, { result: { bytes: 20, alignment: 1 } });
		const d = driver([wide('w1'), wide('w2'), wide('w3')], { limits: HID });
		await d.scheduler.runTick();                     // w3 carried over
		d.scheduler.setRows([wide('w1'), wide('w2'), wide('w3', { kind: 'off' })]);
		await d.scheduler.runTick();

		assert.equal(d.delivered.flat().some((v) => v.startsWith('w3')), false);
	});

	it('keeps a carried-over slow row when the fast command fails', async () => {
		const wide = (id: string) => row(id, { kind: 'repeating', divider: 100 }, { result: { bytes: 20, alignment: 1 } });
		const d = driver([row('f'), wide('s1'), wide('s2'), wide('s3')], { limits: HID, fail: [3] });
		await d.scheduler.runTick();                     // fast; slow s1, s2 (s3 carried)
		await d.scheduler.runTick();                     // fast fails: s3 must wait, not vanish
		await d.scheduler.runTick();                     // fast; slow s3

		assert.ok(d.delivered.flat().some((v) => v.startsWith('s3')), 's3 vanished until tick 100');
	});

	it('neither delivers nor sends anything after dispose during a tick in flight', async () => {
		const d = driver([row('f'), row('s', { kind: 'oneShot' })], { hold: [1] });
		const tick = d.scheduler.runTick();
		await flush();
		d.scheduler.dispose();
		d.held[0].release();
		await tick;

		assert.deepEqual(d.delivered, []);
		assert.equal(d.calls(), 1);
	});

	it('settles a port again after its device was unplugged and plugged back in', async () => {
		const occupancy = row('p1.occupancy', { kind: 'repeating', divider: 1 }, { port: '1', reportsOccupancy: true, result: { bytes: 2, alignment: 1 } });
		const value = sensor('p1.value', 1);
		// [type, float]: known and 1; empty; known again (value gated); known and NaN after the replug.
		const replies: [number, number][] = [[30, 1], [126, NaN], [30, NaN], [30, NaN]];
		let call = 0;
		const delivered: string[] = [];
		const scheduler = new TelemetryScheduler({
			rows: [occupancy, value], limits: LIBUSB, tickPeriodMs: 10, now: () => 0,
			send: () => {
				const [type, reading] = replies[Math.min(call++, replies.length - 1)];
				const b = new Uint8Array(64);
				new DataView(b.buffer).setFloat32(0, reading, true);   // the 4-byte value lays out first
				b[4] = type;
				return Promise.resolve(b);
			},
			onValues: (values) => { for (const v of values) { if (v.rowId === 'p1.value') { delivered.push(String(v.value)); } } },
		});
		for (let i = 0; i < 4; i += 1) { await scheduler.runTick(); }

		// Tick 1 reads the value of a port still known from tick 0 and delivers its NaN (no switch);
		// tick 2 is gated (empty); tick 3 reads a replugged device, which must settle again.
		assert.deepEqual(delivered, ['1', 'NaN']);
	});

	it('remembers the mode a port was left in when its rows are removed and come back in another mode', async () => {
		const d = driver([sensor('a', 0)], { floats: [1, 1, NaN] });
		await d.scheduler.runTick();
		d.scheduler.setRows([row('x')]);
		await d.scheduler.runTick();
		d.scheduler.setRows([sensor('b', 1)]);
		await d.scheduler.runTick();                     // the device switches now: NaN withheld

		assert.equal(d.delivered.flat().includes('b=NaN'), false);
	});
});
