/**
 * Bluetooth connection queue — serializes the *opening* of RFCOMM connections and pairing
 * attempts, so two of them never page the radio at once.
 *
 * It used to be described as enforcing "one active RFCOMM connection at a time". That was the
 * old testlab's claim; measured 29.10.2026, the host holds two sessions to two bricks at once,
 * so callers release the slot as soon as the connection is open (`BtTransportProvider`). The
 * cooldowns are still under measurement (step-1 plan, U3.2).
 */

import { BT, FIRMWARE_SAFETY } from './transportConstants';
import { TransportError } from '../errors/CockpitError';

/** Entry in the pending queue. */
interface QueueEntry {
	readonly brickId: string;
	resolve: (release: (error?: unknown) => void) => void;
	reject: (error: unknown) => void;
	/** Fails the wait if it is not granted a slot before this fires. */
	timeoutTimer?: NodeJS.Timeout;
	/** Its release starts no cooldown and counts no error. */
	readonly holdOnly?: boolean;
}

/**
 * Serialized RFCOMM connection queue.
 *
 * Grants one slot at a time and spaces the grants by the inter-connection and error-recovery
 * cooldowns.
 */
export class BtConnectionQueue {
	private readonly maxConcurrent: number;
	private readonly interConnectionCooldownMs: number;
	private readonly errorRecoveryCooldownMs: number;
	private readonly backoffMax: number;
	private readonly acquireTimeoutMs: number;

	private activeCount = 0;
	private lastReleaseTs = 0;
	private lastErrorTs = 0;
	private consecutiveErrors = 0;
	private readonly queue: QueueEntry[] = [];
	private drainTimer?: NodeJS.Timeout;

	constructor(options?: {
		maxConcurrent?: number;
		interConnectionCooldownMs?: number;
		errorRecoveryCooldownMs?: number;
		backoffMax?: number;
		acquireTimeoutMs?: number;
	}) {
		this.maxConcurrent = options?.maxConcurrent ?? 1;
		this.interConnectionCooldownMs = options?.interConnectionCooldownMs ?? BT.INTER_CONNECTION_COOLDOWN_MS;
		this.errorRecoveryCooldownMs = options?.errorRecoveryCooldownMs ?? BT.ERROR_RECOVERY_COOLDOWN_MS;
		this.backoffMax = options?.backoffMax ?? FIRMWARE_SAFETY.RECONNECT_MAX_MS;
		this.acquireTimeoutMs = options?.acquireTimeoutMs ?? BT.QUEUE_ACQUIRE_TIMEOUT_MS;
	}

	/**
	 * Acquire a slot. Returns a release callback that MUST be called once the operation the
	 * slot was for (an open, a pairing) has finished, passing the error if it failed.
	 *
	 * @throws {TransportError} When no slot opens up within `acquireTimeoutMs`. A cooldown
	 *   wait never takes that long (the backoff caps at `backoffMax`), so this fires when
	 *   another open or pairing holds the slot for longer — a pairing can, since it waits for
	 *   a person at the brick. Per DESIGN §3.3: fail with a stated reason rather than queue
	 *   indefinitely.
	 */
	async acquire(
		brickId: string,
		options?: {
			/**
			 * Hold the slot for mutual exclusion only: its release starts no cooldown and counts
			 * no error.
			 *
			 * For the background presence check and inquiry. They must not run beside a
			 * connect, but the cooldowns were set for RFCOMM opens: armed by a background check,
			 * one round over three paired bricks would hold every user connect behind it for
			 * about a minute (step-2 plan, KTD8). A check that goes unanswered is a result, not
			 * a failure.
			 */
			holdOnly?: boolean;
		},
	): Promise<(error?: unknown) => void> {
		return new Promise<() => void>((resolve, reject) => {
			const entry: QueueEntry = { brickId, resolve, reject, holdOnly: options?.holdOnly };
			entry.timeoutTimer = setTimeout(() => {
				const idx = this.queue.indexOf(entry);
				if (idx < 0) { return; }
				this.queue.splice(idx, 1);
				reject(new TransportError(
					`BT connection queue timed out after ${this.acquireTimeoutMs} ms waiting for `
					+ `a slot for ${brickId} (${this.activeCount}/${this.maxConcurrent} in use). `
					+ 'Bluetooth is busy opening another connection or pairing a brick; try '
					+ 'again once that has finished.'
				));
			}, this.acquireTimeoutMs);
			entry.timeoutTimer.unref?.();
			this.queue.push(entry);
			this.scheduleDrain();
		});
	}

