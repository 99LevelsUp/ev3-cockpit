/**
 * Session Manager — central coordinator for connected brick sessions.
 *
 * Manages the lifecycle of connected sessions: connect, disconnect, heartbeat,
 * reconnect, foreground switching, and command dispatch. Owns all session entries
 * and is the single source of truth for connection state.
 */

import * as vscode from 'vscode';
import { ConnectionState, ActivityMode, Transport } from '../contracts/enums';
import { BrickKey } from '../contracts/brickKey';
import { ConnectedSession } from '../contracts/models';
import { BrickCommand, BrickResponse, TransportProvider } from '../contracts/transport';
import { SessionEntry } from './sessionEntry';
import { CommandQueue } from './commandQueue';
import { HeartbeatMonitor } from './heartbeatMonitor';
import { ReconnectStrategy } from './reconnectStrategy';
import { ProviderRegistry } from '../transports/providerRegistry';
import { FIRMWARE_SAFETY } from '../transports/transportConstants';

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

	constructor(options: SessionManagerOptions) {
		this.providerRegistry = options.providerRegistry;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? FIRMWARE_SAFETY.MIN_HEARTBEAT_INTERVAL_MS;
		this.heartbeatMissThreshold = options.heartbeatMissThreshold ?? 2;
		this.reconnectBaseMs = options.reconnectBaseMs ?? FIRMWARE_SAFETY.RECONNECT_BASE_MS;
		this.reconnectMaxMs = options.reconnectMaxMs ?? FIRMWARE_SAFETY.RECONNECT_MAX_MS;
		this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? FIRMWARE_SAFETY.MAX_RECONNECT_ATTEMPTS;
	}

	// ── Connect / Disconnect ────────────────────────────────────────

	/** Connect to a brick via the specified transport. */
	async connect(brickKey: BrickKey, transport: Transport, displayName?: string): Promise<void> {
		if (this.sessions.has(brickKey)) {
			throw new Error(`Brick ${brickKey} is already connected.`);
		}

		const provider = this.providerRegistry.get(transport);
		if (!provider) {
			throw new Error(`No transport provider registered for "${transport}".`);
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
			entry.setHandle(handle);
			entry.transition(ConnectionState.Connected);
			this.fireStateChange(brickKey, ConnectionState.Connecting, ConnectionState.Connected);

			this.wireExecutor(resources, provider);
			heartbeat.start();
			reconnect.reset();
		} catch (error) {
			entry.setError(error instanceof Error ? error.message : String(error));
			entry.transition(ConnectionState.Disconnected);
			this.sessions.delete(brickKey);
			this.fireStateChange(brickKey, ConnectionState.Connecting, ConnectionState.Disconnected);
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
			throw new Error(`Brick ${brickKey} is not connected.`);
		}

		const previous = this.activeBrickKey;
		if (previous === brickKey) {
			return;
		}

		// Demote previous foreground brick
		if (previous) {
			const prevResources = this.sessions.get(previous);
			if (prevResources) {
				prevResources.entry.setActiveMode(ActivityMode.Subscribed);
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
			prevResources.entry.setActiveMode(ActivityMode.Subscribed);
		}

		this.activeBrickKey = undefined;
		this._onActiveBrickChange.fire({ previousBrickKey: previous, newBrickKey: undefined });
	}

	/** Get the current foreground brick key. */
	getActiveBrickKey(): BrickKey | undefined {
		return this.activeBrickKey;
	}

	// ── Command dispatch ────────────────────────────────────────────

	/** Send a command to a connected brick (via its command queue). */
	send(brickKey: BrickKey, command: BrickCommand): Promise<BrickResponse> {
		const resources = this.sessions.get(brickKey);
		if (!resources) {
			return Promise.reject(new Error(`Brick ${brickKey} is not connected.`));
		}
		return resources.commandQueue.send(command);
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
			const handle = provider.recover
				? await provider.recover(brickKey)
				: await provider.connect(brickKey);

			resources.entry.setHandle(handle);
			resources.entry.transition(ConnectionState.Connected);
			resources.reconnect.reset();
			this.fireStateChange(brickKey, ConnectionState.Reconnecting, ConnectionState.Connected);

			this.wireExecutor(resources, provider);
			resources.heartbeat.start();
		} catch {
			this.scheduleReconnect(brickKey);
		}
	}

	// ── Internal: Cleanup ───────────────────────────────────────────

	private wireExecutor(resources: SessionResources, provider: TransportProvider): void {
		resources.commandQueue.setExecutor(
			(cmd) => provider.send(resources.entry.brickKey, cmd)
		);
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
