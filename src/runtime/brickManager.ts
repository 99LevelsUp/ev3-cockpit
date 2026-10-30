/**
 * Brick manager — the cockpit's bricks, each over whichever channels reach it.
 *
 * The session manager below keeps one session per channel (`usb:…`, `bt:…`) and knows nothing
 * of bricks. This layer signs bricks in and out, joins every channel a signed-in brick is
 * reachable on, and sends each command over the best channel that is connected at that
 * moment — by the priority each transport declares, USB → Bluetooth → TCP (step-2 plan, KD1,
 * KD2, KTD5). A pulled cable moves traffic to Bluetooth on the first failed command; the cable
 * back in moves it back.
 */

import * as vscode from 'vscode';
import {
	BrickCommand, BrickId, BrickKey, BrickResponse, ChannelState, ConnectionState,
	PresenceState, SendCommandOptions, Transport, brickIdOf, brickKeyTransport,
} from '../contracts';
import {
	ChannelChangedError, ConnectionError, NotConnectedError, TimeoutError, TransportError,
} from '../errors/CockpitError';
import { PinnedLink } from '../fs/fileTransferService';
import type { TelemetryHost } from '../telemetry/telemetryService';
import { FIRMWARE_SAFETY } from '../transports/transportConstants';
import { ProviderRegistry } from '../transports/providerRegistry';
import { PresenceAggregator } from './presenceAggregator';
import { ReconnectStrategy } from './reconnectStrategy';
import { SessionManager } from './sessionManager';

// ── Events ──────────────────────────────────────────────────────────

/** The channel a brick's traffic goes over changed. */
export interface RouteChangeEvent {
	readonly brickId: BrickId;
	readonly previous: BrickKey | undefined;
	readonly current: BrickKey | undefined;
}

export interface ActiveBrickIdChangeEvent {
	readonly previous: BrickId | undefined;
	readonly current: BrickId | undefined;
}

// ── Options ─────────────────────────────────────────────────────────

export interface BrickManagerOptions {
	readonly sessionManager: SessionManager;
	readonly aggregator: PresenceAggregator;
	readonly providerRegistry: ProviderRegistry;
	/** Backoff for retrying a failed join on a transport that allows timed retries. */
	readonly rejoinBaseMs?: number;
	readonly rejoinMaxMs?: number;
}

// ── Per-brick sign-in state ─────────────────────────────────────────

interface SignIn {
	/** Joins in flight, by channel. */
	readonly pending: Set<BrickKey>;
	/** Failed joins that wait for the brick to be seen again before another try. */
	readonly awaitingEvidence: Set<BrickKey>;
	/** Failed joins waiting out a backoff. */
	readonly retryTimers: Map<BrickKey, NodeJS.Timeout>;
	readonly backoff: Map<BrickKey, ReconnectStrategy>;
}

/**
 * Whether an error means the channel's link is in trouble, as opposed to this one command.
 *
 * A transport, timeout or connection error is; so is a degraded channel, which the guard
 * reports as a transport error. A caller's own abort is not, even though an adapter may
 * report it as a transport error, and neither is the guard's rate limit or a queue drained
 * by a disconnect — failing over on those would move traffic off a link that works.
 */
function isLinkFailure(error: unknown, options: SendCommandOptions | undefined): boolean {
	if (options?.signal?.aborted) { return false; }
	return error instanceof TransportError
		|| error instanceof TimeoutError
		|| error instanceof ConnectionError;
}

export class BrickManager implements vscode.Disposable {
	private readonly sessionManager: SessionManager;
	private readonly aggregator: PresenceAggregator;
	private readonly registry: ProviderRegistry;
	private readonly rejoinBaseMs: number;
	private readonly rejoinMaxMs: number;

	private readonly signedIn = new Map<BrickId, SignIn>();
	/** Channels taken out of routing by a link failure, until they answer again. */
	private readonly dropped = new Set<BrickKey>();
	private readonly routes = new Map<BrickId, BrickKey>();
	private activeBrickId?: BrickId;
	private disposed = false;

	private readonly _onRouteChange = new vscode.EventEmitter<RouteChangeEvent>();
	/** Fired when the channel a brick's traffic goes over changes, including to none. */
	readonly onRouteChange = this._onRouteChange.event;

