/**
 * One base tick per brick, with integer dividers.
 *
 * A row's cadence is a whole number of ticks: divider 1 is every tick, 5 is every fifth. This
 * replaced a due-list holding per-row next-due times and firing on wall-clock, which bought
 * nothing and gave up three properties (DESIGN §9.1b):
 *
 *  - **At most one frame in flight.** A tick that arrives while the previous frame is still
 *    outstanding is *skipped*, not queued. LEGO's own Device Manager guards this with an
 *    `Interlocked` counter, and LEGOev3 gets it structurally by awaiting each reply before its
 *    delay. Without it a stalled brick lets frames pile up behind a serial queue until the
 *    heartbeat misses its window and trips reconnect on a brick that is merely busy. Not a
 *    corner case: one unsettled sensor can hold a frame for 1.2 s while Bluetooth sustains
 *    10.7 commands a second.
 *  - **The tick is the only clock.** Phase comes from the tick counter, so no row drifts and
 *    none can be pulled forward. "Nearly due" needed a bound nobody could state; a divider
 *    needs none.
 *  - **A skipped tick is a later sample, never a gap.** The next tick includes every row whose
 *    divider comes up, so a stall costs latency and nothing else.
 */

import { TelemetryRow, RowValue, comesUpOnTick } from './telemetryRow';
import {
	AssembledFrame,
	FrameLimits,
	assembleFrame,
	buildTelemetryFrame,
	parseFrame,
} from './frameAssembler';

/** Sends one composed frame and returns the reply payload. */
export type FrameSender = (payload: Uint8Array) => Promise<Uint8Array>;

/** Port states in which a value row is safe to read. Anything else is gated out. */
const TYPE_TERMINAL = 124;

export interface SchedulerOptions {
	readonly rows: readonly TelemetryRow[];
	readonly limits: FrameLimits;
	readonly send: FrameSender;
	/** Milliseconds between ticks. Throttling moves this and nothing else (§9.5). */
	readonly tickPeriodMs: number;
	/** Called with every row value a frame produced. */
	readonly onValues?: (values: readonly RowValue[]) => void;
	/** Called when a frame fails, so the caller can decide about the link. */
	readonly onError?: (error: unknown) => void;
	/** Injectable clock, so tests need neither timers nor real time. */
	readonly now?: () => number;
}

export interface SchedulerStats {
	readonly ticks: number;
	readonly framesSent: number;
	/** Ticks that found the previous frame still outstanding and stood down. */
	readonly ticksSkipped: number;
	/** Ticks where every eligible row was gated or retired, so nothing was worth sending. */
	readonly ticksEmpty: number;
	readonly framesFailed: number;
	/** Rows deferred by truncation and still waiting for a turn. */
	readonly carriedOver: number;
}

/**
 * Drives telemetry for one brick.
 *
 * `runTick` is public and returns a promise so tests can drive it directly. `start` wraps it
 * in a timer for production; nothing about the scheduling logic depends on which is used.
 */
export class TelemetryScheduler {
	private tick = 0;
	private inFlight = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	private framesSent = 0;
	private ticksSkipped = 0;
	private ticksEmpty = 0;
	private framesFailed = 0;

	/** Rows truncation deferred, which go to the front of the next tick. */
	private carriedOver: TelemetryRow[] = [];

	/** One-shot rows already read. Retired rather than asked twice. */
	private readonly retired = new Set<string>();

	/**
	 * Last occupancy code seen per port.
	 *
	 * A value row is gated on this, and it is one tick stale by construction: a port's type
	 * arrives in the same reply as its value, so the decision can only use what the previous
	 * frame reported. The consequences are stated rather than hidden — a freshly known port
	 * shows no value for one extra tick, and a just-emptied port had a slot allocated in the
	 * frame already in flight.
	 *
	 * Empty until the first occupancy row lands. An unknown port is treated as readable, so a
	 * cold start does not sit silent waiting for permission; the firmware answers NAN for a
	 * port with nothing on it, which is a correct reading of an empty port.
	 */
	private readonly occupancy = new Map<string, number>();

	private readonly now: () => number;

	constructor(private readonly options: SchedulerOptions) {
		this.now = options.now ?? (() => Date.now());
	}

	get stats(): SchedulerStats {
		return {
			ticks: this.tick,
			framesSent: this.framesSent,
			ticksSkipped: this.ticksSkipped,
			ticksEmpty: this.ticksEmpty,
			framesFailed: this.framesFailed,
			carriedOver: this.carriedOver.length,
		};
	}

