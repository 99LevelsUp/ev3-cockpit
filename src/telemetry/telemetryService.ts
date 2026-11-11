/**
 * Decides which bricks run telemetry, which rows each reads and at what cadence (step-6 plan U5;
 * IMPLEMENTATION_PLAN 3.3.1–3.3.5, 3.1.10; DESIGN §9.1–§9.4).
 *
 * Three modes, one per brick:
 *
 *  - **foreground** — the active brick, read for the cockpit's panel: every row, at the
 *    transport's foreground cadence.
 *  - **subscribed** — a connected brick that is not active but that a consumer claimed rows of:
 *    only those rows, at the interval each was granted.
 *  - **minimal** — every other connected brick. No telemetry; the session's heartbeat and
 *    reconnect keep running, which is what "minimal" means.
 *
 * **One loop per brick.** The foreground is a claim like the others (`TelemetryClaims`), so the
 * loop's rows and tick come from one plan: the active brick changing re-plans a running loop
 * instead of restarting it. A restart would read every static row again and settle every port
 * afresh. Only a change of transport restarts a loop, because a loop is built for one link's
 * cadence. Every event funnels into one {@link TelemetryService.refresh}, which works out what a
 * brick should be doing from the host's state rather than from the event that woke it.
 *
 * **Claims outlive a lost link and end with the session.** While a brick reconnects its loop
 * stops and its claims wait; when the brick is disconnected or signed out they end, and
 * {@link TelemetryService.onClaimsEnded} names them so the API can tell its consumers (4.5.4).
 *
 * **One telemetry frame per brick at a time, across loops.** A loop holds one frame in flight, but
 * a restarted loop is a new loop: the retired one's frame may still be on its way over the old
 * link, and if it commands a sensor mode it would switch the device behind the new loop's back.
 * Every loop of a brick sends through one chain, so a new loop's first frame waits until the
 * retired one's has settled (review of U5, round 2).
 *
 * **A grant is fixed when the claim is made** (D2): the request clamped to the floor. What a row
 * really runs at — slower after a route change or under throttling — travels in the data.
 */

import * as vscode from 'vscode';

import { BrickCommand, BrickRef, BrickResponse, SendCommandOptions, Transport } from '../contracts';
import { ActivityMode, ConnectionState } from '../contracts/enums';
import { NotConnectedError, SubscriptionError } from '../errors/CockpitError';
import { ProviderRegistry } from '../transports/providerRegistry';
import { BrickTelemetry, TelemetrySender, createBrickTelemetry, transportFor } from './brickTelemetry';
import { RowRegistry, createEv3RowRegistry } from './rowRegistry';
import { ClaimCadence, ClaimHandle, ClaimRequest, Grant, TelemetryClaims } from './telemetryClaims';
import { cadenceFor } from './telemetryConstants';
import { RowValue } from './telemetryRow';

/** One brick's telemetry values, tagged with where they came from. */
export interface TelemetryValuesEvent {
	readonly brickKey: BrickRef;
	readonly values: readonly RowValue[];
}

/** A telemetry frame that failed, tagged with the brick whose loop produced it. */
export interface TelemetryErrorEvent {
	readonly brickKey: BrickRef;
	readonly error: unknown;
}

/** A claim as its maker holds it: the handle to release it by and what each row was granted. */
export interface TelemetryClaimTicket {
	readonly handle: string;
	readonly grant: Grant;
}

/** Claims that ended because their brick went, not because their makers released them. */
export interface ClaimsEndedEvent {
	readonly brickKey: BrickRef;
	readonly handles: readonly string[];
}

/**
 * What this service needs of a session manager.
 *
 * Narrow on purpose: a test drives it with an object literal, and the service cannot reach
 * for session internals it has no business touching.
 */
export interface TelemetryHost {
	send(
		brickKey: BrickRef,
		command: BrickCommand,
		options?: SendCommandOptions,
	): Promise<BrickResponse>;
	maxPacketBytes?(brickKey: BrickRef): number | undefined;
	/** See {@link TelemetrySender.transportOf}. */
	transportOf?(brickKey: BrickRef): Transport | undefined;
	getActiveBrickKey(): BrickRef | undefined;
	getSession(brickKey: BrickRef): { readonly connectionState: ConnectionState } | undefined;
	readonly onSessionStateChange: vscode.Event<{
		readonly brickKey: BrickRef;
		readonly newState: ConnectionState;
	}>;
	readonly onActiveBrickChange: vscode.Event<{
		readonly previousBrickKey: BrickRef | undefined;
		readonly newBrickKey: BrickRef | undefined;
	}>;
	/**
	 * Fired when a brick's traffic moves to another channel.
	 *
	 * The loop's cadence belongs to the transport it started on, so a loop whose transport
	 * changed restarts: one that began at USB's 100 ms would otherwise keep that period over
	 * Bluetooth, whose floor is 250 ms, and crowd out every other command.
	 */
	readonly onRouteChange?: vscode.Event<{ readonly brickKey: BrickRef }>;
}

