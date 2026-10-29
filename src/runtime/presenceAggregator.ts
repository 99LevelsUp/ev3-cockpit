import * as vscode from 'vscode';
import { BrickKey, PresenceState, DiscoveryItem } from '../contracts';
import { createTypedEvent, TypedEvent } from '../events';
import { DiscoveryScheduler, PresenceChangeEvent } from './discoveryScheduler';

// ── Events ──────────────────────────────────────────────────────────

export interface DiscoveryListChangeEvent {
	readonly items: ReadonlyArray<DiscoveryItem>;
}

// ── Aggregator ──────────────────────────────────────────────────────

/**
 * Unifies discovery output from the scheduler with remembered bricks from
 * persistence into a single discovery list.
 *
 * The aggregator is the single read model for the discovery list — both the
 * Cockpit UI and the public API consume it.
 *
 * It keeps a record of which bricks exist and what is currently true about each one. It does
 * not order them, and deliberately so: what belongs at the top of a list is a question about
 * the person reading it, not about discovery. A panel that wants the brick someone is
 * carrying to climb towards the top as they walk over sorts by signal; another view may want
 * something else entirely. Both are UI decisions, and neither is improved by this layer
 * having an opinion first.
 */
export class PresenceAggregator implements vscode.Disposable {
	private readonly items = new Map<BrickKey, DiscoveryItem>();

	private readonly listChanged: TypedEvent<DiscoveryListChangeEvent>;
	private readonly presenceChanged: TypedEvent<PresenceChangeEvent>;

	/** Fired whenever the discovery list changes (add, remove, state change). */
	readonly onListChanged: vscode.Event<DiscoveryListChangeEvent>;
	/** Fired on individual presence state transitions (forwarded from scheduler). */
	readonly onPresenceChanged: vscode.Event<PresenceChangeEvent>;

	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly scheduler: DiscoveryScheduler) {
		this.listChanged = createTypedEvent<DiscoveryListChangeEvent>();
		this.presenceChanged = createTypedEvent<PresenceChangeEvent>();
		this.onListChanged = this.listChanged.event;
		this.onPresenceChanged = this.presenceChanged.event;

		// Subscribe to scheduler events
		this.disposables.push(
			scheduler.onPresenceChanged(e => this.handlePresenceChange(e)),
			scheduler.onScanCompleted(() => this.rebuildFromScheduler()),
		);
	}

	// ── Read model ──────────────────────────────────────────────────

	/**
	 * The bricks currently known, in no particular order — sorting belongs to whoever is
	 * displaying them.
	 */
	getDiscoveryList(): ReadonlyArray<DiscoveryItem> {
		return [...this.items.values()];
	}

	/** Get a single brick's current state. */
	getBrick(brickKey: BrickKey): DiscoveryItem | undefined {
		return this.items.get(brickKey);
	}

	// ── Remembered bricks (from persistence) ────────────────────────

	/** Merge remembered bricks from persistence into the discovery list. */
	mergeRemembered(remembered: ReadonlyArray<DiscoveryItem>): void {
		for (const item of remembered) {
			if (!this.items.has(item.brickKey)) {
				// Enforce invariant: presenceState.Remembered always implies remembered === true.
				this.items.set(item.brickKey, {
					...item,
					presenceState: PresenceState.Remembered,
					remembered: true,
				});
			}
		}
		this.emitListChanged();
	}

	// ── Mutable operations for session manager ──────────────────────

	/** Update fields on a tracked brick (e.g. connected, favorite). */
	updateBrick(brickKey: BrickKey, patch: Partial<Pick<DiscoveryItem, 'connected' | 'favorite' | 'remembered'>>): void {
		const existing = this.items.get(brickKey);
		if (!existing) { return; }
		this.items.set(brickKey, { ...existing, ...patch });
		this.emitListChanged();
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	dispose(): void {
		for (const d of this.disposables) { d.dispose(); }
		this.disposables.length = 0;
		this.listChanged.dispose();
		this.presenceChanged.dispose();
		this.items.clear();
	}

	// ── Internals ───────────────────────────────────────────────────

	private handlePresenceChange(e: PresenceChangeEvent): void {
		if (e.currentState === PresenceState.Removed) {
			this.items.delete(e.brickKey);
		} else {
			this.items.set(e.brickKey, this.mergeLocalMetadata(e.brickKey, e.item));
		}
		this.presenceChanged.fire(e);
		this.emitListChanged();
	}

	private rebuildFromScheduler(): void {
		const tracked = this.scheduler.getTrackedBricks();
		for (const [key, item] of tracked) {
			this.items.set(key, this.mergeLocalMetadata(key, item));
		}
		this.emitListChanged();
	}

	/**
	 * Overlay incoming provider data with the metadata this list owns.
	 *
	 * These three fields are local state, not transport state: providers report them
	 * as plain `false` and only {@link updateBrick} is allowed to change them. The
	 * previous `existing.x ?? incoming.x` spelling read as "take the incoming value
	 * when the local one is unset", but all three are required booleans, so `??`
	 * never fell through and the local value always won. Same behaviour, stated
	 * outright instead of resting on a coincidence.
	 */
	private mergeLocalMetadata(brickKey: BrickKey, incoming: DiscoveryItem): DiscoveryItem {
		const existing = this.items.get(brickKey);
		if (!existing) { return incoming; }
		return {
			...incoming,
			remembered: existing.remembered,
			favorite: existing.favorite,
			connected: existing.connected,
		};
	}

	private emitListChanged(): void {
		this.listChanged.fire({ items: this.getDiscoveryList() });
	}
}
