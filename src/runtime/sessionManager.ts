/**
 * Session Manager — central coordinator for connected brick sessions.
 *
 * Manages the lifecycle of connected sessions: connect, disconnect, heartbeat,
 * reconnect, foreground switching, and command dispatch. Owns all session entries
 * and is the single source of truth for connection state.
 */

import * as vscode from 'vscode';
import { ConnectionState, ActivityMode, Transport } from '../contracts/enums';
import { BrickKey, brickIdOf, describeChannel } from '../contracts/brickKey';
import { ConnectedSession } from '../contracts/models';
import { BrickCommand, BrickResponse, SendCommandOptions, TransportProvider } from '../contracts/transport';
import { SessionEntry } from './sessionEntry';
import { CommandQueue } from './commandQueue';
import { PacketCommandChannel } from '../commands/commandChannel';
import { HeartbeatMonitor } from './heartbeatMonitor';
import { ReconnectStrategy } from './reconnectStrategy';
import { ProviderRegistry } from '../transports/providerRegistry';
import {
	AlreadyConnectedError, ConnectionAbandonedError, NotConnectedError, NoProviderError, ProtocolError,
} from '../errors/CockpitError';
import { FIRMWARE_SAFETY } from '../transports/transportConstants';
import { TransportGuard } from '../transports/transportGuard';

// ── Events ──────────────────────────────────────────────────────────

export interface SessionStateChangeEvent {
	readonly brickKey: BrickKey;
	readonly previousState: ConnectionState;
	readonly newState: ConnectionState;
}

export interface ActiveBrickChangeEvent {
	readonly previousBrickKey: BrickKey | undefined;
	readonly newBrickKey: BrickKey | undefined;
}

// ── Options ─────────────────────────────────────────────────────────

export interface SessionManagerOptions {
	providerRegistry: ProviderRegistry;
	heartbeatIntervalMs?: number;
	heartbeatMissThreshold?: number;
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
	reconnectMaxAttempts?: number;
	/** Firmware-protection layer shared across every transport. Defaults to a fresh guard. */
	transportGuard?: TransportGuard;
}

// ── Per-session resources ───────────────────────────────────────────

interface SessionResources {
	entry: SessionEntry;
	commandQueue: CommandQueue;
	heartbeat: HeartbeatMonitor;
	reconnect: ReconnectStrategy;
	reconnectTimer?: NodeJS.Timeout;
}

/**
 * Central coordinator for all connected brick sessions.
 */
export class SessionManager implements vscode.Disposable {
	private readonly providerRegistry: ProviderRegistry;
	private readonly sessions = new Map<BrickKey, SessionResources>();
	private readonly suppressedBricks = new Set<BrickKey>();

	private activeBrickKey?: BrickKey;

	private readonly _onSessionStateChange = new vscode.EventEmitter<SessionStateChangeEvent>();
	readonly onSessionStateChange = this._onSessionStateChange.event;

	private readonly _onActiveBrickChange = new vscode.EventEmitter<ActiveBrickChangeEvent>();
	readonly onActiveBrickChange = this._onActiveBrickChange.event;

	private readonly heartbeatIntervalMs: number;
	private readonly heartbeatMissThreshold: number;
	private readonly reconnectBaseMs: number;
	private readonly reconnectMaxMs: number;
	private readonly reconnectMaxAttempts: number;
	private readonly transportGuard: TransportGuard;

	constructor(options: SessionManagerOptions) {
		this.providerRegistry = options.providerRegistry;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? FIRMWARE_SAFETY.MIN_HEARTBEAT_INTERVAL_MS;
		this.heartbeatMissThreshold = options.heartbeatMissThreshold ?? 2;
		this.reconnectBaseMs = options.reconnectBaseMs ?? FIRMWARE_SAFETY.RECONNECT_BASE_MS;
		this.reconnectMaxMs = options.reconnectMaxMs ?? FIRMWARE_SAFETY.RECONNECT_MAX_MS;
		this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? FIRMWARE_SAFETY.MAX_RECONNECT_ATTEMPTS;
		this.transportGuard = options.transportGuard ?? new TransportGuard();
	}

	// ── Connect / Disconnect ────────────────────────────────────────

