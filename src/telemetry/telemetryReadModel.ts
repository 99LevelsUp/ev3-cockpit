/**
 * What the telemetry loops read, kept for whoever asks (step-6 plan U6; IMPLEMENTATION_PLAN 3.2.1,
 * 3.2.2, 3.6; DESIGN §5.4, §9.3; owner decisions D2, D9, D10).
 *
 * Per brick, the last value of every row with the time it was sampled, the interval the row runs
 * at now and whether the value is still fresh. The panel's view of the active brick and the API's
 * snapshot and events read it; neither talks to a loop.
 *
 * **Stale (D9).** A value is stale when its row stops being read — the link went, the brick is no
 * longer active, the claim was released — or when it is `staleFactor` of its own intervals old
 * while the row is still read (the brick is stalling). Once stale it stays stale until a new
 * sample. A stale value stays, marked, for `staleTimeoutMs` counted from when it went stale, then
 * goes. When the brick's session ends its values go at once, and replies still on their way are not
 * taken until the brick is read again. A static row, read once, stays fresh for the whole session:
 * it is what serves a claim made after the read. Both numbers are user settings; this class holds
 * none of its own.
 *
 * **Events carry the rows that changed (D10)** — value, mode, unit, stale flag or effective
 * interval — and the rows dropped. Nothing is lost in an outage: there are no samples to lose, the
 * values turning stale is an event, and the first sample after the outage is one even when its
 * value is the same, because the stale flag flips back.
 *
 * **One order for every input** (review of U6, rounds 1–2, where each input had kept its own and
 * each round found one that forgot a case). A sample, a plan, a session's end, a settings change
 * and the timer all go through {@link TelemetryReadModel.run}: first time is brought up to now
 * under the state as it was — what went stale is announced, then what expired goes — and only then
 * is the input applied. Events are not picked by hand: they are the difference between what readers
 * were last told and what holds now, so a change cannot go untold.
 */

import * as vscode from 'vscode';

import { BrickRef } from '../contracts';
import { RowValue } from './telemetryRow';
import type { PlanChangeEvent, SessionEndedEvent, TelemetryValuesEvent } from './telemetryService';
import { TelemetrySettings, checkTelemetrySettings } from './telemetrySettings';

/** One row's last value as a reader sees it. */
export interface ReadValue {
	readonly rowId: string;
	readonly value: RowValue['value'];
	readonly unit?: string;
	readonly mode?: number;
	/** When the reply carrying the value arrived. */
	readonly sampledAt: number;
	/** How often the row is read now; `'once'` for a static row; absent while it is not read. */
	readonly effectiveIntervalMs?: number | 'once';
	readonly stale: boolean;
}

/** What changed for one brick: rows that are new or different, and rows dropped. */
export interface ReadModelChange {
	readonly brickKey: BrickRef;
	readonly rows: readonly ReadValue[];
	readonly removed: readonly string[];
}

/** Where the values come from: the telemetry service, or a test's stand-in. */
export interface TelemetrySource {
	readonly onValues: vscode.Event<TelemetryValuesEvent>;
	readonly onPlanChange: vscode.Event<PlanChangeEvent>;
	readonly onSessionEnded: vscode.Event<SessionEndedEvent>;
	/**
	 * What each brick is read for right now: a reader attached to a source that already runs learns
	 * the plans announced before it subscribed (review of U6, round 1).
	 */
	currentPlans(): ReadonlyMap<BrickRef, ReadonlyMap<string, number | 'once'>>;
}

/** Runs `fn` once after `ms`; returns a function that cancels it. */
export interface ReadModelTimer {
	set(ms: number, fn: () => void): () => void;
}

export interface TelemetryReadModelOptions {
	readonly source: TelemetrySource;
	readonly settings: TelemetrySettings;
	readonly now?: () => number;
	readonly timer?: ReadModelTimer;
}

interface Entry {
	value: RowValue['value'];
	unit?: string;
	mode?: number;
	sampledAt: number;
	/** How often the row is read now; `'once'` for a static row; undefined while it is not read. */
	interval?: number | 'once';
	/** When the value went stale; undefined while it is fresh. Sticky until a new sample. */
	staleSince?: number;
}

/**
 * The longest delay Node's timers keep; a longer one fires after 1 ms. Not a setting: the platform's
 * limit. A deadline further out wakes the timer at this and is checked again (review of U6, round 1).
 */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

