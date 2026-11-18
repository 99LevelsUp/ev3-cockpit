/**
 * Binds the telemetry scheduler to one connected brick.
 *
 * The scheduler composes frames and decides when to send them; it does not know how to
 * reach a brick. This is the join: frames go out as `telemetry:frame` through the session's
 * own command queue, which is the whole point of the exercise (3.3).
 *
 * **Why the queue rather than the transport.** A frame that went straight to `sendPacket`
 * would run *beside* the heartbeat instead of interleaving with it — two writers on one
 * serial link, each unaware of the other's outstanding command. The queue is what makes the
 * heartbeat, the user's commands and a telemetry tick take turns. The scheduler's
 * one-frame-in-flight rule then bounds what telemetry can add to that queue to exactly one
 * entry, so a stalled brick delays a sample rather than growing a backlog that eventually
 * starves the heartbeat and trips reconnect on a brick that is merely busy.
 */

import { BrickCommand, BrickRef, BrickResponse, SendCommandOptions, Transport, describeChannel } from '../contracts';
import { brickKeyTransport } from '../contracts/brickKey';
import { maxPacketBytesFor } from '../fs/brickFilesystem';
import { FIRMWARE_BUFFER_BYTES } from '../protocol/ev3Commands';
import { FrameLimits } from './frameAssembler';
import { createEv3RowRegistry } from './rowRegistry';
import { RowValue, TelemetryRow } from './telemetryRow';
import { SchedulerStats, TelemetryScheduler } from './telemetryScheduler';
import { cadenceFor } from './telemetryConstants';

/** What this module needs of a session manager. Narrow, so a test can stand in for one. */
export interface TelemetrySender {
	send(
		brickKey: BrickRef,
		command: BrickCommand,
		options?: SendCommandOptions,
	): Promise<BrickResponse>;

	/** Largest packet the live link carries, when the sender knows. */
	maxPacketBytes?(brickKey: BrickRef): number | undefined;

	/**
	 * The transport a brick's traffic goes over now.
	 *
	 * For a sender addressed by brick, where the key names no transport and the answer
	 * moves with the route. Omitted, the transport is read from the key.
	 */
	transportOf?(brickKey: BrickRef): Transport | undefined;
}

/** The transport behind a key: the sender's answer when it routes, else the key's own. */
export function transportFor(sender: TelemetrySender, brickKey: BrickRef): Transport | undefined {
	return sender.transportOf?.(brickKey) ?? brickKeyTransport(brickKey);
}

export interface BrickTelemetryOptions {
	readonly sender: TelemetrySender;
	readonly brickKey: BrickRef;
	/** Rows to drive. Defaults to the full EV3 catalogue. */
	readonly rows?: readonly TelemetryRow[];
	/** Tick period in ms. Defaults to the transport's foreground cadence (DESIGN §9.2). */
	readonly tickPeriodMs?: number;
	/** The fastest period `setPeriod` grants. Defaults to the transport's floor; probes go below it. */
	readonly floorMs?: number;
	readonly onValues?: (values: readonly RowValue[]) => void;
	readonly onError?: (error: unknown) => void;
	/**
	 * Each frame's round trip, from handing it to the sender to its answer or failure, in ms: the
	 * throttle's input (U7). Queue wait is included on purpose — a brick busy with a transfer is a
	 * brick to slow down for.
	 */
	readonly onRoundTrip?: (ms: number) => void;
	readonly now?: () => number;
}

/**
 * A telemetry loop for one brick.
 *
 * `runTick` is exposed alongside `start`/`stop` so a test or a hardware probe can drive
 * ticks by hand without waiting on a timer.
 */
export interface BrickTelemetry {
	start(): void;
	stop(): void;
	dispose(): void;
	runTick(): Promise<void>;
	readonly stats: SchedulerStats;
	/** Tick period this loop actually runs at, in milliseconds. */
	readonly tickPeriodMs: number;
	/** The rows this loop reads now. */
	readonly rows: readonly TelemetryRow[];
	/** Changes the period, clamped to the transport's floor; returns the period granted. */
	setPeriod(ms: number): number;
	/** Replaces the rows while running (KTD2). */
	setRows(rows: readonly TelemetryRow[]): void;
}

/**
 * Resolves the packet budget for a brick's *current* link.
 *
 * Called on every tick rather than once, because the answer changes under a session that
 * does not: `attemptReconnect` reuses its `SessionResources` and rewires the executor, so a
 * USB brick that comes back on the HID fallback is the same session on a link a sixteenth
 * the size. Asked once at construction, this would keep composing 1024-byte frames for a
 * 64-byte link — and the firmware would answer the truncated request rather than complain.
 */
export function frameLimitsFor(
	sender: TelemetrySender,
	brickKey: BrickRef,
): FrameLimits {
	const live = sender.maxPacketBytes?.(brickKey);
	const fallback = maxPacketBytesFor(transportFor(sender, brickKey));
	return { maxPacketBytes: live ?? fallback ?? FIRMWARE_BUFFER_BYTES };
}

/**
 * Creates the telemetry loop for one connected brick.
 *
 * Does not start it: who runs telemetry and when is the service's decision (3.3.4), not
 * this function's.
 */
export function createBrickTelemetry(options: BrickTelemetryOptions): BrickTelemetry {
	const { sender, brickKey } = options;
	// Fixed for the loop's life: a route change restarts the loop rather than retiming it.
	const transport = transportFor(sender, brickKey);
	const tickPeriodMs = options.tickPeriodMs ?? cadenceFor(transport).foregroundMs;
	const floorMs = options.floorMs ?? cadenceFor(transport).floorMs;

	const scheduler = new TelemetryScheduler({
		// Through the registry, so every row was validated against the tightest link (3.1.6).
		rows: options.rows ?? createEv3RowRegistry().all(),
		limits: () => frameLimitsFor(sender, brickKey),
		send: async (payload) => {
			const now = options.now ?? Date.now;
			const started = now();
			let response: BrickResponse;
			try {
				response = await sender.send(brickKey, { kind: 'telemetry:frame', payload });
			} finally {
				options.onRoundTrip?.(now() - started);
			}
			if (response.kind !== 'telemetry:frame') {
				// The queue answered a different command than the one that went in, which
				// means the counter-to-reply pairing is wrong somewhere below. Coercing it
				// would hand the row parser a buffer laid out by somebody else's frame and
				// produce readings that look plausible and came from nowhere.
				throw new Error(
					`Telemetry frame for ${describeChannel(brickKey)} came back as '${response.kind}'.`
				);
			}
			return response.payload;
		},
		tickPeriodMs,
		onValues: options.onValues,
		onError: options.onError,
		now: options.now,
	});

	return {
		start: () => scheduler.start(),
		stop: () => scheduler.stop(),
		dispose: () => scheduler.dispose(),
		runTick: () => scheduler.runTick(),
		get stats() { return scheduler.stats; },
		get tickPeriodMs() { return scheduler.tickPeriodMs; },
		get rows() { return scheduler.currentRows; },
		setPeriod: (ms: number) => {
			const granted = Math.max(ms, floorMs);
			scheduler.setPeriod(granted);
			return granted;
		},
		setRows: (rows) => scheduler.setRows(rows),
	};
}