	private readonly _onActiveBrickChange = new vscode.EventEmitter<ActiveBrickIdChangeEvent>();
	readonly onActiveBrickChange = this._onActiveBrickChange.event;

	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(options: BrickManagerOptions) {
		this.sessionManager = options.sessionManager;
		this.aggregator = options.aggregator;
		this.registry = options.providerRegistry;
		this.rejoinBaseMs = options.rejoinBaseMs ?? FIRMWARE_SAFETY.RECONNECT_BASE_MS;
		this.rejoinMaxMs = options.rejoinMaxMs ?? FIRMWARE_SAFETY.RECONNECT_MAX_MS;

		this.subscriptions.push(
			this.sessionManager.onSessionStateChange((e) => {
				// The list's channel state follows its session.
				this.aggregator.updateChannelSession(e.brickKey, e.newState);
				if (e.newState === ConnectionState.Connected) { this.dropped.delete(e.brickKey); }
				const brickId = brickIdOf(e.brickKey);
				this.recomputeRoute(brickId);
				// A channel whose session ended while its brick stays signed in joins again once
				// it is available — whatever ended it.
				if (e.newState === ConnectionState.Disconnected) { this.reconcile(brickId); }
			}),
			this.aggregator.onPresenceChanged((e) => {
				if (e.currentState !== PresenceState.Available) { return; }
				// A brick that has just become visible again is the evidence a reconnecting
				// session is waiting for. Measured before this existed: a brick that boots in
				// about 40 s took 121 s to be picked up, because the backoff had reached 30 s
				// steps and waited them out beside a brick that was ready.
				this.sessionManager.notifyBrickAvailable(e.brickKey);
				const signIn = this.signedIn.get(brickIdOf(e.brickKey));
				if (signIn?.awaitingEvidence.delete(e.brickKey)) {
					this.reconcile(brickIdOf(e.brickKey));
				}
			}),
			this.aggregator.onListChanged(() => {
				for (const brickId of this.signedIn.keys()) { this.reconcile(brickId); }
			}),
		);
	}

	// ── Sign-in ─────────────────────────────────────────────────────

	/**
	 * Sign a brick in: join every channel it is available on now, and every one that becomes
	 * available later while it stays signed in.
	 *
	 * Resolves once the first channel connects; the rest keep joining in the background, so a
	 * cable that opens in 30 ms does not wait out a 5 s Bluetooth attempt. Makes the brick the
	 * active one.
	 *
	 * @throws When no channel is available, or every join fails. The brick is then not signed in.
	 */
	async signIn(brickId: BrickId): Promise<void> {
		if (this.signedIn.has(brickId)) {
			this.setActiveBrick(brickId);
			return;
		}
		const candidates = this.joinCandidates(brickId);
		if (candidates.length === 0) {
			throw new NotConnectedError(`Brick ${brickId} is not available on any channel.`);
		}

		this.signedIn.set(brickId, {
			pending: new Set(), awaitingEvidence: new Set(), retryTimers: new Map(), backoff: new Map(),
		});
		try {
			await Promise.any(candidates.map((key) => this.join(brickId, key)));
		} catch (error) {
			this.forgetSignIn(brickId);
			const first: unknown = error instanceof AggregateError ? error.errors[0] : error;
			throw first instanceof Error ? first : new Error(String(first));
		}
		this.setActiveBrick(brickId);
	}

	/** Sign a brick out: close every channel; it does not reconnect until signed in again. */
	async signOut(brickId: BrickId): Promise<void> {
		// Cleared first, so nothing that fires while the channels close joins them again.
		this.forgetSignIn(brickId);
		const keys = this.sessionManager.getAllSessions()
			.map((s) => s.brickKey)
			.filter((key) => brickIdOf(key) === brickId);
		await Promise.all(keys.map((key) => this.sessionManager.disconnect(key)));
		for (const key of keys) { this.dropped.delete(key); }
		this.recomputeRoute(brickId);
		if (this.activeBrickId === brickId) { this.clearActiveBrick(); }
	}

	isSignedIn(brickId: BrickId): boolean {
		return this.signedIn.has(brickId);
	}

	/** The bricks currently signed in. */
	signedInBricks(): BrickId[] {
		return [...this.signedIn.keys()];
	}

	// ── Routing ─────────────────────────────────────────────────────

	/** The channel a brick's traffic goes over now, or undefined when none is connected. */
	routeOf(brickId: BrickId): BrickKey | undefined {
		return this.routes.get(brickId);
	}

