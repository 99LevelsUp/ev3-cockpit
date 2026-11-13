/**
 * How fast one brick's telemetry tick may run, from how its round trips behave (step-6 plan U7;
 * IMPLEMENTATION_PLAN 3.4.1, 3.4.3, 3.4.5; DESIGN §4.5, §9.5; KTD5).
 *
 * Throttling moves one knob, the tick, by a factor over the plan's period: dividers and phases
 * stay. The input is each telemetry frame's round trip, as a distribution rather than an average:
 * a brick drawing its port screen keeps a 6 ms median and a 37 ms p95, and only the tail tells it
 * from a quiet one (DESIGN §4.5). Queue depth is not an input — one frame in flight per brick pins
 * it at 0 or 1.
 *
 * Tumbling windows of `windowSize` round trips. At the end of each, the window's p95 is set against
 * `tailFactor` × the link's usual round trip: over it, the factor grows one `step`, up to
 * `maxSlowdown`; within it for `calmWindows` windows in a row, it shrinks one step, down to 1. One
 * stall in a window is not its p95; two in twenty are. All of these are user settings (D9); the
 * links' usual round trips are measurements, not settings.
 */

import { Transport } from '../contracts/enums';
import { BT, TCP, USB } from '../transports/transportConstants';
import { ThrottleSettings, checkThrottleSettings } from './telemetrySettings';

/** What the diagnostic display shows for a brick (3.4.5). */
export interface ThrottleState {
	/** The tick as a multiple of the plan's: 1 is not throttled. */
	readonly factor: number;
	/** The p95 a window may reach, in milliseconds. */
	readonly limitMs: number;
	/** The last complete window's p95, in milliseconds; absent before the first. */
	readonly p95Ms?: number;
	/** Round trips over the limit in the last complete window. */
	readonly stalls: number;
	/** Round trips gathered towards the next decision. */
	readonly windowSamples: number;
}

/**
 * A link's usual round trip, measured (`COMMAND_RTT_MS`, DESIGN §9.2). The mock has no wire and is
 * timed as USB; a transport not known is timed as the slowest, Bluetooth, so the limit errs wide.
 */
export function typicalRoundTripMs(transport: Transport | undefined): number {
	switch (transport) {
	case Transport.USB:
	case Transport.Mock:
		return USB.COMMAND_RTT_MS;
	case Transport.TCP:
		return TCP.COMMAND_RTT_MS;
	default:
		return BT.COMMAND_RTT_MS;
	}
}

export class TickThrottle {
	private trips: number[] = [];
	private calm = 0;
	private current = 1;
	private last: { readonly p95Ms: number; readonly stalls: number } | undefined;

	constructor(private settings: ThrottleSettings, private readonly roundTripMs: number) {
		checkThrottleSettings(settings);
	}

	/** The tick as a multiple of the plan's. */
	get factor(): number {
		return this.current;
	}

	/** Takes one frame's round trip; true when the factor changed. */
	observe(roundTripMs: number): boolean {
		this.trips.push(roundTripMs);
		if (this.trips.length < this.settings.windowSize) { return false; }

		const sorted = [...this.trips].sort((a, b) => a - b);
		const p95Ms = sorted[Math.ceil(0.95 * sorted.length) - 1];
		const limit = this.limitMs();
		this.last = { p95Ms, stalls: sorted.filter((ms) => ms > limit).length };
		this.trips = [];
		if (!this.settings.enabled) { return false; }

		const before = this.current;
		if (p95Ms > limit) {
			this.calm = 0;
			this.current = Math.min(this.settings.maxSlowdown, this.current * this.settings.step);
		} else {
			this.calm += 1;
			if (this.calm >= this.settings.calmWindows && this.current > 1) {
				this.calm = 0;
				this.current = Math.max(1, this.current / this.settings.step);
			}
		}
		return this.current !== before;
	}

	/** New settings apply at once; true when that changed the factor. Throws, changing nothing, for settings out of range. */
	configure(settings: ThrottleSettings): boolean {
		checkThrottleSettings(settings);
		this.settings = settings;
		const before = this.current;
		this.current = settings.enabled ? Math.min(this.current, settings.maxSlowdown) : 1;
		return this.current !== before;
	}

	state(): ThrottleState {
		return {
			factor: this.current,
			limitMs: this.limitMs(),
			...(this.last ? { p95Ms: this.last.p95Ms } : {}),
			stalls: this.last?.stalls ?? 0,
			windowSamples: this.trips.length,
		};
	}

	private limitMs(): number {
		return this.settings.tailFactor * this.roundTripMs;
	}
}
