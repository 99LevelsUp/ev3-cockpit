import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { Transport, PresenceState, makeBrickKey, BrickKey, DiscoveryItem } from '../contracts';
import type { TransportProvider, SessionHandle, DiscoveryScanResult, TransportCapabilities, BrickCommand, BrickResponse } from '../contracts';
import { ProviderRegistry } from '../transports/providerRegistry';
import { waitFor } from './waitFor';
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
		lastSeenAt: Date.now(),
	};
}

function makeFakeProvider(transport: Transport, items: DiscoveryItem[]): TransportProvider {
	return {
		transport,
		priority: 0,
		capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: false } satisfies TransportCapabilities,
		async discover(): Promise<DiscoveryScanResult> { return { transport, items }; },
		async connect(brickKey: BrickKey): Promise<SessionHandle> { return { brickKey, transport }; },
		async disconnect(): Promise<void> { /* noop */ },
		async sendPacket(): Promise<Uint8Array> { return new Uint8Array(0); },
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
			priority: 0,
			capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: false },
			async discover(): Promise<DiscoveryScanResult> { throw new Error('scan failed'); },
			async connect(brickKey: BrickKey): Promise<SessionHandle> { return { brickKey, transport: Transport.Mock }; },
			async disconnect(): Promise<void> { /* noop */ },
			async sendPacket(): Promise<Uint8Array> { return new Uint8Array(0); },
			dispose(): void { /* noop */ },
		};
		registry.register(failingProvider);

		const scheduler = new DiscoveryScheduler(registry);
		const failures: string[] = [];
		scheduler.onScanFailed(e => failures.push(e.transport));

		// Should not throw
		await scheduler.scanOnce();
		assert.equal(scheduler.getTrackedBricks().size, 0);

		// A silently skipped provider is indistinguishable from a transport with no
		// bricks, while its tracked bricks keep accruing misses toward Removed.
		assert.deepEqual(failures, [Transport.Mock]);

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

describe('DiscoveryScheduler -- skipped transports must not accrue misses', () => {
	it('does not count a miss for a transport whose scan was already in flight', async () => {
		// Regression on the round-3 in-flight guard. It skipped a transport whose scan was
		// still running, but processMisses then walked every tracked brick regardless -- so
		// a brick was marked absent purely because nobody had looked for it.
		const key = makeBrickKey(Transport.Mock, 'slow-brick');
		let discoverCalls = 0;
		let releaseSecond: (() => void) | undefined;

		const item: DiscoveryItem = {
			brickKey: key,
			displayName: 'Slow brick',
			transport: Transport.Mock,
			presenceState: PresenceState.Available,
			remembered: false,
			connected: false,
			favorite: false,
			lastSeenAt: 0,
		};

		const provider: TransportProvider = {
			transport: Transport.Mock,
			priority: 0,
			capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: false },
			discover: () => {
				discoverCalls += 1;
				if (discoverCalls === 1) {
					return Promise.resolve({ transport: Transport.Mock, items: [item] });
				}
				return new Promise((resolve) => {
					releaseSecond = () => resolve({ transport: Transport.Mock, items: [item] });
				});
			},
			connect: (brickKey) => Promise.resolve({ brickKey, transport: Transport.Mock }),
			disconnect: () => Promise.resolve(),
			sendPacket: () => Promise.resolve(new Uint8Array(0)),
			dispose: () => { /* nothing to release */ },
		};

		const registry = new ProviderRegistry();
		registry.register(provider);
		// One missed scan is enough to leave Available, so the assertion is sharp.
		const scheduler = new DiscoveryScheduler(registry, { unavailableAfterMisses: 1 });

		await scheduler.scanOnce();
		assert.equal(scheduler.getTrackedBricks().get(key)?.presenceState, PresenceState.Available);

		const inFlight = scheduler.scanOnce();
		await waitFor(() => releaseSecond !== undefined, 2000);

		// This cycle finds the transport busy and scans nothing at all.
		await scheduler.scanOnce();
		assert.equal(
			scheduler.getTrackedBricks().get(key)?.presenceState,
			PresenceState.Available,
			'a transport nobody scanned must not cost its bricks a miss'
		);

		releaseSecond!();
		await inFlight;

		scheduler.dispose();
		registry.dispose();
	});
});

describe('DiscoveryScheduler — a failed scan is not a scan', () => {
	it('does not accrue misses for a transport whose scan rejected', async () => {
		// A provider that rejects has told us nothing about its bricks. Treating that as
		// "scanned, found nothing" marks them absent for a reason that has nothing to do
		// with the bricks — the same defect as counting a transport that was skipped for
		// an in-flight scan, one step over. Reachable now that useDiscovery:false rejects.
		const item = makeItem('aaa', Transport.TCP);
		let failNext = false;

		const provider: TransportProvider = {
			transport: Transport.TCP,
			priority: 0,
			capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: false },
			discover(): Promise<DiscoveryScanResult> {
				return failNext
					? Promise.reject(new Error('TCP discovery is disabled for this provider'))
					: Promise.resolve({ transport: Transport.TCP, items: [item] });
			},
			async connect(brickKey: BrickKey): Promise<SessionHandle> {
				return { brickKey, transport: Transport.TCP };
			},
			async disconnect(): Promise<void> { /* noop */ },
			async sendPacket(): Promise<Uint8Array> { return new Uint8Array(0); },
			dispose(): void { /* noop */ },
		};

		const registry = new ProviderRegistry();
		registry.register(provider);
		// One miss demotes and two remove, so three failed scans would evict the brick
		// entirely if a rejected scan counted as one.
		const scheduler = new DiscoveryScheduler(registry, {
			unavailableAfterMisses: 1,
			removedAfterMisses: 2,
		});

		await scheduler.scanOnce();
		assert.equal(scheduler.getTrackedBricks().size, 1, 'the brick was seen once');

		// Every scan now rejects. The brick must survive: nobody looked for it.
		failNext = true;
		await scheduler.scanOnce();
		await scheduler.scanOnce();
		await scheduler.scanOnce();

		assert.equal(
			scheduler.getTrackedBricks().get(makeBrickKey(Transport.TCP, 'aaa'))?.presenceState,
			PresenceState.Available,
			'a transport that could not answer must not report its bricks absent'
		);

		scheduler.dispose();
		registry.dispose();
	});
});