	/** Occupancy code last reported for a port, if any frame has carried it yet. */
	occupancyOf(port: string): number | undefined {
		return this.occupancy.get(port);
	}

	start(): void {
		if (this.timer || this.disposed) { return; }
		this.timer = setInterval(() => { void this.runTick(); }, this.options.tickPeriodMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	/**
	 * Composes and sends one frame, unless a frame is already outstanding.
	 *
	 * Advances the tick counter even when it stands down, so a slow brick slips phase rather
	 * than freezing it: a row with divider 5 keeps coming up every fifth tick of wall-clock
	 * time whether or not each of those ticks got to send.
	 */
	async runTick(): Promise<void> {
		if (this.disposed) { return; }

		const currentTick = this.tick;
		this.tick += 1;

		if (this.inFlight) {
			// The previous frame has not come back. Queueing another would put a stale frame
			// in front of the heartbeat; standing down costs one sample and nothing else.
			this.ticksSkipped += 1;
			return;
		}

		const candidates = this.candidatesFor(currentTick);
		if (candidates.length === 0) {
			this.ticksEmpty += 1;
			return;
		}

		let frame: AssembledFrame;
		try {
			frame = assembleFrame(candidates, this.options.limits);
		} catch (error) {
			this.framesFailed += 1;
			this.options.onError?.(error);
			return;
		}

		this.carriedOver = [...frame.deferred];
		this.inFlight = true;
		try {
			const payload = await this.options.send(buildTelemetryFrame(frame));
			this.framesSent += 1;
			this.consume(frame, payload);
		} catch (error) {
			this.framesFailed += 1;
			this.options.onError?.(error);
		} finally {
			this.inFlight = false;
		}
	}

	/**
	 * Rows for this tick: what truncation deferred last time, then what comes up now.
	 *
	 * Carried-over rows go first, which is what makes truncation rotating rather than a
	 * permanent loss. Static priority on a tight budget starves the same rows every tick —
	 * with the old mandatory type sweep that meant a panel showing ports appear and disappear
	 * but never a reading.
	 */
	private candidatesFor(tick: number): TelemetryRow[] {
		const chosen: TelemetryRow[] = [];
		const taken = new Set<string>();

		const consider = (row: TelemetryRow): void => {
			if (taken.has(row.id)) { return; }
			if (this.retired.has(row.id)) { return; }
			if (!this.isReadable(row)) { return; }
			taken.add(row.id);
			chosen.push(row);
		};

		for (const row of this.carriedOver) { consider(row); }
		for (const row of this.options.rows) {
			if (comesUpOnTick(row.lifetime, tick)) { consider(row); }
		}
		return chosen;
	}

	/**
	 * Is this row safe to include?
	 *
	 * Only value rows are gated, and only on their port's last reported occupancy. A row with
	 * no port, or a port nothing has reported yet, is readable: the gate exists to avoid the
	 * 1.2-second stall a still-*identifying* device causes, not to withhold readings until
	 * permission arrives.
	 */
	private isReadable(row: TelemetryRow): boolean {
		if (row.port === undefined) { return true; }
		// An occupancy row reads the type itself, so gating it on the type would be circular
		// and would make a port that ever went empty unrecoverable.
		if (row.reportsOccupancy) { return true; }

		const code = this.occupancy.get(row.port);
		if (code === undefined) { return true; }
		return isReadableType(code);
	}

	/** Reads a reply, updates the occupancy gate, and retires any one-shot rows it carried. */
	private consume(frame: AssembledFrame, payload: Uint8Array): void {
		const values = parseFrame(frame, payload, this.now());

		for (const { row } of frame.placed) {
			if (row.lifetime.kind === 'oneShot') { this.retired.add(row.id); }
		}

		// Occupancy rows carry a type code, and the value rows read it next tick.
		for (const { row, slot } of frame.placed) {
			if (row.reportsOccupancy && row.port !== undefined) {
				this.occupancy.set(row.port, payload[slot]);
			}
		}

		this.options.onValues?.(values);
	}
}

/**
 * Is a port type code one whose value can be read?
 *
 * 125 `TYPE_UNKNOWN` is a device still identifying — readable-looking but the one code that
 * must be skipped, because the read takes the device-present path and blocks. 126 and 127 are
 * absent and faulty; the firmware answers NAN for both, which is a correct answer rather than
 * an error, but there is nothing to learn from asking. 124 `TYPE_TERMINAL` is a console, not a
 * peripheral.
 */
export function isReadableType(code: number): boolean {
	return code < TYPE_TERMINAL;
}