	/**
	 * Run a task within a connection slot (auto-releases on completion/error).
	 */
	async enqueue<T>(brickId: string, task: () => Promise<T>): Promise<T> {
		const release = await this.acquire(brickId);
		try {
			const result = await task();
			this.recordSuccess();
			return result;
		} catch (error) {
			this.recordError();
			throw error;
		} finally {
			release();
		}
	}

	/** Number of pending entries in the queue. */
	get pending(): number {
		return this.queue.length;
	}

	/** Number of active connection slots in use. */
	get active(): number {
		return this.activeCount;
	}

	/** Cancel all pending entries. */
	dispose(): void {
		if (this.drainTimer) {
			clearTimeout(this.drainTimer);
			this.drainTimer = undefined;
		}
		const entries = this.queue.splice(0);
		for (const entry of entries) {
			if (entry.timeoutTimer) { clearTimeout(entry.timeoutTimer); entry.timeoutTimer = undefined; }
			entry.reject(new Error('BT connection queue disposed.'));
		}
	}

	// ── Internal ────────────────────────────────────────────────────

	private scheduleDrain(): void {
		if (this.drainTimer) {
			return;
		}
		const delay = this.computeDelay();
		if (delay <= 0) {
			this.drain();
		} else {
			this.drainTimer = setTimeout(() => {
				this.drainTimer = undefined;
				this.drain();
			}, delay);
			this.drainTimer.unref();
		}
	}

	private drain(): void {
		while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
			const delay = this.computeDelay();
			if (delay > 0) {
				this.drainTimer = setTimeout(() => {
					this.drainTimer = undefined;
					this.drain();
				}, delay);
				this.drainTimer.unref();
				return;
			}

			const entry = this.queue.shift()!;
			if (entry.timeoutTimer) { clearTimeout(entry.timeoutTimer); entry.timeoutTimer = undefined; }
			this.activeCount += 1;

			const release = (error?: unknown) => {
				this.activeCount = Math.max(0, this.activeCount - 1);
				if (entry.holdOnly) {
					this.scheduleDrain();
					return;
				}
				this.lastReleaseTs = Date.now();
				// A slot released after a failure has to start the longer recovery, not the
				// ordinary gap. Windows carries one RFCOMM channel; a failed attempt leaves it
				// unsettled for far longer than a clean close does, and the lab measured the
				// difference as 10 s against 30 s. Without this the queue paced a failing
				// brick as if nothing had gone wrong.
				if (error === undefined) { this.recordSuccess(); } else { this.recordError(); }
				this.scheduleDrain();
			};

			entry.resolve(release);
		}
	}

	private computeDelay(): number {
		const now = Date.now();
		let requiredWait = 0;

		// Inter-connection cooldown
		if (this.lastReleaseTs > 0) {
			const elapsed = now - this.lastReleaseTs;
			const remaining = this.interConnectionCooldownMs - elapsed;
			if (remaining > 0) {
				requiredWait = Math.max(requiredWait, remaining);
			}
		}

		// Error recovery cooldown with exponential backoff
		if (this.consecutiveErrors > 0 && this.lastErrorTs > 0) {
			const backoffMs = Math.min(
				this.errorRecoveryCooldownMs * Math.pow(2, this.consecutiveErrors - 1),
				this.backoffMax
			);
			const elapsed = now - this.lastErrorTs;
			const remaining = backoffMs - elapsed;
			if (remaining > 0) {
				requiredWait = Math.max(requiredWait, remaining);
			}
		}

		return requiredWait;
	}

	private recordSuccess(): void {
		this.consecutiveErrors = 0;
	}

	private recordError(): void {
		this.consecutiveErrors += 1;
		this.lastErrorTs = Date.now();
	}
}
