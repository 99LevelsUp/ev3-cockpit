/**
 * Who wants which telemetry rows of one brick, and how often (step-6 plan U5; IMPLEMENTATION_PLAN
 * 3.3.5, 3.1.10; DESIGN §9.3; owner decisions D2, D6, D7).
 *
 * A claim names rows and the interval it wants them at. Each row is read as fast as its fastest
 * claim asks, clamped to the transport's floor, so one consumer asking 10 Hz over Bluetooth
 * cannot take the link from everyone else. The tick runs at the fastest interval any claim got;
 * a row's divider is the whole number of ticks that is not slower than its claim asked.
 *
 * The claim is told what each row was granted: its request clamped to the floor, a promise of at
 * least that often. The grant is fixed when the claim is made and stays as negotiated (D2): when
 * the foreground leaves, throttling moves the tick or the route changes the floor, what a row
 * really runs at travels in the data as `effectiveIntervalMs`, and nothing is re-negotiated.
 *
 * The cockpit's own foreground — the active brick's panel — is a claim on every row: sampled
 * rows at the transport's foreground cadence, event rows every fifth of those, static rows once.
 * It holds no sensor mode (D7): it reads whatever mode a claim holds, the device's default
 * otherwise, so a consumer can always ask another mode of the active brick.
 *
 * A mode is a parameter of a claim (D6). The first claim on a port holds its mode; a claim asking
 * another mode is refused with `mode_conflict`, naming the holder (D7). The same mode is shared,
 * and the port is free again when the last claim holding it is released.
 */

import { ModeConflictError } from '../errors/CockpitError';
import { RowRegistry } from './rowRegistry';
import { TelemetryRow, withLifetime } from './telemetryRow';

/** An opaque handle for one claim. */
export type ClaimHandle = string;

export interface ClaimRequest {
	readonly rowIds: readonly string[];
	/** How often the rows are wanted, in milliseconds. */
	readonly intervalMs: number;
	/** The mode to read a sensor port in, by port: `{ '1': 2 }` (D6). */
	readonly modes?: Readonly<Record<string, number>>;
}

/**
 * What each row of a claim was granted: an interval in milliseconds the row is read at least as
 * often as, or `'once'` for a static row.
 */
export type Grant = Readonly<Record<string, number | 'once'>>;

/** The rows to read and the tick to read them on. */
export interface TelemetryPlan {
	readonly periodMs: number;
	readonly rows: readonly TelemetryRow[];
}

export interface ClaimCadence {
	/** The fastest tick the transport permits. */
	readonly floorMs: number;
	/** The foreground's tick on this transport. */
	readonly foregroundMs: number;
}

interface Claim {
	readonly owner: string;
	readonly rowIds: readonly string[];
	readonly intervalMs: number;
	readonly modes: ReadonlyMap<string, number>;
	readonly grant: Grant;
}

/** Event rows go every fifth foreground tick, as LEGO's Device Manager divides its slow tier. */
const FOREGROUND_EVENT_FACTOR = 5;
/** The firmware's modes are 0–7 (`opINPUT_READSI`, `c_input.c`). */
const MAX_MODE = 7;

export class TelemetryClaims {
	private readonly claims = new Map<ClaimHandle, Claim>();
	private foreground = false;
	private next = 1;

	constructor(private readonly registry: RowRegistry, private cadence: ClaimCadence) {}

	/** Whether the brick is the active one, whose panel claims every row. */
	setForeground(active: boolean): void {
		this.foreground = active;
	}

	/** The transport changed: the floor and the foreground's cadence with it. Grants stay as negotiated (D2). */
	setCadence(cadence: ClaimCadence): void {
		this.cadence = cadence;
	}

	/** Whether anything but the foreground claims a row. */
	hasClaims(): boolean {
		return this.claims.size > 0;
	}