export interface TelemetryServiceOptions {
	readonly host: TelemetryHost;
	readonly providerRegistry: ProviderRegistry;
	/** The rows a brick offers. Defaults to the EV3 catalogue. */
	readonly registry?: RowRegistry;
	/**
	 * Overrides the foreground cadence, below the transport's floor if need be. For tests and
	 * probes; production leaves it unset.
	 */
	readonly tickPeriodMs?: number;
	readonly now?: () => number;
}

interface RunningLoop {
	readonly loop: BrickTelemetry;
	/** The transport the loop was built for; another one restarts it. */
	readonly transport: Transport | undefined;
}

export class TelemetryService implements vscode.Disposable {
	private readonly loops = new Map<BrickRef, RunningLoop>();
	/** Each brick's claims, kept apart from its loop so they outlive a lost link. */
	private readonly claims = new Map<BrickRef, TelemetryClaims>();
	/** The service's handles, unique across bricks: each brick's registry counts its own. */
	private readonly handles = new Map<string, { readonly brickKey: BrickRef; readonly inner: ClaimHandle }>();
	private readonly registry: RowRegistry;
	/** Each brick's last telemetry frame, settled or not: the next one, from any loop, goes after it. */
	private readonly lastFrame = new Map<BrickRef, Promise<unknown>>();
	/** The host as the loops see it: sends chained per brick. */
	private readonly sender: TelemetrySender;
	private readonly subscriptions: vscode.Disposable[] = [];
	private nextHandle = 1;
	private disposed = false;

	private readonly _onValues = new vscode.EventEmitter<TelemetryValuesEvent>();
	readonly onValues = this._onValues.event;

	private readonly _onError = new vscode.EventEmitter<TelemetryErrorEvent>();
	readonly onError = this._onError.event;

	private readonly _onClaimsEnded = new vscode.EventEmitter<ClaimsEndedEvent>();
	/** Claims that ended with their brick (4.5.4); the API's hook to tell their makers. */
	readonly onClaimsEnded = this._onClaimsEnded.event;

	constructor(private readonly options: TelemetryServiceOptions) {
		const { host } = options;
		this.registry = options.registry ?? createEv3RowRegistry();
		this.sender = {
			send: (brickKey, command, sendOptions) => {
				const before = this.lastFrame.get(brickKey) ?? Promise.resolve();
				const frame = before.then(() => host.send(brickKey, command, sendOptions));
				this.lastFrame.set(brickKey, frame.catch(() => undefined));
				return frame;
			},
			...(host.maxPacketBytes ? { maxPacketBytes: (brickKey: BrickRef) => host.maxPacketBytes?.(brickKey) } : {}),
			...(host.transportOf ? { transportOf: (brickKey: BrickRef) => host.transportOf?.(brickKey) } : {}),
		};

		this.subscriptions.push(
			host.onActiveBrickChange((event) => {
				this.refresh(event.previousBrickKey);
				this.refresh(event.newBrickKey);
			}),
			host.onSessionStateChange((event) => this.refresh(event.brickKey)),
			...(host.onRouteChange ? [host.onRouteChange((event) => this.refresh(event.brickKey))] : []),
		);

		// A brick may already be active and connected when the service is built.
		this.refresh(host.getActiveBrickKey());
	}

	/** The mode a brick is currently being driven in. */
	modeOf(brickKey: BrickRef): ActivityMode {
		if (this.loops.has(brickKey)) {
			return brickKey === this.options.host.getActiveBrickKey()
				? ActivityMode.Foreground
				: ActivityMode.Subscribed;
		}
		return this.hasSession(brickKey) ? ActivityMode.Minimal : ActivityMode.None;
	}

	/** The running loop for a brick, for tests and hardware probes. */
	loopFor(brickKey: BrickRef): BrickTelemetry | undefined {
		return this.loops.get(brickKey)?.loop;
	}

	/**
	 * Claims rows of a brick, or throws and claims nothing.
	 *
	 * Refused for a brick that has no session, and for one whose link cannot carry telemetry
	 * frames: such a claim would never be read and nobody would hear why. A brick reconnecting
	 * has no link to judge yet; its claim is taken and read when the link is back.
	 */
	claim(brickKey: BrickRef, request: ClaimRequest, owner: string): TelemetryClaimTicket {
		if (this.disposed) { throw new SubscriptionError('Telemetry has been shut down.'); }
		if (!this.hasSession(brickKey)) {
			throw new NotConnectedError(`Brick ${brickKey} is not connected; telemetry can be claimed of a connected brick only.`);
		}
		const transport = transportFor(this.options.host, brickKey);
		if (transport !== undefined && !this.servesFrames(transport)) {
			throw new SubscriptionError(`Brick ${brickKey} is connected over a link that does not carry telemetry.`);
		}
		const claims = this.claimsFor(brickKey);
		// The grant is fixed now, so against the floor of the link the brick is on now: the registry
		// keeps the cadence of its last plan, which a brick nobody read since may have left behind.
		if (transport !== undefined) { claims.setCadence(this.cadenceOf(transport)); }
		const { handle: inner } = claims.claim(request, owner);
		const handle = `telemetry-${this.nextHandle++}`;
		this.handles.set(handle, { brickKey, inner });
		this.refresh(brickKey);
		return { handle, grant: claims.grantOf(inner) as Grant };
	}

