/**
 * Session entry — the runtime representation of a single connected brick session.
 *
 * Encapsulates connection state machine, heartbeat state, error tracking,
 * and activity mode for one brick. The {@link SessionManager} owns session entries.
 */

import { ConnectionState, ActivityMode, TelemetryCategory, Transport } from '../contracts/enums';
import { BrickKey } from '../contracts/brickKey';
import { HeartbeatState, ConnectedSession } from '../contracts/models';
import { SessionHandle } from '../contracts/transport';

/** Valid state transitions for the connection state machine. */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
	[ConnectionState.Connecting]: new Set([ConnectionState.Connected, ConnectionState.Disconnected]),
	[ConnectionState.Connected]: new Set([ConnectionState.Reconnecting, ConnectionState.Disconnected]),
	[ConnectionState.Reconnecting]: new Set([ConnectionState.Connected, ConnectionState.Disconnected]),
	[ConnectionState.Disconnected]: new Set([ConnectionState.Connecting]),
};

export class SessionEntry {
	readonly brickKey: BrickKey;
	readonly transport: Transport;

	private _connectionState: ConnectionState = ConnectionState.Connecting;
	private _activeMode: ActivityMode = ActivityMode.Minimal;
	private _heartbeatState: HeartbeatState = 'unknown';
	private _lastError?: string;
	private _displayName: string;
	private _handle?: SessionHandle;
	private _subscribedCategories = new Set<TelemetryCategory>();
	private _explicitlyDisconnected = false;

	constructor(brickKey: BrickKey, transport: Transport, displayName: string) {
		this.brickKey = brickKey;
		this.transport = transport;
		this._displayName = displayName;
	}

	// ── Getters ─────────────────────────────────────────────────────

	get connectionState(): ConnectionState { return this._connectionState; }
	get activeMode(): ActivityMode { return this._activeMode; }
	get heartbeatState(): HeartbeatState { return this._heartbeatState; }
	get lastError(): string | undefined { return this._lastError; }
	get displayName(): string { return this._displayName; }
	get handle(): SessionHandle | undefined { return this._handle; }
	get subscribedCategories(): TelemetryCategory[] { return [...this._subscribedCategories]; }
	get explicitlyDisconnected(): boolean { return this._explicitlyDisconnected; }

	// ── State machine ───────────────────────────────────────────────

	/** Transition to a new connection state. Throws on invalid transitions. */
	transition(target: ConnectionState): void {
		const allowed = VALID_TRANSITIONS[this._connectionState];
		if (!allowed?.has(target)) {
			throw new Error(
				`Invalid session transition: ${this._connectionState} → ${target} for ${this.brickKey}`
			);
		}
		this._connectionState = target;

		if (target === ConnectionState.Connected) {
			this._lastError = undefined;
			this._heartbeatState = 'ok';
		} else if (target === ConnectionState.Disconnected) {
			this._heartbeatState = 'unknown';
			this._handle = undefined;
		} else if (target === ConnectionState.Reconnecting) {
			this._heartbeatState = 'missed';
		}
	}

	// ── Session handle ──────────────────────────────────────────────

	setHandle(handle: SessionHandle): void {
		this._handle = handle;
	}

	// ── Activity mode ───────────────────────────────────────────────

	setActiveMode(mode: ActivityMode): void {
		this._activeMode = mode;
	}

	// ── Heartbeat ───────────────────────────────────────────────────

	setHeartbeatState(state: HeartbeatState): void {
		this._heartbeatState = state;
	}

	// ── Error tracking ──────────────────────────────────────────────

	setError(message: string): void {
		this._lastError = message;
	}

	clearError(): void {
		this._lastError = undefined;
	}

	// ── Display name ────────────────────────────────────────────────

	setDisplayName(name: string): void {
		this._displayName = name;
	}

	// ── Auto-connect suppression ────────────────────────────────────

	markExplicitlyDisconnected(): void {
		this._explicitlyDisconnected = true;
	}

	clearExplicitDisconnect(): void {
		this._explicitlyDisconnected = false;
	}

	// ── Telemetry subscriptions ─────────────────────────────────────

	subscribe(category: TelemetryCategory): void {
		this._subscribedCategories.add(category);
	}

	unsubscribe(category: TelemetryCategory): void {
		this._subscribedCategories.delete(category);
	}

	clearSubscriptions(): void {
		this._subscribedCategories.clear();
	}

	// ── Snapshot ────────────────────────────────────────────────────

	/** Create a read-only snapshot of the session state. */
	toConnectedSession(): ConnectedSession {
		return {
			brickKey: this.brickKey,
			displayName: this._displayName,
			transport: this.transport,
			connectionState: this._connectionState,
			activeMode: this._activeMode,
			lastError: this._lastError,
			subscribedCategories: [...this._subscribedCategories],
			heartbeatState: this._heartbeatState,
		};
	}
}