const realTimer: ReadModelTimer = {
	set: (ms, fn) => {
		const handle = setTimeout(fn, ms);
		// Never what keeps the extension host alive.
		handle.unref?.();
		return () => clearTimeout(handle);
	},
};

export class TelemetryReadModel implements vscode.Disposable {
	private readonly bricks = new Map<BrickRef, Map<string, Entry>>();
	/** What each brick is read for now, as the source last said. */
	private readonly plans = new Map<BrickRef, ReadonlyMap<string, number | 'once'>>();
	/** What readers were last told, per brick: events are the difference from it. */
	private readonly told = new Map<BrickRef, Map<string, ReadValue>>();
	/** Bricks whose session ended and that are not read again yet: their late replies are not taken. */
	private readonly ended = new Set<BrickRef>();
	private readonly subscriptions: vscode.Disposable[];
	private readonly now: () => number;
	private readonly timer: ReadModelTimer;
	private settings: TelemetrySettings;
	private cancelTimer: (() => void) | undefined;
	private disposed = false;

	private readonly _onChange = new vscode.EventEmitter<ReadModelChange>();
	readonly onChange = this._onChange.event;

	constructor(options: TelemetryReadModelOptions) {
		checkTelemetrySettings(options.settings);
		this.settings = options.settings;
		this.now = options.now ?? (() => Date.now());
		this.timer = options.timer ?? realTimer;
		const { source } = options;
		for (const [brickKey, intervals] of source.currentPlans()) {
			if (intervals.size > 0) { this.plans.set(brickKey, intervals); }
		}
		this.subscriptions = [
			source.onValues((event) => this.run(() => this.take(event))),
			source.onPlanChange((event) => this.run(() => this.plan(event))),
			source.onSessionEnded((event) => this.run(() => this.end(event.brickKey))),
		];
	}

	/** Changes the stale settings; they apply at once. Throws, changing nothing, for settings out of range. */
	configure(settings: TelemetrySettings): void {
		checkTelemetrySettings(settings);
		// Time up to now under the old settings, then the new ones.
		this.run(() => { this.settings = settings; });
	}

	/** The brick's values, all or the rows named; a row with no value is left out. */
	snapshot(brickKey: BrickRef, rowIds?: readonly string[]): ReadValue[] {
		const entries = this.bricks.get(brickKey);
		if (!entries) { return []; }
		const ids = rowIds ?? [...entries.keys()];
		return ids.flatMap((id) => {
			const entry = entries.get(id);
			return entry ? [view(id, entry)] : [];
		});
	}

	valueOf(brickKey: BrickRef, rowId: string): ReadValue | undefined {
		const entry = this.bricks.get(brickKey)?.get(rowId);
		return entry ? view(rowId, entry) : undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.bricks.clear();
		this.plans.clear();
		this.told.clear();
		this._onChange.dispose();
	}

	// ── Internal ────────────────────────────────────────────────────

	/**
	 * Every input goes through here: time first, under the state as it was; then the input; then
	 * time again under the new state (a shorter interval or a smaller `staleFactor` may put a
	 * deadline in the past); each step tells what changed.
	 */
	private run(input: () => void): void {
		if (this.disposed) { return; }
		this.settle();
		input();
		this.announce();
		this.settle();
		this.schedule();
	}

	/** Brings time up to now: what went stale is announced, then what has been stale long enough goes. */
	private settle(): void {
		const now = this.now();
		const { staleFactor, staleTimeoutMs } = this.settings;
		for (const entries of this.bricks.values()) {
			for (const entry of entries.values()) {
				if (entry.staleSince !== undefined || typeof entry.interval !== 'number') { continue; }
				// From the deadline, however late this runs: that is when it went stale.
				const deadline = entry.sampledAt + staleFactor * entry.interval;
				if (now >= deadline) { entry.staleSince = deadline; }
			}
		}
		// Stale before gone, even with no time between: a reader hears both.
		this.announce();
		for (const entries of this.bricks.values()) {
			for (const [id, entry] of entries) {
				if (entry.staleSince !== undefined && now >= entry.staleSince + staleTimeoutMs) { entries.delete(id); }
			}
		}
		this.announce();
	}

