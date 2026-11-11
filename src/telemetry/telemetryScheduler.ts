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
 *    corner case: a brick drawing its own port screen stalls the channel several times a
 *    second (DESIGN §4.5), and Bluetooth sustains 10.7 commands a second.
 *  - **The tick is the only clock.** Phase comes from the tick counter, so no row drifts and
 *    none can be pulled forward. "Nearly due" needed a bound nobody could state; a divider
 *    needs none.
 *  - **A skipped tick is a later sample, never a gap.** The next tick includes every row whose
 *    divider comes up, so a stall costs latency and nothing else.
 */

import { TelemetryRow, RowValue, comesUpOnTick, assertValidLifetime } from './telemetryRow';
import { portStateOf, PortState } from './portState';
import {
	AssembledFrame,
	FrameLimits,
	assembleFrame,
	assertNoModeConflict,
	buildTelemetryFrame,
	parseFrame,
} from './frameAssembler';

/**
 * How long a port's readings are withheld after its mode was switched, at most: the firmware's
 * `MAX_DEVICE_BUSY_TIME`, 1200 ms (`lms2012.h` 313), the longest a device may stay busy after a
 * mode change. U10 measures the real settle on a brick and may tune it.
 */
export const SETTLE_LIMIT_MS = 1200;

/** Sends one composed frame and returns the reply payload. */
export type FrameSender = (payload: Uint8Array) => Promise<Uint8Array>;

export interface SchedulerOptions {
	readonly rows: readonly TelemetryRow[];
	/**
	 * The link's packet budget, or a function returning it.
	 *
	 * A function is what a live session needs. `maxPacketBytes` is a property of the link
	 * rather than of the transport, and a session outlives its link: `attemptReconnect`
	 * reuses the same session resources and only rewires the executor, so a USB brick that
	 * comes back on the HID fallback keeps a scheduler that was built for libusb. Fixed
	 * limits would then compose 1024-byte frames for a 64-byte link, and the failure is
	 * silent truncation rather than an error.
	 */
	readonly limits: FrameLimits | (() => FrameLimits);
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

	/**
	 * The mode last sent to each port, whatever rows are in the set now: the device stays in it
	 * until a command changes it. Forgotten when the port stops being known (a replugged device
	 * starts afresh).
	 */
	private readonly commandedMode = new Map<string, number>();

	/**
	 * Ports settling after a command switched their mode, with the clock time it ends at the latest.
	 * One frame in flight and one mode per port mean a reply always reads the mode being settled.
	 */
	private readonly settling = new Map<string, { readonly until: number }>();

	/** A row set given while a tick was in flight; applied when that tick ends. */
	private pendingRows: readonly TelemetryRow[] | undefined;

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
	/** The rows read now; `setRows` replaces them while running (KTD2). */
	private rows: readonly TelemetryRow[];
	private period: number;

	constructor(private readonly options: SchedulerOptions) {
		this.now = options.now ?? (() => Date.now());
		assertNoModeConflict(options.rows);
		this.rows = options.rows;
		this.period = options.tickPeriodMs;
	}

	/** The rows in force: a set given while a tick was in flight counts from when it was given. */
	get currentRows(): readonly TelemetryRow[] {
		return this.pendingRows ?? this.rows;
	}

	/** Milliseconds between ticks now. */
	get tickPeriodMs(): number {
		return this.period;
	}

	/**
	 * Replaces the rows while running. Keeps the tick counter (phase), the occupancy gate and the
	 * retired one-shots; a carried-over row stays only if still wanted, in its new version. A
	 * refused set leaves the old one in place. Given while a tick is in flight, the set is
	 * checked now and takes effect when that tick ends, so the tick finishes the work it began
	 * and nothing it collected outlives the new set (review of U4, 11.11.2026).
	 */
	setRows(rows: readonly TelemetryRow[]): void {
		const ids = new Set<string>();
		for (const row of rows) {
			assertValidLifetime(row.id, row.lifetime);
			if (ids.has(row.id)) { throw new Error(`Row '${row.id}' is in the set twice.`); }
			ids.add(row.id);
		}
		// One mode per port at any time (DESIGN §9.1c): alternating frames would switch the mode
		// every frame and both rows would read NaN for ever.
		assertNoModeConflict(rows);
		if (this.inFlight) { this.pendingRows = [...rows]; return; }
		this.applyRows(rows);
	}

