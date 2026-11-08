/**
 * Forgetting a brick (step-3 plan, U4): `BrickManager.forget` across the brick's own list, the
 * operating-system pairing and the cockpit's memory. And clearing a brick's list (U8):
 * `BrickManager.clearBluetoothList`, in the same world.
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
	BrickCommand, BrickKey, BrickResponse, ChannelState, ConnectionState, DiscoveryItem, ForgetResidue, PresenceState, Transport,
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
import { connectPickedBrick, followPairing } from '../ui/connectBrick';
import { waitFor } from './waitFor';

const THIS_PC = 'Petrův PC';
const MAC = '00:16:53:F0:0C:0C';
const usbKey = makeBrickKey(Transport.USB, '001653F00C0C');
const btKey = makeBrickKey(Transport.BT, MAC);
const CCC = brickIdOf(usbKey);

/** What the Bluetooth provider says Windows keeps, returned by its `forget`. */
const RESIDUE: readonly ForgetResidue[] = [
	{ location: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\001653f00c0c', reason: 'owned by SYSTEM' },
	{ location: 'Windows\' in-memory Bluetooth device record for 001653F00C0C', reason: 'until Windows restarts' },
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
	/** The name a removal named. */
	readonly name?: string;
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
		/** Names whose removal the firmware acks and does not run. */
		refuses: new Set<string>(),
		/** Names the firmware removes this many copies of, then acks the next removal and does not run it. */
		refusesAfter: new Map<string, number>(),
		/** After a removal, the list cannot be read back. */
		readBackFails: false,
		removalSeen: false,
		/** The entry the brick holds this computer's Bluetooth link under: its removal cuts the link. */
		linkEntry: THIS_PC,
		/**
		 * Entries the list marks connected, as `FAVOUR_ITEM` reports `DevList[].Connected`
		 * (`c_bt.c` 3566). None by default, as the mock answers.
		 */
		connected: new Set<string>(),
		/** Entries the list marks connected, by their place in the list, for one copy of a name held twice. */
		connectedAt: new Set<number>(),
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
		/** Switched off: a connect gets no answer. */
		off: false,
		attempted: [] as string[],
		unpairs: [] as BrickKey[],
		/** The reason Windows gives for refusing the unpair, when it does. */
		refuse: undefined as string | undefined,
		discoverGate: undefined as Promise<void> | undefined,
		forgetGate: undefined as Promise<void> | undefined,
		/** Once unpaired, Windows' in-memory record still lists the brick, unpaired. */
		cachedAfterUnpair: false,
	};

	const answer = async (over: Transport, command: BrickCommand): Promise<BrickResponse> => {
		brick.received.push({
			over, kind: command.kind, btLinkOpen: bt.open,
			...(command.kind === 'brick:removeBluetoothPeer' ? { name: command.name } : {}),
		});
		const hold = brick.holds.get(command.kind);
		if (hold) { brick.holds.delete(command.kind); await hold; }
		if (command.kind === 'brick:bluetoothPeerCount' && brick.removalSeen && brick.readBackFails) {
			throw new TimeoutError('no reply to the read-back');
		}
		if (command.kind === 'brick:removeBluetoothPeer') {
			brick.removalSeen = true;
			if (brick.ignoresRemoval || brick.refuses.has(command.name)) { return { kind: 'brick:removeBluetoothPeer' }; }
			const allowed = brick.refusesAfter.get(command.name);
			if (allowed !== undefined) {
				if (allowed === 0) { return { kind: 'brick:removeBluetoothPeer' }; }
				brick.refusesAfter.set(command.name, allowed - 1);
			}
			const reply = await mock.executeCommand(mockKey, command);
			// The brick closes the removed peer's RFCOMM channel before it answers anything.
			if (command.name === brick.linkEntry && bt.open) {
				bt.open = false;
				if (over === Transport.BT) { throw new TimeoutError('BT reply timed out'); }
			}
			return reply;
		}
		const reply = await mock.executeCommand(mockKey, command);
		const marked = reply.kind === 'brick:bluetoothPeer' && (brick.connected.has(reply.name)
			|| (command.kind === 'brick:bluetoothPeer' && brick.connectedAt.has(command.index)));
		return marked ? { ...reply, connected: true } : reply;
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
			const cached = !bt.paired && bt.cachedAfterUnpair;
			const unheard = bt.unheard;
			const held = bt.discoverGate;
			bt.discoverGate = undefined;
			if (held) { await held; }
			const items: DiscoveryItem[] = listed || cached ? [{
				brickKey: btKey, displayName: 'CCC', nameSource: 'bt-cache', transport: Transport.BT,
				presenceState: PresenceState.Available, remembered: listed, paired: listed, connected: false, favorite: false,
				lastSeenAt: Date.now(), ...(unheard ? { heard: false } : {}),
			}] : [];
			return { transport: Transport.BT, items };
		},
		async connect(brickKey: BrickKey): Promise<SessionHandle> {
			bt.connects += 1;
			if (bt.off) { throw new TransportError('BT connect failed: no answer'); }
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
			const held = bt.forgetGate;
			bt.forgetGate = undefined;   // holds one unpair, not a second one that comes meanwhile
			if (held) { await held; }
			bt.open = false;
			if (bt.refuse) { throw new TransportError(`Could not forget 001653F00C0C: ${bt.refuse}`); }
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
	const presence = {
		forgotten: [] as string[],
		forget(mac: string) { this.forgotten.push(mac); },
		notePaired() { /* the checks are not under test here */ },
	};
	/** Pairing as Windows and the brick do it: an accepted pairing pairs Windows and adds this computer to the brick's list. */
	const pairing = {
		calls: 0,
		/** Whether the USB link was open when each pairing started. */
		usbOpenAtStart: [] as boolean[],
		/** Holds every pairing until it opens, or until the pairing is aborted. */
		gate: undefined as Promise<void> | undefined,
		/** What the person at the brick answers. */
		accepts: true,
		/** The brick's dialog was accepted just as the pairing was aborted: it pairs anyway. */
		completesOnAbort: false,
	};
	const completePairing = (): void => {
		bt.paired = true;
		mock['bricks'].get(mockKey)!.bluetoothPeers.push(radio ?? THIS_PC);
	};
	const bricks = new BrickManager({
		sessionManager, aggregator, providerRegistry: registry, rejoinBaseMs: 20, rejoinMaxMs: 40,
		discovery: scheduler, btPresence: presence, radioName: options.radioName ?? (() => radio),
		pair: async (_mac, _onEvent, signal) => {
			pairing.calls += 1;
			pairing.usbOpenAtStart.push(usb.open);
			if (pairing.gate) {
				await Promise.race([pairing.gate, new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
			}
			if (signal?.aborted) {
				// Windows takes a moment to report a pairing the brick accepted as it was cancelled.
				if (pairing.completesOnAbort) { await settle(100); completePairing(); }
				return { ok: false, reason: 'The pairing was cancelled.' };
			}
			if (!pairing.accepts) { return { ok: false, reason: 'The brick did not confirm.' }; }
			completePairing();
			return { ok: true, status: 'Paired' };
		},
	});
	const done = () => {
		bricks.dispose(); sessionManager.dispose(); aggregator.dispose(); scheduler.dispose(); registry.dispose();
		mock.dispose();
	};
	/** The kinds of the peer-list commands that reached the brick over a transport. */
	const peerTraffic = (over?: Transport): string[] => brick.received
		.filter((r) => (over === undefined || r.over === over) && r.kind.includes('luetooth'))
		.map((r) => r.kind.replace('brick:', ''));
	/** The names of the removals that reached the brick, in order. */
	const removals = (): (string | undefined)[] => brick.received
		.filter((r) => r.kind === 'brick:removeBluetoothPeer').map((r) => r.name);
	return {
		mock, brick, usb, bt, pairing, registry, scheduler, aggregator, sessionManager, bricks, presence, peerTraffic,
		removals, done,
	};
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

	it('confirms one removal of a name the brick holds twice, and says one entry under it remains', async () => {
		const w = world({ peers: [THIS_PC, THIS_PC], paired: false });
		await signedInOver(w, Transport.USB);

		const report = await w.bricks.forget(CCC);

		// The firmware removes the first entry whose name matches (`c_bt.c` 2215, 3603–3622).
		assert.deepEqual(w.removals(), [THIS_PC]);
		assert.deepEqual(w.brick.peers(), [THIS_PC]);
		assert.deepEqual(report.brickSide, { status: 'confirmed', name: THIS_PC, over: usbKey, remaining: 1 });
		assert.deepEqual(report.peers, [THIS_PC, THIS_PC]);
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

	it('tries a paired Bluetooth channel the presence checks do not hear, and says why when it cannot open it', async () => {
		const w = world({ cabled: false });
		w.bt.unheard = true;   // paired, but the presence checks no longer hear it
		w.bt.off = true;       // and it is indeed switched off
		await w.scheduler.scanOnce();

		const report = await w.bricks.forget(CCC);

		assert.equal(report.brickSide.status, 'skipped');
		assert.equal(report.brickSide.status === 'skipped' ? report.brickSide.reason : undefined, 'not-reachable');
		assert.match(report.brickSide.status === 'skipped' ? report.brickSide.detail ?? '' : '', /no answer/);
		assert.equal(report.peers, undefined);
		assert.deepEqual(w.brick.received, []);
		assert.equal(w.bt.connects, 1, 'the channel was not tried');
		assert.deepEqual(w.bt.unpairs, [btKey]);
		assert.deepEqual(report.pairing, [{ status: 'removed', channel: btKey }]);
		assert.equal(w.aggregator.getBrick(CCC), undefined, 'the cockpit still lists the brick');
		w.done();
	});

	it('removes this computer\'s entry over a paired Bluetooth channel the presence checks missed', async () => {
		// Measured 01.11.2026 (U7): the checks miss bricks right next to the computer.
		const w = world({ cabled: false });
		w.bt.unheard = true;
		await w.scheduler.scanOnce();
		assert.equal(w.aggregator.getBrick(CCC)?.channels[0]?.state, ChannelState.Lost,
			'the channel is not lost, so this test shows nothing');

		const report = await w.bricks.forget(CCC);

		assert.equal(report.brickSide.status, 'sent');
		assert.deepEqual(w.removals(), [THIS_PC]);
		assert.deepEqual(w.bt.unpairs, [btKey]);
		w.done();
	});

	it('does not try a lost Bluetooth channel of a brick nobody has paired', async () => {
		const w = world({ cabled: false, paired: false });
		w.bt.cachedAfterUnpair = true;   // Windows' cache lists it, unpaired
		w.bt.unheard = true;
		await w.scheduler.scanOnce();
		assert.equal(w.aggregator.getBrick(CCC)?.channels[0]?.state, ChannelState.Lost,
			'the channel is not lost, so this test shows nothing');

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		assert.equal(report?.skipped?.reason, 'not-reachable');
		assert.equal(w.bt.connects, 0, 'a Bluetooth channel nobody has paired was opened');
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
		await settle();   // the scan the forget starts and does not wait for

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
		await settle();

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
		await waitFor(() => w.aggregator.getBrick(CCC) !== undefined, 1000);
		assert.equal(w.aggregator.getBrick(CCC)?.favorite, false);
		w.done();
	});

	it('reports without waiting for a scan in flight, and that scan does not bring the brick back as paired', async () => {
		const w = world({ cabled: false, radio: undefined });
		await w.scheduler.scanOnce();
		const held = gate();
		w.bt.discoverGate = held.promise;
		const staleScan = w.scheduler.scanOnce();   // reads the paired list now, answers when let

		const outcome = await Promise.race([
			w.bricks.forget(CCC).then(() => 'reported'),
			settle(1000).then(() => 'waiting'),
		]);
		assert.equal(outcome, 'reported', 'the forget waited for a scan, which can hang in the operating system');
		held.open();
		await staleScan;
		await settle();

		assert.equal(w.aggregator.getBrick(CCC), undefined, 'the stale scan brought the forgotten brick back');
		w.done();
	});

	it('reports without waiting for the scan it starts itself', async () => {
		const w = world({ cabled: false, radio: undefined });
		await signedInOver(w, Transport.BT);
		const held = gate();
		w.bt.discoverGate = held.promise;   // the next Bluetooth scan, the forget's own, never answers

		const outcome = await Promise.race([
			w.bricks.forget(CCC).then(() => 'reported'),
			settle(1000).then(() => 'waiting'),
		]);
		held.open();

		assert.equal(outcome, 'reported', 'the forget waited for its own scan, which can hang in the operating system');
		assert.equal(w.bt.discoverGate, undefined, 'the forget started no scan, so this test shows nothing');
		w.done();
	});
});

// ── Clearing a brick's list (U8) ────────────────────────────────────

/** A confirmation that records what it was shown and answers `answer`. */
function asked(answer = true) {
	const calls: { names: readonly string[]; includesThisComputer: boolean; thisComputer: string | undefined }[] = [];
	const confirm = async (names: readonly string[], includesThisComputer: boolean, thisComputer: string | undefined) => {
		calls.push({ names: [...names], includesThisComputer, thisComputer });
		return answer;
	};
	return { calls, confirm };
}

describe('Clear a brick\'s Bluetooth list — removing every entry (R16, R17)', () => {
	it('removes three entries over USB, each confirmed, and reads the list back empty', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC, 'Zed'], paired: false });
		await signedInOver(w, Transport.USB);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(ask.calls, [{ names: ['OLD-PC', THIS_PC, 'Zed'], includesThisComputer: true, thisComputer: THIS_PC }]);
		assert.deepEqual(w.removals(), ['OLD-PC', THIS_PC, 'Zed']);
		assert.deepEqual(w.brick.peers(), []);
		assert.equal(report?.over, usbKey);
		assert.deepEqual(report?.peers, ['OLD-PC', THIS_PC, 'Zed']);
		assert.deepEqual(report?.entries, [
			{ status: 'confirmed', name: 'OLD-PC' }, { status: 'confirmed', name: THIS_PC }, { status: 'confirmed', name: 'Zed' },
		]);
		assert.deepEqual(report?.left, [], 'the report does not carry the list as read back');
		assert.equal(report?.skipped, undefined);
		assert.deepEqual(report?.pairing, [], 'a brick Windows has not paired has no pairing to remove');
		assert.equal(report?.pairingLeft, 'not-paired');
		assert.equal(w.sessionManager.getSession(usbKey)?.connectionState, ConnectionState.Connected);
		assert.equal(w.bricks.isSignedIn(CCC), true);
		w.done();
	});

	it('sends a name held twice twice, and both entries go', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC, 'OLD-PC'], paired: false });
		await signedInOver(w, Transport.USB);

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		assert.equal(w.removals().filter((name) => name === 'OLD-PC').length, 2);
		assert.deepEqual(w.brick.peers(), []);
		assert.ok(report?.entries.every((entry) => entry.status === 'confirmed'), JSON.stringify(report?.entries));
		w.done();
	});

	it('stops after a pass that removes nothing, and names the entry the brick keeps', async () => {
		const w = world({ peers: ['OLD-PC', 'STUCK', 'Zed'], paired: false });
		await signedInOver(w, Transport.USB);
		w.brick.refuses.add('STUCK');

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		// Once in the pass that removed the others, once in the pass that removed nothing.
		assert.equal(w.removals().filter((name) => name === 'STUCK').length, 2, `removals: ${w.removals().join(', ')}`);
		assert.deepEqual(w.brick.peers(), ['STUCK']);
		assert.deepEqual(report?.entries, [
			{ status: 'confirmed', name: 'OLD-PC' },
			{ status: 'failed', name: 'STUCK', detail: 'The list read back still holds it.' },
			{ status: 'confirmed', name: 'Zed' },
		]);
		w.done();
	});

	it('sends no removal for an entry without a name, reports it as not removable, and closes the channel it opened', async () => {
		const w = world({ peers: ['', 'OLD-PC', '  '], paired: false });
		await w.scheduler.scanOnce();   // available on USB, not signed in
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(ask.calls[0].names, ['OLD-PC'], 'the confirmation offered to remove a blank name');
		assert.deepEqual(w.removals(), ['OLD-PC']);
		assert.deepEqual(w.brick.peers(), ['', '  ']);
		assert.deepEqual(report?.entries, [
			{ status: 'not-removable', name: '', reason: 'blank-name' },
			{ status: 'confirmed', name: 'OLD-PC' },
			{ status: 'not-removable', name: '  ', reason: 'blank-name' },
		]);
		assert.equal(w.usb.connects, 1);
		assert.equal(w.sessionManager.getSession(usbKey), undefined, 'the channel the clear opened is still open');
		w.done();
	});

	it('sends nothing and closes the channel it opened when the user declines', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC], paired: false });
		await w.scheduler.scanOnce();
		const ask = asked(false);

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.equal(report, undefined);
		assert.equal(ask.calls.length, 1);
		assert.deepEqual(w.removals(), []);
		assert.deepEqual(w.brick.peers(), ['OLD-PC', THIS_PC]);
		assert.equal(w.usb.connects, 1);
		assert.equal(w.sessionManager.getSession(usbKey), undefined, 'the channel the clear opened is still open');
		w.done();
	});

	it('over Bluetooth alone, removes every other entry first, each confirmed, and this computer\'s last, sent and not confirmed', async () => {
		const w = world({ cabled: false, peers: [THIS_PC, 'OLD-PC', 'Zed'] });
		await signedInOver(w, Transport.BT);

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);
		await w.scheduler.scanOnce();
		await settle();

		assert.deepEqual(w.removals(), ['OLD-PC', 'Zed', THIS_PC]);
		assert.deepEqual(w.peerTraffic(Transport.BT).slice(4), [
			'removeBluetoothPeer', 'bluetoothPeerCount', 'bluetoothPeer', 'bluetoothPeer',
			'removeBluetoothPeer', 'bluetoothPeerCount', 'bluetoothPeer',
			'removeBluetoothPeer',
		], 'each other entry was not read back over the same link before this computer\'s went');
		assert.deepEqual(report?.entries, [
			{ status: 'sent', name: THIS_PC, detail: 'BT reply timed out' },
			{ status: 'confirmed', name: 'OLD-PC' },
			{ status: 'confirmed', name: 'Zed' },
		]);
		assert.equal(report?.over, btKey);
		assert.deepEqual(report?.pairing, [{ status: 'removed', channel: btKey }]);
		assert.equal(w.bt.connects, 1, 'a connect reached the Bluetooth provider after the removal cut the link');
		assert.equal(w.sessionManager.getSession(btKey), undefined);
		assert.equal(w.bricks.isSignedIn(CCC), false);
		assert.equal(w.aggregator.getBrick(CCC), undefined, 'a brick reachable on nothing is still listed');
		w.done();
	});

	it('over Bluetooth alone with this computer\'s name unknown, removes nothing and asks nothing', async () => {
		const w = world({ cabled: false, radio: undefined });
		await signedInOver(w, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(report?.skipped, { reason: 'radio-name-unknown' });
		assert.deepEqual(report?.peers, ['Office PC', THIS_PC]);
		assert.equal(ask.calls.length, 0);
		assert.deepEqual(w.removals(), []);
		assert.deepEqual(w.bt.unpairs, []);
		w.done();
	});

	it('over Bluetooth alone, removes the entry the brick marks connected last, though it carries an earlier name of this computer', async () => {
		const w = world({ cabled: false, peers: ['OLD-PC', 'Office PC', 'Zed'] });
		w.brick.linkEntry = 'OLD-PC';
		w.brick.connected.add('OLD-PC');
		await signedInOver(w, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(ask.calls, [{ names: ['OLD-PC', 'Office PC', 'Zed'], includesThisComputer: true, thisComputer: THIS_PC }]);
		assert.deepEqual(w.removals(), ['Office PC', 'Zed', 'OLD-PC']);
		assert.deepEqual(report?.entries, [
			{ status: 'sent', name: 'OLD-PC', detail: 'BT reply timed out' },
			{ status: 'confirmed', name: 'Office PC' },
			{ status: 'confirmed', name: 'Zed' },
		]);
		assert.deepEqual(w.bt.unpairs, [btKey], 'the brick no longer knows this computer, and Windows still has it paired');
		assert.deepEqual(report?.pairing, [{ status: 'removed', channel: btKey }]);
		assert.equal(report?.pairingLeft, undefined);
		w.done();
	});

	it('over Bluetooth alone with this computer\'s name unknown, goes ahead when one entry is marked connected, and removes it last', async () => {
		const w = world({ cabled: false, radio: undefined, peers: ['OLD-PC', 'Office PC', 'Zed'] });
		w.brick.linkEntry = 'OLD-PC';
		w.brick.connected.add('OLD-PC');
		await signedInOver(w, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(ask.calls, [{ names: ['OLD-PC', 'Office PC', 'Zed'], includesThisComputer: true, thisComputer: undefined }]);
		assert.equal(report?.skipped, undefined);
		assert.deepEqual(w.removals(), ['Office PC', 'Zed', 'OLD-PC']);
		assert.deepEqual(report?.pairing, [{ status: 'removed', channel: btKey }]);
		w.done();
	});

	it('over Bluetooth alone with this computer\'s name unknown, removes nothing when two entries are marked connected', async () => {
		const w = world({ cabled: false, radio: undefined, peers: ['OLD-PC', 'Office PC', 'Zed'] });
		w.brick.linkEntry = 'OLD-PC';
		w.brick.connected.add('OLD-PC').add('Zed');
		await signedInOver(w, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(report?.skipped, { reason: 'radio-name-unknown' });
		assert.equal(ask.calls.length, 0);
		assert.deepEqual(w.removals(), []);
		w.done();
	});

	it('over Bluetooth alone, removes nothing when no entry carries this computer\'s name and two are marked connected', async () => {
		// This computer paired as OLD-PC and is now THIS_PC; another computer holds a link as OTHER-PC.
		const w = world({ cabled: false, peers: ['OTHER-PC', 'OLD-PC', 'Zed'] });
		w.brick.linkEntry = 'OLD-PC';
		w.brick.connected.add('OTHER-PC').add('OLD-PC');
		w.brick.refuses.add('OLD-PC');
		await signedInOver(w, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(report?.skipped, { reason: 'link-entry-unknown' });
		assert.deepEqual(report?.peers, ['OTHER-PC', 'OLD-PC', 'Zed']);
		assert.equal(ask.calls.length, 0);
		assert.deepEqual(w.removals(), []);
		assert.deepEqual(w.bt.unpairs, [], 'Windows was unpaired from a brick that may still list this computer');
		w.done();
	});

	it('over USB, leaves the Windows pairing alone when no entry carries this computer\'s name, though entries are marked connected', async () => {
		const w = world({ peers: ['OTHER-PC', 'OLD-PC', 'Zed'] });
		w.brick.linkEntry = 'OLD-PC';
		w.brick.connected.add('OTHER-PC').add('OLD-PC');
		w.brick.refuses.add('OLD-PC');
		await signedInOver(w, Transport.USB, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.equal(report?.over, usbKey);
		assert.equal(ask.calls[0].includesThisComputer, false);
		assert.deepEqual(w.brick.peers(), ['OLD-PC'], 'the clear did not run, so this test shows nothing');
		assert.deepEqual(report?.left, ['OLD-PC']);
		assert.equal(report?.entries.find((entry) => entry.name === 'OTHER-PC')?.status, 'confirmed');
		assert.deepEqual(w.bt.unpairs, [], 'Windows was unpaired from a brick that may still list this computer');
		assert.deepEqual(report?.pairing, []);
		assert.equal(report?.pairingLeft, 'not-on-brick');
		w.done();
	});

	it('over Bluetooth alone, removes the entry marked connected after the one carrying this computer\'s name', async () => {
		// The brick holds this computer's link under OLD-PC, and also lists it under its current name.
		const w = world({ cabled: false, peers: ['OLD-PC', THIS_PC, 'Zed'] });
		w.brick.linkEntry = 'OLD-PC';
		w.brick.connected.add('OLD-PC');
		await signedInOver(w, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(ask.calls, [{ names: ['OLD-PC', THIS_PC, 'Zed'], includesThisComputer: true, thisComputer: THIS_PC }]);
		assert.deepEqual(w.removals(), ['Zed', THIS_PC, 'OLD-PC'],
			'the entry marked connected went before another, and its removal cut the link the rest needed');
		assert.deepEqual(report?.entries, [
			{ status: 'sent', name: 'OLD-PC', detail: 'BT reply timed out' },
			{ status: 'confirmed', name: THIS_PC },
			{ status: 'confirmed', name: 'Zed' },
		]);
		assert.deepEqual(w.bt.unpairs, [btKey], 'this computer\'s entry went, and Windows still has the brick paired');
		w.done();
	});

	it('over Bluetooth alone, leaves the Windows pairing alone when the entry carrying this computer\'s name stays, though the marked one went', async () => {
		const w = world({ cabled: false, peers: ['OLD-PC', THIS_PC] });
		w.brick.linkEntry = 'OLD-PC';
		w.brick.connected.add('OLD-PC');
		w.brick.refuses.add(THIS_PC);
		await signedInOver(w, Transport.BT);

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		assert.deepEqual(w.removals(), [THIS_PC, 'OLD-PC']);
		assert.equal(report?.entries.find((entry) => entry.name === 'OLD-PC')?.status, 'sent');
		assert.equal(report?.pairingLeft, 'not-removed');
		assert.deepEqual(w.bt.unpairs, [], 'Windows was unpaired from a brick that still lists this computer');
		w.done();
	});

	it('over Bluetooth alone, removes nothing when the list holds this computer\'s name twice', async () => {
		// The brick removes the first copy a name matches; that may be the one holding this link,
		// which cuts it before the other copy is sent.
		const w = world({ cabled: false, peers: [THIS_PC, 'Zed', THIS_PC] });
		await signedInOver(w, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(report?.skipped, { reason: 'duplicate-link-entry' });
		assert.deepEqual(report?.peers, [THIS_PC, 'Zed', THIS_PC]);
		assert.equal(ask.calls.length, 0);
		assert.deepEqual(w.removals(), []);
		assert.deepEqual(w.brick.peers(), [THIS_PC, 'Zed', THIS_PC]);
		assert.deepEqual(w.bt.unpairs, []);
		w.done();
	});

	it('over Bluetooth alone, removes nothing when the entry marked connected shares its name with another', async () => {
		// This computer paired as OLD-PC; the brick holds the link under the first copy.
		const w = world({ cabled: false, peers: ['OLD-PC', 'Zed', 'OLD-PC'] });
		w.brick.linkEntry = 'OLD-PC';
		w.brick.connectedAt.add(0);
		await signedInOver(w, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.deepEqual(report?.skipped, { reason: 'duplicate-link-entry' });
		assert.equal(ask.calls.length, 0);
		assert.deepEqual(w.removals(), []);
		assert.deepEqual(w.bt.unpairs, []);
		w.done();
	});

	it('over USB, clears a list that holds this computer\'s name twice', async () => {
		const w = world({ peers: [THIS_PC, 'Zed', THIS_PC] });
		await signedInOver(w, Transport.USB, Transport.BT);

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		assert.equal(report?.skipped, undefined);
		assert.deepEqual(w.brick.peers(), []);
		assert.deepEqual(w.bt.unpairs, [btKey]);
		w.done();
	});

	it('is refused while the brick is being forgotten', async () => {
		const w = world({ paired: false });
		await signedInOver(w, Transport.USB);
		const held = gate();
		w.brick.holds.set('brick:bluetoothPeerCount', held.promise);

		const forgetting = w.bricks.forget(CCC);
		// Raced: a clear that is not refused queues behind the forget's held read and never answers.
		const outcome = await Promise.race([
			w.bricks.clearBluetoothList(CCC, asked().confirm).then(() => 'it ran', (error: Error) => error.message),
			settle(300).then(() => 'it is still running behind the forget'),
		]);
		assert.match(outcome, /being forgotten/);
		held.open();
		await forgetting;
		w.done();
	});

	it('keeps the guards up for a clear still running when a forget that started during it ends', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC] });
		await signedInOver(w, Transport.USB, Transport.BT);
		const held = gate();
		w.bt.forgetGate = held.promise;   // the clear waits in its unpair of the Bluetooth channel

		const clearing = w.bricks.clearBluetoothList(CCC, asked().confirm);
		await waitFor(() => w.bt.unpairs.length === 1, 1000);
		await w.bricks.forget(CCC);
		const guarded = w.bricks['forgetting'].has(CCC);
		held.open();
		await clearing;

		assert.equal(guarded, true, 'the forget lifted the guards while the clear was still removing entries');
		assert.equal(w.bricks['forgetting'].has(CCC), false, 'the guards stayed up after both had finished');
		w.done();
	});
});

describe('Clear a brick\'s Bluetooth list — this computer\'s pairing (R18, KTD10)', () => {
	it('with this computer\'s entry gone and the brick paired, forgets the Bluetooth channel only; USB stays signed in', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC, 'Zed'] });
		await signedInOver(w, Transport.USB, Transport.BT);
		assert.equal(w.aggregator.getBrick(CCC)?.paired, true);

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		assert.deepEqual(w.brick.peers(), []);
		assert.equal(w.brick.received.find((r) => r.kind === 'brick:removeBluetoothPeer')?.btLinkOpen, false,
			'the Bluetooth link was still open when the removals ran');
		assert.deepEqual(w.bt.unpairs, [btKey]);
		assert.deepEqual(report?.pairing, [{ status: 'removed', channel: btKey }]);
		assert.equal(report?.pairingLeft, undefined);
		assert.deepEqual(report?.residue, RESIDUE);
		assert.deepEqual(report?.memory, { status: 'cleared' });
		assert.deepEqual(w.presence.forgotten, [MAC]);
		assert.equal(w.sessionManager.getSession(usbKey)?.connectionState, ConnectionState.Connected, 'the USB session closed');
		assert.equal(w.bricks.isSignedIn(CCC), true);
		assert.equal(w.bricks.routeOf(CCC), usbKey);
		const entry = w.aggregator.getBrick(CCC);
		assert.equal(entry?.paired, false, 'the list still says the brick is paired');
		assert.deepEqual(entry?.channels.map((c) => c.transport), [Transport.USB]);
		assert.equal(w.bt.connects, 1);
		w.done();
	});

	it('reports without waiting for a scan in flight, and that scan does not bring the pairing back', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC] });
		await signedInOver(w, Transport.USB, Transport.BT);
		const held = gate();
		w.bt.discoverGate = held.promise;
		const staleScan = w.scheduler.scanOnce();   // reads the paired list now, answers when let

		const outcome = await Promise.race([
			w.bricks.clearBluetoothList(CCC, asked().confirm).then(() => 'reported'),
			settle(1000).then(() => 'waiting'),
		]);
		assert.equal(outcome, 'reported', 'the clear waited for a scan, which can hang in the operating system');
		held.open();
		await staleScan;
		await settle();

		const entry = w.aggregator.getBrick(CCC);
		assert.equal(entry?.paired, false, 'the stale scan listed the brick as paired again');
		assert.deepEqual(entry?.channels.map((c) => c.transport), [Transport.USB]);
		assert.equal(w.bt.connects, 1, 'the signed-in brick rejoined Bluetooth from the stale scan');
		w.done();
	});

	it('does not rejoin the Bluetooth channel when Windows\' cache lists the brick again, unpaired', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC] });
		await signedInOver(w, Transport.USB, Transport.BT);
		w.bt.cachedAfterUnpair = true;

		await w.bricks.clearBluetoothList(CCC, asked().confirm);
		await w.scheduler.scanOnce();
		await settle();

		const entry = w.aggregator.getBrick(CCC);
		assert.deepEqual(entry?.channels.map((c) => c.transport), [Transport.USB, Transport.BT],
			'the cached sighting did not come back, so this test shows nothing');
		assert.equal(entry?.paired, false);
		assert.equal(w.bt.connects, 1, 'the signed-in brick joined a Bluetooth channel nobody has paired');
		assert.equal(w.bricks.isSignedIn(CCC), true);
		w.done();
	});

	it('signs a brick in over USB alone when its Bluetooth channel is a sighting the user declines to pair', async () => {
		const w = world({ paired: false });
		w.pairing.accepts = false;       // the pairing it starts is cancelled on the brick
		w.bt.cachedAfterUnpair = true;   // Windows' cache lists the brick, unpaired
		await w.scheduler.scanOnce();
		assert.deepEqual(w.aggregator.getBrick(CCC)?.channels.map((c) => c.transport), [Transport.USB, Transport.BT],
			'the unpaired sighting is not listed, so this test shows nothing');

		await w.bricks.signIn(CCC);
		await settle();

		assert.equal(w.bt.connects, 0, 'a connect reached the Bluetooth provider for a brick nobody has paired');
		assert.equal(w.bricks.routeOf(CCC), usbKey);
		assert.equal(w.sessionManager.getSession(btKey), undefined);
		w.done();
	});

	it('signs a brick in again over USB alone after its list was cleared and Windows\' cache relists it unpaired', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC] });
		await signedInOver(w, Transport.USB, Transport.BT);
		w.bt.cachedAfterUnpair = true;
		await w.bricks.clearBluetoothList(CCC, asked().confirm);
		await w.scheduler.scanOnce();
		assert.deepEqual(w.aggregator.getBrick(CCC)?.channels.map((c) => c.transport), [Transport.USB, Transport.BT],
			'the cached sighting did not come back, so this test shows nothing');

		await w.bricks.signOut(CCC);
		await w.bricks.signIn(CCC);
		await settle();

		assert.equal(w.bt.connects, 1, 'the new sign-in connected to a brick that no longer knows this computer');
		assert.equal(w.bricks.routeOf(CCC), usbKey);
		w.done();
	});

	it('does not open a Bluetooth channel nobody has paired to read the list', async () => {
		const w = world({ cabled: false, paired: false });
		w.bt.cachedAfterUnpair = true;
		await w.scheduler.scanOnce();
		assert.ok(w.aggregator.getBrick(CCC), 'the unpaired sighting is not listed, so this test shows nothing');

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		assert.deepEqual(report?.skipped, { reason: 'not-reachable' });
		assert.equal(w.bt.connects, 0, 'a connect reached the Bluetooth provider for a brick nobody has paired');
		w.done();
	});

	it('leaves the Windows pairing alone when this computer\'s entry was not on the brick', async () => {
		const w = world({ peers: ['OLD-PC', 'Zed'] });
		await signedInOver(w, Transport.USB, Transport.BT);
		const ask = asked();

		const report = await w.bricks.clearBluetoothList(CCC, ask.confirm);

		assert.equal(ask.calls[0].includesThisComputer, false);
		assert.deepEqual(w.brick.peers(), []);
		assert.deepEqual(w.bt.unpairs, []);
		assert.deepEqual(report?.pairing, []);
		assert.equal(report?.pairingLeft, 'not-on-brick');
		assert.equal(report?.paired, true, 'the report does not say the pairing it left was there');
		assert.equal(report?.memory, undefined);
		assert.equal(w.aggregator.getBrick(CCC)?.paired, true);
		w.done();
	});

	it('leaves the Windows pairing alone over USB when this computer\'s Bluetooth name is unknown', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC], radio: undefined });
		await signedInOver(w, Transport.USB, Transport.BT);

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		assert.deepEqual(w.brick.peers(), [], 'the clear did not run, so this test shows nothing');
		assert.equal(report?.pairingLeft, 'radio-name-unknown');
		assert.deepEqual(w.bt.unpairs, [], 'an unpair reached the Bluetooth provider');
		assert.deepEqual(report?.pairing, []);
		assert.equal(report?.memory, undefined);
		w.done();
	});

	it('leaves the Windows pairing alone when the brick keeps this computer\'s entry', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC] });
		await signedInOver(w, Transport.USB, Transport.BT);
		w.brick.refuses.add(THIS_PC);

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		assert.deepEqual(w.brick.peers(), [THIS_PC]);
		assert.equal(report?.pairingLeft, 'not-removed');
		assert.deepEqual(w.bt.unpairs, [], 'an unpair reached the Bluetooth provider');
		assert.deepEqual(report?.pairing, []);
		assert.equal(report?.memory, undefined);
		const entry = w.aggregator.getBrick(CCC);
		assert.equal(entry?.paired, true, 'the cockpit forgot the pairing of a brick that still lists this computer');
		assert.deepEqual(entry?.channels.map((c) => c.transport), [Transport.USB, Transport.BT]);
		w.done();
	});

	it('leaves the Windows pairing alone when the brick lists this computer twice and keeps one copy', async () => {
		const w = world({ peers: [THIS_PC, THIS_PC] });
		await signedInOver(w, Transport.USB, Transport.BT);
		w.brick.refusesAfter.set(THIS_PC, 1);

		const report = await w.bricks.clearBluetoothList(CCC, asked().confirm);

		assert.deepEqual(w.brick.peers(), [THIS_PC]);
		assert.deepEqual(report?.entries.map((entry) => entry.status), ['confirmed', 'failed'],
			'the first copy did not go, so this test shows nothing');
		assert.equal(report?.pairingLeft, 'not-removed');
		assert.deepEqual(w.bt.unpairs, [], 'Windows was unpaired from a brick that still lists this computer');
		assert.deepEqual(report?.pairing, []);
		assert.equal(w.aggregator.getBrick(CCC)?.paired, true);
		w.done();
	});
});

