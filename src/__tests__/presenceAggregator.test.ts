import assert from 'assert/strict';
import { describe, it } from 'node:test';

import {
	Transport, PresenceState, ChannelState, ConnectionState, makeBrickKey, brickIdOf,
	BrickKey, DiscoveryItem, NameSource,
} from '../contracts';
import type { TransportProvider, SessionHandle, DiscoveryScanResult } from '../contracts';
import { ProviderRegistry } from '../transports/providerRegistry';
import { DiscoveryScheduler } from '../runtime/discoveryScheduler';
import { PresenceAggregator } from '../runtime/presenceAggregator';

// ── Helpers ─────────────────────────────────────────────────────────

/** CCC on the bench, as each transport names it. */
const CCC = {
	usb: makeBrickKey(Transport.USB, '00165342D9F2'),
	bt: makeBrickKey(Transport.BT, '00:16:53:42:D9:F2'),
	tcp: makeBrickKey(Transport.TCP, '00165342d9f2'),
};
const CCC_ID = brickIdOf(CCC.usb);

function item(brickKey: BrickKey, transport: Transport, displayName: string, nameSource?: NameSource): DiscoveryItem {
	return {
		brickKey,
		displayName,
		...(nameSource ? { nameSource } : {}),
		transport,
		presenceState: PresenceState.Available,
		remembered: false,
		connected: false,
		favorite: false,
		lastSeenAt: Date.now(),
	};
}

function fakeProvider(transport: Transport, priority: number, items: DiscoveryItem[]): TransportProvider {
	return {
		transport,
		priority,
		capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: false },
		// Stamped at each scan, as the real providers do.
		async discover(): Promise<DiscoveryScanResult> {
			return { transport, items: items.map((i) => ({ ...i, lastSeenAt: Date.now() })) };
		},
		async connect(brickKey: BrickKey): Promise<SessionHandle> { return { brickKey, transport }; },
		async disconnect(): Promise<void> { /* noop */ },
		async sendPacket(): Promise<Uint8Array> { return new Uint8Array(0); },
		dispose(): void { /* noop */ },
	};
}

/** Discovery over USB, BT and TCP, each with a list the test can change between scans. */
function setup() {
	const seen = { usb: [] as DiscoveryItem[], bt: [] as DiscoveryItem[], tcp: [] as DiscoveryItem[] };
	const registry = new ProviderRegistry();
	registry.register(fakeProvider(Transport.USB, 30, seen.usb));
	registry.register(fakeProvider(Transport.BT, 20, seen.bt));
	registry.register(fakeProvider(Transport.TCP, 10, seen.tcp));
	const scheduler = new DiscoveryScheduler(registry, { unavailableAfterMisses: 1, removedAfterMisses: 1 });
	const aggregator = new PresenceAggregator(scheduler, registry);
	const done = () => { aggregator.dispose(); scheduler.dispose(); registry.dispose(); };
	return { seen, registry, scheduler, aggregator, done };
}

function stateOf(aggregator: PresenceAggregator, transport: Transport): ChannelState {
	return aggregator.getBrick(CCC_ID)?.channels.find((c) => c.transport === transport)?.state
		?? ChannelState.Absent;
}

// ── One brick, many channels ────────────────────────────────────────

