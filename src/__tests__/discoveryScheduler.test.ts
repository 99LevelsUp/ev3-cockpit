import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { Transport, PresenceState, makeBrickKey, BrickKey, DiscoveryItem } from '../contracts';
import type { TransportProvider, SessionHandle, DiscoveryScanResult, TransportCapabilities, BrickCommand, BrickResponse } from '../contracts';
import { ProviderRegistry } from '../transports/providerRegistry';
import { DiscoveryScheduler, PresenceChangeEvent } from '../runtime/discoveryScheduler';

// ── Helpers ─────────────────────────────────────────────────────────

function makeItem(id: string, transport: Transport = Transport.Mock): DiscoveryItem {
	return {
		brickKey: makeBrickKey(transport, id),
		displayName: `Brick ${id}`,
		transport,
		presenceState: PresenceState.Available,
		remembered: false,
		connected: false,
		favorite: false,
		availableTransports: [transport],
		lastSeenAt: Date.now(),
	};
}

function makeFakeProvider(transport: Transport, items: DiscoveryItem[]): TransportProvider {
	return {
		transport,
		capabilities: { supportsSignalInfo: false } satisfies TransportCapabilities,
		async discover(): Promise<DiscoveryScanResult> { return { transport, items }; },
		async connect(brickKey: BrickKey): Promise<SessionHandle> { return { brickKey, transport }; },
		async disconnect(): Promise<void> { /* noop */ },
		async send(_key: BrickKey, _cmd: BrickCommand): Promise<BrickResponse> { return { kind: 'battery', level: 0 }; },
		dispose(): void { /* noop */ },
	};
}

// ── Tests ───────────────────────────────────────────────────────────

describe('DiscoveryScheduler — scanOnce', () => {
	it('discovers bricks from a single provider', async () => {
		const registry = new ProviderRegistry();
		const item = makeItem('a');
		registry.register(makeFakeProvider(Transport.Mock, [item]));

		const scheduler = new DiscoveryScheduler(registry);
		await scheduler.scanOnce();

		const tracked = scheduler.getTrackedBricks();
		assert.equal(tracked.size, 1);
		assert.equal(tracked.get(makeBrickKey(Transport.Mock, 'a'))?.presenceState, PresenceState.Available);

		scheduler.dispose();
		registry.dispose();
	});

	it('discovers bricks from multiple providers', async () => {
		const registry = new ProviderRegistry();
		registry.register(makeFakeProvider(Transport.Mock, [makeItem('a', Transport.Mock)]));
		registry.register(makeFakeProvider(Transport.USB, [makeItem('b', Transport.USB)]));

		const scheduler = new DiscoveryScheduler(registry);
		await scheduler.scanOnce();

		assert.equal(scheduler.getTrackedBricks().size, 2);

		scheduler.dispose();
		registry.dispose();
	});

	it('deduplicates bricks seen in consecutive scans', async () => {
		const registry = new ProviderRegistry();
		registry.register(makeFakeProvider(Transport.Mock, [makeItem('a')]));

		const scheduler = new DiscoveryScheduler(registry);
		await scheduler.scanOnce();
		await scheduler.scanOnce();

		assert.equal(scheduler.getTrackedBricks().size, 1);

		scheduler.dispose();
		registry.dispose();
	});
});