// ── Automatic pairing (step 4: pairing is part of connecting) ──────

describe('Automatic pairing of a signed-in brick', () => {
	/** A brick signed in over USB alone whose Bluetooth then shows up as a sighting nobody has paired. */
	async function signedInOverUsbThenSighted(w: World): Promise<void> {
		await signedInOver(w, Transport.USB);
		w.bt.cachedAfterUnpair = true;   // listed, unpaired: what an inquiry or Windows' cache reports
		await w.scheduler.scanOnce();
	}

	it('pairs the Bluetooth sighting of a brick signed in over USB, then joins it; USB stays connected', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		await signedInOverUsbThenSighted(w);

		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 2000);

		assert.equal(w.pairing.calls, 1);
		assert.equal(w.aggregator.getBrick(CCC)?.paired, true);
		assert.equal(w.sessionManager.getSession(usbKey)?.connectionState, ConnectionState.Connected, 'USB dropped');
		w.done();
	});

	it('announces an automatic pairing, so its progress is shown', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		let announced = 0;
		w.bricks.onPairingStarted(() => { announced += 1; });
		await signedInOverUsbThenSighted(w);

		await waitFor(() => w.pairing.calls === 1, 2000);

		assert.equal(announced, 1);
		w.done();
	});

	it('starts one pairing however many times the list changes while it waits', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		const held = gate();
		w.pairing.gate = held.promise;
		await signedInOverUsbThenSighted(w);
		for (let scan = 0; scan < 10; scan++) { await w.scheduler.scanOnce(); }

		assert.equal(w.pairing.calls, 1);
		held.open();
		w.done();
	});

	it('does not pair from a sighting of a brick that is not signed in', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		w.bt.cachedAfterUnpair = true;
		await w.scheduler.scanOnce();
		await settle();

		assert.equal(w.pairing.calls, 0);
		w.done();
	});

	it('does not start a pairing for a paired brick whose Bluetooth channel the presence checks lost', async () => {
		const w = world({ paired: true });
		await signedInOver(w, Transport.USB);
		w.bt.unheard = true;
		await w.scheduler.scanOnce();
		await settle();

		assert.equal(w.pairing.calls, 0);
		w.done();
	});

	it('pairs no more once a pairing failed: the brick is suspended', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		w.pairing.accepts = false;   // the person at the brick cancels
		await signedInOverUsbThenSighted(w);
		await waitFor(() => w.pairing.calls === 1, 2000);
		await settle();

		for (let scan = 0; scan < 5; scan++) { await w.scheduler.scanOnce(); }
		await settle();

		assert.equal(w.pairing.calls, 1, 'the brick asked again after the user cancelled');
		w.done();
	});

	it('does not pair a brick whose list a clear is reading before the user confirms', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		await signedInOver(w, Transport.USB);
		const answer = gate();
		const clearing = w.bricks.clearBluetoothList(CCC, async () => { await answer.promise; return false; });
		await waitFor(() => w.peerTraffic(Transport.USB).length > 0, 1000);
		w.bt.cachedAfterUnpair = true;
		await w.scheduler.scanOnce();
		await settle();

		assert.equal(w.pairing.calls, 0);
		answer.open();
		await clearing;
		w.done();
	});

	it('leaves a brick suspended after a clear: Windows relisting it unpaired starts no pairing', async () => {
		const w = world({ peers: ['OLD-PC', THIS_PC] });
		await signedInOver(w, Transport.USB, Transport.BT);
		w.bt.cachedAfterUnpair = true;

		await w.bricks.clearBluetoothList(CCC, asked().confirm);
		await w.scheduler.scanOnce();
		await settle();

		assert.equal(w.aggregator.getBrick(CCC)?.paired, false, 'the clear did not unpair, so this test shows nothing');
		assert.equal(w.pairing.calls, 0, 'the brick asked to pair right after the user cleared its list');
		w.done();
	});

	it('does not pair a sighting nothing hears any more', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		w.bt.cachedAfterUnpair = true;
		await w.scheduler.scanOnce();   // the sighting
		w.bt.cachedAfterUnpair = false;
		await w.scheduler.scanOnce();   // gone: the channel is lost
		assert.equal(w.aggregator.getBrick(CCC)?.channels.find((c) => c.transport === Transport.BT)?.state,
			ChannelState.Lost, 'the sighting is not lost, so this test shows nothing');

		await w.bricks.signIn(CCC);
		await settle();

		assert.equal(w.pairing.calls, 0, 'a pairing started for a brick nobody can hear');
		w.done();
	});

	it('does not pair a brick Windows has paired', async () => {
		const w = world({ paired: true });
		await signedInOver(w, Transport.USB, Transport.BT);
		await w.scheduler.scanOnce();
		await settle();

		assert.equal(w.pairing.calls, 0);
		w.done();
	});

	it('aborts a pairing in flight before a clear reads the brick\'s list, so the clear removes this computer\'s entry too', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		w.pairing.gate = gate().promise;   // never opens: only the abort ends it
		w.pairing.completesOnAbort = true; // the person accepts just as the clear begins
		await signedInOverUsbThenSighted(w);
		await waitFor(() => w.pairing.calls === 1, 2000);

		await w.bricks.clearBluetoothList(CCC, asked().confirm);
		await settle(150);   // a pairing still finishing behind the clear would show by now

		assert.deepEqual(w.brick.peers(), [], 'an entry the pairing added stayed after the clear');
		w.done();
	});

	it('aborts a pairing in flight before a forget reads the brick\'s list, so no entry for this computer stays', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		w.pairing.gate = gate().promise;   // never opens: only the abort ends it
		w.pairing.completesOnAbort = true; // the person accepts just as the forget begins
		await signedInOverUsbThenSighted(w);
		await waitFor(() => w.pairing.calls === 1, 2000);

		await w.bricks.forget(CCC);
		await settle(150);   // a pairing still finishing behind the forget would show by now

		assert.deepEqual(w.brick.peers(), ['Office PC'], 'this computer\'s entry stayed on the brick');
		assert.ok(w.bt.unpairs.includes(btKey), 'Windows kept the pairing');
		assert.equal(w.aggregator.getBrick(CCC)?.paired ?? false, false);
		w.done();
	});
});

