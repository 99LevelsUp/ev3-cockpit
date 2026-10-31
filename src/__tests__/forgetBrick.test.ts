/**
 * Forgetting a brick (step-3 plan, U4): `BrickManager.forget` across the brick's own list, the
 * operating-system pairing and the cockpit's memory.
 *
 * Runs the real registry, scheduler, aggregator, session manager and brick layer. The brick
 * is the shipped mock brick, so its peer list matches and removes names as the mock does; the
 * USB and Bluetooth providers in front of it are fakes that add what a link does — a
 * Bluetooth link the removal of this computer's entry cuts (`c_bt.c` 3609–3612), and a
 * Windows pairing the Bluetooth provider forgets.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import {
	BrickCommand, BrickKey, BrickResponse, ConnectionState, DiscoveryItem, ForgetResidue, PresenceState, Transport,
	brickIdOf, makeBrickKey,
} from '../contracts';
import type { DiscoveryScanResult, SessionHandle, TransportProvider } from '../contracts';
import { TimeoutError, TransportError } from '../errors/CockpitError';
import { MockTransportProvider } from '../mock';
import { EV3_REPLY, decodeEv3Packet, encodeEv3Packet } from '../protocol/ev3Packet';
import { ProviderRegistry } from '../transports/providerRegistry';
import { DiscoveryScheduler } from '../runtime/discoveryScheduler';
import { PresenceAggregator } from '../runtime/presenceAggregator';
import { SessionManager } from '../runtime/sessionManager';
import { BrickManager } from '../runtime/brickManager';
import { waitFor } from './waitFor';

const THIS_PC = 'Petrův PC';
const MAC = '00:16:53:42:D9:F2';
const usbKey = makeBrickKey(Transport.USB, '00165342D9F2');
const btKey = makeBrickKey(Transport.BT, MAC);
const CCC = brickIdOf(usbKey);

/** What the Bluetooth provider says Windows keeps, returned by its `forget`. */
const RESIDUE: readonly ForgetResidue[] = [
	{ location: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\00165342d9f2', reason: 'owned by SYSTEM' },
	{ location: 'Windows\' in-memory Bluetooth device record for 00165342D9F2', reason: 'until Windows restarts' },
];

const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A gate a test opens when it has looked at the middle of something. */
function gate(): { promise: Promise<void>; open: () => void } {
	let open = () => { /* replaced below */ };
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
}

/** An `info` reply packet, as the brick sends it: the name in the first 16 bytes of 72. */
function infoReply(request: Uint8Array, name: string): Uint8Array {
	const payload = new Uint8Array(72);
	payload.set(new TextEncoder().encode(name).subarray(0, 15), 0);
	return encodeEv3Packet(decodeEv3Packet(request).messageCounter, EV3_REPLY.DIRECT_REPLY, payload);
}

interface WorldOptions {
	/** The brick's Bluetooth list. */
	readonly peers?: string[];
	/** This computer's Bluetooth name; `undefined` when it cannot be read. */
	readonly radio?: string | undefined;
	/** Whether the USB cable is in. */
	readonly cabled?: boolean;
	/** Whether Windows has the brick paired, so Bluetooth discovery lists it. */
	readonly paired?: boolean;
	/** The session manager's reconnect backoff; short by default, so a reconnect shows. */
	readonly reconnectBaseMs?: number;
	/** Replaces the radio-name hook, for one that throws. */
	readonly radioName?: () => string | undefined;
}

/** What reached the brick, in order: each command's kind, its channel, and whether a Bluetooth link was open. */
interface Received {
	readonly over: Transport;
	readonly kind: BrickCommand['kind'];
	readonly btLinkOpen: boolean;
}

function world(options: WorldOptions = {}) {
	const radio = 'radio' in options ? options.radio : THIS_PC;
	const mockKey = makeBrickKey(Transport.Mock, 'CCC');
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'CCC', displayName: 'CCC', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
			bluetoothPeers: options.peers ?? ['Office PC', THIS_PC],
		}],
	});
	void mock.connect(mockKey);   // the brick is on; the links below are what come and go

	const brick = {
		received: [] as Received[],
		/** The firmware acks a removal it does not run: its Bluetooth is off or busy. */
		ignoresRemoval: false,
		/** After a removal, the list cannot be read back. */
		readBackFails: false,
		removalSeen: false,
		/** A reply that waits for this, by command kind, once. */
		holds: new Map<BrickCommand['kind'], Promise<void>>(),
		peers: (): string[] => mock['bricks'].get(mockKey)!.bluetoothPeers.slice(),
	};
	const usb = {
		cabled: options.cabled ?? true, connects: 0, open: false, probes: 0,
		/** Every command that reached the USB link, by kind, before it was answered or failed. */
		attempted: [] as string[],
		/** Commands of these kinds fail as a dead link would. */
		failKinds: new Set<string>(),
	};
	const bt = {
		paired: options.paired ?? true, connects: 0, open: false,
		/** Not heard by the presence checks: the list shows the channel lost. */
		unheard: false,
		attempted: [] as string[],
		unpairs: [] as BrickKey[],
		/** The reason Windows gives for refusing the unpair, when it does. */
		refuse: undefined as string | undefined,
		discoverGate: undefined as Promise<void> | undefined,
		forgetGate: undefined as Promise<void> | undefined,
	};

	const answer = async (over: Transport, command: BrickCommand): Promise<BrickResponse> => {
		brick.received.push({ over, kind: command.kind, btLinkOpen: bt.open });
		const hold = brick.holds.get(command.kind);
		if (hold) { brick.holds.delete(command.kind); await hold; }
		if (command.kind === 'brick:bluetoothPeerCount' && brick.removalSeen && brick.readBackFails) {
			throw new TimeoutError('no reply to the read-back');
		}
		if (command.kind === 'brick:removeBluetoothPeer') {
			brick.removalSeen = true;
			if (brick.ignoresRemoval) { return { kind: 'brick:removeBluetoothPeer' }; }
			const reply = await mock.executeCommand(mockKey, command);
			// The brick closes the removed peer's RFCOMM channel before it answers anything.
			if (command.name === THIS_PC && bt.open) {
				bt.open = false;
				if (over === Transport.BT) { throw new TimeoutError('BT reply timed out'); }
			}
			return reply;
		}
		return mock.executeCommand(mockKey, command);
	};

	const usbProvider: TransportProvider = {
		transport: Transport.USB,
		priority: 30,
		capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: false },
		async discover(): Promise<DiscoveryScanResult> {
			const items: DiscoveryItem[] = usb.cabled ? [{
				brickKey: usbKey, displayName: 'CCC', nameSource: 'usb-descriptor', transport: Transport.USB,
				presenceState: PresenceState.Available, remembered: false, connected: false, favorite: false,
				lastSeenAt: Date.now(),
			}] : [];
			return { transport: Transport.USB, items };
		},
		async connect(brickKey: BrickKey): Promise<SessionHandle> {
			usb.connects += 1;
			usb.open = true;
			return { brickKey, transport: Transport.USB };
		},
		async disconnect(): Promise<void> { usb.open = false; },
		async sendPacket(): Promise<Uint8Array> { throw new Error('not used: commands go through the channel below'); },
		createCommandChannel: () => ({
			execute: async (command) => {
				usb.attempted.push(command.kind);
				if (!usb.open || usb.failKinds.has(command.kind)) { throw new TransportError('USB send failed: LIBUSB_ERROR_IO'); }
				return answer(Transport.USB, command);
			},
		}),
		async openProbe() {
			usb.probes += 1;
			return {
				sendPacket: async (packet: Uint8Array) => infoReply(packet, 'CCC'),
				close: async () => { /* nothing held */ },
			};
		},
		dispose(): void { /* nothing to release */ },
	};

	const btProvider: TransportProvider = {
		transport: Transport.BT,
		priority: 20,
		capabilities: {
			supportsSignalInfo: false, supportsForget: true, supportsTelemetryFrames: false, rejoinOnEvidenceOnly: true,
		},
		async discover(): Promise<DiscoveryScanResult> {
			// Read before any hold: a scan that started before the unpair lists what it saw then.
			const listed = bt.paired;
			const unheard = bt.unheard;
			const held = bt.discoverGate;
			bt.discoverGate = undefined;
			if (held) { await held; }
			const items: DiscoveryItem[] = listed ? [{
				brickKey: btKey, displayName: 'CCC', nameSource: 'bt-cache', transport: Transport.BT,
				presenceState: PresenceState.Available, remembered: true, paired: true, connected: false, favorite: false,
				lastSeenAt: Date.now(), ...(unheard ? { heard: false } : {}),
			}] : [];
			return { transport: Transport.BT, items };
		},
		async connect(brickKey: BrickKey): Promise<SessionHandle> {
			bt.connects += 1;
			bt.open = true;
			return { brickKey, transport: Transport.BT };
		},
		async disconnect(): Promise<void> { bt.open = false; },
		async sendPacket(): Promise<Uint8Array> { throw new Error('not used: commands go through the channel below'); },
		createCommandChannel: () => ({
			execute: async (command) => {
				bt.attempted.push(command.kind);
				if (!bt.open) { throw new TransportError('BT link closed'); }
				return answer(Transport.BT, command);
			},
		}),
		async forget(brickKey: BrickKey): Promise<readonly ForgetResidue[]> {
			bt.unpairs.push(brickKey);
			if (bt.forgetGate) { await bt.forgetGate; }
			bt.open = false;
			if (bt.refuse) { throw new TransportError(`Could not forget 00165342D9F2: ${bt.refuse}`); }
			bt.paired = false;
			return RESIDUE;
		},
		dispose(): void { /* nothing to release */ },
	};

	const registry = new ProviderRegistry();
	registry.register(usbProvider);
	registry.register(btProvider);
	const scheduler = new DiscoveryScheduler(registry, { unavailableAfterMisses: 1, removedAfterMisses: 5 });
	const aggregator = new PresenceAggregator(scheduler, registry);
	const sessionManager = new SessionManager({
		providerRegistry: registry,
		heartbeatIntervalMs: 60_000,
		reconnectBaseMs: options.reconnectBaseMs ?? 20,
		reconnectMaxMs: Math.max(40, options.reconnectBaseMs ?? 0),
	});
	const presence = { forgotten: [] as string[], forget(mac: string) { this.forgotten.push(mac); } };
	const bricks = new BrickManager({
		sessionManager, aggregator, providerRegistry: registry, rejoinBaseMs: 20, rejoinMaxMs: 40,
		discovery: scheduler, btPresence: presence, radioName: options.radioName ?? (() => radio),
	});
	const done = () => {
		bricks.dispose(); sessionManager.dispose(); aggregator.dispose(); scheduler.dispose(); registry.dispose();
		mock.dispose();
	};
	/** The kinds of the peer-list commands that reached the brick over a transport. */
	const peerTraffic = (over?: Transport): string[] => brick.received
		.filter((r) => (over === undefined || r.over === over) && r.kind.includes('luetooth'))
		.map((r) => r.kind.replace('brick:', ''));
	return { mock, brick, usb, bt, registry, scheduler, aggregator, sessionManager, bricks, presence, peerTraffic, done };
}

