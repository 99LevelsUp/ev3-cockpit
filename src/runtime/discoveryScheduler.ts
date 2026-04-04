import * as vscode from 'vscode';
import {
	Transport, BrickKey, PresenceState,
	TransportProvider, DiscoveryScanResult, DiscoveryItem,
} from '../contracts';
import { createTypedEvent, TypedEvent } from '../events';
import { ProviderRegistry } from '../transports/providerRegistry';

// ── Configuration ───────────────────────────────────────────────────

export interface DiscoverySchedulerOptions {
	/** Default scan interval in ms (used when a transport has no override). */
	readonly defaultIntervalMs: number;
	/** Per-transport scan interval overrides. */
	readonly intervalOverrides?: Partial<Record<Transport, number>>;
	/** Number of consecutive missed scans before `available → unavailable`. */
	readonly unavailableAfterMisses: number;
	/** Number of consecutive missed scans (after unavailable) before `unavailable → removed`. */
	readonly removedAfterMisses: number;
}

const DEFAULT_OPTIONS: DiscoverySchedulerOptions = {
	defaultIntervalMs: 3000,
	unavailableAfterMisses: 2,
	removedAfterMisses: 5,
};

// ── Events ──────────────────────────────────────────────────────────

export interface PresenceChangeEvent {
	readonly brickKey: BrickKey;
	readonly previousState: PresenceState;
	readonly currentState: PresenceState;
	readonly item: DiscoveryItem;
}

// ── Tracked brick entry ─────────────────────────────────────────────

interface TrackedBrick {
	item: DiscoveryItem;
	/** Number of consecutive scans where this brick was NOT seen. */
	missCount: number;
}

// ── Scheduler ───────────────────────────────────────────────────────

/**
 * Periodically polls registered transport providers for discovery results,
 * tracks presence state transitions, deduplicates results, and emits
 * change events.
 *
 * Subscribes to registry events so that providers registered after `start()`
 * are automatically included in polling — no sequential coupling between
 * provider registration and scheduler startup.
 */
export class DiscoveryScheduler implements vscode.Disposable {
	private readonly options: DiscoverySchedulerOptions;
	private readonly registry: ProviderRegistry;
	private readonly tracked = new Map<BrickKey, TrackedBrick>();
	private readonly timers = new Map<Transport, ReturnType<typeof setInterval>>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private polling = false;

	private readonly presenceChanged: TypedEvent<PresenceChangeEvent>;
	private readonly scanCompleted: TypedEvent<undefined>;

	/** Fired whenever a brick's presence state changes. */
	readonly onPresenceChanged: vscode.Event<PresenceChangeEvent>;
	/** Fired after each full scan cycle completes. */
	readonly onScanCompleted: vscode.Event<undefined>;

	constructor(registry: ProviderRegistry, options?: Partial<DiscoverySchedulerOptions>) {
		this.registry = registry;
		this.options = { ...DEFAULT_OPTIONS, ...options };

		this.presenceChanged = createTypedEvent<PresenceChangeEvent>();
		this.scanCompleted = createTypedEvent<undefined>();
		this.onPresenceChanged = this.presenceChanged.event;
		this.onScanCompleted = this.scanCompleted.event;

		this.subscriptions.push(
			registry.onProviderRegistered(p => {
				if (this.polling) { this.startProviderTimer(p); }
			}),
			registry.onProviderUnregistered(t => { this.stopProviderTimer(t); }),
		);
	}

	/** Start periodic polling for all currently registered providers. */
	start(): void {
		this.polling = true;
		for (const provider of this.registry.all()) {
			this.startProviderTimer(provider);
		}
	}

	/** Stop all polling timers. Tracked state is preserved. */
	stop(): void {
		this.polling = false;
		for (const timer of this.timers.values()) {
			clearInterval(timer);
		}
		this.timers.clear();
	}

	/** Run one discovery cycle for all providers (useful for testing). */
	async scanOnce(): Promise<void> {
		const providers = this.registry.all();
		const results = await Promise.allSettled(
			providers.map(p => p.discover())
		);

		// Collect all brickKeys seen in this cycle
		const seenKeys = new Set<BrickKey>();

		for (const result of results) {
			if (result.status === 'fulfilled') {
				this.processScanResult(result.value, seenKeys);
			}
			// Rejected providers are silently skipped — their bricks will miss scans.
		}

		// Increment miss counts for bricks not seen in this cycle
		this.processMisses(seenKeys);

		this.scanCompleted.fire(undefined);
	}