	/** Connect to a brick via the specified transport. */
	async connect(brickKey: BrickKey, transport: Transport, displayName?: string): Promise<void> {
		if (this.sessions.has(brickKey)) {
			throw new AlreadyConnectedError(`Brick ${describeChannel(brickKey)} is already connected.`);
		}

		const provider = this.providerRegistry.get(transport);
		if (!provider) {
			throw new NoProviderError(`No transport provider registered for "${transport}".`);
		}

		// Clear auto-connect suppression on explicit connect
		this.suppressedBricks.delete(brickKey);

		const entry = new SessionEntry(brickKey, transport, displayName ?? brickKey);
		const commandQueue = new CommandQueue();
		const heartbeat = this.createHeartbeat(brickKey, commandQueue);
		const reconnect = new ReconnectStrategy({
			baseMs: this.reconnectBaseMs,
			maxMs: this.reconnectMaxMs,
			maxAttempts: this.reconnectMaxAttempts,
		});

		const resources: SessionResources = { entry, commandQueue, heartbeat, reconnect };
		this.sessions.set(brickKey, resources);

		try {
			const handle = await provider.connect(brickKey);

			// disconnect() may have run while the provider was still connecting. It
			// removed this session, and the provider had not registered its own yet, so
			// the disconnect it forwarded was a no-op. Proceeding here would leave the
			// connection the provider just opened with nobody tracking it -- and the
			// Disconnected -> Connected transition below would throw anyway. The user
			// asked to disconnect, so abandoning the connect attempt is the answer -- and
			// saying so, because a caller that saw it return would take the brick as connected.
			if (this.sessions.get(brickKey) !== resources || entry.explicitlyDisconnected) {
				await this.releaseUnownedConnection(brickKey, provider);
				throw new ConnectionAbandonedError(
					`${describeChannel(brickKey)} was disconnected while it was connecting.`);
			}

			entry.setHandle(handle);
			entry.transition(ConnectionState.Connected);
			this.fireStateChange(brickKey, ConnectionState.Connecting, ConnectionState.Connected);

			this.wireExecutor(resources, provider);
			heartbeat.start();
			reconnect.reset();
		} catch (error) {
			// The disconnect that abandoned this attempt ends the session itself.
			if (error instanceof ConnectionAbandonedError) { throw error; }
			// So does one that ran while the provider failed, and the key may belong to a
			// newer connect by now.
			if (this.sessions.get(brickKey) === resources) {
				entry.setError(error instanceof Error ? error.message : String(error));
				entry.transition(ConnectionState.Disconnected);
				this.sessions.delete(brickKey);
				this.fireStateChange(brickKey, ConnectionState.Connecting, ConnectionState.Disconnected);
			}
			throw error;
		}
	}

	/** Disconnect a brick. Explicit disconnect suppresses auto-reconnect. */
	async disconnect(brickKey: BrickKey, explicit = true): Promise<void> {
		const resources = this.sessions.get(brickKey);
		if (!resources) {
			return;
		}

		if (explicit) {
			resources.entry.markExplicitlyDisconnected();
			this.suppressedBricks.add(brickKey);
		}

		const previousState = resources.entry.connectionState;
		this.cleanupSession(resources);
		// The channel's failures are history the next connect should not inherit --
		// checkRateLimit() has no path back from `degraded` except recordSuccess(), which a
		// degraded channel can never reach on its own. Only this channel: another channel to
		// the same brick keeps its own count.
		this.transportGuard.resetHealth(brickKey);

		const provider = this.providerRegistry.get(resources.entry.transport);
		try {
			await provider?.disconnect(brickKey);
		} catch {
			// Best-effort disconnect
		}

		resources.entry.transition(ConnectionState.Disconnected);
		this.sessions.delete(brickKey);

		if (this.activeBrickKey === brickKey) {
			this.clearActiveBrick();
		}

		if (previousState !== ConnectionState.Disconnected) {
			this.fireStateChange(brickKey, previousState, ConnectionState.Disconnected);
		}
	}

	// ── Foreground switching ────────────────────────────────────────

	/** Promote a brick to foreground. Only one brick can be foreground. */
	setActiveBrick(brickKey: BrickKey): void {
		const resources = this.sessions.get(brickKey);
		if (!resources) {
			throw new NotConnectedError(`Brick ${describeChannel(brickKey)} is not connected.`);
		}

		const previous = this.activeBrickKey;
		if (previous === brickKey) {
			return;
		}

		// Demote previous foreground brick
		if (previous) {
			const prevResources = this.sessions.get(previous);
			if (prevResources) {
				this.demote(prevResources);
			}
		}

		// Promote new brick
		this.activeBrickKey = brickKey;
		resources.entry.setActiveMode(ActivityMode.Foreground);

		this._onActiveBrickChange.fire({ previousBrickKey: previous, newBrickKey: brickKey });
	}