type World = ReturnType<typeof world>;

async function signedInOver(w: World, ...transports: Transport[]): Promise<void> {
	await w.scheduler.scanOnce();
	await w.bricks.signIn(CCC);
	for (const transport of transports) {
		const key = transport === Transport.USB ? usbKey : btKey;
		await waitFor(() => w.sessionManager.getSession(key)?.connectionState === ConnectionState.Connected, 1000);
	}
}

// ── The brick's own list ────────────────────────────────────────────

describe('Forget a brick — this computer\'s entry on the brick (R7–R9)', () => {
	it('removes the entry over USB and confirms it from the list read back', async () => {
		const w = world({ paired: false });
		await signedInOver(w, Transport.USB);

		const report = await w.bricks.forget(CCC);

		assert.deepEqual(report.brickSide, { status: 'confirmed', name: THIS_PC, over: usbKey });
		assert.deepEqual(report.peers, ['Office PC', THIS_PC]);
		assert.deepEqual(w.peerTraffic(Transport.USB), [
			'bluetoothPeerCount', 'bluetoothPeer', 'bluetoothPeer', 'removeBluetoothPeer',
			'bluetoothPeerCount', 'bluetoothPeer',
		]);
		assert.deepEqual(w.brick.peers(), ['Office PC']);
		assert.deepEqual(report.pairing, [], 'a brick known over USB alone has no pairing to remove');
		assert.deepEqual(report.residue, []);
		assert.deepEqual(report.memory, { status: 'cleared' });
		assert.equal(w.sessionManager.getSession(usbKey), undefined, 'the USB session is still open');
		assert.equal(w.bricks.isSignedIn(CCC), false);
		w.done();
	});

	it('reports failed over USB when the brick acknowledges the removal but the list still holds the entry', async () => {
		const w = world({ paired: false });
		await signedInOver(w, Transport.USB);
		w.brick.ignoresRemoval = true;

		const report = await w.bricks.forget(CCC);

		assert.equal(report.brickSide.status, 'failed');
		assert.deepEqual(w.peerTraffic(Transport.USB).slice(3), ['removeBluetoothPeer', 'bluetoothPeerCount', 'bluetoothPeer', 'bluetoothPeer'],
			'the list was not read back after the removal');
		w.done();
	});

	it('reports a removal over the Bluetooth link it cuts as sent, not confirmed, and nothing reconnects', async () => {
		const w = world({ cabled: false });
		await signedInOver(w, Transport.BT);

		const report = await w.bricks.forget(CCC);
		await settle();

		assert.equal(report.brickSide.status, 'sent');
		assert.deepEqual(report.brickSide, {
			status: 'sent', name: THIS_PC, over: btKey, detail: 'BT reply timed out',
		});
		assert.deepEqual(w.peerTraffic(Transport.BT), ['bluetoothPeerCount', 'bluetoothPeer', 'bluetoothPeer', 'removeBluetoothPeer']);
		assert.equal(w.bt.connects, 1, 'a reconnect reached the Bluetooth provider after the removal cut the link');
		assert.equal(w.sessionManager.getSession(btKey), undefined, 'the Bluetooth session did not end');
		assert.deepEqual(report.pairing, [{ status: 'removed', channel: btKey }]);
		assert.deepEqual(report.residue, RESIDUE, 'the provider\'s residue was not carried unchanged');
		w.done();
	});

	it('reads the list back over Bluetooth when the removal gets a normal reply, and reports failed when the entry stays', async () => {
		const w = world({ cabled: false });
		await signedInOver(w, Transport.BT);
		w.brick.ignoresRemoval = true;   // the brick's Bluetooth is busy: it answers and does nothing

		const report = await w.bricks.forget(CCC);

		assert.equal(report.brickSide.status, 'failed');
		assert.deepEqual(w.peerTraffic(Transport.BT), [
			'bluetoothPeerCount', 'bluetoothPeer', 'bluetoothPeer', 'removeBluetoothPeer',
			'bluetoothPeerCount', 'bluetoothPeer', 'bluetoothPeer',
		]);
		assert.deepEqual(w.brick.peers(), ['Office PC', THIS_PC]);
		w.done();
	});

	it('reports sent, not failed, when the brick answers the removal but the list cannot be read back', async () => {
		const w = world({ cabled: false });
		await signedInOver(w, Transport.BT);
		w.brick.ignoresRemoval = true;
		w.brick.readBackFails = true;

		const report = await w.bricks.forget(CCC);

		assert.deepEqual(report.brickSide, {
			status: 'sent', name: THIS_PC, over: btKey, detail: 'no reply to the read-back',
		});
		w.done();
	});

	it('removes nothing when no entry carries this computer\'s exact name, and reports the names held', async () => {
		const w = world({ peers: ['Office PC', 'petrův pc', 'Petrův PC '], paired: false });
		await signedInOver(w, Transport.USB);

		const report = await w.bricks.forget(CCC);

		assert.deepEqual(report.brickSide, { status: 'skipped', reason: 'no-match' });
		assert.deepEqual(report.peers, ['Office PC', 'petrův pc', 'Petrův PC ']);
		assert.ok(!w.peerTraffic().includes('removeBluetoothPeer'), 'a removal was sent');
		w.done();
	});

	it('sends nothing to a brick with no available channel, and still unpairs and forgets it', async () => {
		const w = world({ cabled: false });
		w.bt.unheard = true;   // paired, but the presence checks no longer hear it: switched off
		await w.scheduler.scanOnce();

		const report = await w.bricks.forget(CCC);

		assert.deepEqual(report.brickSide, { status: 'skipped', reason: 'not-reachable' });
		assert.equal(report.peers, undefined);
		assert.deepEqual(w.brick.received, []);
		assert.equal(w.bt.connects, 0);
		assert.deepEqual(w.bt.unpairs, [btKey]);
		assert.deepEqual(report.pairing, [{ status: 'removed', channel: btKey }]);
		assert.equal(w.aggregator.getBrick(CCC), undefined, 'the cockpit still lists the brick');
		w.done();
	});

	it('removes nothing when this computer\'s Bluetooth name is unknown, and says so', async () => {
		const w = world({ radio: undefined });
		await signedInOver(w, Transport.USB, Transport.BT);

		const report = await w.bricks.forget(CCC);

		assert.deepEqual(report.brickSide, { status: 'skipped', reason: 'radio-name-unknown' });
		assert.deepEqual(w.peerTraffic(), [], 'the brick was asked about its list');
		assert.deepEqual(w.brick.peers(), ['Office PC', THIS_PC]);
		assert.deepEqual(w.bt.unpairs, [btKey]);
		w.done();
	});

	it('records a brick side that throws, and still unpairs and forgets the brick', async () => {
		const w = world({ radioName: () => { throw new Error('radio went away'); } });
		await signedInOver(w, Transport.USB, Transport.BT);

		const report = await w.bricks.forget(CCC);

		assert.deepEqual(report.brickSide, { status: 'skipped', reason: 'error', detail: 'radio went away' });
		assert.deepEqual(w.bt.unpairs, [btKey]);
		assert.deepEqual(report.memory, { status: 'cleared' });
		assert.equal(w.aggregator.getBrick(CCC)?.paired, false);
		w.done();
	});

	it('opens only the USB channel of a brick available on USB and Bluetooth with no session', async () => {
		const w = world();
		await w.scheduler.scanOnce();

		const report = await w.bricks.forget(CCC);

		assert.deepEqual(report.brickSide, { status: 'confirmed', name: THIS_PC, over: usbKey });
		assert.equal(w.usb.connects, 1);
		assert.equal(w.bt.connects, 0, 'a Bluetooth connect reached the provider');
		assert.equal(w.bricks.isSignedIn(CCC), false);
		assert.equal(w.sessionManager.getSession(usbKey), undefined, 'the channel the forget opened is still open');
		w.done();
	});

	it('closes the Bluetooth session before a USB removal, and nothing reconnects it once the brick drops the link', async () => {
		const w = world();
		await signedInOver(w, Transport.USB, Transport.BT);
		assert.equal(w.bt.connects, 1);

		const report = await w.bricks.forget(CCC);
		await settle();

		assert.deepEqual(report.brickSide, { status: 'confirmed', name: THIS_PC, over: usbKey });
		const removal = w.brick.received.find((r) => r.kind === 'brick:removeBluetoothPeer');
		assert.equal(removal?.btLinkOpen, false, 'the Bluetooth link was still open when the removal ran');
		// The Bluetooth close is a session ending while the brick is signed in, which would
		// otherwise rejoin it.
		assert.equal(w.bt.connects, 1, 'a connect reached the Bluetooth provider during or after the forget');
		w.done();
	});
});

