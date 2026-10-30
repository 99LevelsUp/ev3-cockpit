/**
 * Brick layer: one brick over several channels (step-2 plan, U4).
 *
 * Runs the real session manager, scheduler and aggregator over fake providers, so what is
 * tested is the shipped wiring between them and not a copy of it.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import {
	Transport, PresenceState, ConnectionState, makeBrickKey, brickIdOf,
	BrickKey, DiscoveryItem, BrickCommand, SendCommandOptions,
} from '../contracts';
import type { TransportProvider, SessionHandle, DiscoveryScanResult, BrickResponse } from '../contracts';
import { TransportError } from '../errors/CockpitError';
import { ProviderRegistry } from '../transports/providerRegistry';
import { DiscoveryScheduler } from '../runtime/discoveryScheduler';
import { PresenceAggregator } from '../runtime/presenceAggregator';
import { SessionManager } from '../runtime/sessionManager';
import { BrickManager } from '../runtime/brickManager';
import { waitFor } from './waitFor';

// ── A fake channel ──────────────────────────────────────────────────

interface FakeChannel {
	readonly provider: TransportProvider;
	/** What discovery reports; empty means the brick is not seen on this transport. */
	readonly seen: DiscoveryItem[];
	/** Connect attempts left to fail. */
	connectFailures: number;
	/** Connect attempts made. */
	connects: number;
	/** Commands fail with a link error while true. */
	failing: boolean;
	/** Commands that reached this channel, by kind. */
	readonly sent: string[];
}

function fakeChannel(transport: Transport, priority: number, extra: Partial<TransportProvider['capabilities']> = {}): FakeChannel {
	const channel: FakeChannel = {
		seen: [], connectFailures: 0, connects: 0, failing: false, sent: [],
		provider: undefined as unknown as TransportProvider,
	};
	const execute = (command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> => {
		channel.sent.push(command.kind);
		if (options?.signal?.aborted) {
			// What the USB adapter really reports for an abort.
			return Promise.reject(new TransportError(`${transport} send aborted.`));
		}
		if (channel.failing) {
			return Promise.reject(new TransportError(`${transport} send failed: LIBUSB_ERROR_IO`));
		}
		return Promise.resolve({ kind: 'battery', level: 80 });
	};
	(channel as { provider: TransportProvider }).provider = {
		transport,
		priority,
		capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: false, ...extra },
		async discover(): Promise<DiscoveryScanResult> { return { transport, items: [...channel.seen] }; },
		async connect(brickKey: BrickKey): Promise<SessionHandle> {
			channel.connects += 1;
			if (channel.connectFailures > 0) {
				channel.connectFailures -= 1;
				throw new TransportError(`${transport} connect failed`);
			}
			return { brickKey, transport };
		},
		async disconnect(): Promise<void> { /* nothing to close */ },
		async sendPacket(): Promise<Uint8Array> { throw new Error('not used: commands go through the channel below'); },
		createCommandChannel: () => ({ execute }),
		dispose(): void { /* nothing to release */ },
	};
	return channel;
}

function item(brickKey: BrickKey, transport: Transport): DiscoveryItem {
	return {
		brickKey, displayName: 'CCC', transport, presenceState: PresenceState.Available,
		remembered: false, connected: false, favorite: false, lastSeenAt: Date.now(),
	};
}

// ── The world ───────────────────────────────────────────────────────

const usbKey = makeBrickKey(Transport.USB, '00165342D9F2');
const btKey = makeBrickKey(Transport.BT, '00:16:53:42:D9:F2');
const CCC = brickIdOf(usbKey);

