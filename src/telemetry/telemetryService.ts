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
 * retired one's has settled (review of U5, round 2). The wait is bounded below: every transport
 * adapter times a send out (`SEND_TIMEOUT_MS`, 1–2 s) and rejects it when its link closes. A frame
 * that waited in the chain goes out only if its loop is still the brick's loop (a disposed service
 * has none); otherwise it fails without reaching the brick (round 3).
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
import { RowDescriptor, RowRegistry, createEv3RowRegistry } from './rowRegistry';
import { ClaimCadence, ClaimHandle, ClaimRequest, Grant, TelemetryClaims } from './telemetryClaims';
import { cadenceFor } from './telemetryConstants';
import { RowValue } from './telemetryRow';
import { ThrottleSettings, checkThrottleSettings } from './telemetrySettings';
import { ThrottleState, TickThrottle, typicalRoundTripMs } from './tickThrottle';

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

/**
 * Which rows a brick is read for now and how often each comes: the loop's tick times the row's
 * divider, `'once'` for a static row. Empty when the brick is not read. The read model learns
 * from it what is fresh and the effective interval it reports (D2, U6).
 */
export interface PlanChangeEvent {
	readonly brickKey: BrickRef;
	readonly intervals: ReadonlyMap<string, number | 'once'>;
}

/** A brick this service read has no session any more: whatever was read of it is gone (U6). */
export interface SessionEndedEvent {
	readonly brickKey: BrickRef;
}

/** A brick's throttle, as the diagnostic display shows it (3.4.5): the decision's numbers and the tick. */
export interface BrickThrottleState extends ThrottleState {
	/** The plan's tick, in milliseconds. */
	readonly basePeriodMs: number;
	/** The tick the loop runs at: the plan's times the factor. */
	readonly periodMs: number;
}

/** A brick's throttle moved its tick (U7). */
export interface ThrottleChangeEvent {
	readonly brickKey: BrickRef;
	readonly state: BrickThrottleState;
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
	/**
	 * How each brick's tick slows down when its round trips grow (U7); the user's settings. Absent,
	 * no brick is throttled.
	 */
	readonly throttle?: ThrottleSettings;
	readonly now?: () => number;
}

interface RunningLoop {
	readonly loop: BrickTelemetry;
	/** The plan's tick; the loop runs at it times the throttle's factor. */
	basePeriodMs: number;
	/** Absent while throttling has no settings. */
	throttle?: TickThrottle;
	/** This loop's identity: a frame waiting in the chain goes out only while it is the brick's loop. */
	readonly token: object;
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
	/** The plan last announced per brick, so a refresh that changed nothing announces nothing. */
	private readonly announced = new Map<BrickRef, ReadonlyMap<string, number | 'once'>>();
	/** Bricks read since their session began: the ones whose end is worth announcing. */
	private readonly read = new Set<BrickRef>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private nextHandle = 1;
	private disposed = false;
	private throttleSettings: ThrottleSettings | undefined;

	private readonly _onValues = new vscode.EventEmitter<TelemetryValuesEvent>();
	readonly onValues = this._onValues.event;

	private readonly _onError = new vscode.EventEmitter<TelemetryErrorEvent>();
	readonly onError = this._onError.event;

	private readonly _onClaimsEnded = new vscode.EventEmitter<ClaimsEndedEvent>();
	/** Claims that ended with their brick (4.5.4); the API's hook to tell their makers. */
	readonly onClaimsEnded = this._onClaimsEnded.event;

	private readonly _onPlanChange = new vscode.EventEmitter<PlanChangeEvent>();
	/** A brick's rows or their intervals changed; empty when it stops being read. */
	readonly onPlanChange = this._onPlanChange.event;

	private readonly _onSessionEnded = new vscode.EventEmitter<SessionEndedEvent>();
	/** A brick this service read has no session any more. */
	readonly onSessionEnded = this._onSessionEnded.event;

	private readonly _onThrottleChange = new vscode.EventEmitter<ThrottleChangeEvent>();
	/** A brick's throttle moved its tick. */
	readonly onThrottleChange = this._onThrottleChange.event;