	/** Releases one claim; releasing it again, or after its brick went, does nothing. */
	release(handle: string): void {
		const entry = this.handles.get(handle);
		if (!entry) { return; }
		this.handles.delete(handle);
		this.claims.get(entry.brickKey)?.release(entry.inner);
		this.refresh(entry.brickKey);
	}

	/** What each row of a claim was granted; undefined once the claim has ended. */
	grantOf(handle: string): Grant | undefined {
		const entry = this.handles.get(handle);
		return entry ? this.claims.get(entry.brickKey)?.grantOf(entry.inner) : undefined;
	}

	dispose(): void {
		this.disposed = true;
		for (const brickKey of [...this.loops.keys()]) { this.stopFor(brickKey); }
		this.claims.clear();
		this.handles.clear();
		this.lastFrame.clear();
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.subscriptions.length = 0;
		this._onValues.dispose();
		this._onError.dispose();
		this._onClaimsEnded.dispose();
	}

	// ── Internal ────────────────────────────────────────────────────

	/**
	 * Brings one brick's telemetry in line with the host's state: ends its claims if its session
	 * went, runs a loop if it is connected and someone wants it read, and gives that loop the
	 * rows and tick the claims plan. Safe to call for any brick, any number of times.
	 */
	private refresh(brickKey: BrickRef | undefined): void {
		if (this.disposed || brickKey === undefined) { return; }
		const { host } = this.options;
		if (!this.hasSession(brickKey)) { this.endClaims(brickKey); }

		const active = brickKey === host.getActiveBrickKey();
		const transport = transportFor(host, brickKey);
		const wanted = host.getSession(brickKey)?.connectionState === ConnectionState.Connected
			&& transport !== undefined && this.servesFrames(transport)
			&& (active || this.claims.get(brickKey)?.hasClaims() === true);
		if (!wanted) { this.stopFor(brickKey); return; }

		const claims = this.claimsFor(brickKey);
		claims.setCadence(this.cadenceOf(transport));
		claims.setForeground(active);
		const plan = claims.plan();

		const running = this.loops.get(brickKey);
		if (running && running.transport === transport) {
			running.loop.setRows(plan.rows);
			if (running.loop.tickPeriodMs !== plan.periodMs) { running.loop.setPeriod(plan.periodMs); }
			return;
		}
		this.stopFor(brickKey);
		const loop = createBrickTelemetry({
			sender: this.sender,
			brickKey,
			rows: plan.rows,
			tickPeriodMs: plan.periodMs,
			// The plan's floor, override included: retiming clamps to the same floor the plan used.
			floorMs: this.cadenceOf(transport).floorMs,
			now: this.options.now,
			onValues: (values) => this._onValues.fire({ brickKey, values }),
			onError: (error) => this._onError.fire({ brickKey, error }),
		});
		this.loops.set(brickKey, { loop, transport });
		loop.start();
	}

	private hasSession(brickKey: BrickRef): boolean {
		const state = this.options.host.getSession(brickKey)?.connectionState;
		return state !== undefined && state !== ConnectionState.Disconnected;
	}

	private claimsFor(brickKey: BrickRef): TelemetryClaims {
		let claims = this.claims.get(brickKey);
		if (!claims) {
			claims = new TelemetryClaims(this.registry, this.cadenceOf(transportFor(this.options.host, brickKey)));
			this.claims.set(brickKey, claims);
		}
		return claims;
	}

	/** The transport's cadence, with the foreground override probes use. */
	private cadenceOf(transport: Transport | undefined): ClaimCadence {
		const cadence = cadenceFor(transport);
		const override = this.options.tickPeriodMs;
		return override === undefined
			? cadence
			: { foregroundMs: override, floorMs: Math.min(override, cadence.floorMs) };
	}

	/** Ends every claim on a brick whose session went, and says which ended. */
	private endClaims(brickKey: BrickRef): void {
		const claims = this.claims.get(brickKey);
		if (!claims) { return; }
		this.claims.delete(brickKey);
		const ended = new Set(claims.endAll());
		const handles: string[] = [];
		for (const [handle, entry] of this.handles) {
			if (entry.brickKey === brickKey && ended.has(entry.inner)) {
				handles.push(handle);
				this.handles.delete(handle);
			}
		}
		if (handles.length > 0) { this._onClaimsEnded.fire({ brickKey, handles }); }
	}

	private stopFor(brickKey: BrickRef): void {
		const running = this.loops.get(brickKey);
		if (!running) { return; }
		this.loops.delete(brickKey);
		running.loop.dispose();
	}

	/**
	 * Does this transport execute composed frames?
	 *
	 * Read from the provider's declared capability rather than probed by sending one: a
	 * provider that cannot serve frames would otherwise announce itself as a thrown error
	 * on every tick, for as long as the brick stayed active.
	 */
	private servesFrames(transport: Transport): boolean {
		return this.options.providerRegistry.get(transport)
			?.capabilities.supportsTelemetryFrames === true;
	}
}