describe('PresenceAggregator — one entry per brick', () => {
	it('groups the USB and Bluetooth sightings of one brick into one entry', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC', 'usb-descriptor'));
		seen.bt.push(item(CCC.bt, Transport.BT, 'CCC', 'bt-cache'));

		await scheduler.scanOnce();

		const list = aggregator.getDiscoveryList();
		assert.equal(list.length, 1);
		assert.equal(list[0].brickId, '00165342D9F2');
		assert.deepEqual(list[0].channels.map((c) => [c.transport, c.state]), [
			[Transport.USB, ChannelState.Available],
			[Transport.BT, ChannelState.Available],
		]);
		done();
	});

	it('turns a channel that disappears lost while the others stay available', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC'));
		seen.bt.push(item(CCC.bt, Transport.BT, 'CCC'));
		await scheduler.scanOnce();

		seen.usb.length = 0;   // the cable comes out
		await scheduler.scanOnce();

		assert.equal(stateOf(aggregator, Transport.USB), ChannelState.Lost);
		assert.equal(stateOf(aggregator, Transport.BT), ChannelState.Available);
		done();
	});

	it('reports a channel never seen this session as absent, not lost', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.bt.push(item(CCC.bt, Transport.BT, 'CCC'));
		await scheduler.scanOnce();

		assert.equal(stateOf(aggregator, Transport.USB), ChannelState.Absent);
		assert.equal(aggregator.getBrick(CCC_ID)?.channels.length, 1);
		done();
	});

	it('keeps a TCP brick known only by its IP as its own one-channel entry', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.bt.push(item(CCC.bt, Transport.BT, 'CCC'));
		seen.tcp.push(item(makeBrickKey(Transport.TCP, '192.168.1.20'), Transport.TCP, 'EV3 [192.168.1.20]'));
		await scheduler.scanOnce();

		const list = aggregator.getDiscoveryList();
		assert.equal(list.length, 2);
		const byIp = list.find((b) => b.brickId === 'tcp:192.168.1.20');
		assert.deepEqual(byIp?.channels.map((c) => c.transport), [Transport.TCP]);
		done();
	});

	it('leaves a mock brick as one entry with one channel', async () => {
		const registry = new ProviderRegistry();
		const mockKey = makeBrickKey(Transport.Mock, 'brick-a');
		registry.register(fakeProvider(Transport.Mock, 0, [item(mockKey, Transport.Mock, 'Brick A', 'brick')]));
		const scheduler = new DiscoveryScheduler(registry);
		const aggregator = new PresenceAggregator(scheduler, registry);
		await scheduler.scanOnce();

		const list = aggregator.getDiscoveryList();
		assert.equal(list.length, 1);
		assert.equal(list[0].brickId, 'mock:brick-a');
		assert.equal(list[0].name.value, 'Brick A');
		aggregator.dispose(); scheduler.dispose(); registry.dispose();
	});

	it('orders channels by the priority their providers declare, whatever the transport', async () => {
		// A transport the brick layer has never heard of slots in by its own priority alone.
		const registry = new ProviderRegistry();
		registry.register(fakeProvider(Transport.USB, 30, [item(CCC.usb, Transport.USB, 'CCC')]));
		registry.register(fakeProvider(Transport.BT, 20, [item(CCC.bt, Transport.BT, 'CCC')]));
		registry.register(fakeProvider(Transport.TCP, 25, [item(CCC.tcp, Transport.TCP, 'CCC')]));
		const scheduler = new DiscoveryScheduler(registry);
		const aggregator = new PresenceAggregator(scheduler, registry);
		await scheduler.scanOnce();

		assert.deepEqual(aggregator.getBrick(CCC_ID)?.channels.map((c) => c.transport),
			[Transport.USB, Transport.TCP, Transport.BT]);
		aggregator.dispose(); scheduler.dispose(); registry.dispose();
	});
});

// ── Sessions ────────────────────────────────────────────────────────

describe('PresenceAggregator — channel state follows the session', () => {
	it('marks a channel connected, lost while it reconnects, and available once signed out', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC'));
		await scheduler.scanOnce();

		aggregator.updateChannelSession(CCC.usb, ConnectionState.Connected);
		assert.equal(stateOf(aggregator, Transport.USB), ChannelState.Connected);
		aggregator.updateChannelSession(CCC.usb, ConnectionState.Reconnecting);
		assert.equal(stateOf(aggregator, Transport.USB), ChannelState.Lost);
		aggregator.updateChannelSession(CCC.usb, ConnectionState.Connected);
		aggregator.updateChannelSession(CCC.usb, ConnectionState.Disconnected);
		assert.equal(stateOf(aggregator, Transport.USB), ChannelState.Available);
		done();
	});

	it('takes a connected session as proof the brick is there, before discovery lists it', () => {
		const { aggregator, done } = setup();
		aggregator.updateChannelSession(CCC.bt, ConnectionState.Connected);
		assert.equal(stateOf(aggregator, Transport.BT), ChannelState.Connected);
		done();
	});

	it('keeps a connected channel connected when a scan misses it', async () => {
		// USB discovery skips a device its own transport holds claimed; the session decides.
		const { seen, scheduler, aggregator, done } = setup();
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC'));
		await scheduler.scanOnce();
		aggregator.updateChannelSession(CCC.usb, ConnectionState.Connected);

		seen.usb.length = 0;
		await scheduler.scanOnce();
		assert.equal(stateOf(aggregator, Transport.USB), ChannelState.Connected);
		done();
	});
});