	/**
	 * Send a command to a brick over its best connected channel.
	 *
	 * A command that fails on a link fault is not resent: its caller hears the failure. The
	 * channel leaves routing at once, so the next command goes over the next channel, and is
	 * probed straight away — back in routing if it answers, reconnecting if not.
	 */
	async send(brickId: BrickId, command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> {
		const route = this.routes.get(brickId);
		if (!route) {
			throw new NotConnectedError(`Brick ${brickId} has no connected channel.`);
		}
		try {
			return await this.sessionManager.send(route, command, options);
		} catch (error) {
			if (isLinkFailure(error, options)) { this.dropFromRouting(route); }
			throw error;
		}
	}

	/**
	 * Hold the brick's current channel for a multi-step operation (step-2 plan, KD9).
	 *
	 * Every step goes over that channel even if traffic moves meanwhile, so a transfer that
	 * started over Bluetooth finishes there when a cable is plugged in; a step fails with
	 * {@link ChannelChangedError} only once that channel is lost. A link fault on a step
	 * fails over for everyone else as an ordinary send would.
	 */
	pin(brickId: BrickId): PinnedLink {
		const key = this.routes.get(brickId);
		if (!key) {
			throw new NotConnectedError(`Brick ${brickId} has no connected channel.`);
		}
		return {
			maxPacketBytes: this.sessionManager.maxPacketBytes(key),
			send: async (command) => {
				if (this.sessionManager.getSession(key)?.connectionState !== ConnectionState.Connected
					|| this.dropped.has(key)) {
					throw new ChannelChangedError(
						`The channel ${key} this operation started on was lost; start it again.`);
				}
				try {
					return await this.sessionManager.send(key, command);
				} catch (error) {
					if (isLinkFailure(error, undefined)) { this.dropFromRouting(key); }
					throw error;
				}
			},
		};
	}

	/** Largest packet the brick's current channel carries, or undefined for the firmware's own. */
	maxPacketBytes(brickId: BrickId): number | undefined {
		const route = this.routes.get(brickId);
		return route ? this.sessionManager.maxPacketBytes(route) : undefined;
	}

	/** The transport a brick's traffic goes over now, or undefined when none is connected. */
	transportOfBrick(brickId: BrickId): Transport | undefined {
		const route = this.routes.get(brickId);
		return route ? this.transportOf(route) : undefined;
	}

	/**
	 * This layer as a telemetry host: the active brick's loop runs over whichever channel
	 * carries its traffic, at that channel's cadence, and restarts when the route moves.
	 *
	 * A brick counts as connected while it has a route and as reconnecting while it is
	 * signed in without one, which is what the loop needs to know to run or wait.
	 */
	telemetryHost(): TelemetryHost {
		const asBrick = (key: string): BrickId => key as BrickId;
		return {
			send: (key, command, options) => this.send(asBrick(key), command, options),
			maxPacketBytes: (key) => this.maxPacketBytes(asBrick(key)),
			transportOf: (key) => this.transportOfBrick(asBrick(key)),
			getActiveBrickKey: () => this.activeBrickId,
			getSession: (key) => {
				if (this.routes.has(asBrick(key))) { return { connectionState: ConnectionState.Connected }; }
				return this.signedIn.has(asBrick(key))
					? { connectionState: ConnectionState.Reconnecting }
					: undefined;
			},
			onSessionStateChange: (listener, thisArgs, disposables) => this.onRouteChange(
				(e) => {
					listener.call(thisArgs, {
						brickKey: e.brickId,
						newState: e.current ? ConnectionState.Connected : ConnectionState.Reconnecting,
					});
				}, undefined, disposables),
			onActiveBrickChange: (listener, thisArgs, disposables) => this.onActiveBrickChange(
				(e) => { listener.call(thisArgs, { previousBrickKey: e.previous, newBrickKey: e.current }); },
				undefined, disposables),
			onRouteChange: (listener, thisArgs, disposables) => this.onRouteChange(
				(e) => { listener.call(thisArgs, { brickKey: e.brickId }); }, undefined, disposables),
		};
	}

	// ── Active brick ────────────────────────────────────────────────

	getActiveBrickId(): BrickId | undefined {
		return this.activeBrickId;
	}

	/** Make a signed-in brick the active one. */
	setActiveBrick(brickId: BrickId): void {
		if (!this.signedIn.has(brickId)) {
			throw new NotConnectedError(`Brick ${brickId} is not signed in.`);
		}
		const previous = this.activeBrickId;
		this.activeBrickId = brickId;
		this.followRouteInSessionManager(brickId);
		if (previous !== brickId) {
			this._onActiveBrickChange.fire({ previous, current: brickId });
		}
	}

	clearActiveBrick(): void {
		const previous = this.activeBrickId;
		if (!previous) { return; }
		this.activeBrickId = undefined;
		this.sessionManager.clearActiveBrick();
		this._onActiveBrickChange.fire({ previous, current: undefined });
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	dispose(): void {
		this.disposed = true;
		for (const brickId of [...this.signedIn.keys()]) { this.forgetSignIn(brickId); }
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.subscriptions.length = 0;
		this._onRouteChange.dispose();
		this._onActiveBrickChange.dispose();
	}

	// ── Internal: joining ───────────────────────────────────────────

	/** Channels of a brick that are available and have no session yet. */
	private joinCandidates(brickId: BrickId): BrickKey[] {
		const entry = this.aggregator.getBrick(brickId);
		if (!entry) { return []; }
		return entry.channels
			.filter((c) => c.state === ChannelState.Available)
			.map((c) => c.brickKey)
			.filter((key) => !this.sessionManager.getSession(key));
	}

	/** Join every channel of a signed-in brick that can be joined now. Idempotent. */
	private reconcile(brickId: BrickId): void {
		const signIn = this.signedIn.get(brickId);
		if (!signIn || this.disposed) { return; }
		for (const key of this.joinCandidates(brickId)) {
			if (signIn.pending.has(key) || signIn.awaitingEvidence.has(key) || signIn.retryTimers.has(key)) {
				continue;
			}
			this.join(brickId, key).catch(() => { /* recorded by join; retried per transport */ });
		}
	}

	private async join(brickId: BrickId, key: BrickKey): Promise<void> {
		const signIn = this.signedIn.get(brickId);
		if (!signIn) { throw new NotConnectedError(`Brick ${brickId} is not signed in.`); }
		const transport = this.transportOf(key);
		signIn.pending.add(key);
		try {
			const name = this.aggregator.getBrick(brickId)?.name.value;
			await this.sessionManager.connect(key, transport, name);
			signIn.backoff.delete(key);
			// Signed out while this join was in flight: the user asked for nothing to stay open.
			if (this.signedIn.get(brickId) !== signIn) {
				await this.sessionManager.disconnect(key);
			}
		} catch (error) {
			if (this.signedIn.get(brickId) === signIn) { this.scheduleRejoin(brickId, signIn, key, transport); }
			throw error;
		} finally {
			signIn.pending.delete(key);
		}
	}

	private scheduleRejoin(brickId: BrickId, signIn: SignIn, key: BrickKey, transport: Transport): void {
		if (this.registry.get(transport)?.capabilities.rejoinOnEvidenceOnly) {
			signIn.awaitingEvidence.add(key);
			return;
		}
		let backoff = signIn.backoff.get(key);
		if (!backoff) {
			backoff = new ReconnectStrategy({ baseMs: this.rejoinBaseMs, maxMs: this.rejoinMaxMs });
			signIn.backoff.set(key, backoff);
		}
		const delay = backoff.nextDelay() ?? this.rejoinMaxMs;
		const timer = setTimeout(() => {
			signIn.retryTimers.delete(key);
			this.reconcile(brickId);
		}, delay);
		timer.unref();
		signIn.retryTimers.set(key, timer);
	}

	private forgetSignIn(brickId: BrickId): void {
		const signIn = this.signedIn.get(brickId);
		if (!signIn) { return; }
		for (const timer of signIn.retryTimers.values()) { clearTimeout(timer); }
		this.signedIn.delete(brickId);
	}

	// ── Internal: routing ───────────────────────────────────────────

	private dropFromRouting(key: BrickKey): void {
		if (this.dropped.has(key)) { return; }
		this.dropped.add(key);
		const brickId = brickIdOf(key);
		this.recomputeRoute(brickId);
		void this.sessionManager.probeNow(key).then((answered) => {
			if (answered && this.dropped.delete(key)) { this.recomputeRoute(brickId); }
		});
	}

	/** The connected, undropped channel with the highest priority its provider declares. */
	private recomputeRoute(brickId: BrickId): void {
		const best = this.sessionManager.getAllSessions()
			.filter((s) => brickIdOf(s.brickKey) === brickId
				&& s.connectionState === ConnectionState.Connected
				&& !this.dropped.has(s.brickKey))
			.map((s) => s.brickKey)
			.sort((a, b) => this.priorityOf(b) - this.priorityOf(a))[0];

		const previous = this.routes.get(brickId);
		if (best === previous) { return; }
		if (best) { this.routes.set(brickId, best); } else { this.routes.delete(brickId); }
		if (this.activeBrickId === brickId) { this.followRouteInSessionManager(brickId); }
		this._onRouteChange.fire({ brickId, previous, current: best });
	}

	/** The session manager's foreground follows the active brick's route channel. */
	private followRouteInSessionManager(brickId: BrickId): void {
		const route = this.routes.get(brickId);
		if (route) { this.sessionManager.setActiveBrick(route); }
	}

	private priorityOf(key: BrickKey): number {
		return this.registry.get(this.transportOf(key))?.priority ?? 0;
	}

	private transportOf(key: BrickKey): Transport {
		// Every key this layer handles came from discovery or a session, so it is well formed.
		return this.sessionManager.getSession(key)?.transport ?? brickKeyTransport(key) as Transport;
	}
}
