/**
 * Bluetooth connection queue — serializes RFCOMM connections.
 *
 * Windows only supports one active RFCOMM connection at a time (error 121
 * on second connection). This queue enforces that constraint with mandatory
 * inter-connection cooldowns derived from lab measurements.
 */

import { BT, FIRMWARE_SAFETY } from './transportConstants';

/** Entry in the pending queue. */
interface QueueEntry {
	readonly brickId: string;
	resolve: (release: () => void) => void;
	reject: (error: unknown) => void;
}

/**
 * Serialized RFCOMM connection queue.
 *
 * Ensures only one Bluetooth RFCOMM connection is active at a time
 * and enforces inter-connection cooldowns to prevent Windows BT stack errors.
 */
export class BtConnectionQueue {
	private readonly maxConcurrent: number;
	private readonly interConnectionCooldownMs: number;
	private readonly errorRecoveryCooldownMs: number;
	private readonly backoffMax: number;

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
	}) {
		this.maxConcurrent = options?.maxConcurrent ?? 1;
		this.interConnectionCooldownMs = options?.interConnectionCooldownMs ?? BT.INTER_CONNECTION_COOLDOWN_MS;
		this.errorRecoveryCooldownMs = options?.errorRecoveryCooldownMs ?? BT.ERROR_RECOVERY_COOLDOWN_MS;
		this.backoffMax = options?.backoffMax ?? FIRMWARE_SAFETY.RECONNECT_MAX_MS;
	}

	/**
	 * Acquire a connection slot. Returns a release callback that MUST be called
	 * when the connection is no longer needed.
	 */
	async acquire(brickId: string): Promise<() => void> {
		return new Promise<() => void>((resolve, reject) => {
			this.queue.push({ brickId, resolve, reject });
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
			this.activeCount += 1;

			const release = () => {
				this.activeCount = Math.max(0, this.activeCount - 1);
				this.lastReleaseTs = Date.now();
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
