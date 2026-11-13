/**
 * The telemetry read model (step-6 plan U6; IMPLEMENTATION_PLAN 3.2.1, 3.2.2, 3.6, 3.7.4, 3.7.5;
 * owner decisions D9, D10).
 *
 * Per brick, the last value of each row with `sampledAt`, its effective interval and whether it is
 * still fresh. Events carry only the rows that changed — and no information may be lost in an
 * outage: values turn stale (an event), and the first sample after it makes an event even when its
 * value did not change.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import type { BrickId } from '../contracts';
import type { RowValue } from '../telemetry/telemetryRow';
import {
	ReadModelChange, ReadModelTimer, TelemetryReadModel, TelemetrySource,
} from '../telemetry/telemetryReadModel';
import type { PlanChangeEvent, TelemetryValuesEvent } from '../telemetry/telemetryService';

const A = 'AAA' as BrickId;
const B = 'BBB' as BrickId;
const TACHO = 'ports.motor.A.tacho';
const BATTERY = 'system.battery.level';
const FIRMWARE = 'system.firmwareVersion';

function world(
	settings = { staleFactor: 3, staleTimeoutMs: 1000 },
	running: ReadonlyMap<BrickId, ReadonlyMap<string, number | 'once'>> = new Map(),
) {
	const values = new vscode.EventEmitter<TelemetryValuesEvent>();
	const plans = new vscode.EventEmitter<PlanChangeEvent>();
	const ended = new vscode.EventEmitter<{ readonly brickKey: BrickId }>();
	const source: TelemetrySource = {
		onValues: values.event, onPlanChange: plans.event, onSessionEnded: ended.event,
		currentPlans: () => running,
	};

	let now = 0;
	let pending: { at: number; fn: () => void } | undefined;
	const delays: number[] = [];
	const timer: ReadModelTimer = {
		set: (ms, fn) => {
			delays.push(ms);
			const entry = { at: now + ms, fn };
			pending = entry;
			return () => { if (pending === entry) { pending = undefined; } };
		},
	};
	const model = new TelemetryReadModel({ source, settings, now: () => now, timer });
	const changes: ReadModelChange[] = [];
	model.onChange((change) => changes.push(change));

	return {
		model, changes, delays,
		/** Moves the clock without running the timer: a callback the event loop has not reached yet. */
		jump(ms: number) { now += ms; },
		/** Runs the timer now, if one is set: the late callback finally runs. */
		fire() { const due = pending; pending = undefined; due?.fn(); },
		plan: (brickKey: BrickId, intervals: Record<string, number | 'once'>) =>
			plans.fire({ brickKey, intervals: new Map(Object.entries(intervals)) }),
		sample: (brickKey: BrickId, ...rows: [string, RowValue['value']][]) =>
			values.fire({ brickKey, values: rows.map(([rowId, value]) => ({ rowId, value, sampledAt: now })) }),
		end: (brickKey: BrickId) => ended.fire({ brickKey }),
		/**
		 * Moves the clock, running the timer each time it comes due on the way. A timer that keeps
		 * coming due at the same moment is a busy loop in production: it fails here, not hangs.
		 */
		advance(ms: number) {
			const until = now + ms;
			let rounds = 0;
			while (pending && pending.at <= until) {
				rounds += 1;
				if (rounds > 10_000) { throw new Error('The read model\'s timer keeps coming due: a busy loop.'); }
				const due = pending;
				pending = undefined;
				now = due.at;
				due.fn();
			}
			now = until;
		},
		take() { return changes.splice(0); },
	};
}

const rowsOf = (change: ReadModelChange | undefined) =>
	(change?.rows ?? []).map((row) => [row.rowId, row.value, row.stale] as const);