	/** Clear the foreground brick (discovery view shown). */
	clearActiveBrick(): void {
		const previous = this.activeBrickKey;
		if (!previous) {
			return;
		}

		const prevResources = this.sessions.get(previous);
		if (prevResources) {
			this.demote(prevResources);
		}

		this.activeBrickKey = undefined;
		this._onActiveBrickChange.fire({ previousBrickKey: previous, newBrickKey: undefined });
	}

	/**
	 * Drop a brick out of foreground into whichever background mode it has earned.
	 *
	 * DESIGN 9.3 scopes subscribed telemetry to bricks with a live API subscription
	 * and 9.4 makes minimal the base mode, so demoting straight to subscribed put
	 * every backgrounded brick into a mode that schedules telemetry nobody asked for.
	 */
	private demote(resources: SessionResources): void {
		resources.entry.setActiveMode(
			resources.entry.subscribedCategories.length > 0
				? ActivityMode.Subscribed
				: ActivityMode.Minimal
		);
	}

	/** Get the current foreground brick key. */
	getActiveBrickKey(): BrickKey | undefined {
		return this.activeBrickKey;
	}

	// ── Command dispatch ────────────────────────────────────────────

	/** Send a command to a connected brick (via its command queue). */
	send(
		brickKey: BrickKey,
		command: BrickCommand,
		options?: SendCommandOptions,
	): Promise<BrickResponse> {
		const resources = this.sessions.get(brickKey);
		if (!resources) {
			return Promise.reject(new NotConnectedError(`Brick ${describeChannel(brickKey)} is not connected.`));
		}
		return resources.commandQueue.send(command, options);
	}

	/**
	 * Largest packet the live link to this brick carries, or `undefined` for the
	 * firmware's own buffer.
	 *
	 * Asked of the provider rather than derived from the transport: a USB brick reached
	 * over libusb carries sixteen times what the same brick carries over HID, and the
	 * filesystem services need the figure that is actually in force.
	 */
	maxPacketBytes(brickKey: BrickKey): number | undefined {
		const resources = this.sessions.get(brickKey);
		if (!resources) {
			return undefined;
		}
		const provider = this.providerRegistry.get(resources.entry.transport);
		return provider?.maxPacketBytes?.(brickKey);
	}

	// ── Query ───────────────────────────────────────────────────────

	/** Get the current snapshot of a session. */
	getSession(brickKey: BrickKey): ConnectedSession | undefined {
		return this.sessions.get(brickKey)?.entry.toConnectedSession();
	}

	/** Get all active sessions. */
	getAllSessions(): ConnectedSession[] {
		return [...this.sessions.values()].map((r) => r.entry.toConnectedSession());
	}

	/** Check if a brick has been explicitly disconnected (suppressed from auto-connect). */
	isSuppressed(brickKey: BrickKey): boolean {
		return this.suppressedBricks.has(brickKey);
	}