function world() {
	const usb = fakeChannel(Transport.USB, 30);
	const bt = fakeChannel(Transport.BT, 20, { rejoinOnEvidenceOnly: true });
	const registry = new ProviderRegistry();
	registry.register(usb.provider);
	registry.register(bt.provider);
	const scheduler = new DiscoveryScheduler(registry, { unavailableAfterMisses: 1, removedAfterMisses: 5 });
	const aggregator = new PresenceAggregator(scheduler, registry);
	const sessionManager = new SessionManager({
		providerRegistry: registry,
		heartbeatIntervalMs: 60_000,
		reconnectBaseMs: 20,
		reconnectMaxMs: 40,
	});
	const bricks = new BrickManager({
		sessionManager, aggregator, providerRegistry: registry, rejoinBaseMs: 20, rejoinMaxMs: 40,
	});
	const show = { usb: () => usb.seen.splice(0, usb.seen.length, item(usbKey, Transport.USB)),
		bt: () => bt.seen.splice(0, bt.seen.length, item(btKey, Transport.BT)) };
	const hide = { usb: () => { usb.seen.length = 0; }, bt: () => { bt.seen.length = 0; } };
	const done = () => {
		bricks.dispose(); sessionManager.dispose(); aggregator.dispose(); scheduler.dispose(); registry.dispose();
	};
	return { usb, bt, scheduler, aggregator, sessionManager, bricks, show, hide, done };
}

const battery: BrickCommand = { kind: 'battery' };

// ── Tests ───────────────────────────────────────────────────────────

describe('BrickManager — signing in', () => {
	it('opens every available channel and routes traffic over USB', async () => {
		const w = world();
		w.show.usb(); w.show.bt();
		await w.scheduler.scanOnce();

		await w.bricks.signIn(CCC);
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 1000);

		assert.equal(w.sessionManager.getSession(usbKey)?.connectionState, ConnectionState.Connected);
		assert.equal(w.bricks.routeOf(CCC), usbKey);
		await w.bricks.send(CCC, battery);
		assert.deepEqual([w.usb.sent, w.bt.sent], [['battery'], []]);
		w.done();
	});

	it('makes the signed-in brick active, and clears it on sign-out', async () => {
		const w = world();
		w.show.usb();
		await w.scheduler.scanOnce();

		await w.bricks.signIn(CCC);
		assert.equal(w.bricks.getActiveBrickId(), CCC);
		await w.bricks.signOut(CCC);
		assert.equal(w.bricks.getActiveBrickId(), undefined);
		w.done();
	});

	it('refuses to sign in a brick that is available on no channel', async () => {
		const w = world();
		await assert.rejects(w.bricks.signIn(CCC), /not available/);
		assert.equal(w.bricks.isSignedIn(CCC), false);
		w.done();
	});

	it('routes a single-channel brick over its one channel, whatever its priority', async () => {
		const mock = fakeChannel(Transport.Mock, 0);
		const mockKey = makeBrickKey(Transport.Mock, 'brick-a');
		mock.seen.push(item(mockKey, Transport.Mock));
		const registry = new ProviderRegistry();
		registry.register(mock.provider);
		const scheduler = new DiscoveryScheduler(registry);
		const aggregator = new PresenceAggregator(scheduler, registry);
		const sessionManager = new SessionManager({ providerRegistry: registry, heartbeatIntervalMs: 60_000 });
		const bricks = new BrickManager({ sessionManager, aggregator, providerRegistry: registry });
		await scheduler.scanOnce();

		await bricks.signIn(brickIdOf(mockKey));
		assert.equal(bricks.routeOf(brickIdOf(mockKey)), mockKey);
		bricks.dispose(); sessionManager.dispose(); aggregator.dispose(); scheduler.dispose(); registry.dispose();
	});
});

