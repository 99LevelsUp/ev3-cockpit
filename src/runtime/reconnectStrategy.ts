/**
 * Reconnect strategy — exponential backoff with configurable limits.
 *
 * Used by the session manager to retry connection after transport failure.
 */

import { FIRMWARE_SAFETY } from '../transports/transportConstants';

export interface ReconnectStrategyOptions {
	/** Base delay in ms (default: 1000). */
	baseMs?: number;
	/** Maximum delay in ms (default: 30000). */
	maxMs?: number;
	/** Backoff multiplier (default: 2). */
	multiplier?: number;
	/** Maximum number of attempts before giving up (default: 10). */
	maxAttempts?: number;
}

/**
 * Exponential backoff reconnect strategy.
 *
 * Each call to {@link nextDelay} returns the delay before the next attempt
 * and increments the attempt counter. Returns `undefined` when max attempts
 * are exhausted.
 */
export class ReconnectStrategy {
	private readonly baseMs: number;
	private readonly maxMs: number;
	private readonly multiplier: number;
	private readonly maxAttempts: number;

	private _attempts = 0;

	constructor(options?: ReconnectStrategyOptions) {
		this.baseMs = options?.baseMs ?? FIRMWARE_SAFETY.RECONNECT_BASE_MS;
		this.maxMs = options?.maxMs ?? FIRMWARE_SAFETY.RECONNECT_MAX_MS;
		this.multiplier = options?.multiplier ?? FIRMWARE_SAFETY.RECONNECT_MULTIPLIER;
		this.maxAttempts = options?.maxAttempts ?? FIRMWARE_SAFETY.MAX_RECONNECT_ATTEMPTS;
	}

	/** Number of attempts made so far. */
	get attempts(): number {
		return this._attempts;
	}

	/** Whether all attempts have been exhausted. */
	get exhausted(): boolean {
		return this._attempts >= this.maxAttempts;
	}

	/**
	 * Get the next reconnect delay in ms.
	 * Returns `undefined` if max attempts reached.
	 */
	nextDelay(): number | undefined {
		if (this._attempts >= this.maxAttempts) {
			return undefined;
		}

		const delay = Math.min(
			this.baseMs * Math.pow(this.multiplier, this._attempts),
			this.maxMs
		);
		this._attempts += 1;
		return delay;
	}

	/** Reset the strategy for a fresh reconnect cycle. */
	reset(): void {
		this._attempts = 0;
	}
}