// ── Nothing reopens the brick while it is forgotten (R3, KTD4) ─────

describe('Forget a brick — nothing opens or probes it meanwhile (R3)', () => {
	it('starts no name probe for a presence event, and refuses a sign-in from outside', async () => {
		const w = world();
		await w.scheduler.scanOnce();
		await waitFor(() => w.usb.probes === 1, 1000);   // the cable's first sighting asks the name
		const held = gate();
		w.bt.forgetGate = held.promise;

		const forgetting = w.bricks.forget(CCC);
		await waitFor(() => w.bt.unpairs.length === 1, 1000);
		w.usb.cabled = false; await w.scheduler.scanOnce();
		w.usb.cabled = true; await w.scheduler.scanOnce();   // the cable back: a presence event
		await settle(30);
		const connectsBefore = w.usb.connects;
		await assert.rejects(w.bricks.signIn(CCC), /being forgotten/);
		await settle(30);
		const probesDuringForget = w.usb.probes;
		const connectsDuringForget = w.usb.connects;
		held.open();
		await forgetting;

		assert.equal(probesDuringForget, 1, 'a name probe opened the brick while it was being forgotten');
		assert.equal(connectsDuringForget, connectsBefore, 'the refused sign-in opened a channel');
		// Once forgotten, the cable's sighting is a stranger's, and its name is asked again.
		await waitFor(() => w.usb.probes === 2, 1000);
		w.done();
	});

	it('does not hand a presence event to a reconnecting session', async () => {
		const w = world({ reconnectBaseMs: 60_000 });
		await signedInOver(w, Transport.USB, Transport.BT);
		w.sessionManager['handleHeartbeatFailure'](btKey, new TransportError('link went away'));
		assert.equal(w.sessionManager.getSession(btKey)?.connectionState, ConnectionState.Reconnecting);
		const held = gate();
		w.brick.holds.set('brick:bluetoothPeerCount', held.promise);

		const forgetting = w.bricks.forget(CCC);
		await waitFor(() => w.peerTraffic().length === 1, 1000);
		w.bt.paired = false; await w.scheduler.scanOnce();
		w.bt.paired = true; await w.scheduler.scanOnce();   // the brick seen again: what a reconnect waits for
		await settle(30);
		held.open();
		await forgetting;

		assert.equal(w.bt.connects, 1, 'the sighting reconnected the Bluetooth session during the forget');
		w.done();
	});

	it('does not take a channel out of routing, or probe it, when an outside command fails on it', async () => {
		const w = world();
		await signedInOver(w, Transport.USB, Transport.BT);
		const held = gate();
		w.brick.holds.set('brick:bluetoothPeerCount', held.promise);
		w.usb.failKinds.add('ports');

		const forgetting = w.bricks.forget(CCC);
		await waitFor(() => w.peerTraffic().length === 1, 1000);
		const outside = w.bricks.send(CCC, { kind: 'ports' });
		held.open();
		await assert.rejects(outside, /LIBUSB_ERROR_IO/);
		await forgetting;

		assert.ok(!w.usb.attempted.includes('battery'), 'the failed command started a probe of the channel');
		w.done();
	});

	it('cancels a pending reconnect: none reaches the provider after the forget', async () => {
		const w = world({ cabled: false });
		await signedInOver(w, Transport.BT);
		w.sessionManager['handleHeartbeatFailure'](btKey, new TransportError('link went away'));

		const report = await w.bricks.forget(CCC);
		await settle();

		assert.deepEqual(report.brickSide, { status: 'skipped', reason: 'not-reachable' });
		assert.equal(w.bt.connects, 1, 'the reconnect the lost link scheduled still ran');
		w.done();
	});

	it('runs one forget for two calls made at once', async () => {
		const w = world({ paired: false });
		await signedInOver(w, Transport.USB);

		const [first, second] = await Promise.all([w.bricks.forget(CCC), w.bricks.forget(CCC)]);

		assert.equal(first, second);
		assert.equal(w.peerTraffic().filter((k) => k === 'removeBluetoothPeer').length, 1);
		w.done();
	});
});

