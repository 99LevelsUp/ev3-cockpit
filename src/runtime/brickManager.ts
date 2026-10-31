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
	BrickCommand, BrickId, BrickKey, BrickResponse, ChannelState, ConnectionState, ForgetResidue,
	PresenceState, SendCommandOptions, Transport, brickIdOf, brickKeyId, brickKeyTransport, describeChannel,
} from '../contracts';
import {
	ChannelChangedError, ConnectionAbandonedError, ConnectionError, NotConnectedError, ProtocolError, TimeoutError,
	TransportError,
} from '../errors/CockpitError';
import { PinnedLink } from '../fs/fileTransferService';
import { PacketCommandChannel } from '../commands/commandChannel';
import type { TelemetryHost } from '../telemetry/telemetryService';
import { FIRMWARE_SAFETY } from '../transports/transportConstants';
import { ProviderRegistry } from '../transports/providerRegistry';
import { channelLabel } from './brickLabels';
import type { DiscoveryScheduler } from './discoveryScheduler';
import type {
	BrickSideOutcome, ForgetReport, MemoryOutcome, PairingOutcome, PeerRemoval,
} from './forgetReport';
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
	/** Where a name that could not be read is reported, once per channel. */
	readonly log?: { warn(message: string): void };
	/**
	 * Discovery, for {@link BrickManager.forget}: it waits out the scans in flight, stops
	 * tracking the brick's channels, and scans once afterwards (step-3 plan, KTD1, KTD7).
	 * Absent, a forget does none of that.
	 */
	readonly discovery?: Pick<DiscoveryScheduler, 'scansSettled' | 'forget' | 'scanOnce'>;
	/** Bluetooth presence, which a forget tells to drop the brick's address (KTD7). Absent: nothing to drop. */
	readonly btPresence?: { forget(mac: string): void };
	/**
	 * This computer's Bluetooth name, the only key to its entry on a brick (KTD3). Absent, or
	 * returning undefined, when it cannot be read; a forget then leaves the brick's list alone.
	 */
	readonly radioName?: () => string | undefined;
}

// ── Per-brick sign-in state ─────────────────────────────────────────