	/** Clear all auto-connect suppressions (e.g. on new session). */
	clearSuppressions(): void {
		this.suppressedBricks.clear();
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	dispose(): void {
		for (const [, resources] of this.sessions) {
			this.cleanupSession(resources);
		}
		this.sessions.clear();
		this.suppressedBricks.clear();
		this.activeBrickKey = undefined;
		this.transportGuard.dispose();
		this._onSessionStateChange.dispose();
		this._onActiveBrickChange.dispose();
	}

	// ── Internal: Heartbeat ─────────────────────────────────────────

	private createHeartbeat(brickKey: BrickKey, commandQueue: CommandQueue): HeartbeatMonitor {
		return new HeartbeatMonitor({
			intervalMs: this.heartbeatIntervalMs,
			missThreshold: this.heartbeatMissThreshold,
			probe: async () => {
				await commandQueue.send({ kind: 'battery' });
			},
			onSuccess: () => {
				const resources = this.sessions.get(brickKey);
				if (resources) {
					resources.entry.setHeartbeatState('ok');
				}
			},
			onFailure: (error) => {
				this.handleHeartbeatFailure(brickKey, error);
			},
			// The probe is the battery command, so a firmware whose payload layout differs
			// rejects every single tick. Counted as a miss that reconnects on success and
			// resets the backoff, it would loop forever and make the brick unusable rather
			// than merely un-metered.
			isLinkFailure: (error) => !(error instanceof ProtocolError),
			onAnomaly: (error) => {
				const resources = this.sessions.get(brickKey);
				if (resources) {
					resources.entry.setError(error instanceof Error ? error.message : String(error));
					// The reply arrived, so the link is confirmed alive.
					resources.entry.setHeartbeatState('ok');
				}
			},
		});
	}

	private handleHeartbeatFailure(brickKey: BrickKey, error: unknown): void {
		const resources = this.sessions.get(brickKey);
		if (!resources) {
			return;
		}

		// If explicitly disconnected, don't attempt reconnect
		if (resources.entry.explicitlyDisconnected) {
			void this.disconnect(brickKey, false);
			return;
		}

		const previousState = resources.entry.connectionState;
		if (previousState === ConnectionState.Connected) {
			resources.entry.setError(error instanceof Error ? error.message : String(error));
			resources.entry.transition(ConnectionState.Reconnecting);
			this.fireStateChange(brickKey, previousState, ConnectionState.Reconnecting);
			this.scheduleReconnect(brickKey);
		}
	}

	// ── Internal: Reconnect ─────────────────────────────────────────

	/**
	 * Tells a reconnecting session that its brick has been seen again.
	 *
	 * Backoff is a guess about when to look; discovery is evidence that there is something to
	 * look at. Without this the two never talk, and the cost is measurable: a brick that boots
	 * in about 40 seconds took **121 seconds** to be picked up, because the backoff had already
	 * stretched to 30-second steps by the time it came back and simply waited them out. Roughly
	 * eighty seconds of a session sitting broken next to a brick that was ready.
	 *
	 * Backoff stays as the fallback for everything discovery cannot see — a brick that answers
	 * a scan but refuses a session, or a transport with no discovery at all. This only ever
	 * makes an attempt happen sooner, never less often, so the guard against hammering an
	 * unreachable brick is untouched.
	 *
	 * Does nothing unless the session is actually waiting to reconnect.
	 */
	notifyBrickAvailable(brickKey: BrickKey): void {
		const resources = this.sessions.get(brickKey);
		if (!resources || resources.entry.connectionState !== ConnectionState.Reconnecting) {
			return;
		}
		if (resources.entry.explicitlyDisconnected) {
			return;
		}

		if (resources.reconnectTimer) {
			clearTimeout(resources.reconnectTimer);
			resources.reconnectTimer = undefined;
		}
		// The wait was the only thing standing between the last failure and this attempt, and
		// discovery has just retired the reason for it.
		resources.reconnect.reset();
		void this.attemptReconnect(brickKey);
	}

	/**
	 * Checks one channel now, outside the heartbeat's schedule, and reports whether it answered.
	 *
	 * For a caller that has just seen a command fail on this channel and needs to know at once
	 * whether the link is gone — the brick layer, which has already moved traffic elsewhere
	 * and wants the channel back if it was only a hiccup. Waiting for the heartbeat would take
	 * two missed beats, about 6 s. A failure here is treated as the heartbeat would treat it:
	 * the session goes to Reconnecting straight away, without waiting for a second miss,
	 * because the failed command was the first.
	 *
	 * A reply that arrives but does not parse still proves the link, as it does for the
	 * heartbeat.
	 */
	async probeNow(brickKey: BrickKey): Promise<boolean> {
		const resources = this.sessions.get(brickKey);
		if (!resources || resources.entry.connectionState !== ConnectionState.Connected) {
			return false;
		}
		try {
			await resources.commandQueue.send({ kind: 'battery' });
			resources.entry.setHeartbeatState('ok');
			return true;
		} catch (error) {
			if (error instanceof ProtocolError) { return true; }
			this.handleHeartbeatFailure(brickKey, error);
			return false;
		}
	}

	private scheduleReconnect(brickKey: BrickKey): void {
		const resources = this.sessions.get(brickKey);
		if (!resources) {
			return;
		}

		const delay = resources.reconnect.nextDelay();
		if (delay === undefined) {
			// Exhausted — transition to disconnected
			void this.disconnect(brickKey, false);
			return;
		}

		resources.reconnectTimer = setTimeout(() => {
			void this.attemptReconnect(brickKey);
		}, delay);
		resources.reconnectTimer.unref();
	}

	private async attemptReconnect(brickKey: BrickKey): Promise<void> {
		const resources = this.sessions.get(brickKey);
		if (!resources || resources.entry.connectionState !== ConnectionState.Reconnecting) {
			return;
		}

		// If explicitly disconnected during wait, abort
		if (resources.entry.explicitlyDisconnected) {
			void this.disconnect(brickKey, false);
			return;
		}

		const provider = this.providerRegistry.get(resources.entry.transport);
		if (!provider) {
			void this.disconnect(brickKey, false);
			return;
		}

		try {
			// Release whatever the provider still thinks it holds, before asking for a new
			// link. A provider drops its own session record only in `disconnect()`, so after
			// a link dies on its own the record survives and `connect()` answers "already
			// connected" — every attempt, instantly, forever. Measured on a brick: a USB
			// session could never recover from a power cycle, an unplugged cable, or a brick
			// going out of range, which are the only kinds of loss that matter. An explicit
			// disconnect is not a failure and never reached this path.
			//
			// Providers that implement `recover` own this themselves, so leave those alone.
			if (!provider.recover) {
				await provider.disconnect(brickKey).catch(() => { /* may already be gone */ });
			}

			const handle = provider.recover
				? await provider.recover(brickKey)
				: await provider.connect(brickKey);

			// disconnect() may have run while recover() was in flight: it deletes the
			// session, but `resources` is a captured reference that stays alive. Without
			// this check the just-reopened physical connection would belong to nobody.
			if (this.sessions.get(brickKey) !== resources || resources.entry.explicitlyDisconnected) {
				await this.releaseUnownedConnection(brickKey, provider);
				return;
			}

			resources.entry.setHandle(handle);
			resources.entry.transition(ConnectionState.Connected);
			resources.reconnect.reset();
			// The failures that degraded this channel belonged to the link that died. Without
			// this a cable that comes back after three failed sends stays refused for good.
			this.transportGuard.resetHealth(brickKey);
			this.fireStateChange(brickKey, ConnectionState.Reconnecting, ConnectionState.Connected);

			this.wireExecutor(resources, provider);
			resources.heartbeat.start();
		} catch (error) {
			// Record why. A bare catch here hid the defect above for as long as it existed:
			// every attempt failed with the same message and left no trace anywhere, so a
			// session stuck in Reconnecting looked like a brick that had not come back rather
			// than like a bug.
			resources.entry.setError(error instanceof Error ? error.message : String(error));
			this.scheduleReconnect(brickKey);
		}
	}

	// ── Internal: Cleanup ───────────────────────────────────────────

	/**
	 * Close a connection whose session no longer exists.
	 *
	 * Providers key their sessions by `brickKey` and nothing else, so a blind
	 * `provider.disconnect(brickKey)` would close whatever currently holds that key.
	 * When a slow connect is abandoned and a second connect for the same brick has
	 * since succeeded, that is the live connection -- disconnecting it would leave
	 * SessionManager reporting a brick as connected over a socket it just closed. So
	 * release only while the key is genuinely unowned.
	 */
	private async releaseUnownedConnection(brickKey: BrickKey, provider: TransportProvider): Promise<void> {
		if (this.sessions.has(brickKey)) {
			return;
		}
		try { await provider.disconnect(brickKey); } catch { /* best effort */ }
	}

	/**
	 * Binds the queue to a command channel over this session.
	 *
	 * The channel is session-scoped because the message counter is: two channels over
	 * one connection would hand out colliding counters and match each other's replies.
	 */
	private wireExecutor(resources: SessionResources, provider: TransportProvider): void {
		const brickKey = resources.entry.brickKey;
		// The rate window belongs to the brick, failures to this channel (see TransportGuard).
		const brickId = brickIdOf(brickKey);
		const channel = provider.createCommandChannel
			? provider.createCommandChannel(brickKey)
			: new PacketCommandChannel(
				(packet, options) => provider.sendPacket(brickKey, packet, options),
				provider.transport,
			);
		resources.commandQueue.setExecutor(async (cmd, options) => {
			this.transportGuard.checkRateLimit(brickId, brickKey);
			const startedAt = Date.now();
			try {
				const response = await channel.execute(cmd, options);
				this.transportGuard.recordSuccess(brickKey, Date.now() - startedAt);
				return response;
			} catch (error) {
				this.transportGuard.recordFailure(brickKey);
				throw error;
			}
		});
	}

	private cleanupSession(resources: SessionResources): void {
		resources.heartbeat.stop();
		resources.commandQueue.drainWith(new Error('Session disconnected.'));
		resources.commandQueue.dispose();
		resources.entry.clearSubscriptions();

		if (resources.reconnectTimer) {
			clearTimeout(resources.reconnectTimer);
			resources.reconnectTimer = undefined;
		}
	}

	private fireStateChange(
		brickKey: BrickKey,
		previousState: ConnectionState,
		newState: ConnectionState
	): void {
		this._onSessionStateChange.fire({ brickKey, previousState, newState });
	}
}