	private applyRows(rows: readonly TelemetryRow[]): void {
		const byId = new Map(rows.map((row) => [row.id, row] as const));
		this.rows = [...rows];
		this.carriedOver = this.carriedOver.flatMap((row) => {
			const next = byId.get(row.id);
			return next && next.lifetime.kind !== 'off' ? [next] : [];
		});
	}

	/**
	 * Changes the period: restarts the timer, adds no tick, keeps the count. No floor here — the
	 * scheduler does not know the transport; `BrickTelemetry.setPeriod` clamps to it.
	 */
	setPeriod(ms: number): void {
		if (!(Number.isFinite(ms) && ms > 0)) { throw new Error(`A tick period must be a positive number of milliseconds, not ${ms}.`); }
		this.period = ms;
		if (this.timer) { this.stop(); this.start(); }
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

	/** What the port is doing, from its last reported occupancy (3.1.11). */
	portState(port: string): PortState {
		return portStateOf(this.occupancy.get(port));
	}

	start(): void {
		if (this.timer || this.disposed) { return; }
		this.timer = setInterval(() => { void this.runTick(); }, this.period);
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
		// One command a tick (owner decision D8): every command costs a running program about 2 ms
		// of the brick's VM whatever it carries, so event and static rows ride with the sampled ones.
		this.inFlight = true;
		try {
			const carried: TelemetryRow[] = [];
			await this.sendFrame(candidates, carried);
			this.carriedOver = carried;
		} finally {
			this.inFlight = false;
			const pending = this.pendingRows;
			this.pendingRows = undefined;
			if (pending) { this.applyRows(pending); }
		}
	}

	/** Composes and sends one frame; what did not fit goes into `carried`. Resolves whether it went. */
	private async sendFrame(rows: readonly TelemetryRow[], carried: TelemetryRow[]): Promise<boolean> {
		// Disposed meanwhile — also from a listener of the tick's first frame: nothing more goes out.
		if (this.disposed) { return false; }
		let frame: AssembledFrame;
		try {
			// Resolved per frame, not per scheduler: see `SchedulerOptions.limits`.
			frame = assembleFrame(rows, this.resolveLimits());
		} catch (error) {
			this.framesFailed += 1;
			this.options.onError?.(error);
			return false;
		}
		carried.push(...frame.deferred);
		this.noteModes(frame);
		let payload: Uint8Array;
		try {
			payload = await this.options.send(buildTelemetryFrame(frame));
		} catch (error) {
			// The command may never have reached the brick: the mode it carried is not known to be
			// set, so the next read of those ports settles afresh (review of U4, round 2).
			this.forgetModes(frame);
			// Its rows go to the front of the next tick: a slow row would otherwise wait for its next
			// turn, a divider-100 row a hundred ticks (review of U4, round 1).
			carried.push(...frame.placed.map(({ row }) => row));
			this.framesFailed += 1;
			this.options.onError?.(error);
			return false;
		}
		this.framesSent += 1;
		// Disposed while the reply was on its way: nobody is to hear from this loop again.
		if (this.disposed) { return false; }
		// The command reached the brick: what goes wrong from here is not the link's (round 3).
		this.consume(frame, payload);
		return true;
	}

	private forgetModes(frame: AssembledFrame): void {
		for (const { row } of frame.placed) {
			if (row.port === undefined || row.mode === undefined || row.reportsOccupancy) { continue; }
			this.commandedMode.delete(row.port);
			this.settling.delete(row.port);
		}
	}

	/** The packet budget in force right now. */
	private resolveLimits(): FrameLimits {
		const { limits } = this.options;
		return typeof limits === 'function' ? limits() : limits;
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
		for (const row of this.rows) {
			// A one-shot comes up on every tick until it has been read, not only on tick 0: a row
			// set replaced later may add one, and it must still be read once (step-6 U4).
			if (row.lifetime.kind === 'oneShot' || comesUpOnTick(row.lifetime, tick)) { consider(row); }
		}
		return chosen;
	}

	/**
	 * Is this row safe to include?
	 *
	 * Only value rows are gated, and only on their port's last reported occupancy. A row with
	 * no port, or a port nothing has reported yet, is readable: the gate saves the bytes of a
	 * read with nothing to learn, it does not withhold readings until permission arrives.
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

	/**
	 * Records the mode each read in the frame selects. A read in a mode other than the one last
	 * sent to the port — or to a port whose mode is not known — switches the device, and its
	 * readings are NaN until it settles: the settle starts now, when the command goes out, and is
	 * timed by the clock, so neither a late divider nor a period change moves it (review of U4).
	 */
	private noteModes(frame: AssembledFrame): void {
		for (const { row } of frame.placed) {
			if (row.port === undefined || row.mode === undefined || row.reportsOccupancy) { continue; }
			if (this.commandedMode.get(row.port) !== row.mode) {
				this.settling.set(row.port, { until: this.now() + SETTLE_LIMIT_MS });
				this.commandedMode.set(row.port, row.mode);
			}
		}
	}

	/** Reads a reply, updates the occupancy gate, and retires the one-shots whose reading was delivered. */
	private consume(frame: AssembledFrame, payload: Uint8Array): void {
		const values = this.settled(frame, parseFrame(frame, payload, this.now()));
		const delivered = new Set(values.map((value) => value.rowId));

		for (const { row } of frame.placed) {
			// A reading the settle withheld was not delivered: the one-shot is asked again.
			if (row.lifetime.kind === 'oneShot' && delivered.has(row.id)) { this.retired.add(row.id); }
		}

		// Occupancy rows carry a type code, and the value rows read it next tick.
		for (const { row, slot } of frame.placed) {
			if (row.reportsOccupancy && row.port !== undefined) {
				this.occupancy.set(row.port, payload[slot]);
				// Not known any more: whatever is plugged in next starts in its own default mode.
				if (portStateOf(payload[slot]) !== 'known') {
					this.commandedMode.delete(row.port);
					this.settling.delete(row.port);
				}
			}
		}

		if (values.length === 0) { return; }
		// A consumer's failing listener is reported, not mistaken for a failed frame (review of U4, round 3).
		try { this.options.onValues?.(values); } catch (error) { this.options.onError?.(error); }
	}

	/**
	 * Drops the readings of a port that is settling after a mode switch, until one comes back as
	 * a number or the settle limit passes — a mode that legitimately reads NaN, or a port emptied
	 * mid-settle, must not stay muted.
	 */
	private settled(frame: AssembledFrame, values: RowValue[]): RowValue[] {
		if (this.settling.size === 0) { return values; }
		const now = this.now();
		return values.filter((value, index) => {
			const { row } = frame.placed[index];
			if (row.port === undefined || row.reportsOccupancy) { return true; }
			const entry = this.settling.get(row.port);
			if (entry === undefined) { return true; }
			if ((typeof value.value === 'number' && Number.isFinite(value.value)) || now >= entry.until) {
				this.settling.delete(row.port);
				return true;
			}
			return false;
		});
	}
}

/**
 * Is a port type code one whose value is read? Only a known device's (`portState.ts` says why:
 * nothing to learn otherwise, and the bytes are scarce — not a stall, per `c_input.c`).
 */
export function isReadableType(code: number): boolean {
	return portStateOf(code) === 'known';
}