describe('Telemetry read model (step-6 U6)', () => {
	it('keeps the last value of a row with when it was sampled and the interval it runs at', () => {
		const w = world();
		w.plan(A, { [TACHO]: 100 });
		w.advance(40);
		w.sample(A, [TACHO, 90]);

		assert.deepEqual(w.model.valueOf(A, TACHO), {
			rowId: TACHO, value: 90, sampledAt: 40, effectiveIntervalMs: 100, stale: false,
		});
		assert.deepEqual(rowsOf(w.take()[0]), [[TACHO, 90, false]]);
	});

	it('makes no event for a sample that changed nothing, but keeps its time', () => {
		const w = world();
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.take();

		w.advance(100);
		w.sample(A, [TACHO, 90]);
		assert.deepEqual(w.take(), []);
		assert.equal(w.model.valueOf(A, TACHO)?.sampledAt, 100);

		w.sample(A, [TACHO, Number.NaN]);
		w.take();
		w.sample(A, [TACHO, Number.NaN]);
		assert.deepEqual(w.take(), [], 'NaN again is no change');
	});

	it('marks a value stale once it is staleFactor of its intervals old, not before', () => {
		const w = world();
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.take();

		w.advance(299);
		assert.equal(w.model.valueOf(A, TACHO)?.stale, false);
		assert.deepEqual(w.take(), []);
		w.advance(1);
		assert.equal(w.model.valueOf(A, TACHO)?.stale, true);
		assert.deepEqual(rowsOf(w.take()[0]), [[TACHO, 90, true]]);
	});

	it('marks a value stale at once when its row stops being read', () => {
		const w = world();
		w.plan(A, { [TACHO]: 100, [BATTERY]: 500 });
		w.sample(A, [TACHO, 90], [BATTERY, 80]);
		w.take();

		w.plan(A, { [BATTERY]: 500 });

		assert.deepEqual(rowsOf(w.take()[0]), [[TACHO, 90, true]]);
		assert.equal(w.model.valueOf(A, BATTERY)?.stale, false);
	});

	it('loses nothing in an outage: stale is an event, and an unchanged value after it is one too (D10)', () => {
		const w = world();
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.take();

		w.plan(A, {});                       // the link went
		assert.deepEqual(rowsOf(w.take()[0]), [[TACHO, 90, true]]);
		w.advance(500);
		w.plan(A, { [TACHO]: 100 });         // it is back
		w.sample(A, [TACHO, 90]);            // and the motor did not move

		const after = w.take();
		assert.deepEqual(rowsOf(after[after.length - 1]), [[TACHO, 90, false]]);
	});

	it('drops a stale value after staleTimeoutMs, not before, and says so', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 1000 });
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.plan(A, {});
		w.take();

		w.advance(999);
		assert.ok(w.model.valueOf(A, TACHO));
		w.advance(1);
		assert.equal(w.model.valueOf(A, TACHO), undefined);
		assert.deepEqual(w.take(), [{ brickKey: A, rows: [], removed: [TACHO] }]);
	});

	it('clears a brick at once when its session ends', () => {
		const w = world();
		w.plan(A, { [TACHO]: 100, [FIRMWARE]: 'once' });
		w.sample(A, [TACHO, 90], [FIRMWARE, 'V1.09D']);
		w.take();

		w.end(A);

		assert.deepEqual(w.model.snapshot(A), []);
		assert.deepEqual(w.take(), [{ brickKey: A, rows: [], removed: [TACHO, FIRMWARE] }]);
	});

	it('keeps a static row fresh for the whole session, read or not', () => {
		const w = world();
		w.plan(A, { [FIRMWARE]: 'once' });
		w.sample(A, [FIRMWARE, 'V1.09D']);
		w.take();

		w.plan(A, {});
		w.advance(60_000);

		assert.equal(w.model.valueOf(A, FIRMWARE)?.stale, false);
		assert.deepEqual(w.take(), []);
	});

	it('says when a row\'s effective interval changes, value or not', () => {
		const w = world();
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.take();

		w.plan(A, { [TACHO]: 250 });

		assert.deepEqual(w.take()[0]?.rows.map((row) => row.effectiveIntervalMs), [250]);
	});

	it('keeps bricks apart', () => {
		const w = world();
		w.plan(A, { [TACHO]: 100 });
		w.plan(B, { [TACHO]: 100 });
		w.sample(A, [TACHO, 1]);
		w.sample(B, [TACHO, 2]);

		w.end(A);

		assert.equal(w.model.valueOf(A, TACHO), undefined);
		assert.equal(w.model.valueOf(B, TACHO)?.value, 2);
	});

	it('follows a settings change at once, and refuses settings out of range', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 1000 });
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.advance(250);
		w.take();

		w.model.configure({ staleFactor: 2, staleTimeoutMs: 1000 });

		assert.equal(w.model.valueOf(A, TACHO)?.stale, true, '250 ms is past 2 intervals of 100');
		assert.throws(() => w.model.configure({ staleFactor: 0, staleTimeoutMs: 1000 }), /staleFactor/);
		assert.throws(() => w.model.configure({ staleFactor: 3, staleTimeoutMs: -1 }), /staleTimeoutMs/);
	});
	it('keeps a row that left the plan stale when a late reply still brings it, and does not put off its drop (review 1)', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 1000 });
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.plan(A, {});                   // re-planned while a frame was in flight
		w.take();
		w.advance(50);

		w.sample(A, [TACHO, 91]);        // that frame's reply

		const late = w.model.valueOf(A, TACHO);
		assert.deepEqual([late?.value, late?.stale, late?.effectiveIntervalMs], [91, true, undefined]);
		w.advance(950);
		assert.equal(w.model.valueOf(A, TACHO), undefined, 'dropped 1000 ms after it stopped being read, not after the late reply');
	});

	it('announces an outage even when a sample beats the late timer to it, then the recovery (D10, review 1)', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 1000 });
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.take();

		w.jump(400);                     // the timer was due at 300 and has not run
		w.sample(A, [TACHO, 90]);        // the brick answers again, the same value

		assert.deepEqual(w.take().map((change) => rowsOf(change)), [[[TACHO, 90, true]], [[TACHO, 90, false]]]);
	});

	it('counts a stale value\'s time from when it went stale, not from when the timer got round to it (review 1)', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 1000 });
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.take();

		w.jump(2000);                    // stale at 300, due to go at 1300
		w.fire();

		assert.equal(w.model.valueOf(A, TACHO), undefined);
		assert.deepEqual(w.take(), [
			{ brickKey: A, rows: [{ rowId: TACHO, value: 90, sampledAt: 0, effectiveIntervalMs: 100, stale: true }], removed: [] },
			{ brickKey: A, rows: [], removed: [TACHO] },
		], 'stale first, then gone: nothing skipped');
	});

	it('says a value went stale before it says it is gone, even with no time between (staleTimeoutMs 0, review 1)', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 0 });
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.take();

		w.advance(300);

		assert.deepEqual(w.take().map((change) => [rowsOf(change), change.removed]), [[[[TACHO, 90, true]], []], [[], [TACHO]]]);
	});

	it('never asks the platform for a longer timer than it can keep (review 1)', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 2 ** 40 });
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.plan(A, {});

		assert.ok(w.delays.every((ms) => ms <= 2 ** 31 - 1), `asked for ${Math.max(...w.delays)} ms`);
		w.model.configure({ staleFactor: Number.MAX_VALUE, staleTimeoutMs: 1000 });   // never stale by age
	});

	it('learns what a brick is already read for when it is attached to a service that runs (review 1)', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 1000 }, new Map([[A, new Map([[TACHO, 100]])]]));
		w.sample(A, [TACHO, 90]);

		assert.equal(w.model.valueOf(A, TACHO)?.effectiveIntervalMs, 100);
		w.advance(300);
		assert.equal(w.model.valueOf(A, TACHO)?.stale, true);
	});
	it('says a row is no longer read the moment it leaves the plan, stale already or not (review 2)', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 1000 });
		w.plan(A, { [TACHO]: 100, [BATTERY]: 500 });
		w.sample(A, [TACHO, 90], [BATTERY, 80]);
		w.advance(300);                  // the tacho went stale by age
		w.take();

		w.plan(A, {});

		const rows = w.take().flatMap((change) => change.rows);
		assert.deepEqual(rows.map((row) => [row.rowId, row.stale, row.effectiveIntervalMs]).sort(),
			[[TACHO, true, undefined], [BATTERY, true, undefined]]);
	});

	it('lets no plan change hide an overdue outage or put off a drop (review 2)', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 1000 });
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.take();

		w.jump(400);                     // stale at 300; the timer has not run
		w.plan(A, { [TACHO]: 1000 });    // a slower plan arrives first

		assert.equal(w.model.valueOf(A, TACHO)?.stale, true, 'stale it went, and stays until a sample');
		assert.equal(w.take()[0]?.rows[0]?.stale, true);
		w.plan(A, {});
		w.advance(900);                  // t = 1300: 1000 ms after it went stale
		assert.equal(w.model.valueOf(A, TACHO), undefined);
	});

	it('takes no late reply for a brick whose session ended, until it is read again (review 2)', () => {
		const w = world();
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);
		w.end(A);
		w.take();

		w.sample(A, [TACHO, 91]);        // a frame that was on its way
		assert.deepEqual(w.model.snapshot(A), []);
		assert.deepEqual(w.take(), []);

		w.plan(A, { [TACHO]: 100 });     // signed in again: a new loop
		w.sample(A, [TACHO, 92]);
		assert.equal(w.model.valueOf(A, TACHO)?.value, 92);
	});

	it('takes no sample for a brick a listener ended while hearing about it (review 2)', () => {
		const w = world({ staleFactor: 3, staleTimeoutMs: 1000 });
		w.model.onChange((change) => { if (change.rows.some((row) => row.stale)) { w.end(A); } });
		w.plan(A, { [TACHO]: 100 });
		w.sample(A, [TACHO, 90]);

		w.jump(400);
		w.sample(A, [TACHO, 91]);        // its stale news ends the session first

		assert.deepEqual(w.model.snapshot(A), []);
	});
});