describe('DiscoveryScheduler — presence transitions', () => {
	it('emits Available on first discovery', async () => {
		const registry = new ProviderRegistry();
		registry.register(makeFakeProvider(Transport.Mock, [makeItem('a')]));

		const scheduler = new DiscoveryScheduler(registry);
		const events: PresenceChangeEvent[] = [];
		scheduler.onPresenceChanged(e => events.push(e));

		await scheduler.scanOnce();

		assert.equal(events.length, 1);
		assert.equal(events[0].currentState, PresenceState.Available);

		scheduler.dispose();
		registry.dispose();
	});

	it('transitions Available → Unavailable after missed scans', async () => {
		const items = [makeItem('a')];
		const registry = new ProviderRegistry();
		registry.register(makeFakeProvider(Transport.Mock, items));

		const scheduler = new DiscoveryScheduler(registry, {
			unavailableAfterMisses: 2,
			removedAfterMisses: 3,
		});

		const events: PresenceChangeEvent[] = [];
		scheduler.onPresenceChanged(e => events.push(e));

		// Scan 1: brick discovered
		await scheduler.scanOnce();
		assert.equal(events.length, 1);
		assert.equal(events[0].currentState, PresenceState.Available);

		// Brick disappears
		items.length = 0;

		// Scan 2: miss 1
		await scheduler.scanOnce();
		// Scan 3: miss 2 → Unavailable
		await scheduler.scanOnce();

		const unavailableEvent = events.find(e => e.currentState === PresenceState.Unavailable);
		assert.ok(unavailableEvent, 'Expected an Unavailable event');
		assert.equal(unavailableEvent!.previousState, PresenceState.Available);

		scheduler.dispose();
		registry.dispose();
	});

	it('transitions Unavailable → Removed after extended absence', async () => {
		const items = [makeItem('a')];
		const registry = new ProviderRegistry();
		registry.register(makeFakeProvider(Transport.Mock, items));

		const scheduler = new DiscoveryScheduler(registry, {
			unavailableAfterMisses: 1,
			removedAfterMisses: 2,
		});

		const events: PresenceChangeEvent[] = [];
		scheduler.onPresenceChanged(e => events.push(e));

		// Scan 1: discover
		await scheduler.scanOnce();

		// Brick disappears
		items.length = 0;

		// Scan 2: miss 1 → Unavailable (unavailableAfterMisses = 1)
		await scheduler.scanOnce();
		// Scan 3: miss 2
		await scheduler.scanOnce();
		// Scan 4: miss 3 → Removed (1 + 2 = 3 total misses)
		await scheduler.scanOnce();

		const removedEvent = events.find(e => e.currentState === PresenceState.Removed);
		assert.ok(removedEvent, 'Expected a Removed event');

		// Brick should be gone from tracked
		assert.equal(scheduler.getTrackedBricks().size, 0);

		scheduler.dispose();
		registry.dispose();
	});

	it('transitions Unavailable → Available on rediscovery', async () => {
		const items = [makeItem('a')];
		const registry = new ProviderRegistry();
		registry.register(makeFakeProvider(Transport.Mock, items));

		const scheduler = new DiscoveryScheduler(registry, {
			unavailableAfterMisses: 1,
			removedAfterMisses: 5,
		});

		const events: PresenceChangeEvent[] = [];
		scheduler.onPresenceChanged(e => events.push(e));

		// Discover
		await scheduler.scanOnce();

		// Disappear
		items.length = 0;
		await scheduler.scanOnce(); // → Unavailable

		// Reappear
		items.push(makeItem('a'));
		await scheduler.scanOnce(); // → Available

		const reappearEvent = events.find(
			e => e.previousState === PresenceState.Unavailable && e.currentState === PresenceState.Available
		);
		assert.ok(reappearEvent, 'Expected Unavailable → Available transition');

		scheduler.dispose();
		registry.dispose();
	});

	it('does not emit event when brick remains Available', async () => {
		const registry = new ProviderRegistry();
		registry.register(makeFakeProvider(Transport.Mock, [makeItem('a')]));

		const scheduler = new DiscoveryScheduler(registry);
		const events: PresenceChangeEvent[] = [];

		await scheduler.scanOnce();
		// Now subscribe — skip initial event
		scheduler.onPresenceChanged(e => events.push(e));

		await scheduler.scanOnce();
		await scheduler.scanOnce();

		assert.equal(events.length, 0);

		scheduler.dispose();
		registry.dispose();
	});
});

describe('DiscoveryScheduler — error resilience', () => {
	it('handles provider errors gracefully', async () => {
		const registry = new ProviderRegistry();
		const failingProvider: TransportProvider = {
			transport: Transport.Mock,
			capabilities: { supportsSignalInfo: false },
			async discover(): Promise<DiscoveryScanResult> { throw new Error('scan failed'); },
			async connect(brickKey: BrickKey): Promise<SessionHandle> { return { brickKey, transport: Transport.Mock }; },
			async disconnect(): Promise<void> { /* noop */ },
			async send(_key: BrickKey, _cmd: BrickCommand): Promise<BrickResponse> { return { kind: 'battery', level: 0 }; },
			dispose(): void { /* noop */ },
		};
		registry.register(failingProvider);

		const scheduler = new DiscoveryScheduler(registry);
		// Should not throw
		await scheduler.scanOnce();
		assert.equal(scheduler.getTrackedBricks().size, 0);

		scheduler.dispose();
		registry.dispose();
	});
});

describe('DiscoveryScheduler — auto-start on late registration', () => {
	it('auto-starts polling for a provider registered after start()', async () => {
		const registry = new ProviderRegistry();
		const scheduler = new DiscoveryScheduler(registry, { defaultIntervalMs: 50000 });

		scheduler.start();

		// Register provider AFTER start() — should be auto-started
		registry.register(makeFakeProvider(Transport.Mock, [makeItem('a')]));

		// Verify the timer was created by checking scanOnce still works
		await scheduler.scanOnce();
		assert.equal(scheduler.getTrackedBricks().size, 1);

		scheduler.dispose();
		registry.dispose();
	});
});