// ── Connect a Brick: every channel that can work ───────────────────

describe('Connect a Brick connects every channel', () => {
	/** The command's dependencies over this world, with every pairing's progress followed as the extension does. */
	function command(w: World) {
		const shown = { titles: [] as string[], info: [] as string[], errors: [] as string[] };
		const progress = async <T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> => {
			shown.titles.push(title);
			return task(() => { /* the messages are not under test here */ });
		};
		const showError = (message: string): void => { shown.errors.push(message); };
		w.bricks.onPairingStarted((event) => { void followPairing(event, { aggregator: w.aggregator, progress, showError }); });
		const log = { info: () => { /* quiet */ }, warn: () => { /* quiet */ }, error: () => { /* quiet */ }, debug: () => { /* quiet */ } };
		const deps = {
			aggregator: w.aggregator, bricks: w.bricks, log, progress, showError,
			showInfo: (message: string) => { shown.info.push(message); },
		};
		return { shown, connect: () => connectPickedBrick(CCC, deps) };
	}

	it('connects USB first, then pairs the Bluetooth sighting and joins it', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		w.bt.cachedAfterUnpair = true;
		await w.scheduler.scanOnce();
		const c = command(w);

		await c.connect();
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 2000);

		assert.deepEqual(w.pairing.usbOpenAtStart, [true], 'the pairing did not wait for USB, or ran twice');
		assert.equal(w.sessionManager.getSession(usbKey)?.connectionState, ConnectionState.Connected);
		assert.deepEqual(c.shown.errors, []);
		w.done();
	});

	it('keeps USB connected when the pairing is cancelled on the brick, says so, and asks no more', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		w.pairing.accepts = false;
		w.bt.cachedAfterUnpair = true;
		await w.scheduler.scanOnce();
		const c = command(w);

		await c.connect();
		await waitFor(() => c.shown.errors.length === 1, 2000);
		for (let scan = 0; scan < 3; scan++) { await w.scheduler.scanOnce(); }
		await settle();

		assert.match(c.shown.errors[0], /could not pair CCC/);
		assert.equal(w.sessionManager.getSession(usbKey)?.connectionState, ConnectionState.Connected);
		assert.equal(w.pairing.calls, 1, 'the brick asked again before the user connected it again');
		w.done();
	});

	it('pairs again on a Connect after the user cancelled: the Connect lifts the suspension', async () => {
		const w = world({ paired: false, peers: ['Office PC'] });
		w.pairing.accepts = false;
		w.bt.cachedAfterUnpair = true;
		await w.scheduler.scanOnce();
		const c = command(w);
		await c.connect();
		await waitFor(() => w.pairing.calls === 1, 2000);
		await settle();
		w.pairing.accepts = true;

		await c.connect();
		await waitFor(() => w.sessionManager.getSession(btKey)?.connectionState === ConnectionState.Connected, 2000);

		assert.equal(w.pairing.calls, 2);
		w.done();
	});

	it('tries the paired Bluetooth channel of a signed-in brick that the presence checks did not hear', async () => {
		const w = world({ paired: true });
		w.bt.unheard = true;   // the checks miss it from the start: the sign-in joins USB alone
		await signedInOver(w, Transport.USB);
		assert.equal(w.bt.connects, 0, 'Bluetooth was joined already, so this test shows nothing');
		const c = command(w);

		await c.connect();

		assert.equal(w.bt.connects, 1, 'the Bluetooth channel was not tried');
		w.done();
	});

	it('makes a brick connected on every channel the active one and starts nothing', async () => {
		const w = world({ paired: true });
		await signedInOver(w, Transport.USB, Transport.BT);
		const before = { usb: w.usb.connects, bt: w.bt.connects };
		const c = command(w);

		await c.connect();

		assert.deepEqual({ usb: w.usb.connects, bt: w.bt.connects }, before);
		assert.equal(w.pairing.calls, 0);
		assert.match(c.shown.info.at(-1) ?? '', /CCC is the active brick/);
		w.done();
	});

	it('reports the failure when the only channel left, a paired Bluetooth one, does not connect', async () => {
		const w = world({ paired: true, cabled: false });
		await signedInOver(w, Transport.BT);
		w.bt.off = true;
		await w.sessionManager.disconnect(btKey);
		await settle();
		const c = command(w);

		await c.connect();

		assert.equal(c.shown.errors.length, 1, 'the failed connect said nothing');
		w.done();
	});
});
