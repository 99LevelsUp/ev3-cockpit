import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { Transport, PresenceState, makeBrickKey, BrickKey, DiscoveryItem } from '../contracts';
import type { TransportProvider, SessionHandle, DiscoveryScanResult, BrickCommand, BrickResponse } from '../contracts';
import { ProviderRegistry } from '../transports/providerRegistry';
import { DiscoveryScheduler } from '../runtime/discoveryScheduler';
import { PresenceAggregator, DiscoveryListChangeEvent } from '../runtime/presenceAggregator';

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
		capabilities: { supportsSignalInfo: false },
		async discover(): Promise<DiscoveryScanResult> { return { transport, items }; },
		async connect(brickKey: BrickKey): Promise<SessionHandle> { return { brickKey, transport }; },
		async disconnect(): Promise<void> { /* noop */ },
		async send(_key: BrickKey, _cmd: BrickCommand): Promise<BrickResponse> { return { kind: 'battery', level: 0 }; },
		dispose(): void { /* noop */ },
	};
}

function setup(items: DiscoveryItem[] = []) {
	const registry = new ProviderRegistry();
	registry.register(makeFakeProvider(Transport.Mock, items));
	const scheduler = new DiscoveryScheduler(registry, { unavailableAfterMisses: 2, removedAfterMisses: 3 });
	const aggregator = new PresenceAggregator(scheduler);
	return { registry, scheduler, aggregator };
}

