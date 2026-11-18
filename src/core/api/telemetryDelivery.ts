/**
 * One delivery order for every telemetry subscription on the API (step-6 plan U8, review round 3).
 *
 * Three review rounds in a row found the same kind of defect: a listener reacting to one update
 * could make some subscription hear a newer update before an older one, or lose one. Each round
 * patched a single subscription's own ordering; the third found it across subscriptions, where no
 * single subscription can see the order. The order belongs to the stream of events, so one owner
 * keeps it here:
 *
 * - An event from the telemetry source is queued for the subscriptions that exist **when it
 *   happens**. A subscription made later hears it in its snapshot, not again.
 * - Updates go out only from the drain, never from inside the source's own dispatch, so whatever a
 *   listener causes — another change, the end of a brick, a new subscription — joins the end of the
 *   queue, behind everything that happened before it.
 * - A subscription's snapshot is queued at its claim, so it comes before anything after the claim.
 * - Delivery is asynchronous: the drain starts in a microtask, after the call that queued the first
 *   update has returned (4.5.2). One drain tells only what was queued when it began; anything queued
 *   meanwhile waits for the next turn of the event loop, so a listener whose every update causes
 *   another cannot freeze the extension host.
 */

import type { BrickId } from '../contracts';
import type { ReadModelChange, ReadValue } from '../telemetry/telemetryReadModel';
import type { Subscription, TelemetryUpdate, TelemetryValue } from './cockpitApi';

/** What the delivery listens to: the read model's changes and the claims that ended with their brick. */
export interface TelemetrySource {
	onChange(listener: (change: ReadModelChange) => void): Subscription;
	onClaimsEnded(listener: (event: { readonly brickKey: string; readonly handles: readonly string[] }) => void): Subscription;
}

/** One subscription as the delivery sees it. */
export interface DeliveryTarget {
	readonly brickId: BrickId;
	/** The claim behind it, so a claim that ended with its brick ends exactly this subscription. */
	readonly handle: string;
	readonly rows: ReadonlySet<string>;
	/** Told every update in order; a throw is the listener's own and stops nothing else. */
	readonly listener: (update: TelemetryUpdate) => void;
	/** Named in the warning when the listener throws. */
	readonly owner: string;
	/** Called once, when `ended` has been told. */
	readonly onEnded: () => void;
}

/** A subscription's place in the delivery. */
export interface DeliveryHandle {
	/**
	 * Stops telling it anything, including what is already queued.
	 *
	 * @returns Whether its claim is still held — false once the claim ended with its brick, or when
	 *   already closed — so the caller releases a claim at most once and never one already gone.
	 */
	close(): boolean;
}

/** A read model value as plain data, with only the fields it has. */
export function toTelemetryValue(value: ReadValue): TelemetryValue {
	return {
		rowId: value.rowId,
		value: value.value,
		...(value.unit !== undefined ? { unit: value.unit } : {}),
		...(value.mode !== undefined ? { mode: value.mode } : {}),
		sampledAt: value.sampledAt,
		...(value.effectiveIntervalMs !== undefined ? { effectiveIntervalMs: value.effectiveIntervalMs } : {}),
		stale: value.stale,
	};
}

/**
 * live: hears what happens; ending: its claim ended with the brick, `ended` is queued and nothing
 * more joins it; done: closed or told `ended`, hears nothing.
 */
type State = 'live' | 'ending' | 'done';

interface Recipient {
	readonly target: DeliveryTarget;
	state: State;
}

export class TelemetryDelivery implements Subscription {
	/** In the order they were opened, so one event reaches them in a stable order. */
	private readonly recipients = new Set<Recipient>();
	private readonly queue: { readonly to: Recipient; readonly update: TelemetryUpdate }[] = [];
	private scheduled = false;
	private disposed = false;
	private readonly sources: Subscription[];

	constructor(source: TelemetrySource, private readonly warn: (message: string) => void) {
		this.sources = [
			source.onChange((change) => this.changed(change)),
			source.onClaimsEnded((event) => this.claimsEnded(event.brickKey, event.handles)),
		];
	}

	/**
	 * Starts telling `target`: `snapshot` first, then every change after it.
	 *
	 * Call it straight after the claim, with `snapshot` taken straight after the claim too and
	 * nothing in between, so the snapshot holds everything that happened up to here and the queue
	 * everything after.
	 */
	open(target: DeliveryTarget, snapshot: readonly TelemetryValue[]): DeliveryHandle {
		const recipient: Recipient = { target, state: this.disposed ? 'done' : 'live' };
		if (recipient.state === 'live') {
			this.recipients.add(recipient);
			this.enqueue(recipient, { brickId: target.brickId, kind: 'snapshot', values: snapshot, removed: [] });
		}
		return {
			close: () => {
				const held = recipient.state === 'live';
				recipient.state = 'done';
				this.recipients.delete(recipient);
				return held;
			},
		};
	}

	/** Stops listening to the source; nothing more is told. */
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		for (const source of this.sources) { source.dispose(); }
		for (const recipient of this.recipients) { recipient.state = 'done'; }
		this.recipients.clear();
		this.queue.length = 0;
	}

	private changed(change: ReadModelChange): void {
		for (const recipient of this.recipients) {
			const { brickId, rows } = recipient.target;
			if (change.brickKey !== brickId) { continue; }
			const values = change.rows.filter((row) => rows.has(row.rowId)).map(toTelemetryValue);
			const removed = change.removed.filter((id) => rows.has(id));
			if (values.length > 0 || removed.length > 0) {
				this.enqueue(recipient, { brickId, kind: 'change', values, removed });
			}
		}
	}

	private claimsEnded(brickKey: string, handles: readonly string[]): void {
		for (const recipient of [...this.recipients]) {
			const { brickId, handle } = recipient.target;
			if (brickKey !== brickId || !handles.includes(handle)) { continue; }
			// From here the claim is gone: nothing more joins this subscription, and closing it
			// releases nothing.
			recipient.state = 'ending';
			this.recipients.delete(recipient);
			this.enqueue(recipient, { brickId, kind: 'ended', values: [], removed: [] });
		}
	}

	private enqueue(to: Recipient, update: TelemetryUpdate): void {
		this.queue.push({ to, update });
		if (!this.scheduled) {
			this.scheduled = true;
			queueMicrotask(() => this.drain());
		}
	}

	private drain(): void {
		// Only what was queued when this drain began; the rest waits for the next turn.
		const batch = this.queue.splice(0);
		for (const { to, update } of batch) {
			if (to.state === 'done') { continue; }
			if (update.kind === 'ended') {
				to.state = 'done';
				to.target.onEnded();
			}
			try {
				to.target.listener(update);
			} catch (error) {
				this.warn(`Telemetry listener of ${to.target.owner} threw: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (this.queue.length > 0) {
			setImmediate(() => this.drain());
		} else {
			this.scheduled = false;
		}
	}
}