// ── Expiry ──────────────────────────────────────────────────────────

describe('PresenceAggregator — bricks that leave', () => {
	it('drops a stranger\'s brick once discovery gives up on all its channels', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.bt.push(item(CCC.bt, Transport.BT, 'CCC'));
		await scheduler.scanOnce();

		seen.bt.length = 0;
		for (let i = 0; i < 3; i++) { await scheduler.scanOnce(); }

		assert.equal(aggregator.getBrick(CCC_ID), undefined);
		done();
	});

	it('keeps a brick it was connected to, with the expired channel shown lost', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC'));
		await scheduler.scanOnce();
		aggregator.updateChannelSession(CCC.usb, ConnectionState.Connected);
		aggregator.updateChannelSession(CCC.usb, ConnectionState.Reconnecting);

		seen.usb.length = 0;
		for (let i = 0; i < 3; i++) { await scheduler.scanOnce(); }

		assert.equal(stateOf(aggregator, Transport.USB), ChannelState.Lost);
		done();
	});

	it('brings an expired channel back when it is seen again', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC'));
		seen.bt.push(item(CCC.bt, Transport.BT, 'CCC'));
		await scheduler.scanOnce();
		seen.usb.length = 0;
		for (let i = 0; i < 3; i++) { await scheduler.scanOnce(); }

		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC'));
		await scheduler.scanOnce();
		assert.equal(stateOf(aggregator, Transport.USB), ChannelState.Available);
		done();
	});
});

// ── Bluetooth presence ──────────────────────────────────────────────

describe('PresenceAggregator — a paired brick nobody hears', () => {
	it('turns a paired brick that stopped answering lost, and keeps it lost across scans', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.bt.push({ ...item(CCC.bt, Transport.BT, 'CCC'), paired: true, heard: false });
		await scheduler.scanOnce();
		assert.equal(stateOf(aggregator, Transport.BT), ChannelState.Lost);
		await scheduler.scanOnce();
		assert.equal(stateOf(aggregator, Transport.BT), ChannelState.Lost);
		assert.ok(aggregator.getBrick(CCC_ID), 'a paired brick nobody hears stays in the list');
		done();
	});

	it('brings it back when it answers again', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.bt.push({ ...item(CCC.bt, Transport.BT, 'CCC'), paired: true, heard: false });
		await scheduler.scanOnce();

		seen.bt[0] = { ...seen.bt[0], heard: true, heardAt: Date.now() };
		await scheduler.scanOnce();
		assert.equal(stateOf(aggregator, Transport.BT), ChannelState.Available);
		done();
	});

	it('does not bring back a channel lost to a dropped session on an old answer', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		const heardAt = Date.now();
		seen.bt.push({ ...item(CCC.bt, Transport.BT, 'CCC'), paired: true, heard: true, heardAt });
		await scheduler.scanOnce();
		aggregator.updateChannelSession(CCC.bt, ConnectionState.Connected);
		aggregator.updateChannelSession(CCC.bt, ConnectionState.Reconnecting);

		await scheduler.scanOnce();   // same answer as before: not news
		assert.equal(stateOf(aggregator, Transport.BT), ChannelState.Lost);
		done();
	});
});

// ── Name ────────────────────────────────────────────────────────────

