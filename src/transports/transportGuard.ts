/**
 * Transport guard — per-brick firmware protection layer.
 *
 * Enforces:
 * - One active transport per brick
 * - Transport switch cooldown (prevents firmware freeze under multi-transport bombardment)
 * - Command rate limiting (≤10 cmd/s sliding window)
 * - Consecutive failure tracking with degradation
 */

import { FIRMWARE_SAFETY } from './transportConstants';

/** Per-brick transport state tracked by the guard. */
interface BrickGuardState {
	activeTransport: string | undefined;
	/** The transport last opened, remembered past a close so a same-transport reconnect
	 * can be told apart from an actual switch. */
	lastTransport: string | undefined;
	lastCloseTs: number;
	commandTimestamps: number[];
	consecutiveFailures: number;
	degraded: boolean;
	lastRttMs: number | undefined;
}

/** Callback fired when a brick's degradation state changes. */
export type DegradationCallback = (brickId: string, degraded: boolean) => void;

export interface TransportGuardOptions {
	maxCommandsPerSec?: number;
	switchCooldownMs?: number;
	degradationThreshold?: number;
	onDegradationChange?: DegradationCallback;
}

/**
 * Per-brick transport guard enforcing firmware-safe communication.
 */
export class TransportGuard {
	private readonly maxCommandsPerSec: number;
	private readonly switchCooldownMs: number;
	private readonly degradationThreshold: number;
	private readonly onDegradationChange?: DegradationCallback;
	private readonly bricks = new Map<string, BrickGuardState>();

	constructor(options?: TransportGuardOptions) {
		this.maxCommandsPerSec = options?.maxCommandsPerSec ?? FIRMWARE_SAFETY.MAX_COMMANDS_PER_SEC;
		this.switchCooldownMs = options?.switchCooldownMs ?? FIRMWARE_SAFETY.TRANSPORT_SWITCH_COOLDOWN_MS;
		this.degradationThreshold = options?.degradationThreshold ?? FIRMWARE_SAFETY.DEGRADATION_THRESHOLD;
		this.onDegradationChange = options?.onDegradationChange;
	}

	/**
	 * Register a brick opening a transport. Enforces one-at-a-time and switch cooldown.
	 *
	 * The cooldown guards against **switching** transports rapidly (DESIGN §4.1's firmware
	 * freeze under multi-transport bombardment) — reopening the *same* transport right
	 * after closing it is an ordinary reconnect and is not gated here; that pacing belongs
	 * to whatever paces reconnects for that transport (e.g. `BtConnectionQueue`,
	 * `ReconnectStrategy`).
	 */
	openTransport(brickId: string, transport: string): void {
		const state = this.getOrCreate(brickId);

		if (state.activeTransport && state.activeTransport !== transport) {
			throw new Error(
				`Brick ${brickId} already has active transport "${state.activeTransport}". `
				+ `Close it before opening "${transport}".`
			);
		}

		if (!state.activeTransport && state.lastTransport && state.lastTransport !== transport
			&& state.lastCloseTs > 0) {
			const elapsed = Date.now() - state.lastCloseTs;
			if (elapsed < this.switchCooldownMs) {
				throw new Error(
					`Transport switch cooldown: ${this.switchCooldownMs - elapsed}ms remaining for ${brickId}.`
				);
			}
		}

		state.activeTransport = transport;
		state.lastTransport = transport;
	}

	/**
	 * Mark a brick's transport as closed.
	 */
	closeTransport(brickId: string): void {
		const state = this.bricks.get(brickId);
		if (!state) {
			return;
		}
		state.activeTransport = undefined;
		state.lastCloseTs = Date.now();
	}

	/**
	 * Clears degradation and rate-limit history without touching the switch-cooldown clock.
	 *
	 * Call when a session ends. The failures that degraded a brick belonged to the
	 * connection that just closed, not to whatever connects next — and `checkRateLimit`
	 * has no path back from `degraded` except `recordSuccess`, which a degraded brick can
	 * never reach on its own, since every send is refused before it reaches the transport.
	 * `forget` would also do this, but it drops `lastCloseTs` with it, and losing that is
	 * what a rapid reconnect's switch cooldown depends on.
	 */
	resetHealth(brickId: string): void {
		const state = this.bricks.get(brickId);
		if (!state) {
			return;
		}
		state.consecutiveFailures = 0;
		state.commandTimestamps = [];
		state.lastRttMs = undefined;
		if (state.degraded) {
			state.degraded = false;
			this.onDegradationChange?.(brickId, false);
		}
	}

	/**
	 * Check rate limit before sending a command. Throws if the window is full.
	 */
	checkRateLimit(brickId: string): void {
		const state = this.getOrCreate(brickId);

		if (state.degraded) {
			throw new Error(`Brick ${brickId} is degraded — sends blocked until recovery.`);
		}

		const now = Date.now();
		const windowStart = now - 1000;
		state.commandTimestamps = state.commandTimestamps.filter((ts) => ts > windowStart);

		if (state.commandTimestamps.length >= this.maxCommandsPerSec) {
			throw new Error(
				`Rate limit: ${this.maxCommandsPerSec} commands/sec exceeded for ${brickId}.`
			);
		}

		state.commandTimestamps.push(now);
	}

	/**
	 * Record a successful send. Resets failure counter.
	 */
	recordSuccess(brickId: string, rttMs?: number): void {
		const state = this.getOrCreate(brickId);
		state.consecutiveFailures = 0;
		if (rttMs !== undefined) {
			state.lastRttMs = rttMs;
		}
		if (state.degraded) {
			state.degraded = false;
			this.onDegradationChange?.(brickId, false);
		}
	}

	/**
	 * Record a send failure. May trigger degradation.
	 */
	recordFailure(brickId: string): void {
		const state = this.getOrCreate(brickId);
		state.consecutiveFailures += 1;

		if (!state.degraded && state.consecutiveFailures >= this.degradationThreshold) {
			state.degraded = true;
			this.onDegradationChange?.(brickId, true);
		}
	}

	/** Whether a brick is currently degraded. */
	isDegraded(brickId: string): boolean {
		return this.bricks.get(brickId)?.degraded ?? false;
	}

	/** Last recorded RTT for a brick. */
	getLastRttMs(brickId: string): number | undefined {
		return this.bricks.get(brickId)?.lastRttMs;
	}

	/** Remove all state for a brick. */
	forget(brickId: string): void {
		this.bricks.delete(brickId);
	}

	/** Remove all state. */
	dispose(): void {
		this.bricks.clear();
	}

	// ── Internal ────────────────────────────────────────────────────

	private getOrCreate(brickId: string): BrickGuardState {
		let state = this.bricks.get(brickId);
		if (!state) {
			state = {
				activeTransport: undefined,
				lastTransport: undefined,
				lastCloseTs: 0,
				commandTimestamps: [],
				consecutiveFailures: 0,
				degraded: false,
				lastRttMs: undefined,
			};
			this.bricks.set(brickId, state);
		}
		return state;
	}
}