interface SignIn {
	/** Joins in flight, by channel. */
	readonly pending: Set<BrickKey>;
	/** Failed joins that wait for the brick to be seen again before another try, with when they failed. */
	readonly awaitingEvidence: Map<BrickKey, number>;
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
	private readonly log?: { warn(message: string): void };
	/** Channels being asked their name without a session, so one sighting asks once. */
	private readonly probing = new Set<BrickKey>();
	/** Channels whose name probe has failed and been reported, so it is reported once. */
	private readonly probeFailuresReported = new Set<BrickKey>();
	/** Bricks being forgotten: nothing opens, reopens or probes a link to them (KTD4). */
	private readonly forgetting = new Set<BrickId>();
	/** The forget running for each brick, so a second call joins it. */
	private readonly forgets = new Map<BrickId, Promise<ForgetReport>>();
	private readonly discovery?: Pick<DiscoveryScheduler, 'scansSettled' | 'forget' | 'scanOnce'>;
	private readonly btPresence?: { forget(mac: string): void };
	private readonly radioName?: () => string | undefined;

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
		this.log = options.log;
		this.discovery = options.discovery;
		this.btPresence = options.btPresence;
		this.radioName = options.radioName;

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
				// Not for a brick being forgotten: either would open a link the forget is closing (KTD4).
				const forgetting = this.forgetting.has(brickIdOf(e.brickKey));
				if (!forgetting) { this.sessionManager.notifyBrickAvailable(e.brickKey); }
				if (!forgetting) { this.probeName(e.brickKey); }
				const signIn = this.signedIn.get(brickIdOf(e.brickKey));
				if (signIn?.awaitingEvidence.delete(e.brickKey)) {
					this.reconcile(brickIdOf(e.brickKey));
				}
			}),
			this.aggregator.onListChanged(() => {
				for (const brickId of this.signedIn.keys()) {
					this.takeAnswersAsEvidence(brickId);
					this.reconcile(brickId);
				}
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
		// The forget is closing every channel of this brick; a sign-in would reopen one under it
		// (step-3 plan, KTD4). The forget opens its own channel without coming through here.
		if (this.forgetting.has(brickId)) {
			throw new NotConnectedError(`Brick ${brickId} is being forgotten; sign it in once that has finished.`);
		}
		if (this.signedIn.has(brickId)) {
			this.setActiveBrick(brickId);
			return;
		}
		const candidates = this.joinCandidates(brickId);
		if (candidates.length === 0) {
			throw new NotConnectedError(`Brick ${brickId} is not available on any channel.`);
		}

		const signIn: SignIn = {
			pending: new Set(), awaitingEvidence: new Map(), retryTimers: new Map(), backoff: new Map(),
		};
		const abandoned = (): ConnectionAbandonedError =>
			new ConnectionAbandonedError(`Brick ${brickId} was disconnected while it was connecting.`);
		this.signedIn.set(brickId, signIn);
		try {
			await Promise.any(candidates.map((key) => this.join(brickId, key)));
		} catch (error) {
			// Signed out meanwhile, whatever the other channels failed with before that; a newer
			// sign-in is not this one's to end.
			if (this.signedIn.get(brickId) !== signIn) { throw abandoned(); }
			this.forgetSignIn(brickId);
			const first: unknown = error instanceof AggregateError ? error.errors[0] : error;
			throw first instanceof Error ? first : new Error(String(first));
		}
		if (this.signedIn.get(brickId) !== signIn) { throw abandoned(); }
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

	// ── Forget ──────────────────────────────────────────────────────

	/**
	 * Make this computer forget a brick on every channel (step-3 plan, KD1, KTD1).
	 *
	 * In this order, each part running even when an earlier one failed, and each recorded in
	 * the report:
	 * 1. mark the brick as being forgotten, so nothing opens, reopens or probes a link to it
	 *    (KTD4);
	 * 2. remove this computer's entry from the brick's own Bluetooth list, over a live channel
	 *    when there is one (KTD5);
	 * 3. sign the brick out, which closes every channel, the one opened for step 2 too;
	 * 4. have each channel's provider forget it where the provider can: the operating-system
	 *    pairing (KTD6);
	 * 5. wait out the discovery scans in flight, then clear the cockpit's memory of it (KTD7);
	 * 6. lift the mark and scan once, so a brick still in reach comes back as a stranger (R4).
	 *
	 * Shows nothing; the caller builds the message from the report (KTD8). A second call while
	 * one runs gets the same report rather than a second run, whose end would lift the guards
	 * while the first still works.
	 */
	forget(brickId: BrickId): Promise<ForgetReport> {
		let running = this.forgets.get(brickId);
		if (!running) {
			running = this.runForget(brickId).finally(() => { this.forgets.delete(brickId); });
			this.forgets.set(brickId, running);
		}
		return running;
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
		let response: BrickResponse;
		try {
			response = await this.sessionManager.send(route, command, options);
		} catch (error) {
			if (isLinkFailure(error, options)) { this.dropFromRouting(route); }
			throw error;
		}
		// The brick answers a rename with a bare status, and rejects a bad name in silence; the
		// only proof it took is to read the name back.
		if (command.kind === 'brick:setName') { void this.readNameOverSession(route); }
		return response;
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
						`The channel ${describeChannel(key)} this operation started on was lost; start it again.`);
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
		// A brick being forgotten loses its channels on purpose; none joins again (KTD4). A
		// rejoin that `scheduleRejoin` set up runs through here too, so it needs no check of its own.
		if (!signIn || this.disposed || this.forgetting.has(brickId)) { return; }
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
			// A connect from an earlier sign-in can still be inside the provider, a Bluetooth one
			// for seconds in the connection queue; the session manager makes this one wait its
			// turn, and rejects it if the brick is signed out meanwhile.
			const name = this.aggregator.getBrick(brickId)?.name.value;
			await this.sessionManager.connect(key, transport, name);
			signIn.backoff.delete(key);
			void this.readNameOverSession(key);
			// Signed out once the connect was through: the user asked for nothing to stay open.
			// A newer sign-in keeps the channel; it is the one it would have opened.
			if (!this.signedIn.has(brickId)) {
				await this.sessionManager.disconnect(key);
			}
		} catch (error) {
			// Nothing to say or retry for a join its sign-in no longer wants.
			if (error instanceof ConnectionAbandonedError || this.signedIn.get(brickId) !== signIn) { throw error; }
			// Said, because a channel that will not join is otherwise invisible: the brick works
			// over its other channels and nothing explains why this one stays unused.
			this.log?.warn(`Joining ${channelLabel(this.aggregator, key)} failed: `
				+ `${error instanceof Error ? error.message : String(error)}`);
			this.scheduleRejoin(brickId, signIn, key, transport);
			throw error;
		} finally {
			signIn.pending.delete(key);
		}
	}

	private scheduleRejoin(brickId: BrickId, signIn: SignIn, key: BrickKey, transport: Transport): void {
		if (this.registry.get(transport)?.capabilities.rejoinOnEvidenceOnly) {
			signIn.awaitingEvidence.set(key, Date.now());
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

	/**
	 * A presence check answered after a join failed is the evidence that join was waiting for:
	 * the brick is there now, whatever stopped the last attempt.
	 */
	private takeAnswersAsEvidence(brickId: BrickId): void {
		const signIn = this.signedIn.get(brickId);
		if (!signIn || signIn.awaitingEvidence.size === 0) { return; }
		for (const channel of this.aggregator.getBrick(brickId)?.channels ?? []) {
			const failedAt = signIn.awaitingEvidence.get(channel.brickKey);
			if (failedAt !== undefined && (channel.heardAt ?? 0) > failedAt) {
				signIn.awaitingEvidence.delete(channel.brickKey);
			}
		}
	}

	private forgetSignIn(brickId: BrickId): void {
		const signIn = this.signedIn.get(brickId);
		if (!signIn) { return; }
		for (const timer of signIn.retryTimers.values()) { clearTimeout(timer); }
		this.signedIn.delete(brickId);
	}

	// ── Internal: forgetting ────────────────────────────────────────

	private async runForget(brickId: BrickId): Promise<ForgetReport> {
		this.forgetting.add(brickId);
		let report: ForgetReport;
		try {
			// Read before anything is forgotten: the list is where the channels and the Bluetooth
			// address come from, and step 5 deletes it.
			const keys = this.channelKeysOf(brickId);
			const { outcome: brickSide, peers } = await this.removeOwnEntry(brickId).catch((error: unknown) => ({
				outcome: { status: 'skipped', reason: 'error', detail: messageOf(error) } as BrickSideOutcome,
				peers: undefined,
			}));
			try {
				await this.signOut(brickId);
			} catch (error) {
				// The providers' forget below closes their links again; the rest still runs.
				this.log?.warn(`Signing ${brickId} out to forget it failed: ${messageOf(error)}`);
			}
			const { pairing, residue } = await this.forgetPairings(keys);
			// A scan that read Windows' list before the unpair would re-track the brick as paired
			// once its memory is gone; one that starts later reads the list after it.
			await this.discovery?.scansSettled();
			const memory = this.forgetMemory(brickId, keys);
			report = { brickId, brickSide, ...(peers ? { peers } : {}), pairing, memory, residue };
		} finally {
			this.forgetting.delete(brickId);
		}
		try {
			await this.discovery?.scanOnce();
		} catch {
			// The scan's own failure is reported by the scheduler; the forget is done.
		}
		return report;
	}

	/** Every channel the list or a session holds for a brick. */
	private channelKeysOf(brickId: BrickId): BrickKey[] {
		const keys = new Set<BrickKey>(this.aggregator.getBrick(brickId)?.channels.map((c) => c.brickKey) ?? []);
		for (const session of this.sessionManager.getAllSessions()) {
			if (brickIdOf(session.brickKey) === brickId) { keys.add(session.brickKey); }
		}
		return [...keys];
	}

	/**
	 * Remove this computer's entry from the brick's Bluetooth list (KTD5, R7, R8).
	 *
	 * The entry is found by an exact match on this computer's radio name, the name the brick
	 * stored it under and compares with `strcmp` (KTD3, `c_bt.c` 2215). No name, no channel, no
	 * list or no match: nothing is sent, and the outcome says which.
	 */
	private async removeOwnEntry(brickId: BrickId): Promise<{ outcome: BrickSideOutcome; peers?: string[] }> {
		const name = this.radioName?.();
		if (!name) { return { outcome: { status: 'skipped', reason: 'radio-name-unknown' } }; }

		const channel = await this.peerListChannel(brickId);
		if (!channel.key) {
			return {
				outcome: {
					status: 'skipped', reason: 'not-reachable', ...(channel.failure ? { detail: channel.failure } : {}),
				},
			};
		}
		let peers: string[];
		try {
			peers = await this.readPeers(channel.key);
		} catch (error) {
			return { outcome: { status: 'skipped', reason: 'list-unreadable', detail: messageOf(error) } };
		}
		if (!peers.includes(name)) { return { outcome: { status: 'skipped', reason: 'no-match' }, peers }; }
		return { outcome: await this.removePeer(brickId, channel.key, name), peers };
	}

	/**
	 * The channel the brick's list is read and changed over (KTD5): a connected one if there is
	 * one, otherwise the best available one, opened for this alone through the session manager
	 * — not through {@link signIn}, which would join every available channel. A failed open
	 * means the brick is not reachable (R8); step 3 of the forget closes what this opened.
	 *
	 * Bluetooth comes last, below what the providers' priorities say (USB 30, Bluetooth 20, TCP
	 * 10): only a channel the removal does not cut can read the list back and confirm it. The
	 * same order holds among connected channels, so a brick connected over TCP and Bluetooth
	 * is changed over TCP although its traffic goes over Bluetooth.
	 */
	private async peerListChannel(brickId: BrickId): Promise<{ key?: BrickKey; failure?: string }> {
		const best = (keys: BrickKey[]): BrickKey | undefined =>
			keys.sort((a, b) => this.peerListRank(b) - this.peerListRank(a))[0];
		const connected = best(this.sessionManager.getAllSessions()
			.filter((s) => brickIdOf(s.brickKey) === brickId
				&& s.connectionState === ConnectionState.Connected
				&& !this.dropped.has(s.brickKey))
			.map((s) => s.brickKey));
		if (connected) { return { key: connected }; }

		const available = best(this.joinCandidates(brickId));
		if (!available) { return {}; }
		try {
			await this.sessionManager.connect(available, this.transportOf(available),
				this.aggregator.getBrick(brickId)?.name.value);
			return { key: available };
		} catch (error) {
			return { failure: messageOf(error) };
		}
	}

	private peerListRank(key: BrickKey): number {
		return (this.transportOf(key) === Transport.BT ? 0 : 1000) + this.priorityOf(key);
	}

	/**
	 * The brick's Bluetooth list over one channel, names untrimmed: the count, then each index
	 * below it, because the firmware does not bounds-check the index (KTD2, `c_bt.c` 3561–3567).
	 */
	private async readPeers(key: BrickKey): Promise<string[]> {
		const count = await this.sessionManager.send(key, { kind: 'brick:bluetoothPeerCount' });
		if (count.kind !== 'brick:bluetoothPeerCount') {
			throw new ProtocolError(`Expected the Bluetooth peer count, got ${count.kind}.`);
		}
		const names: string[] = [];
		for (let index = 0; index < count.count; index++) {
			const peer = await this.sessionManager.send(key, { kind: 'brick:bluetoothPeer', index });
			if (peer.kind !== 'brick:bluetoothPeer') {
				throw new ProtocolError(`Expected Bluetooth peer ${index}, got ${peer.kind}.`);
			}
			names.push(peer.name);
		}
		return names;
	}

	/**
	 * Remove one entry from the brick's list over `key`, and find out whether it went (KTD5, R9).
	 *
	 * Over USB or TCP the brick's Bluetooth sessions are closed first, explicitly: the removal
	 * cuts the link of the peer it removes (`c_bt.c` 3609–3612), and the session manager would
	 * otherwise reconnect it to a brick that has just dropped this computer. Over Bluetooth the
	 * removal is the last command on its link, so a drop or a timeout is all that comes back
	 * and it counts as sent. A normal reply means the firmware did not run it — its Bluetooth
	 * is off or busy (`c_bt.c` 3594–3656) — and the list read back says so.
	 *
	 * Sent once, with the normal timeout, and through the session manager rather than
	 * {@link send}, so a failure here is not a failover. The brick's VM waits on BlueZ while it
	 * removes; a retry would only wait again.
	 */
	private async removePeer(brickId: BrickId, key: BrickKey, name: string): Promise<PeerRemoval> {
		if (this.transportOf(key) !== Transport.BT) { await this.closeBluetoothSessions(brickId); }
		try {
			await this.sessionManager.send(key, { kind: 'brick:removeBluetoothPeer', name });
		} catch (error) {
			return isLinkFailure(error, undefined)
				? { status: 'sent', name, over: key, detail: messageOf(error) }
				: { status: 'failed', name, over: key, detail: messageOf(error) };
		}
		let after: string[];
		try {
			after = await this.readPeers(key);
		} catch (error) {
			return { status: 'sent', name, over: key, detail: messageOf(error) };
		}
		return after.includes(name)
			? { status: 'failed', name, over: key, detail: 'The list read back still holds the entry.' }
			: { status: 'confirmed', name, over: key };
	}

	/** Close every Bluetooth session of a brick explicitly, so the session manager reopens none. */
	private async closeBluetoothSessions(brickId: BrickId): Promise<void> {
		const keys = this.sessionManager.getAllSessions()
			.map((s) => s.brickKey)
			.filter((key) => brickIdOf(key) === brickId && this.transportOf(key) === Transport.BT);
		await Promise.all(keys.map((key) => this.sessionManager.disconnect(key)));
	}

	/**
	 * Each channel's provider forgets the brick where it can (KTD6, R5). One provider at a time;
	 * a refusal is recorded with the provider's reason and the next still runs.
	 */
	private async forgetPairings(keys: readonly BrickKey[]): Promise<{
		pairing: PairingOutcome[]; residue: ForgetResidue[];
	}> {
		const pairing: PairingOutcome[] = [];
		const residue: ForgetResidue[] = [];
		for (const key of keys) {
			const provider = this.registry.get(this.transportOf(key));
			if (!provider?.capabilities.supportsForget || !provider.forget) { continue; }
			try {
				residue.push(...await provider.forget(key));
				pairing.push({ status: 'removed', channel: key });
			} catch (error) {
				pairing.push({ status: 'refused', channel: key, reason: messageOf(error) });
			}
		}
		return { pairing, residue };
	}

	/**
	 * Clear every layer's memory of the brick (KTD7) in one synchronous block: an await between
	 * two of these would let a scan finish in the gap and rebuild the brick from a layer not yet
	 * cleared. Discovery goes before the list, which a scan rebuilds from it.
	 */
	private forgetMemory(brickId: BrickId, keys: readonly BrickKey[]): MemoryOutcome {
		const failures: string[] = [];
		const attempt = (step: () => void): void => {
			try { step(); } catch (error) { failures.push(messageOf(error)); }
		};
		if (this.discovery) {
			attempt(() => this.discovery?.forget(keys));
		} else {
			// The list is rebuilt from discovery's tracked channels, so without this the next scan
			// brings the brick back as it was.
			failures.push('Discovery was not reachable, so it still tracks the brick\'s channels.');
		}
		attempt(() => this.aggregator.forget(brickId));
		for (const key of keys) {
			const mac = brickKeyTransport(key) === Transport.BT ? brickKeyId(key) : undefined;
			if (mac) { attempt(() => this.btPresence?.forget(mac)); }
			this.dropped.delete(key);
			this.probing.delete(key);
			this.probeFailuresReported.delete(key);
		}
		// Sign-out already did these; a sign-out that failed part-way may not have.
		this.forgetSignIn(brickId);
		this.recomputeRoute(brickId);
		return failures.length > 0 ? { status: 'failed', detail: failures.join('; ') } : { status: 'cleared' };
	}

	// ── Internal: names ─────────────────────────────────────────────

	/** Ask a channel's session for the brick's name and record it as confirmed. */
	private async readNameOverSession(key: BrickKey): Promise<void> {
		try {
			const reply = await this.sessionManager.send(key, { kind: 'info' });
			if (reply.kind === 'info') { this.aggregator.confirmName(brickIdOf(key), reply.displayName); }
		} catch {
			// The name stays what discovery said; the heartbeat deals with the link.
		}
	}

	/**
	 * Ask a brick that has just appeared for its name, without signing it in.
	 *
	 * Only where the transport offers a probe (USB), and only for a brick nobody is signed
	 * into: a signed-in brick's join reads the name itself, and a probe would hold the device
	 * the join is about to open.
	 */
	private probeName(key: BrickKey): void {
		const provider = this.registry.get(this.transportOf(key));
		if (!provider?.openProbe || this.probing.has(key)) { return; }
		if (this.signedIn.has(brickIdOf(key)) || this.sessionManager.getSession(key)) { return; }

		this.probing.add(key);
		void (async () => {
			try {
				const link = await provider.openProbe!(key);
				try {
					const channel = new PacketCommandChannel(
						(packet, options) => link.sendPacket(packet, options), provider.transport);
					const reply = await channel.execute({ kind: 'info' });
					if (reply.kind === 'info') { this.aggregator.confirmName(brickIdOf(key), reply.displayName); }
				} finally {
					await link.close();
				}
			} catch (error) {
				if (!this.probeFailuresReported.has(key)) {
					this.probeFailuresReported.add(key);
					this.log?.warn(`Could not read the name of ${channelLabel(this.aggregator, key)} without connecting; showing `
						+ `the USB descriptor's until it connects: ${error instanceof Error ? error.message : String(error)}`);
				}
			} finally {
				this.probing.delete(key);
			}
		})();
	}

	// ── Internal: routing ───────────────────────────────────────────

	private dropFromRouting(key: BrickKey): void {
		// A brick being forgotten loses its links on purpose, and the probe below would put a
		// lost one into reconnecting (KTD4).
		if (this.dropped.has(key) || this.forgetting.has(brickIdOf(key))) { return; }
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