	constructor(private readonly options: TelemetryServiceOptions) {
		const { host } = options;
		this.registry = options.registry ?? createEv3RowRegistry();
		this.throttleSettings = options.throttle;

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

	/** The rows a brick offers, as plain data: what a consumer can claim (U8, 4.5.1). */
	rows(): RowDescriptor[] {
		return this.registry.list();
	}

	/** What each brick is read for now, as last announced: for a reader attached after the loops started. */
	currentPlans(): ReadonlyMap<BrickRef, ReadonlyMap<string, number | 'once'>> {
		return this.announced;
	}

	/** A brick's throttle for the diagnostic display; undefined when it is not read or not throttled. */
	throttleOf(brickKey: BrickRef): BrickThrottleState | undefined {
		const running = this.loops.get(brickKey);
		return running?.throttle ? stateOf(running) : undefined;
	}

	/** New throttle settings apply at once to every brick. Throws, changing nothing, for settings out of range. */
	configureThrottle(settings: ThrottleSettings): void {
		checkThrottleSettings(settings);
		for (const [brickKey, running] of this.loops) {
			if (!running.throttle) {
				running.throttle = new TickThrottle(settings, typicalRoundTripMs(running.transport));
			} else if (running.throttle.configure(settings)) {
				this.applyThrottle(brickKey, running);
			}
		}
		this.throttleSettings = settings;
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
		this._onPlanChange.dispose();
		this._onSessionEnded.dispose();
		this._onThrottleChange.dispose();
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
		if (!wanted) {
			this.stopFor(brickKey);
			if (!this.hasSession(brickKey) && this.read.delete(brickKey)) {
				this._onSessionEnded.fire({ brickKey });
			}
			return;
		}

		const claims = this.claimsFor(brickKey);
		claims.setCadence(this.cadenceOf(transport));
		claims.setForeground(active);
		const plan = claims.plan();

		const running = this.loops.get(brickKey);
		if (running && running.transport === transport) {
			running.loop.setRows(plan.rows);
			running.basePeriodMs = plan.periodMs;
			// The brick's slowdown carries over to the new plan's tick.
			const period = plan.periodMs * (running.throttle?.factor ?? 1);
			if (running.loop.tickPeriodMs !== period) { running.loop.setPeriod(period); }
			this.announce(brickKey, intervalsOf(running.loop));
			return;
		}
		this.stopFor(brickKey);
		const token = {};
		const current = (): boolean => this.loops.get(brickKey)?.token === token;
		const loop = createBrickTelemetry({
			sender: this.senderFor(brickKey, current),
			brickKey,
			rows: plan.rows,
			tickPeriodMs: plan.periodMs,
			// The plan's floor, override included: retiming clamps to the same floor the plan used.
			floorMs: this.cadenceOf(transport).floorMs,
			now: this.options.now,
			onValues: (values) => { if (current()) { this._onValues.fire({ brickKey, values }); } },
			onRoundTrip: (ms) => { if (current()) { this.observe(brickKey, ms); } },
			// A retired loop's refused frame is not a failure anyone needs to hear about.
			onError: (error) => { if (current()) { this._onError.fire({ brickKey, error }); } },
		});
		this.loops.set(brickKey, {
			loop, transport, token, basePeriodMs: plan.periodMs,
			// A new loop is a new link: it starts unthrottled and learns this one's round trips.
			...(this.throttleSettings ? { throttle: new TickThrottle(this.throttleSettings, typicalRoundTripMs(transport)) } : {}),
		});
		this.read.add(brickKey);
		loop.start();
		this.announce(brickKey, intervalsOf(loop));
	}

	/** The host as one loop sees it: its sends chained behind the brick's last frame, from any loop. */
	private senderFor(brickKey: BrickRef, current: () => boolean): TelemetrySender {
		const { host } = this.options;
		return {
			send: (key, command, sendOptions) => {
				const go = (): Promise<BrickResponse> => {
					// Disposing the service stops every loop, so this covers a disposed service too.
					if (!current()) {
						return Promise.reject(new SubscriptionError(`Telemetry loop for ${brickKey} was retired before its frame went out.`));
					}
					return host.send(key, command, sendOptions);
				};
				// Nothing outstanding: out at once, as it was sent. Something outstanding: after it.
				const before = this.lastFrame.get(key);
				const frame = before ? before.then(go) : go();
				const settled = frame.then(() => undefined, () => undefined);
				this.lastFrame.set(key, settled);
				void settled.then(() => { if (this.lastFrame.get(key) === settled) { this.lastFrame.delete(key); } });
				return frame;
			},
			...(host.maxPacketBytes ? { maxPacketBytes: (key: BrickRef) => host.maxPacketBytes?.(key) } : {}),
			...(host.transportOf ? { transportOf: (key: BrickRef) => host.transportOf?.(key) } : {}),
		};
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
		this.announce(brickKey, new Map());
	}

	/** One frame's round trip, to its brick's throttle. */
	private observe(brickKey: BrickRef, ms: number): void {
		const running = this.loops.get(brickKey);
		if (running?.throttle?.observe(ms)) { this.applyThrottle(brickKey, running); }
	}

	/** Moves a loop's tick to the plan's times the factor, and says so: in the plan (D2) and to the display. */
	private applyThrottle(brickKey: BrickRef, running: RunningLoop): void {
		const period = running.basePeriodMs * (running.throttle?.factor ?? 1);
		if (running.loop.tickPeriodMs !== period) { running.loop.setPeriod(period); }
		this.announce(brickKey, intervalsOf(running.loop));
		this._onThrottleChange.fire({ brickKey, state: stateOf(running) });
	}

	/** Tells the read model what a brick is read for now, if that differs from what it was last told. */
	private announce(brickKey: BrickRef, intervals: ReadonlyMap<string, number | 'once'>): void {
		const before = this.announced.get(brickKey) ?? new Map<string, number | 'once'>();
		if (sameIntervals(before, intervals)) { return; }
		if (intervals.size === 0) { this.announced.delete(brickKey); } else { this.announced.set(brickKey, intervals); }
		this._onPlanChange.fire({ brickKey, intervals });
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

/** How often each row of a loop comes now: its divider times the loop's tick, `'once'` for a one-shot. */
function intervalsOf(loop: BrickTelemetry): Map<string, number | 'once'> {
	const intervals = new Map<string, number | 'once'>();
	for (const row of loop.rows) {
		if (row.lifetime.kind === 'repeating') { intervals.set(row.id, row.lifetime.divider * loop.tickPeriodMs); }
		if (row.lifetime.kind === 'oneShot') { intervals.set(row.id, 'once'); }
	}
	return intervals;
}

function sameIntervals(a: ReadonlyMap<string, number | 'once'>, b: ReadonlyMap<string, number | 'once'>): boolean {
	if (a.size !== b.size) { return false; }
	for (const [id, interval] of a) { if (b.get(id) !== interval) { return false; } }
	return true;
}

function stateOf(running: RunningLoop): BrickThrottleState {
	return {
		...(running.throttle?.state() ?? { factor: 1, limitMs: 0, stalls: 0, windowSamples: 0 }),
		basePeriodMs: running.basePeriodMs,
		periodMs: running.loop.tickPeriodMs,
	};
}