describe('PresenceAggregator — the name shown', () => {
	it('prefers the TCP beacon\'s name, confirmed, over the USB descriptor', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC', 'usb-descriptor'));
		await scheduler.scanOnce();
		assert.deepEqual(aggregator.getBrick(CCC_ID)?.name,
			{ value: 'CCC', source: 'usb-descriptor', confirmed: false });

		// Renamed on the brick: the descriptor keeps the old name, the beacon has the new one.
		seen.tcp.push(item(CCC.tcp, Transport.TCP, 'CCCx', 'beacon'));
		await scheduler.scanOnce();
		assert.deepEqual(aggregator.getBrick(CCC_ID)?.name,
			{ value: 'CCCx', source: 'beacon', confirmed: true });
		done();
	});

	it('does not let a later Windows Bluetooth record overrule a confirmed name', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.tcp.push(item(CCC.tcp, Transport.TCP, 'CCCx', 'beacon'));
		await scheduler.scanOnce();
		seen.bt.push(item(CCC.bt, Transport.BT, 'CCC', 'bt-cache'));
		await scheduler.scanOnce();

		assert.equal(aggregator.getBrick(CCC_ID)?.name.value, 'CCCx');
		done();
	});

	it('keeps a name the brick just confirmed while the beacon still repeats the old one', async () => {
		// The cockpit renamed the brick and read the new name back; the beacon catches up
		// seconds later. Until then it keeps announcing the old name every scan.
		const { seen, scheduler, aggregator, done } = setup();
		seen.tcp.push(item(CCC.tcp, Transport.TCP, 'CCC', 'beacon'));
		await scheduler.scanOnce();

		aggregator.confirmName(CCC_ID, 'Rover');
		await new Promise((resolve) => setTimeout(resolve, 5));   // the next scans are later
		await scheduler.scanOnce();
		await scheduler.scanOnce();
		assert.equal(aggregator.getBrick(CCC_ID)?.name.value, 'Rover');
		done();
	});

	it('prefers the USB descriptor over the Bluetooth record while nothing is confirmed', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.bt.push(item(CCC.bt, Transport.BT, 'Xfer data to and from EV3 brick', 'bt-cache'));
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC', 'usb-descriptor'));
		await scheduler.scanOnce();

		assert.equal(aggregator.getBrick(CCC_ID)?.name.value, 'CCC');
		done();
	});
});

// ── Local metadata ──────────────────────────────────────────────────

describe('PresenceAggregator — what the list owns', () => {
	it('reports a brick paired when its Bluetooth channel says so', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.bt.push({ ...item(CCC.bt, Transport.BT, 'CCC'), paired: true });
		await scheduler.scanOnce();
		assert.equal(aggregator.getBrick(CCC_ID)?.paired, true);
		done();
	});

	it('keeps favorite across scans', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC'));
		await scheduler.scanOnce();
		aggregator.updateBrick(CCC_ID, { favorite: true });
		await scheduler.scanOnce();
		assert.equal(aggregator.getBrick(CCC_ID)?.favorite, true);
		done();
	});

	it('merges a remembered brick once, and keeps it when its channels expire', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		aggregator.mergeRemembered([{ ...item(CCC.bt, Transport.BT, 'CCC'), presenceState: PresenceState.Remembered, remembered: true }]);
		seen.bt.push(item(CCC.bt, Transport.BT, 'CCC'));
		await scheduler.scanOnce();
		assert.equal(aggregator.getDiscoveryList().length, 1);

		seen.bt.length = 0;
		for (let i = 0; i < 3; i++) { await scheduler.scanOnce(); }
		assert.equal(aggregator.getBrick(CCC_ID)?.remembered, true);
		done();
	});

	it('forwards channel presence changes from the scheduler', async () => {
		const { seen, scheduler, aggregator, done } = setup();
		const events: PresenceState[] = [];
		aggregator.onPresenceChanged((e) => events.push(e.currentState));
		seen.usb.push(item(CCC.usb, Transport.USB, 'CCC'));
		await scheduler.scanOnce();
		assert.deepEqual(events, [PresenceState.Available]);
		done();
	});
});