	/** Adds a claim, or throws and adds nothing. */
	claim(request: ClaimRequest, owner: string): { readonly handle: ClaimHandle } {
		if (!(Number.isFinite(request.intervalMs) && request.intervalMs > 0)) {
			throw new Error(`A claim's interval must be a positive number of milliseconds, not ${request.intervalMs}.`);
		}
		for (const id of request.rowIds) {
			if (!this.registry.get(id)) { throw new Error(`There is no telemetry row '${id}'; list the rows for their ids.`); }
		}
		const modes = new Map(Object.entries(request.modes ?? {}));
		const modePorts = this.registry.modePorts();
		for (const [port, mode] of modes) {
			if (!modePorts.has(port)) { throw new Error(`Port ${port} has no mode to choose.`); }
			if (!(Number.isInteger(mode) && mode >= 0 && mode <= MAX_MODE)) {
				throw new Error(`A mode is a whole number from 0 to ${MAX_MODE}, not ${mode}.`);
			}
			const holder = this.holderOf(port);
			if (holder && holder.mode !== mode) {
				throw new ModeConflictError(`Port ${port} is read in mode ${holder.mode} for ${holder.owner}; release that claim first.`);
			}
		}
		const grant: Record<string, number | 'once'> = {};
		for (const id of request.rowIds) {
			grant[id] = this.registry.get(id)?.tier === 'static'
				? 'once'
				: Math.max(request.intervalMs, this.cadence.floorMs);
		}
		const handle = `claim-${this.next++}`;
		this.claims.set(handle, { owner, rowIds: [...request.rowIds], intervalMs: request.intervalMs, modes, grant });
		return { handle };
	}

	/** Releases one claim; releasing it again does nothing. */
	release(handle: ClaimHandle): void {
		this.claims.delete(handle);
	}

	/** Ends every claim, as when the brick goes; returns the handles that ended. */
	endAll(): ClaimHandle[] {
		const ended = [...this.claims.keys()];
		this.claims.clear();
		return ended;
	}

	/** What each row of a claim was granted when it was made; undefined for a released claim. */
	grantOf(handle: ClaimHandle): Grant | undefined {
		return this.claims.get(handle)?.grant;
	}

	/** The rows to read, with their dividers and modes, and the tick to read them on. */
	plan(): TelemetryPlan {
		const wanted = this.wantedIntervals();
		if (wanted.size === 0) { return { periodMs: this.cadence.foregroundMs, rows: [] }; }
		const repeating = [...wanted.values()].filter((ms): ms is number => ms !== 'once');
		// Every interval is clamped to the floor already, so the period is too.
		const periodMs = repeating.length ? Math.min(...repeating) : this.cadence.foregroundMs;
		const rows: TelemetryRow[] = [];
		// Registration order is truncation priority (`allEv3Rows`).
		for (const base of this.registry.all()) {
			const ms = wanted.get(base.id);
			if (ms === undefined) { continue; }
			const mode = base.port === undefined ? undefined : this.holderOf(base.port)?.mode;
			const row = mode === undefined ? base : (this.registry.inMode(base.id, mode) ?? base);
			rows.push(withLifetime(row, ms === 'once'
				? { kind: 'oneShot' }
				: { kind: 'repeating', divider: Math.max(1, Math.floor(ms / periodMs)) }));
		}
		return { periodMs, rows };
	}

	/** The fastest interval asked of each row, `'once'` for a static row. */
	private wantedIntervals(): Map<string, number | 'once'> {
		const wanted = new Map<string, number | 'once'>();
		const want = (id: string, ms: number): void => {
			const row = this.registry.get(id);
			if (!row) { return; }
			if (row.tier === 'static') { wanted.set(id, 'once'); return; }
			const asked = Math.max(ms, this.cadence.floorMs);
			const before = wanted.get(id);
			wanted.set(id, typeof before === 'number' ? Math.min(before, asked) : asked);
		};
		if (this.foreground) {
			for (const row of this.registry.all()) {
				want(row.id, row.tier === 'sampled' ? this.cadence.foregroundMs : this.cadence.foregroundMs * FOREGROUND_EVENT_FACTOR);
			}
		}
		for (const claim of this.claims.values()) {
			for (const id of claim.rowIds) { want(id, claim.intervalMs); }
		}
		return wanted;
	}

	/** The mode a port is held in, and by whom: the earliest claim still holding it. */
	private holderOf(port: string): { mode: number; owner: string } | undefined {
		for (const claim of this.claims.values()) {
			const mode = claim.modes.get(port);
			if (mode !== undefined) { return { mode, owner: claim.owner }; }
		}
		return undefined;
	}
}
