/**
 * Bluetooth presence — which bricks are actually there, found without connecting.
 *
 * Windows lists every paired brick whether it is switched on or not, and a brick nobody has
 * paired yet shows up nowhere until somebody runs an inquiry. Two background jobs fill those
 * gaps (step-2 plan, KD5, U7):
 *
 *  - an **inquiry** every so often, so a brick never seen before appears in the list by itself;
 *  - a **presence check** of each paired brick without a session (an uncached service query),
 *    so a switched-off brick turns "not heard" instead of looking available.
 *
 * The check is one-sided (measured 30.10.2026, plan U6): an answer proves the brick is on,
 * silence may be this host's adapter missing the page. So a brick is "heard" on its first
 * answer and "not heard" only after several misses in a row — the owner's choice. Until its
 * first check a paired brick counts as heard: Windows' record is all there is to go on.
 *
 * Both jobs hold the Bluetooth connection queue while they run, so neither ever pages the
 * radio beside a connect or a pairing, but they hold it for mutual exclusion only: releasing
 * it starts no cooldown, and an unanswered check is not an error.
 */

import { BackendUnavailableError } from '../errors/CockpitError';
import { BtConnectionQueue } from './btConnectionQueue';
import { ScannedBrick } from './btPairingHelper';
import { BT } from './transportConstants';

/** What the latest checks say about one paired brick. */
export interface PairedPresence {
	readonly heard: boolean;
	/** When it last answered, if it ever has. */
	readonly heardAt?: number;
}

/** A brick the inquiry heard that is not paired with this computer. */
export interface UnpairedSighting {
	readonly mac: string;
	readonly name: string;
	readonly signal: number | null;
	readonly seenAt: number;
}

export interface BtPresenceOptions {
	readonly queue: BtConnectionQueue;
	/** One presence check; true when the brick answered. */
	readonly check: (mac: string) => Promise<boolean>;
	/** One inquiry window; resolves with every brick it heard. */
	readonly inquire: () => Promise<ScannedBrick[]>;
	/** The paired bricks to check now: those without a Bluetooth session. */
	readonly pairedWithoutSession: () => readonly string[];
	readonly checkIntervalMs?: number;
	readonly inquiryIntervalMs?: number;
	/** Misses in a row before a paired brick counts as not heard. */
	readonly missesBeforeNotHeard?: number;
	/** Told once when the helper cannot run, after which both jobs stop. */
	readonly onUnavailable?: (reason: string) => void;
	/** Fired after a round that changed what is known, so discovery can be asked again. */
	readonly onChange?: () => void;
}

interface PairedState {
	heard: boolean;
	heardAt?: number;
	misses: number;
}

const normalise = (mac: string): string => mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

export class BtPresenceMonitor {
	private readonly paired = new Map<string, PairedState>();
	private readonly unpaired = new Map<string, UnpairedSighting>();
	private readonly checkIntervalMs: number;
	private readonly inquiryIntervalMs: number;
	private readonly missesBeforeNotHeard: number;
	private timers: NodeJS.Timeout[] = [];
	private checking = false;
	private inquiring = false;
	private stopped = false;

	constructor(private readonly options: BtPresenceOptions) {
		this.checkIntervalMs = options.checkIntervalMs ?? BT.PRESENCE_CHECK_INTERVAL_MS;
		this.inquiryIntervalMs = options.inquiryIntervalMs ?? BT.PRESENCE_INQUIRY_INTERVAL_MS;
		this.missesBeforeNotHeard = options.missesBeforeNotHeard ?? BT.PRESENCE_MISSES_BEFORE_NOT_HEARD;
	}

	/** Start both jobs on their timers, with a first round of each straight away. */
	start(): void {
		if (this.stopped || this.timers.length > 0) { return; }
		const every = (ms: number, job: () => Promise<void>): NodeJS.Timeout => {
			const timer = setInterval(() => { void job(); }, ms);
			timer.unref();
			return timer;
		};
		this.timers = [
			every(this.inquiryIntervalMs, () => this.runInquiry()),
			every(this.checkIntervalMs, () => this.runChecks()),
		];
		void this.runInquiry().then(() => this.runChecks());
	}