describe('BrickManager — failing over', () => {
	it('sends the next command over Bluetooth after one fails on a pulled cable', async () => {
		const w = world();
		w.show.usb(); w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 1000);

		w.usb.failing = true;   // cable out
		await assert.rejects(w.bricks.send(CCC, battery), /LIBUSB_ERROR_IO/);
		assert.deepEqual(w.bt.sent, [], 'the failed command must not have been resent over Bluetooth');

		// No heartbeat tick in between: its interval here is a minute.
		await w.bricks.send(CCC, battery);
		assert.equal(w.bricks.routeOf(CCC), btKey);
		assert.deepEqual(w.bt.sent, ['battery']);
		w.done();
	});

	it('takes a dead USB channel to reconnecting at once, and back to USB when the cable returns', async () => {
		const w = world();
		w.show.usb(); w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 1000);

		w.usb.failing = true;
		await assert.rejects(w.bricks.send(CCC, battery));
		await waitFor(() => w.sessionManager.getSession(usbKey)?.connectionState === ConnectionState.Reconnecting, 1000);

		w.usb.failing = false;   // cable back in; the session reconnects on its own backoff
		await waitFor(() => w.bricks.routeOf(CCC) === usbKey, 1000);
		w.done();
	});

	it('puts a channel back into routing when the failure was a one-off', async () => {
		const w = world();
		w.show.usb(); w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 1000);

		w.usb.failing = true;
		const failed = w.bricks.send(CCC, battery);
		w.usb.failing = false;   // only that one command hit the fault; the probe that follows answers
		await assert.rejects(failed);

		await waitFor(() => w.bricks.routeOf(CCC) === usbKey, 1000);
		assert.equal(w.sessionManager.getSession(usbKey)?.connectionState, ConnectionState.Connected);
		w.done();
	});

	it('does not fail over on a command the caller aborted', async () => {
		const w = world();
		w.show.usb(); w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 1000);

		const controller = new AbortController();
		controller.abort();
		await assert.rejects(w.bricks.send(CCC, battery, { signal: controller.signal }));

		assert.equal(w.bricks.routeOf(CCC), usbKey);
		assert.deepEqual(w.usb.sent, ['battery'], 'an abort must not have triggered a probe either');
		w.done();
	});
});

describe('BrickManager — channels that come later', () => {
	it('joins a USB channel that appears after a Bluetooth-only sign-in, and moves traffic to it', async () => {
		const w = world();
		w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);
		assert.equal(w.bricks.routeOf(CCC), btKey);

		w.show.usb();   // cable plugged in
		await w.scheduler.scanOnce();
		await waitFor(() => w.bricks.routeOf(CCC) === usbKey, 1000);
		w.done();
	});

	it('retries a failed USB join on a backoff, without the cable being replugged', async () => {
		const w = world();
		w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);

		w.usb.connectFailures = 1;
		w.show.usb();
		await w.scheduler.scanOnce();
		await waitFor(() => w.bricks.routeOf(CCC) === usbKey, 1000);
		assert.equal(w.usb.connects, 2);
		w.done();
	});

	it('leaves a failed Bluetooth join alone until the brick is seen again', async () => {
		const w = world();
		w.show.usb(); w.show.bt();
		await w.scheduler.scanOnce();
		w.bt.connectFailures = 1;

		await w.bricks.signIn(CCC);   // USB connects; BT fails
		await waitFor(() => w.bt.connects === 1, 1000);
		for (let i = 0; i < 3; i++) { await w.scheduler.scanOnce(); }
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(w.bt.connects, 1, 'Bluetooth must not be retried on a timer or on every scan');

		w.hide.bt(); await w.scheduler.scanOnce();   // out of range
		w.show.bt(); await w.scheduler.scanOnce();   // and back: new evidence
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 1000);
		assert.equal(w.bt.connects, 2);
		w.done();
	});
});

describe('BrickManager — signing out', () => {
	it('closes every channel and does not join one that appears afterwards', async () => {
		const w = world();
		w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);

		await w.bricks.signOut(CCC);
		assert.equal(w.sessionManager.getSession(btKey), undefined);

		w.show.usb();
		await w.scheduler.scanOnce();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(w.usb.connects, 0);
		assert.equal(w.bricks.routeOf(CCC), undefined);
		w.done();
	});
});
