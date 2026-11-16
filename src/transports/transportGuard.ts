/**
 * Transport guard — per-brick firmware protection layer.
 *
 * Enforces:
 * - A command rate ceiling (1 s sliding window), per brick across all its channels; a full
 *   window waits, it does not refuse
 * - Consecutive failure tracking with degradation, per channel
 *
 * Two keys, because the two protections are about different things. Firmware stress is a
 * property of the brick: commands arriving over USB and Bluetooth at once still land on one
 * VM, so the rate window is shared by every channel to that brick (`BrickId`). Failures are a
 * property of a link: a pulled cable fails every USB send while the Bluetooth link to the same
 * brick is healthy, and counting those failures against the brick would degrade it and block
 * the standby channel the cockpit is about to fail over to (`BrickKey`).
 *
 * It used to enforce "one active transport per brick" and a 2 s cooldown before switching,
 * after DESIGN §4.1's "firmware freeze under multi-transport bombardment". Measured
 * 29.10.2026 on three bricks and two firmware versions — USB and Bluetooth open to one brick,
 * commands in flight on both — nothing froze (step-1 plan, U4.4), and the incident record the
 * rule cited does not exist. Both are gone.
 */

import { describeChannel } from '../contracts';
import { FIRMWARE_SAFETY } from './transportConstants';
import { TransportError } from '../errors/CockpitError';

/** Per-channel health tracked by the guard. */
interface ChannelHealth {
	consecutiveFailures: number;
	degraded: boolean;
	lastRttMs: number | undefined;
}

/** Callback fired when a channel's degradation state changes. */
export type DegradationCallback = (channelKey: string, degraded: boolean) => void;

export interface TransportGuardOptions {
	maxCommandsPerSec?: number;
	degradationThreshold?: number;
	onDegradationChange?: DegradationCallback;
}

/**
 * Per-brick transport guard enforcing firmware-safe communication.
 */
export class TransportGuard {
	private readonly maxCommandsPerSec: number;
	private readonly degradationThreshold: number;
	private readonly onDegradationChange?: DegradationCallback;
	/** Send timestamps within the last second, by brick. */
	private readonly commandTimestamps = new Map<string, number[]>();
	private readonly channels = new Map<string, ChannelHealth>();

	constructor(options?: TransportGuardOptions) {
		this.maxCommandsPerSec = options?.maxCommandsPerSec ?? FIRMWARE_SAFETY.MAX_COMMANDS_PER_SEC;
		this.degradationThreshold = options?.degradationThreshold ?? FIRMWARE_SAFETY.DEGRADATION_THRESHOLD;
		this.onDegradationChange = options?.onDegradationChange;
	}

	/**
	 * Clears a channel's failure history and RTT.
	 *
	 * Call when the channel's session ends or reconnects. The failures that degraded it belonged
	 * to the link that just closed or died, not to whatever opens next — and `acquire`
	 * has no path back from `degraded` except `recordSuccess`, which a degraded channel can never
	 * reach on its own, since every send is refused before it reaches the transport. A cable that
	 * comes back would otherwise be refused for good.
	 */
	resetHealth(channelKey: string): void {
		const health = this.channels.get(channelKey);
		if (!health) {
			return;
		}
		health.consecutiveFailures = 0;
		health.lastRttMs = undefined;
		if (health.degraded) {
			health.degraded = false;
			this.onDegradationChange?.(channelKey, false);
		}
	}

	/**
	 * Take a send slot before a command goes over `channelKey` to `brickId`. Throws if the
	 * channel is degraded.
	 *
	 * A full window waits until its oldest send leaves it, it does not refuse. The commands
	 * that fill a window come in runs, a file sent in 1024-byte chunks most of all: refusing
	 * one mid-run left a half-written file and failed the commands queued behind it
	 * (U9 on HOSTA, 16.11.2026). Waiting slows a runaway caller to the ceiling and fails
	 * nothing a working caller asked for.
	 *
	 * Returns `undefined` when the slot is taken at once, a promise only when the window is
	 * full: a send with room to spare goes out in the same turn, as it did before the wait
	 * existed, so the order of a send against what its caller does next is unchanged.
	 */
	acquire(brickId: string, channelKey: string): Promise<void> | undefined {
		const waitMs = this.take(brickId, channelKey);
		return waitMs === 0 ? undefined : this.waitAndTake(brickId, channelKey, waitMs);
	}

	private async waitAndTake(brickId: string, channelKey: string, waitMs: number): Promise<void> {
		// Another channel to the brick may take the freed slot first; the loop asks again.
		while (waitMs > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
			waitMs = this.take(brickId, channelKey);
		}
	}

	/** Takes a slot and answers 0, or answers how long until the oldest send leaves the window. */
	private take(brickId: string, channelKey: string): number {
		if (this.channels.get(channelKey)?.degraded) {
			// A link fault, not a refusal of this one command: the brick layer fails over on it.
			throw new TransportError(`Channel ${describeChannel(channelKey)} is degraded — sends blocked until recovery.`);
		}
		const now = Date.now();
		const timestamps = (this.commandTimestamps.get(brickId) ?? []).filter((ts) => ts > now - 1000);
		this.commandTimestamps.set(brickId, timestamps);
		if (timestamps.length < this.maxCommandsPerSec) {
			timestamps.push(now);
			return 0;
		}
		return timestamps[0] + 1001 - now;
	}

	/**
	 * Record a successful send. Resets the channel's failure counter.
	 */
	recordSuccess(channelKey: string, rttMs?: number): void {
		const health = this.getOrCreate(channelKey);
		health.consecutiveFailures = 0;
		if (rttMs !== undefined) {
			health.lastRttMs = rttMs;
		}
		if (health.degraded) {
			health.degraded = false;
			this.onDegradationChange?.(channelKey, false);
		}
	}

	/**
	 * Record a send failure. May degrade the channel.
	 */
	recordFailure(channelKey: string): void {
		const health = this.getOrCreate(channelKey);
		health.consecutiveFailures += 1;

		if (!health.degraded && health.consecutiveFailures >= this.degradationThreshold) {
			health.degraded = true;
			this.onDegradationChange?.(channelKey, true);
		}
	}

	/** Whether a channel is currently degraded. */
	isDegraded(channelKey: string): boolean {
		return this.channels.get(channelKey)?.degraded ?? false;
	}

	/** Last recorded RTT for a channel. */
	getLastRttMs(channelKey: string): number | undefined {
		return this.channels.get(channelKey)?.lastRttMs;
	}

	/** Remove all state held under `id`, whether it names a brick or a channel. */
	forget(id: string): void {
		this.commandTimestamps.delete(id);
		this.channels.delete(id);
	}

	/** Remove all state. */
	dispose(): void {
		this.commandTimestamps.clear();
		this.channels.clear();
	}

	// ── Internal ────────────────────────────────────────────────────

	private getOrCreate(channelKey: string): ChannelHealth {
		let health = this.channels.get(channelKey);
		if (!health) {
			health = { consecutiveFailures: 0, degraded: false, lastRttMs: undefined };
			this.channels.set(channelKey, health);
		}
		return health;
	}
}