	/** Get the current snapshot of all tracked bricks. */
	getTrackedBricks(): ReadonlyMap<BrickKey, DiscoveryItem> {
		const result = new Map<BrickKey, DiscoveryItem>();
		for (const [key, tracked] of this.tracked) {
			result.set(key, tracked.item);
		}
		return result;
	}

	dispose(): void {
		this.stop();
		this.tracked.clear();
		this.presenceChanged.dispose();
		this.scanCompleted.dispose();
		for (const s of this.subscriptions) { s.dispose(); }
		this.subscriptions.length = 0;
	}

	// ── Internals ───────────────────────────────────────────────────

	private startProviderTimer(provider: TransportProvider): void {
		if (this.timers.has(provider.transport)) { return; }

		const interval = this.options.intervalOverrides?.[provider.transport]
			?? this.options.defaultIntervalMs;

		const timer = setInterval(() => {
			void this.scanProvider(provider);
		}, interval);

		this.timers.set(provider.transport, timer);
	}

	private stopProviderTimer(transport: Transport): void {
		const timer = this.timers.get(transport);
		if (timer) {
			clearInterval(timer);
			this.timers.delete(transport);
		}
	}

	private async scanProvider(provider: TransportProvider): Promise<void> {
		try {
			const result = await provider.discover();
			const seenKeys = new Set<BrickKey>();
			this.processScanResult(result, seenKeys);

			// Only process misses for bricks belonging to this transport
			for (const [brickKey, tracked] of this.tracked) {
				if (tracked.item.transport === provider.transport && !seenKeys.has(brickKey)) {
					this.incrementMiss(brickKey, tracked);
				}
			}

			this.scanCompleted.fire(undefined);
		} catch (err: unknown) {
			console.warn(`[DiscoveryScheduler] ${provider.transport} scan failed:`, err);
		}
	}

	private processScanResult(result: DiscoveryScanResult, seenKeys: Set<BrickKey>): void {
		for (const item of result.items) {
			seenKeys.add(item.brickKey);

			const existing = this.tracked.get(item.brickKey);
			if (!existing) {
				// New brick discovered
				const newItem: DiscoveryItem = { ...item, presenceState: PresenceState.Available };
				this.tracked.set(item.brickKey, { item: newItem, missCount: 0 });
				this.presenceChanged.fire({
					brickKey: item.brickKey,
					previousState: PresenceState.Removed, // was not tracked
					currentState: PresenceState.Available,
					item: newItem,
				});
			} else {
				// Brick seen again — reset miss count, update fields
				const previousState = existing.item.presenceState;
				existing.item = {
					...item,
					presenceState: PresenceState.Available,
					remembered: existing.item.remembered,
					favorite: existing.item.favorite,
				};
				existing.missCount = 0;

				if (previousState !== PresenceState.Available) {
					this.presenceChanged.fire({
						brickKey: item.brickKey,
						previousState,
						currentState: PresenceState.Available,
						item: existing.item,
					});
				}
			}
		}
	}

	private processMisses(seenKeys: Set<BrickKey>): void {
		for (const [brickKey, tracked] of this.tracked) {
			if (!seenKeys.has(brickKey)) {
				this.incrementMiss(brickKey, tracked);
			}
		}
	}

	private incrementMiss(brickKey: BrickKey, tracked: TrackedBrick): void {
		// Only process bricks that are available or unavailable
		if (tracked.item.presenceState === PresenceState.Removed) { return; }
		if (tracked.item.presenceState === PresenceState.Remembered) { return; }

		tracked.missCount++;
		const previousState = tracked.item.presenceState;

		if (tracked.item.presenceState === PresenceState.Available
			&& tracked.missCount >= this.options.unavailableAfterMisses) {
			tracked.item = { ...tracked.item, presenceState: PresenceState.Unavailable };
			this.presenceChanged.fire({
				brickKey,
				previousState,
				currentState: PresenceState.Unavailable,
				item: tracked.item,
			});
		} else if (tracked.item.presenceState === PresenceState.Unavailable
			&& tracked.missCount >= this.options.unavailableAfterMisses + this.options.removedAfterMisses) {
			tracked.item = { ...tracked.item, presenceState: PresenceState.Removed };
			this.presenceChanged.fire({
				brickKey,
				previousState,
				currentState: PresenceState.Removed,
				item: tracked.item,
			});
			this.tracked.delete(brickKey);
		}
	}
}
