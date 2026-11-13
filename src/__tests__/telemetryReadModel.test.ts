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

function world(settings = { staleFactor: 3, staleTimeoutMs: 1000 }) {
	const values = new vscode.EventEmitter<TelemetryValuesEvent>();
	const plans = new vscode.EventEmitter<PlanChangeEvent>();
	const ended = new vscode.EventEmitter<{ readonly brickKey: BrickId }>();
	const source: TelemetrySource = { onValues: values.event, onPlanChange: plans.event, onSessionEnded: ended.event };

	let now = 0;
	let pending: { at: number; fn: () => void } | undefined;
	const timer: ReadModelTimer = {
		set: (ms, fn) => {
			const entry = { at: now + ms, fn };
			pending = entry;
			return () => { if (pending === entry) { pending = undefined; } };
		},
	};
	const model = new TelemetryReadModel({ source, settings, now: () => now, timer });
	const changes: ReadModelChange[] = [];
	model.onChange((change) => changes.push(change));

	return {
		model, changes,
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
});
