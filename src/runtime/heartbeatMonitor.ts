/**
 * Heartbeat monitor — periodic health check for a connected session.
 *
 * Sends periodic battery queries to detect connection loss. Transitions
 * session to 'reconnecting' on missed heartbeats.
 */

import { FIRMWARE_SAFETY } from '../transports/transportConstants';

/** Callback when heartbeat succeeds. */
export type HeartbeatSuccessCallback = () => void;
/** Callback when heartbeat fails (missed). */
export type HeartbeatFailureCallback = (error: unknown) => void;

export interface HeartbeatMonitorOptions {
	/** Heartbeat interval in ms (default: 3000, minimum enforced). */
	intervalMs?: number;
	/** Number of consecutive misses before reporting failure (default: 2). */
	missThreshold?: number;
	/** Heartbeat probe function — should send a lightweight command (e.g. battery). */
	probe: () => Promise<void>;
	/** Called on each successful heartbeat. */
	onSuccess?: HeartbeatSuccessCallback;
	/** Called when miss threshold is reached. */
	onFailure?: HeartbeatFailureCallback;
}

/**
 * Per-session heartbeat monitor.
 *
 * Starts a periodic loop that calls the probe function and tracks
 * consecutive misses. When the miss threshold is reached, it calls
 * the failure callback (typically triggering reconnect).
 */
export class HeartbeatMonitor {
	private readonly intervalMs: number;
	private readonly missThreshold: number;
	private readonly probe: () => Promise<void>;
	private readonly onSuccess?: HeartbeatSuccessCallback;
	private readonly onFailure?: HeartbeatFailureCallback;

	private timer?: NodeJS.Timeout;
	private consecutiveMisses = 0;
	private _running = false;

	constructor(options: HeartbeatMonitorOptions) {
		this.intervalMs = Math.max(
			options.intervalMs ?? FIRMWARE_SAFETY.MIN_HEARTBEAT_INTERVAL_MS,
			FIRMWARE_SAFETY.MIN_HEARTBEAT_INTERVAL_MS
		);
		this.missThreshold = options.missThreshold ?? 2;
		this.probe = options.probe;
		this.onSuccess = options.onSuccess;
		this.onFailure = options.onFailure;
	}

	get running(): boolean {
		return this._running;
	}

	get misses(): number {
		return this.consecutiveMisses;
	}

	/** Start the heartbeat loop. */
	start(): void {
		if (this._running) {
			return;
		}
		this._running = true;
		this.consecutiveMisses = 0;
		this.scheduleNext();
	}

	/** Stop the heartbeat loop. */
	stop(): void {
		this._running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Reset the miss counter (e.g. after successful command). */
	resetMisses(): void {
		this.consecutiveMisses = 0;
	}

	// ── Internal ────────────────────────────────────────────────────

	private scheduleNext(): void {
		if (!this._running) {
			return;
		}
		this.timer = setTimeout(() => {
			void this.tick();
		}, this.intervalMs);
		this.timer.unref();
	}

	private async tick(): Promise<void> {
		if (!this._running) {
			return;
		}

		try {
			await this.probe();
			this.consecutiveMisses = 0;
			this.onSuccess?.();
		} catch (error) {
			this.consecutiveMisses += 1;
			if (this.consecutiveMisses >= this.missThreshold) {
				this.onFailure?.(error);
				return; // Don't schedule next — let reconnect logic handle it
			}
		}

		this.scheduleNext();
	}
}
