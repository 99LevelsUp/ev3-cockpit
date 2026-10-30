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
import { ChannelChangedError, TransportError } from '../errors/CockpitError';
import { createBrickFilesystem } from '../fs/brickFilesystem';
import { TelemetryService } from '../telemetry/telemetryService';
import { cadenceFor } from '../telemetry/telemetryConstants';
import { EV3_REPLY, decodeEv3Packet, encodeEv3Packet } from '../protocol/ev3Packet';
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
	/** When set, a `fs:continueWrite` waits for it before answering: the middle of a transfer. */
	gate?: Promise<void>;
	/** The name the brick answers `info` with; `info` is not recorded in `sent`. */
	name: string;
	/** Probes opened, when the transport offers them. */
	probes: number;
	/** When set, opening a probe fails with this. */
	probeFailure?: string;
}

/** An `info` reply packet, as the brick sends it: the name in the first 16 bytes of 72. */
function infoReply(request: Uint8Array, name: string): Uint8Array {
	const payload = new Uint8Array(72);
	payload.set(new TextEncoder().encode(name).subarray(0, 15), 0);
	return encodeEv3Packet(decodeEv3Packet(request).messageCounter, EV3_REPLY.DIRECT_REPLY, payload);
}

/** A gate a test opens when it is done doing things in the middle of a transfer. */
function gate(): { promise: Promise<void>; open: () => void } {
	let open = () => { /* replaced below */ };
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
}

function fakeChannel(
	transport: Transport,
	priority: number,
	extra: Partial<TransportProvider['capabilities']> = {},
	probes = false,
): FakeChannel {
	const channel: FakeChannel = {
		seen: [], connectFailures: 0, connects: 0, failing: false, sent: [], name: 'CCC', probes: 0,
		provider: undefined as unknown as TransportProvider,
	};
	const execute = async (command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> => {
		if (command.kind === 'info' && !channel.failing) {
			return { kind: 'info', displayName: channel.name };
		}
		channel.sent.push(command.kind);
		if (options?.signal?.aborted) {
			// What the USB adapter really reports for an abort.
			throw new TransportError(`${transport} send aborted.`);
		}
		if (channel.failing) {
			throw new TransportError(`${transport} send failed: LIBUSB_ERROR_IO`);
		}
		switch (command.kind) {
			case 'fs:beginWrite': return { kind: 'fs:beginWrite', handle: 1, endOfFile: false };
			case 'fs:continueWrite':
				await channel.gate;
				return { kind: 'fs:continueWrite', handle: 1, endOfFile: false };
			case 'fs:closeHandle': return { kind: 'fs:closeHandle' };
			case 'brick:setName':
				channel.name = command.name;
				return { kind: 'brick:setName' };
			default: return { kind: 'battery', level: 80 };
		}
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
		...(probes ? {
			async openProbe() {
				if (channel.probeFailure) { throw new Error(channel.probeFailure); }
				channel.probes += 1;
				return {
					sendPacket: async (packet: Uint8Array) => infoReply(packet, channel.name),
					close: async () => { /* nothing held */ },
				};
			},
		} : {}),
		dispose(): void { /* nothing to release */ },
	};
	return channel;
}

function item(brickKey: BrickKey, transport: Transport): DiscoveryItem {
	return {
		brickKey, displayName: 'CCC', nameSource: 'usb-descriptor', transport, presenceState: PresenceState.Available,
		remembered: false, connected: false, favorite: false, lastSeenAt: Date.now(),
	};
}

// ── The world ───────────────────────────────────────────────────────

const usbKey = makeBrickKey(Transport.USB, '00165342D9F2');
const btKey = makeBrickKey(Transport.BT, '00:16:53:42:D9:F2');
const CCC = brickIdOf(usbKey);

function world(frames = false) {
	const usb = fakeChannel(Transport.USB, 30, { supportsTelemetryFrames: frames }, true);
	const bt = fakeChannel(Transport.BT, 20, { rejoinOnEvidenceOnly: true, supportsTelemetryFrames: frames });
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
	return { usb, bt, registry, scheduler, aggregator, sessionManager, bricks, show, hide, done };
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

describe('BrickManager — a transfer keeps its channel', () => {
	const file = new Uint8Array(3000);   // a few chunks at the firmware's 1024-byte packet

	it('finishes a Bluetooth transfer over Bluetooth when USB joins mid-way', async () => {
		const w = world();
		w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);
		const middle = gate();
		w.bt.gate = middle.promise;

		const fs = createBrickFilesystem(w.bricks, CCC);
		const transfer = fs.transfer.writeFile('/home/root/lms2012/prjs/a.rbf', file);
		await waitFor(() => w.bt.sent.includes('fs:continueWrite'), 1000);

		w.show.usb();   // the cable goes back in mid-transfer
		await w.scheduler.scanOnce();
		await waitFor(() => w.bricks.routeOf(CCC) === usbKey, 1000);
		await w.bricks.send(CCC, battery);   // everyone else follows the new route

		middle.open();
		await transfer;
		assert.deepEqual(w.usb.sent, ['battery'], 'no step of the transfer may have gone over USB');
		assert.ok(w.bt.sent.filter((k) => k === 'fs:continueWrite').length >= 2);
		w.done();
	});

	it('fails a USB transfer with "channel changed" when USB is lost mid-way, and sends no step over Bluetooth', async () => {
		const w = world();
		w.show.usb(); w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 1000);
		const middle = gate();
		w.usb.gate = middle.promise;

		const fs = createBrickFilesystem(w.bricks, CCC);
		const transfer = fs.transfer.writeFile('/home/root/lms2012/prjs/a.rbf', file);
		await waitFor(() => w.usb.sent.includes('fs:continueWrite'), 1000);

		// The heartbeat finds the cable gone while a chunk is in flight.
		w.sessionManager['handleHeartbeatFailure'](usbKey, new TransportError('cable out'));
		middle.open();

		await assert.rejects(transfer, ChannelChangedError);
		assert.deepEqual(w.bt.sent.filter((k) => k.startsWith('fs:')), []);
		w.done();
	});
});