// ── The cockpit's memory (R4, R5) ───────────────────────────────────

describe('Forget a brick — what the cockpit remembers afterwards (R4, R5)', () => {
	it('leaves out a brick Bluetooth no longer lists, and shows a still-cabled one as a stranger', async () => {
		const w = world();
		await signedInOver(w, Transport.USB, Transport.BT);
		assert.equal(w.aggregator.getBrick(CCC)?.paired, true);

		await w.bricks.forget(CCC);

		const entry = w.aggregator.getBrick(CCC);
		assert.ok(entry, 'the cabled brick is missing from the list');
		assert.equal(entry.paired, false);
		assert.equal(entry.remembered, false);
		assert.deepEqual(entry.channels.map((c) => c.transport), [Transport.USB]);
		assert.deepEqual(w.presence.forgotten, [MAC]);
		w.done();
	});

	it('leaves the brick out when it is reachable on nothing after the forget', async () => {
		const w = world({ cabled: false });
		await signedInOver(w, Transport.BT);

		await w.bricks.forget(CCC);

		assert.equal(w.aggregator.getBrick(CCC), undefined);
		w.done();
	});

	it('reports a refused unpair with Windows\' reason, and still clears the cockpit\'s memory', async () => {
		const w = world({ cabled: false });
		await signedInOver(w, Transport.BT);
		w.aggregator.updateBrick(CCC, { favorite: true });
		w.bt.refuse = 'error 5: access denied';

		const report = await w.bricks.forget(CCC);

		assert.equal(report.pairing.length, 1);
		const [pairing] = report.pairing;
		assert.equal(pairing.status, 'refused');
		assert.match(pairing.status === 'refused' ? pairing.reason : '', /error 5: access denied/);
		assert.deepEqual(report.residue, []);
		assert.deepEqual(report.memory, { status: 'cleared' });
		// Windows still lists it, so the scan brings it back; the cockpit's own flag is gone.
		assert.equal(w.aggregator.getBrick(CCC)?.favorite, false);
		w.done();
	});

	it('does not bring the brick back as paired from a scan that read Windows\' list before the unpair', async () => {
		const w = world({ cabled: false, radio: undefined });
		await w.scheduler.scanOnce();
		const held = gate();
		w.bt.discoverGate = held.promise;
		const staleScan = w.scheduler.scanOnce();   // reads the paired list now, answers later

		const forgetting = w.bricks.forget(CCC);
		await waitFor(() => w.bt.unpairs.length === 1, 1000);
		held.open();
		await forgetting;
		await staleScan;
		await w.scheduler.scansSettled();

		assert.equal(w.aggregator.getBrick(CCC), undefined, 'the stale scan brought the forgotten brick back');
		w.done();
	});
});