function teardown(...disposables: { dispose(): void }[]) {
	for (const d of disposables) { d.dispose(); }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('PresenceAggregator — discovery list', () => {
	it('provides an empty list initially', () => {
		const { registry, scheduler, aggregator } = setup();
		assert.deepEqual(aggregator.getDiscoveryList(), []);
		teardown(aggregator, scheduler, registry);
	});

	it('populates after a scan', async () => {
		const items = [makeItem('a'), makeItem('b')];
		const { registry, scheduler, aggregator } = setup(items);

		await scheduler.scanOnce();
		const list = aggregator.getDiscoveryList();
		assert.equal(list.length, 2);

		teardown(aggregator, scheduler, registry);
	});

	it('emits onListChanged after a scan', async () => {
		const items = [makeItem('a')];
		const { registry, scheduler, aggregator } = setup(items);

		let fired = false;
		aggregator.onListChanged(() => { fired = true; });

		await scheduler.scanOnce();
		assert.ok(fired);

		teardown(aggregator, scheduler, registry);
	});
});

describe('PresenceAggregator — stable ordering', () => {
	it('orders by transport group (mock < usb < tcp < bt)', async () => {
		const registry = new ProviderRegistry();
		registry.register(makeFakeProvider(Transport.BT, [makeItem('bt1', Transport.BT)]));
		registry.register(makeFakeProvider(Transport.Mock, [makeItem('m1', Transport.Mock)]));
		registry.register(makeFakeProvider(Transport.USB, [makeItem('u1', Transport.USB)]));
		registry.register(makeFakeProvider(Transport.TCP, [makeItem('t1', Transport.TCP)]));

		const scheduler = new DiscoveryScheduler(registry);
		const aggregator = new PresenceAggregator(scheduler);

		await scheduler.scanOnce();
		const list = aggregator.getDiscoveryList();

		assert.equal(list[0].transport, Transport.Mock);
		assert.equal(list[1].transport, Transport.USB);
		assert.equal(list[2].transport, Transport.TCP);
		assert.equal(list[3].transport, Transport.BT);

		teardown(aggregator, scheduler, registry);
	});

	it('orders by brickKey within the same transport group', async () => {
		const items = [makeItem('c'), makeItem('a'), makeItem('b')];
		const { registry, scheduler, aggregator } = setup(items);

		await scheduler.scanOnce();
		const list = aggregator.getDiscoveryList();

		assert.equal(list[0].brickKey, makeBrickKey(Transport.Mock, 'a'));
		assert.equal(list[1].brickKey, makeBrickKey(Transport.Mock, 'b'));
		assert.equal(list[2].brickKey, makeBrickKey(Transport.Mock, 'c'));

		teardown(aggregator, scheduler, registry);
	});
});

describe('PresenceAggregator — remembered bricks', () => {
	it('merges remembered bricks into the list', () => {
		const { registry, scheduler, aggregator } = setup();

		const remembered: DiscoveryItem = {
			...makeItem('old'),
			presenceState: PresenceState.Remembered,
			remembered: true,
		};
		aggregator.mergeRemembered([remembered]);

		const list = aggregator.getDiscoveryList();
		assert.equal(list.length, 1);
		assert.equal(list[0].presenceState, PresenceState.Remembered);
		assert.equal(list[0].remembered, true);

		teardown(aggregator, scheduler, registry);
	});

	it('enforces remembered: true invariant even if input omits it', () => {
		const { registry, scheduler, aggregator } = setup();

		// Pass an item with remembered: false — mergeRemembered must correct it
		const badItem: DiscoveryItem = { ...makeItem('old'), presenceState: PresenceState.Remembered, remembered: false };
		aggregator.mergeRemembered([badItem]);

		const list = aggregator.getDiscoveryList();
		assert.equal(list[0].remembered, true);

		teardown(aggregator, scheduler, registry);
	});

	it('does not duplicate if a remembered brick is also discovered', async () => {
		const items = [makeItem('a')];
		const { registry, scheduler, aggregator } = setup(items);

		const remembered: DiscoveryItem = {
			...makeItem('a'),
			presenceState: PresenceState.Remembered,
			remembered: true,
		};
		aggregator.mergeRemembered([remembered]);

		await scheduler.scanOnce();
		const list = aggregator.getDiscoveryList();

		// Should be 1, not 2
		assert.equal(list.length, 1);
		assert.equal(list[0].presenceState, PresenceState.Available);

		teardown(aggregator, scheduler, registry);
	});
});

describe('PresenceAggregator — updateBrick', () => {
	it('updates connected and favorite flags', async () => {
		const items = [makeItem('a')];
		const { registry, scheduler, aggregator } = setup(items);

		await scheduler.scanOnce();

		const key = makeBrickKey(Transport.Mock, 'a');
		aggregator.updateBrick(key, { connected: true, favorite: true });

		const brick = aggregator.getBrick(key);
		assert.ok(brick);
		assert.equal(brick!.connected, true);
		assert.equal(brick!.favorite, true);

		teardown(aggregator, scheduler, registry);
	});

	it('preserves connected/favorite across scans', async () => {
		const items = [makeItem('a')];
		const { registry, scheduler, aggregator } = setup(items);

		await scheduler.scanOnce();

		const key = makeBrickKey(Transport.Mock, 'a');
		aggregator.updateBrick(key, { favorite: true });

		// Another scan — should preserve favorite
		await scheduler.scanOnce();

		const brick = aggregator.getBrick(key);
		assert.equal(brick!.favorite, true);

		teardown(aggregator, scheduler, registry);
	});
});

describe('PresenceAggregator — presence forwarding', () => {
	it('forwards presence change events from scheduler', async () => {
		const items = [makeItem('a')];
		const { registry, scheduler, aggregator } = setup(items);

		const events: import('../runtime/discoveryScheduler').PresenceChangeEvent[] = [];
		aggregator.onPresenceChanged(e => events.push(e));

		await scheduler.scanOnce();
		assert.equal(events.length, 1);
		assert.equal(events[0].currentState, PresenceState.Available);

		teardown(aggregator, scheduler, registry);
	});

	it('removes brick from list on Removed state', async () => {
		const items = [makeItem('a')];
		const { registry, scheduler, aggregator } = setup(items);

		await scheduler.scanOnce();
		assert.equal(aggregator.getDiscoveryList().length, 1);

		// Brick disappears
		items.length = 0;

		// Miss enough scans: unavailableAfterMisses=2, removedAfterMisses=3 → total 5
		for (let i = 0; i < 5; i++) {
			await scheduler.scanOnce();
		}

		assert.equal(aggregator.getDiscoveryList().length, 0);

		teardown(aggregator, scheduler, registry);
	});
});