describe('BrickManager — telemetry follows the route', () => {
	it('restarts the active brick loop at the Bluetooth cadence when traffic moves off USB', async () => {
		const w = world(true);
		w.show.usb(); w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 1000);
		const telemetry = new TelemetryService({ host: w.bricks.telemetryHost(), providerRegistry: w.registry });
		try {
			assert.equal(telemetry.loopFor(CCC)?.tickPeriodMs, cadenceFor(Transport.USB).foregroundMs);

			w.usb.failing = true;   // cable out
			await assert.rejects(w.bricks.send(CCC, battery));
			await waitFor(() => w.bricks.routeOf(CCC) === btKey, 1000);

			assert.equal(telemetry.loopFor(CCC)?.tickPeriodMs, cadenceFor(Transport.BT).foregroundMs);
		} finally {
			// A running loop holds a timer; left behind, it keeps the test process alive.
			telemetry.dispose();
			w.done();
		}
	});
});

describe('BrickManager — the name the brick reports', () => {
	const nameOf = (w: ReturnType<typeof world>) => w.aggregator.getBrick(CCC)?.name;

	it('asks a brick that appears on USB for its name, once, without signing it in', async () => {
		const w = world();
		w.usb.name = 'CCCx';   // renamed since the cable went in; the descriptor still says CCC
		w.show.usb();
		await w.scheduler.scanOnce();
		await waitFor(() => nameOf(w)?.value === 'CCCx', 1000);

		assert.deepEqual(nameOf(w), { value: 'CCCx', source: 'brick', confirmed: true });
		await w.scheduler.scanOnce();
		assert.equal(w.usb.probes, 1);
		assert.equal(w.usb.connects, 0, 'asking the name must not have opened a session');
		w.done();
	});

	it('reads the name over the session when a signed-in brick gains a USB channel, without a probe', async () => {
		const w = world();
		w.show.bt();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);

		w.usb.name = 'CCCj';
		w.show.usb();
		await w.scheduler.scanOnce();
		await waitFor(() => nameOf(w)?.value === 'CCCj', 1000);
		assert.equal(w.usb.probes, 0);
		w.done();
	});

	it('keeps the descriptor name, unconfirmed, when the probe cannot open the device, and says so once', async () => {
		const warnings: string[] = [];
		const w = world();
		w.bricks.dispose();
		const bricks = new BrickManager({
			sessionManager: w.sessionManager, aggregator: w.aggregator, providerRegistry: w.registry,
			log: { warn: (message) => warnings.push(message) },
		});
		w.usb.probeFailure = 'LIBUSB_ERROR_BUSY';
		w.show.usb(); await w.scheduler.scanOnce();
		w.hide.usb(); await w.scheduler.scanOnce();
		w.show.usb(); await w.scheduler.scanOnce();   // plugged in again
		await new Promise((resolve) => setTimeout(resolve, 20));

		assert.deepEqual(nameOf(w), { value: 'CCC', source: 'usb-descriptor', confirmed: false });
		assert.equal(warnings.length, 1);
		bricks.dispose();
		w.done();
	});

	it('shows a rename made through the cockpit as soon as the brick confirms it', async () => {
		const w = world();
		w.show.usb();
		await w.scheduler.scanOnce();
		await w.bricks.signIn(CCC);

		await w.bricks.send(CCC, { kind: 'brick:setName', name: 'Rover' });
		await waitFor(() => nameOf(w)?.value === 'Rover', 1000);
		assert.equal(nameOf(w)?.confirmed, true);
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