	private take(event: TelemetryValuesEvent): void {
		const { brickKey } = event;
		// A reply still on its way when the session ended — or ended by a listener just now.
		if (this.ended.has(brickKey)) { return; }
		let entries = this.bricks.get(brickKey);
		if (!entries) { entries = new Map(); this.bricks.set(brickKey, entries); }
		const plan = this.plans.get(brickKey);
		const now = this.now();
		for (const value of event.values) {
			const before = entries.get(value.rowId);
			const planned = plan?.get(value.rowId);
			const reading: Entry = {
				value: value.value,
				...(value.unit !== undefined ? { unit: value.unit } : {}),
				...(value.mode !== undefined ? { mode: value.mode } : {}),
				sampledAt: value.sampledAt,
			};
			if (planned === 'once' || before?.interval === 'once') {
				reading.interval = 'once';
			} else if (planned === undefined) {
				// Not read any more: the reply of a frame sent before the re-plan. Kept, but stale
				// since it stopped being read, so its drop is not put off.
				reading.staleSince = before?.staleSince ?? now;
			} else {
				reading.interval = planned;
			}
			entries.set(value.rowId, reading);
		}
	}

	private plan(event: PlanChangeEvent): void {
		const { brickKey, intervals } = event;
		if (intervals.size === 0) {
			this.plans.delete(brickKey);
		} else {
			this.plans.set(brickKey, intervals);
			// Read again: a new session's loop.
			this.ended.delete(brickKey);
		}
		const entries = this.bricks.get(brickKey);
		if (!entries) { return; }
		const now = this.now();
		for (const [id, entry] of entries) {
			if (entry.interval === 'once') { continue; }
			const interval = intervals.get(id);
			if (interval === undefined) {
				entry.interval = undefined;
				entry.staleSince ??= now;
			} else {
				// Stale stays stale until a sample, whatever the new interval.
				entry.interval = interval;
			}
		}
	}

	private end(brickKey: BrickRef): void {
		this.bricks.delete(brickKey);
		this.plans.delete(brickKey);
		this.ended.add(brickKey);
	}

	/** Tells readers what differs from what they were last told, per brick. */
	private announce(): void {
		const bricks = new Set<BrickRef>([...this.bricks.keys(), ...this.told.keys()]);
		for (const brickKey of bricks) {
			const entries = this.bricks.get(brickKey) ?? new Map<string, Entry>();
			const before = this.told.get(brickKey) ?? new Map<string, ReadValue>();
			const now = new Map<string, ReadValue>();
			const rows: ReadValue[] = [];
			for (const [id, entry] of entries) {
				const current = view(id, entry);
				now.set(id, current);
				const was = before.get(id);
				if (!was || differs(was, current)) { rows.push(current); }
			}
			const removed = [...before.keys()].filter((id) => !entries.has(id));
			if (now.size > 0) { this.told.set(brickKey, now); } else { this.told.delete(brickKey); }
			if (entries.size === 0) { this.bricks.delete(brickKey); }
			if (rows.length > 0 || removed.length > 0) { this._onChange.fire({ brickKey, rows, removed }); }
		}
	}

	/** Sets the timer for the next moment a value turns stale or a stale one goes. */
	private schedule(): void {
		if (this.disposed) { return; }
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		const { staleFactor, staleTimeoutMs } = this.settings;
		let next = Number.POSITIVE_INFINITY;
		for (const entries of this.bricks.values()) {
			for (const entry of entries.values()) {
				if (entry.staleSince !== undefined) {
					next = Math.min(next, entry.staleSince + staleTimeoutMs);
				} else if (typeof entry.interval === 'number') {
					next = Math.min(next, entry.sampledAt + staleFactor * entry.interval);
				}
			}
		}
		if (!Number.isFinite(next)) { return; }
		this.cancelTimer = this.timer.set(Math.min(Math.max(0, next - this.now()), LONGEST_TIMER_MS), () => {
			this.cancelTimer = undefined;
			this.run(() => undefined);
		});
	}
}

/** Whether a reader would see a difference: a new sample of the same value is not one (D10). */
function differs(a: ReadValue, b: ReadValue): boolean {
	return !Object.is(a.value, b.value) || a.unit !== b.unit || a.mode !== b.mode
		|| a.stale !== b.stale || a.effectiveIntervalMs !== b.effectiveIntervalMs;
}

function view(rowId: string, entry: Entry): ReadValue {
	return {
		rowId,
		value: entry.value,
		...(entry.unit !== undefined ? { unit: entry.unit } : {}),
		...(entry.mode !== undefined ? { mode: entry.mode } : {}),
		sampledAt: entry.sampledAt,
		...(entry.interval !== undefined ? { effectiveIntervalMs: entry.interval } : {}),
		stale: entry.staleSince !== undefined,
	};
}