	dispose(): void {
		this.stopped = true;
		for (const timer of this.timers) { clearInterval(timer); }
		this.timers = [];
	}

	/** What the checks say about a paired brick, or undefined before its first check. */
	presenceOf(mac: string): PairedPresence | undefined {
		const state = this.paired.get(normalise(mac));
		return state ? { heard: state.heard, ...(state.heardAt ? { heardAt: state.heardAt } : {}) } : undefined;
	}

	/** Unpaired bricks the recent inquiries heard. */
	unpairedBricks(): UnpairedSighting[] {
		return [...this.unpaired.values()];
	}

	/**
	 * One round of presence checks, one brick at a time. Skipped while the previous round runs.
	 *
	 * The queue is released between bricks, so a user's connect waits for at most one check.
	 */
	async runChecks(): Promise<void> {
		if (this.checking || this.stopped) { return; }
		this.checking = true;
		let changed = false;
		try {
			const targets = this.options.pairedWithoutSession();
			// A brick with a session is plainly there; whatever its last checks said is stale by
			// the time its session ends, and must not mark it not heard on its way back.
			const current = new Set(targets.map(normalise));
			for (const key of [...this.paired.keys()]) {
				if (!current.has(key)) { this.paired.delete(key); }
			}
			for (const mac of targets) {
				if (this.stopped) { return; }
				const release = await this.options.queue.acquire(`presence:${mac}`, { holdOnly: true });
				let answered: boolean;
				try {
					answered = await this.options.check(mac);
				} finally {
					release();
				}
				changed = this.record(mac, answered) || changed;
			}
		} catch (error) {
			this.handleFailure(error);
		} finally {
			this.checking = false;
		}
		if (changed) { this.options.onChange?.(); }
	}

	/** One inquiry window. Skipped while the previous one runs. */
	async runInquiry(): Promise<void> {
		if (this.inquiring || this.stopped) { return; }
		this.inquiring = true;
		let changed = false;
		try {
			const release = await this.options.queue.acquire('presence:inquiry', { holdOnly: true });
			let heard: ScannedBrick[];
			try {
				heard = await this.options.inquire();
			} finally {
				release();
			}
			const now = Date.now();
			for (const brick of heard) {
				// A paired brick is listed from Windows' records and checked on its own.
				if (brick.paired) { continue; }
				const key = normalise(brick.mac);
				changed ||= !this.unpaired.has(key);
				this.unpaired.set(key, { mac: brick.mac, name: brick.name, signal: brick.signal, seenAt: now });
			}
			// A brick missed by two windows running has left; one miss can be the radio.
			for (const [key, sighting] of this.unpaired) {
				if (now - sighting.seenAt > 2 * this.inquiryIntervalMs) {
					this.unpaired.delete(key);
					changed = true;
				}
			}
		} catch (error) {
			this.handleFailure(error);
		} finally {
			this.inquiring = false;
		}
		if (changed) { this.options.onChange?.(); }
	}

	/** Apply one check's answer. Returns true when the brick's heard state changed. */
	private record(mac: string, answered: boolean): boolean {
		const key = normalise(mac);
		const state = this.paired.get(key) ?? { heard: true, misses: 0 };
		const before = this.paired.has(key) ? state.heard : undefined;
		if (answered) {
			state.heard = true;
			state.heardAt = Date.now();
			state.misses = 0;
		} else {
			state.misses += 1;
			if (state.misses >= this.missesBeforeNotHeard) { state.heard = false; }
		}
		this.paired.set(key, state);
		return answered || state.heard !== before;
	}

	private handleFailure(error: unknown): void {
		// A helper that cannot run at all (not installed, not Windows) will not start working
		// on the next tick; stop and say so once rather than fail every minute.
		if (error instanceof BackendUnavailableError) {
			this.dispose();
			this.options.onUnavailable?.(error.message);
		}
	}
}
