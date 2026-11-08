import * as vscode from 'vscode';
import {
	Transport, BrickKey, PresenceState, brickIdOf,
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

/** A provider's discovery scan failed. */
export interface ScanFailedEvent {
	readonly transport: Transport;
	readonly error: unknown;
}

export interface PresenceChangeEvent {
	readonly brickKey: BrickKey;
	/** Undefined when the brick was not tracked before -- a first discovery. */
	readonly previousState: PresenceState | undefined;
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
	/**
	 * Transports with a scan already running. `setInterval` fires regardless of
	 * whether the previous scan finished, and a slow transport (a BT inquiry runs for
	 * tens of seconds) would stack scans that each count misses independently --
	 * enough to walk a brick that is sitting right there to `Unavailable`.
	 */
	private readonly scansInFlight = new Set<Transport>();
	/** Counts scans as they start; each scan applies its results knowing which one it was. */
	private scansStarted = 0;
	/**
	 * Keys the cockpit itself forgot or paired, each with the count of scans started by then
	 * (step-3 plan, KTD11). A scan among those read Windows' list before the change, so it does
	 * not speak for the key: for a forgotten key what it lists is dropped, and for a paired one it
	 * neither overwrites the pairing nor counts a miss. The first later scan clears the fence.
	 */
	private readonly fences = new Map<BrickKey, { readonly at: number; readonly change: 'forgotten' | 'paired' }>();
	private polling = false;
	/** Transports whose provider has answered a scan; a failed scan does not count. */
	private readonly answeredTransports = new Set<Transport>();
	/** Set by dispose(). A scan still in flight must not fire on disposed emitters. */
	private disposed = false;

	private readonly presenceChanged: TypedEvent<PresenceChangeEvent>;
	private readonly scanCompleted: TypedEvent<undefined>;
	private readonly scanFailed: TypedEvent<ScanFailedEvent>;

	/** Fired whenever a brick's presence state changes. */
	readonly onPresenceChanged: vscode.Event<PresenceChangeEvent>;
	/** Fired after each full scan cycle completes. */
	readonly onScanCompleted: vscode.Event<undefined>;
	/**
	 * Fired when a provider's scan throws. A failing provider still costs its bricks
	 * a missed scan, so without this a transport could go dark and march every brick
	 * to `Removed` with nothing surfaced anywhere.
	 */
	readonly onScanFailed: vscode.Event<ScanFailedEvent>;

	constructor(registry: ProviderRegistry, options?: Partial<DiscoverySchedulerOptions>) {
		this.registry = registry;
		this.options = { ...DEFAULT_OPTIONS, ...options };

		this.presenceChanged = createTypedEvent<PresenceChangeEvent>();
		this.scanCompleted = createTypedEvent<undefined>();
		this.scanFailed = createTypedEvent<ScanFailedEvent>();
		this.onPresenceChanged = this.presenceChanged.event;
		this.onScanCompleted = this.scanCompleted.event;
		this.onScanFailed = this.scanFailed.event;

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
	scanOnce(): Promise<void> {
		return this.scanAll();
	}

	private async scanAll(): Promise<void> {
		const providers = this.registry.all().filter(p => !this.scansInFlight.has(p.transport));
		for (const p of providers) { this.scansInFlight.add(p.transport); }
		const scan = ++this.scansStarted;

		let results: PromiseSettledResult<DiscoveryScanResult>[];
		try {
			results = await Promise.allSettled(providers.map(p => p.discover()));
		} finally {
			for (const p of providers) { this.scansInFlight.delete(p.transport); }
		}

		// Collect all brickKeys seen in this cycle
		const seenKeys = new Set<BrickKey>();

		if (this.disposed) { return; }

		// Only transports that actually answered may accrue misses. Two ways to fail
		// that test: skipped for a scan already in flight, or the scan rejected. Both
		// mean nobody looked, and counting either marks bricks absent for a reason that
		// has nothing to do with the bricks. An earlier fix covered only the first.
		const answered = new Set<Transport>();
		results.forEach((result, index) => {
			if (result.status === 'fulfilled') {
				answered.add(providers[index].transport);
				this.answeredTransports.add(providers[index].transport);
				this.processScanResult(result.value, seenKeys, scan);
			} else {
				this.scanFailed.fire({ transport: providers[index].transport, error: result.reason });
			}
		});

		this.processMisses(seenKeys, answered, scan);

		this.scanCompleted.fire(undefined);
	}

	/**
	 * Whether a scan of this transport has answered since the scheduler was made: until one has,
	 * what is tracked for it says nothing about what is there (step-4 plan, KTD6).
	 */
	hasScanned(transport: Transport): boolean {
		return this.answeredTransports.has(transport);
	}

	/** Get the current snapshot of all tracked bricks. */
	getTrackedBricks(): ReadonlyMap<BrickKey, DiscoveryItem> {
		const result = new Map<BrickKey, DiscoveryItem>();
		for (const [key, tracked] of this.tracked) {
			result.set(key, tracked.item);
		}
		return result;
	}

	/**
	 * Stop tracking these channel keys (step-3 plan, KTD7), so the aggregator cannot rebuild a
	 * forgotten brick from a tracked sighting that still says paired.
	 *
	 * Fires no presence change: the brick layer is forgetting the whole brick and clears the
	 * list itself. A scan running now read Windows' list before the unpair, so what it lists for
	 * these keys is dropped when it lands, instead of tracking the brick as paired again; nobody
	 * waits for it. A scan that starts later lists a key again as a first discovery.
	 */
	forget(brickKeys: Iterable<BrickKey>): void {
		for (const key of brickKeys) {
			this.tracked.delete(key);
			this.fences.set(key, { at: this.scansStarted, change: 'forgotten' });
		}
	}

	/**
	 * Record a Bluetooth pairing the cockpit has just made (step-3 plan, KTD11): the channel is
	 * tracked as available and paired at once, a sighting that expired during the pairing too.
	 *
	 * A scan running now read Windows' list before the pairing, so it neither overwrites the
	 * pairing nor counts a miss against it; a scan that starts later is believed again, so a brick
	 * nothing lists any more still expires. Fires no presence change: the caller updates the list,
	 * and an announcement would start a name probe beside the sign-in that follows.
	 */
	notePaired(brickKey: BrickKey): void {
		const earlier = this.tracked.get(brickKey)?.item ?? {
			brickKey, displayName: brickIdOf(brickKey), nameSource: 'fallback' as const, transport: Transport.BT,
			connected: false, favorite: false, lastSeenAt: Date.now(),
		};
		const item: DiscoveryItem = { ...earlier, presenceState: PresenceState.Available, paired: true, remembered: true };
		// A presence check that missed the brick while its owner was confirming on it is older than
		// the pairing; kept, it would take the channel away when the list is next rebuilt.
		delete item.heard;
		delete item.heardAt;
		this.tracked.set(brickKey, { item, missCount: 0 });
		this.fences.set(brickKey, { at: this.scansStarted, change: 'paired' });
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.scansInFlight.clear();
		this.fences.clear();
		this.tracked.clear();
		this.presenceChanged.dispose();
		this.scanCompleted.dispose();
		this.scanFailed.dispose();
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
		if (this.scansInFlight.has(provider.transport)) {
			return;
		}
		this.scansInFlight.add(provider.transport);
		const scan = ++this.scansStarted;
		try {
			const result = await provider.discover();
			if (this.disposed) { return; }
			this.answeredTransports.add(provider.transport);
			const seenKeys = new Set<BrickKey>();
			this.processScanResult(result, seenKeys, scan);

			// Only process misses for bricks belonging to this transport
			this.processMisses(seenKeys, new Set([provider.transport]), scan);

			this.scanCompleted.fire(undefined);
		} catch (error: unknown) {
			this.scanFailed.fire({ transport: provider.transport, error });
		} finally {
			this.scansInFlight.delete(provider.transport);
		}
	}

	/** Whether scan number `scan` began before the cockpit's own change to `brickKey`, if any. */
	private olderThanChange(brickKey: BrickKey, scan: number): 'forgotten' | 'paired' | undefined {
		const fence = this.fences.get(brickKey);
		return fence && scan <= fence.at ? fence.change : undefined;
	}

	/** Apply what scan number `scan` listed; nothing for a key the cockpit changed since it started. */
	private processScanResult(result: DiscoveryScanResult, seenKeys: Set<BrickKey>, scan: number): void {
		for (const item of result.items) {
			if (this.olderThanChange(item.brickKey, scan)) { continue; }
			this.fences.delete(item.brickKey);
			seenKeys.add(item.brickKey);

			const existing = this.tracked.get(item.brickKey);
			if (!existing) {
				// New brick discovered
				const newItem: DiscoveryItem = { ...item, presenceState: PresenceState.Available };
				this.tracked.set(item.brickKey, { item: newItem, missCount: 0 });
				this.presenceChanged.fire({
					brickKey: item.brickKey,
					previousState: undefined, // never tracked before -- not the same as Removed
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

	/** Count a miss against each brick of `scannedTransports` that scan number `scan` did not list. */
	private processMisses(seenKeys: Set<BrickKey>, scannedTransports: Set<Transport>, scan: number): void {
		for (const [brickKey, tracked] of this.tracked) {
			if (!scannedTransports.has(tracked.item.transport)) { continue; }
			// It read the list before the pairing; its silence is no evidence the brick has gone.
			if (this.olderThanChange(brickKey, scan) === 'paired') { continue; }
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
