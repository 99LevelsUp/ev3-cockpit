import * as vscode from 'vscode';
import {
	Transport, BrickKey, PresenceState, DiscoveryItem,
} from '../contracts';
import { createTypedEvent, TypedEvent } from '../events';
import { DiscoveryScheduler, PresenceChangeEvent } from './discoveryScheduler';

// ── Ordering ────────────────────────────────────────────────────────

const TRANSPORT_ORDER: Record<Transport, number> = {
	[Transport.Mock]: 0,
	[Transport.USB]: 1,
	[Transport.TCP]: 2,
	[Transport.BT]: 3,
};

function compareItems(a: DiscoveryItem, b: DiscoveryItem): number {
	const groupDiff = TRANSPORT_ORDER[a.transport] - TRANSPORT_ORDER[b.transport];
	if (groupDiff !== 0) { return groupDiff; }

	// Within a group: by signal strength descending (if available), then by brickKey
	const aSignal = a.signalInfo?.rssi ?? -Infinity;
	const bSignal = b.signalInfo?.rssi ?? -Infinity;
	if (aSignal !== bSignal) { return bSignal - aSignal; }

	return (a.brickKey as string).localeCompare(b.brickKey as string);
}

// ── Events ──────────────────────────────────────────────────────────

export interface DiscoveryListChangeEvent {
	readonly items: ReadonlyArray<DiscoveryItem>;
}

// ── Aggregator ──────────────────────────────────────────────────────

/**
 * Unifies discovery output from the scheduler with remembered bricks from
 * persistence into a single, stably-ordered discovery list.
 *
 * The aggregator is the single read model for the discovery list — both the
 * Cockpit UI and the public API consume it.
 */
export class PresenceAggregator implements vscode.Disposable {
	private readonly items = new Map<BrickKey, DiscoveryItem>();
	private sortedCache: DiscoveryItem[] | null = null;

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

	/** Get the current discovery list, stably ordered. */
	getDiscoveryList(): ReadonlyArray<DiscoveryItem> {
		if (!this.sortedCache) {
			this.sortedCache = [...this.items.values()].sort(compareItems);
		}
		return this.sortedCache;
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
		this.invalidateCache();
		this.emitListChanged();
	}

	// ── Mutable operations for session manager ──────────────────────

	/** Update fields on a tracked brick (e.g. connected, favorite). */
	updateBrick(brickKey: BrickKey, patch: Partial<Pick<DiscoveryItem, 'connected' | 'favorite' | 'remembered'>>): void {
		const existing = this.items.get(brickKey);
		if (!existing) { return; }
		this.items.set(brickKey, { ...existing, ...patch });
		this.invalidateCache();
		this.emitListChanged();
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	dispose(): void {
		for (const d of this.disposables) { d.dispose(); }
		this.disposables.length = 0;
		this.listChanged.dispose();
		this.presenceChanged.dispose();
		this.items.clear();
		this.sortedCache = null;
	}

	// ── Internals ───────────────────────────────────────────────────

	private handlePresenceChange(e: PresenceChangeEvent): void {
		if (e.currentState === PresenceState.Removed) {
			this.items.delete(e.brickKey);
		} else {
			const existing = this.items.get(e.brickKey);
			this.items.set(e.brickKey, {
				...e.item,
				// Preserve local metadata that the scheduler doesn't know about
				remembered: existing?.remembered ?? e.item.remembered,
				favorite: existing?.favorite ?? e.item.favorite,
				connected: existing?.connected ?? e.item.connected,
			});
		}
		this.invalidateCache();
		this.presenceChanged.fire(e);
		this.emitListChanged();
	}

	private rebuildFromScheduler(): void {
		const tracked = this.scheduler.getTrackedBricks();

		// Update items from scheduler, preserving local metadata
		for (const [key, item] of tracked) {
			const existing = this.items.get(key);
			this.items.set(key, {
				...item,
				remembered: existing?.remembered ?? item.remembered,
				favorite: existing?.favorite ?? item.favorite,
				connected: existing?.connected ?? item.connected,
			});
		}

		this.invalidateCache();
		this.emitListChanged();
	}

	private invalidateCache(): void {
		this.sortedCache = null;
	}

	private emitListChanged(): void {
		this.listChanged.fire({ items: this.getDiscoveryList() });
	}
}
