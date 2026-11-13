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
 * while the row is still read (the brick is stalling). A stale value stays, marked, for
 * `staleTimeoutMs`, then goes. When the brick's session ends its values go at once. A static row,
 * read once, stays fresh for the whole session: it is what serves a claim made after the read.
 * Both numbers are user settings; this class holds none of its own.
 *
 * **Events carry the rows that changed (D10)** — value, mode, stale flag or effective interval —
 * and the rows dropped. Nothing is lost in an outage: there are no samples to lose, the values
 * turning stale is an event, and the first sample after the outage is one even when its value is
 * the same, because the stale flag flips back.
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
	interval?: number | 'once';
	/** When the value turned stale; undefined while it is fresh. */
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
	private readonly subscriptions: vscode.Disposable[];
	private readonly now: () => number;
	private readonly timer: ReadModelTimer;
	private settings: TelemetrySettings;
	private cancelTimer: (() => void) | undefined;

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
			source.onValues((event) => this.take(event)),
			source.onPlanChange((event) => this.plan(event)),
			source.onSessionEnded((event) => this.end(event.brickKey)),
		];
	}

	/** Changes the stale settings; they apply at once. Throws, changing nothing, for settings out of range. */
	configure(settings: TelemetrySettings): void {
		checkTelemetrySettings(settings);
		this.settings = settings;
		this.sweep();
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
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.bricks.clear();
		this.plans.clear();
		this._onChange.dispose();
	}

	// ── Internal ────────────────────────────────────────────────────

	private take(event: TelemetryValuesEvent): void {
		// Deadlines that have passed are announced first: a sample that beats a late timer to it
		// must not erase an outage without a word (D10; review of U6, round 1).
		this.sweep();
		const { brickKey } = event;
		let entries = this.bricks.get(brickKey);
		if (!entries) { entries = new Map(); this.bricks.set(brickKey, entries); }
		const plan = this.plans.get(brickKey);
		const now = this.now();
		const changed: ReadValue[] = [];
		for (const value of event.values) {
			const before = entries.get(value.rowId);
			const planned = plan?.get(value.rowId);
			const reading = {
				value: value.value,
				...(value.unit !== undefined ? { unit: value.unit } : {}),
				...(value.mode !== undefined ? { mode: value.mode } : {}),
				sampledAt: value.sampledAt,
			};
			let entry: Entry;
			if (planned === 'once' || before?.interval === 'once') {
				entry = { ...reading, interval: 'once' };
			} else if (planned === undefined) {
				// A row no longer read: the reply of a frame sent before the re-plan. Its value is
				// kept, but it stays stale, and its drop is not put off.
				entry = { ...reading, staleSince: before?.staleSince ?? now };
			} else {
				entry = { ...reading, interval: planned };
			}
			entries.set(value.rowId, entry);
			if (!before || !Object.is(before.value, entry.value) || before.mode !== entry.mode || before.unit !== entry.unit
				|| (before.staleSince === undefined) !== (entry.staleSince === undefined) || before.interval !== entry.interval) {
				changed.push(view(value.rowId, entry));
			}
		}
		this.tell(brickKey, changed, []);
		this.schedule();
	}

	private plan(event: PlanChangeEvent): void {
		const { brickKey, intervals } = event;
		if (intervals.size === 0) { this.plans.delete(brickKey); } else { this.plans.set(brickKey, intervals); }
		const entries = this.bricks.get(brickKey);
		if (!entries) { return; }
		const changed: ReadValue[] = [];
		const now = this.now();
		for (const [id, entry] of entries) {
			if (entry.interval === 'once') { continue; }
			const interval = intervals.get(id);
			if (interval === undefined) {
				// No longer read: stale at once, whatever its age.
				if (entry.staleSince === undefined) { entry.staleSince = now; changed.push(view(id, entry)); }
				continue;
			}
			if (interval !== entry.interval) { entry.interval = interval; changed.push(view(id, entry)); }
		}
		this.tell(brickKey, changed, []);
		this.sweep();
	}

	private end(brickKey: BrickRef): void {
		const entries = this.bricks.get(brickKey);
		this.bricks.delete(brickKey);
		this.plans.delete(brickKey);
		if (entries && entries.size > 0) { this.tell(brickKey, [], [...entries.keys()]); }
		this.schedule();
	}

	/**
	 * Marks what has aged past the stale limit and drops what has been stale long enough.
	 *
	 * Times count from the deadlines, not from when this runs: a value went stale when it reached
	 * `staleFactor` of its intervals, however late the timer is. A value that went stale and is
	 * gone in one pass is announced stale first, then gone: nothing is skipped (D10).
	 */
	private sweep(): void {
		const now = this.now();
		const { staleFactor, staleTimeoutMs } = this.settings;
		for (const [brickKey, entries] of this.bricks) {
			const turnedStale: ReadValue[] = [];
			const removed: string[] = [];
			for (const [id, entry] of entries) {
				if (entry.interval === 'once') { continue; }
				if (entry.staleSince === undefined && typeof entry.interval === 'number') {
					const deadline = entry.sampledAt + staleFactor * entry.interval;
					if (now >= deadline) {
						entry.staleSince = deadline;
						turnedStale.push(view(id, entry));
					}
				}
				if (entry.staleSince !== undefined && now >= entry.staleSince + staleTimeoutMs) {
					entries.delete(id);
					removed.push(id);
				}
			}
			this.tell(brickKey, turnedStale, []);
			this.tell(brickKey, [], removed);
		}
		this.schedule();
	}

	/** Sets the timer for the next moment a value turns stale or a stale one goes. */
	private schedule(): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		const { staleFactor, staleTimeoutMs } = this.settings;
		let next = Number.POSITIVE_INFINITY;
		for (const entries of this.bricks.values()) {
			for (const entry of entries.values()) {
				if (entry.interval === 'once') { continue; }
				if (entry.staleSince !== undefined) {
					next = Math.min(next, entry.staleSince + staleTimeoutMs);
				} else if (typeof entry.interval === 'number') {
					next = Math.min(next, entry.sampledAt + staleFactor * entry.interval);
				}
			}
		}
		if (next === Number.POSITIVE_INFINITY) { return; }
		this.cancelTimer = this.timer.set(Math.min(Math.max(0, next - this.now()), LONGEST_TIMER_MS), () => {
			this.cancelTimer = undefined;
			this.sweep();
		});
	}

	private tell(brickKey: BrickRef, rows: readonly ReadValue[], removed: readonly string[]): void {
		if (rows.length > 0 || removed.length > 0) { this._onChange.fire({ brickKey, rows, removed }); }
	}
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
