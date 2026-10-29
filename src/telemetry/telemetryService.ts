/**
 * Decides which brick runs telemetry, and at what cadence.
 *
 * Two modes exist so far, and the distinction is the one the phase gate names (3.3.1,
 * 3.3.3, 3.3.4):
 *
 *  - **foreground** — the active brick. One loop, at the transport's measured cadence.
 *  - **minimal** — every other connected brick. No telemetry at all; the session's own
 *    heartbeat and reconnect keep running, which is what "minimal" means.
 *
 * The third mode, **subscribed**, needs the row-level subscription registry (3.3.5) and is
 * deliberately absent rather than stubbed: a mode that nothing can subscribe to would be a
 * branch no test could reach.
 *
 * **Why only one brick at a time gets telemetry.** Not a limitation of the loop — it is
 * that nothing yet asks for a second one. When subscriptions land, a brick with a live
 * subscription runs its own loop at the granted interval alongside the foreground one; the
 * per-brick queues already keep them from interfering.
 */

import * as vscode from 'vscode';

import { BrickCommand, BrickKey, BrickResponse, SendCommandOptions } from '../contracts';
import { brickKeyTransport } from '../contracts/brickKey';
import { ActivityMode, ConnectionState } from '../contracts/enums';
import { ProviderRegistry } from '../transports/providerRegistry';
import { BrickTelemetry, createBrickTelemetry } from './brickTelemetry';
import { RowValue, TelemetryRow } from './telemetryRow';

/** One brick's telemetry values, tagged with where they came from. */
export interface TelemetryValuesEvent {
	readonly brickKey: BrickKey;
	readonly values: readonly RowValue[];
}

/** A telemetry frame that failed, tagged with the brick whose loop produced it. */
export interface TelemetryErrorEvent {
	readonly brickKey: BrickKey;
	readonly error: unknown;
}

/**
 * What this service needs of a session manager.
 *
 * Narrow on purpose: a test drives it with an object literal, and the service cannot reach
 * for session internals it has no business touching.
 */
export interface TelemetryHost {
	send(
		brickKey: BrickKey,
		command: BrickCommand,
		options?: SendCommandOptions,
	): Promise<BrickResponse>;
	maxPacketBytes?(brickKey: BrickKey): number | undefined;
	getActiveBrickKey(): BrickKey | undefined;
	getSession(brickKey: BrickKey): { readonly connectionState: ConnectionState } | undefined;
	readonly onSessionStateChange: vscode.Event<{
		readonly brickKey: BrickKey;
		readonly newState: ConnectionState;
	}>;
	readonly onActiveBrickChange: vscode.Event<{
		readonly previousBrickKey: BrickKey | undefined;
		readonly newBrickKey: BrickKey | undefined;
	}>;
}

export interface TelemetryServiceOptions {
	readonly host: TelemetryHost;
	readonly providerRegistry: ProviderRegistry;
	/** Rows to drive. Defaults to the full EV3 catalogue. */
	readonly rows?: readonly TelemetryRow[];
	/** Overrides the transport's cadence. For tests and probes; production leaves it unset. */
	readonly tickPeriodMs?: number;
	readonly now?: () => number;
}

export class TelemetryService implements vscode.Disposable {
	private readonly loops = new Map<BrickKey, BrickTelemetry>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private disposed = false;

	private readonly _onValues = new vscode.EventEmitter<TelemetryValuesEvent>();
	readonly onValues = this._onValues.event;

	private readonly _onError = new vscode.EventEmitter<TelemetryErrorEvent>();
	readonly onError = this._onError.event;

	constructor(private readonly options: TelemetryServiceOptions) {
		const { host } = options;

		this.subscriptions.push(
			host.onActiveBrickChange((event) => {
				// Stop first. Two loops on one brick would each hold a frame in flight and
				// the queue would serve them in turn, doubling what telemetry costs.
				if (event.previousBrickKey) { this.stopFor(event.previousBrickKey); }
				this.reconcile(event.newBrickKey);
			}),
			host.onSessionStateChange((event) => {
				// Only the active brick's state is interesting: nothing else is running.
				if (event.brickKey !== host.getActiveBrickKey()) { return; }
				if (event.newState === ConnectionState.Connected) {
					this.reconcile(event.brickKey);
				} else {
					this.stopFor(event.brickKey);
				}
			}),
		);

		// A brick may already be active and connected when the service is built.
		this.reconcile(host.getActiveBrickKey());
	}

	/** The mode a brick is currently being driven in. */
	modeOf(brickKey: BrickKey): ActivityMode {
		if (this.loops.has(brickKey)) { return ActivityMode.Foreground; }
		return this.options.host.getSession(brickKey) === undefined
			? ActivityMode.None
			: ActivityMode.Minimal;
	}

	/** The running loop for a brick, for tests and hardware probes. */
	loopFor(brickKey: BrickKey): BrickTelemetry | undefined {
		return this.loops.get(brickKey);
	}

	dispose(): void {
		this.disposed = true;
		for (const brickKey of [...this.loops.keys()]) { this.stopFor(brickKey); }
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.subscriptions.length = 0;
		this._onValues.dispose();
		this._onError.dispose();
	}

	// ── Internal ────────────────────────────────────────────────────

	/** Starts the foreground loop for this brick if it can and should run one. */
	private reconcile(brickKey: BrickKey | undefined): void {
		if (this.disposed || !brickKey) { return; }
		if (this.loops.has(brickKey)) { return; }
		if (this.options.host.getSession(brickKey)?.connectionState !== ConnectionState.Connected) {
			return;
		}
		if (!this.servesFrames(brickKey)) { return; }

		const loop = createBrickTelemetry({
			sender: this.options.host,
			brickKey,
			rows: this.options.rows,
			tickPeriodMs: this.options.tickPeriodMs,
			now: this.options.now,
			onValues: (values) => this._onValues.fire({ brickKey, values }),
			onError: (error) => this._onError.fire({ brickKey, error }),
		});
		this.loops.set(brickKey, loop);
		loop.start();
	}

	private stopFor(brickKey: BrickKey): void {
		const loop = this.loops.get(brickKey);
		if (!loop) { return; }
		this.loops.delete(brickKey);
		loop.dispose();
	}

	/**
	 * Does this brick's transport execute composed frames?
	 *
	 * Read from the provider's declared capability rather than probed by sending one: a
	 * provider that cannot serve frames would otherwise announce itself as a thrown error
	 * on every tick, for as long as the brick stayed active.
	 */
	private servesFrames(brickKey: BrickKey): boolean {
		const transport = brickKeyTransport(brickKey);
		if (transport === undefined) { return false; }
		return this.options.providerRegistry.get(transport)
			?.capabilities.supportsTelemetryFrames === true;
	}
}
