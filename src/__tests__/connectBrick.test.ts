/**
 * The "Connect a Brick" command: a brick an inquiry hears while the list is open gets a row, and
 * picking a brick nobody has paired pairs it before it connects.
 *
 * The flow itself runs over a stand-in for the daemon (the first two groups). The groups after
 * them run the Node core's scheduler, aggregator and brick layer underneath the flow, through
 * `coreAsContract`, and stay until the core goes; only the picker, the notifications and the
 * providers underneath are fakes there.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { BrickId, BrickKey, ChannelState, ConnectionState, PresenceState, Transport, brickIdOf, makeBrickKey } from '../core/contracts';
import type { DiscoveryItem, DiscoveryScanResult, SessionHandle, TransportProvider } from '../core/contracts';
import { ProviderRegistry } from '../core/transports/providerRegistry';
import { BtConnectionQueue } from '../core/transports/btConnectionQueue';
import { BtPresenceMonitor } from '../core/transports/btPresence';
import { BtTransportProvider } from '../core/transports/btTransportProvider';
import type { PairingResult } from '../core/transports/btClassicDiscovery';
import type { BtPairingEvent, ScannedBrick } from '../core/transports/btPairingHelper';
import { DiscoveryScheduler } from '../core/runtime/discoveryScheduler';
import { PresenceAggregator } from '../core/runtime/presenceAggregator';
import { SessionManager } from '../core/runtime/sessionManager';
import { BrickManager, BrickManagerOptions } from '../core/runtime/brickManager';
import type { ContractBrick, PairingProgress, PairingResult as ContractPairingResult } from '../contract/generated';
import { BrickPickRow, brickPickRows } from '../vscode/ui/brickPickRows';
import {
	BrickPickerView, ConnectBrickDeps, PairingStartedEvent, connectPickedBrick, describeRepair, followPairing, pickBrick,
} from '../vscode/ui/connectBrick';
import { contractBrick, listOf } from './contractBricks';
import { contractPairingStarted, coreConnect, coreList } from './coreAsContract';
import { waitFor } from './waitFor';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

const CCC_MAC = '00:16:53:F0:0C:0C';
const BOB_MAC = '00:16:53:00:00:B0';
const ZED_MAC = '00:16:53:00:00:FF';
const idOf = (mac: string): BrickId => brickIdOf(makeBrickKey(Transport.BT, mac));

/** A gate a test opens when it has looked at the middle of something. */
function gate(): { promise: Promise<void>; open: () => void } {
	let open = () => { /* replaced below */ };
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
}

/**
 * A QuickPick as the flow sees it. Like VS Code's, replacing the rows keeps the highlight on
 * the same row number, whichever brick is there now.
 */
function fakePicker() {
	let rows: readonly BrickPickRow[] = [];
	let active: readonly BrickPickRow[] = [];
	let busy = false;
	let disposed = false;
	let accept = () => { /* set by the flow */ };
	let hide = () => { /* set by the flow */ };
	const state = { busySeen: [] as boolean[], writesAfterDispose: 0, shown: false };
	const view: BrickPickerView & { selectedItems: BrickPickRow[] } = {
		get items() { return rows; },
		set items(next) {
			if (disposed) { state.writesAfterDispose += 1; }
			const at = active.length ? rows.indexOf(active[0]) : 0;
			rows = next;
			active = rows[at] ? [rows[at]] : [];
		},
		get activeItems() { return active; },
		set activeItems(next) { active = next; },
		selectedItems: [],
		get busy() { return busy; },
		set busy(next) { busy = next; state.busySeen.push(next); },
		onDidAccept(listener) { accept = listener; },
		onDidHide(listener) { hide = listener; },
		show() { state.shown = true; },
		hide() { /* nothing on screen */ },
		dispose() { disposed = true; },
	};
	const rowOf = (brickId: BrickId): BrickPickRow => {
		const row = rows.find((r) => r.brickId === brickId);
		assert.ok(row, `no row for ${brickId}`);
		return row;
	};
	return {
		view, state, rowOf,
		labels: () => rows.map((r) => r.label),
		arrowTo: (brickId: BrickId) => { active = [rowOf(brickId)]; },
		pick: (brickId: BrickId) => { view.selectedItems = [rowOf(brickId)]; accept(); },
		close: () => hide(),
	};
}

function layers(registry: ProviderRegistry, extra: Pick<BrickManagerOptions, 'pair' | 'btPresence'> = {}) {
	const scheduler = new DiscoveryScheduler(registry);
	const aggregator = new PresenceAggregator(scheduler, registry);
	const sessionManager = new SessionManager({ providerRegistry: registry, heartbeatIntervalMs: 60_000 });
	const bricks = new BrickManager({ sessionManager, aggregator, providerRegistry: registry, ...extra });
	const done = () => {
		bricks.dispose(); sessionManager.dispose(); aggregator.dispose(); scheduler.dispose(); registry.dispose();
	};
	return { scheduler, aggregator, sessionManager, bricks, done };
}

/** A daemon failure as the client library raises it: a message and `data.code`. */
const failure = (code: string, message: string): Error => Object.assign(new Error(message), { data: { code } });

/**
 * The daemon as the connect flow sees it: a brick list and a brick layer the test scripts. A
 * pairing is announced the way the bridge announces the daemon's, and its progress is followed the
 * way the extension follows every pairing.
 */
function daemonWorld(bricks: ContractBrick[], script: {
	pair?: ContractPairingResult['outcome'];
	pairMessage?: string;
	connect?: () => Error | undefined;
} = {}) {
	const list = listOf(bricks);
	const calls: string[] = [];
	const shown = { titles: [] as string[], reports: [] as string[], info: [] as string[], errors: [] as string[], log: [] as string[] };
	const progress = async <T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> => {
		shown.titles.push(title);
		return task((message) => shown.reports.push(message));
	};
	const deps: ConnectBrickDeps = {
		list,
		bricks: {
			connect: async (brickId) => {
				calls.push(`connect ${brickId}`);
				const error = script.connect?.();
				if (error) { throw error; }
				const brick = list.brick(brickId)!;
				const connected: ContractBrick = {
					...brick, connected: true,
					channels: brick.channels.map((c) => (c.state === 'available' ? { ...c, state: 'connected' as const } : c)),
				};
				list.set(list.bricks().map((b) => (b.brickId === brickId ? connected : b)));
				return connected;
			},
			pair: async (brickId) => {
				calls.push(`pair ${brickId}`);
				const steps: ((p: PairingProgress) => void)[] = [];
				const result: ContractPairingResult = {
					brickId, outcome: script.pair ?? 'paired', ...(script.pairMessage ? { message: script.pairMessage } : {}),
				};
				const event: PairingStartedEvent = { brickId, done: Promise.resolve(result), onProgress: (l) => { steps.push(l); } };
				const following = followPairing(event, { list, progress, showError: (m) => shown.errors.push(m) });
				for (const step of steps) { step({ phase: 'found', name: list.brick(brickId)?.name ?? '', alreadyPaired: false }); }
				await following;
				if (result.outcome === 'paired') {
					list.set(list.bricks().map((b) => (b.brickId === brickId ? { ...b, paired: true } : b)));
				}
				return result;
			},
		},
		log: { info: (m) => shown.log.push(m), warn: (m) => shown.log.push(m), error: (m) => shown.log.push(m) },
		progress,
		showInfo: (m) => shown.info.push(m),
		showError: (m) => shown.errors.push(m),
	};
	return { list, calls, shown, deps };
}

const BOB = idOf(BOB_MAC);
const ZED = idOf(ZED_MAC);
const CCC = idOf(CCC_MAC);

describe('Connect a Brick — the picker over the daemon\'s list', () => {
	it('adds a brick the daemon lists while the picker is open, keeps the highlight, and says it is looking until the inquiry ends', async () => {
		const w = daemonWorld([
			contractBrick(CCC, 'CCC', { usb: 'available', paired: true }),
			contractBrick(ZED, 'Zed', { bt: 'available' }),
		]);
		const picker = fakePicker();
		const inquiry = gate();
		const picked = pickBrick(picker.view, w.list, () => inquiry.promise);
		assert.deepEqual(picker.labels(), ['CCC', 'Zed']);
		assert.equal(picker.view.busy, true, 'the list did not say it is still looking');
		picker.arrowTo(ZED);

		// Bob is switched on just as the list opens; the inquiry the picker started hears him.
		w.list.set([...w.list.bricks(), contractBrick(BOB, 'Bob', { bt: 'available' })]);
		inquiry.open();
		await waitFor(() => !picker.view.busy, 2000);

		assert.deepEqual(picker.labels(), ['CCC', 'Bob', 'Zed']);
		assert.match(picker.rowOf(BOB).description, /BT available · new$/);
		assert.equal(picker.view.activeItems[0], picker.rowOf(ZED), 'the highlight moved off the brick the user had arrowed to');
		assert.deepEqual(picker.state.busySeen, [true, false]);

		picker.pick(BOB);
		assert.equal(await picked, BOB);
	});

	it('says it stopped looking when the inquiry fails', async () => {
		const w = daemonWorld([contractBrick(CCC, 'CCC', { usb: 'available' })]);
		const picker = fakePicker();
		const picked = pickBrick(picker.view, w.list, () => Promise.reject(failure('backend_unavailable', 'no radio')));
		await waitFor(() => !picker.view.busy, 2000);
		picker.close();
		assert.equal(await picked, undefined);
	});

	it('stops following the list once the picker is closed', async () => {
		const w = daemonWorld([contractBrick(CCC, 'CCC', { usb: 'available' })]);
		const picker = fakePicker();
		const picked = pickBrick(picker.view, w.list);
		picker.close();
		assert.equal(await picked, undefined);
		w.list.set([...w.list.bricks(), contractBrick(BOB, 'Bob', { bt: 'available' })]);
		assert.equal(w.list.listening(), 0, 'the closed picker still listens to the list');
		assert.equal(picker.state.writesAfterDispose, 0, 'a closed picker was still being redrawn');
	});
});

describe('Connect a Brick — connecting a picked brick over the daemon', () => {
	it('pairs a brick only an inquiry has heard, then connects it', async () => {
		const w = daemonWorld([contractBrick(BOB, 'Bob', { bt: 'available' })]);
		await connectPickedBrick(BOB, w.deps);
		assert.deepEqual(w.calls, [`pair ${BOB}`, `connect ${BOB}`]);
		assert.deepEqual(w.shown.titles, ['EVƎ Cockpit: pairing Bob', 'EVƎ Cockpit: connecting to Bob']);
		assert.deepEqual(w.shown.reports, ['Confirm on the brick\'s display, then accept PIN 1234.']);
		assert.deepEqual(w.shown.info, ['EVƎ Cockpit: connected to Bob.']);
		assert.deepEqual(w.shown.errors, []);
		assert.ok(w.shown.log.some((line) => line === `Connected to Bob [${BOB}] over BT`), w.shown.log.join('\n'));
		assert.equal(brickPickRows(w.list.bricks())[0].description, 'BT connected');
	});

	it('connects nothing when the pairing fails, and says why once', async () => {
		const w = daemonWorld([contractBrick(BOB, 'Bob', { bt: 'available' })], { pair: 'failed', pairMessage: 'the brick did not confirm' });
		await connectPickedBrick(BOB, w.deps);
		assert.deepEqual(w.shown.errors, ['EVƎ Cockpit: could not pair Bob — the brick did not confirm']);
		assert.deepEqual(w.shown.titles, ['EVƎ Cockpit: pairing Bob']);
		assert.deepEqual(w.calls, [`pair ${BOB}`]);
	});

	it('connects nothing and shows no error when the pairing was cancelled', async () => {
		const w = daemonWorld([contractBrick(BOB, 'Bob', { bt: 'available' })], { pair: 'cancelled', pairMessage: 'The pairing was cancelled.' });
		await connectPickedBrick(BOB, w.deps);
		assert.deepEqual(w.shown.errors, []);
		assert.deepEqual(w.calls, [`pair ${BOB}`]);
	});

	it('pairs a brick an inquiry has heard whose only other channel is lost, then connects it', async () => {
		// 01.11.2026: AAA, unplugged after a cable session, showed "USB lost · BT available · new";
		// the connect skipped the pairing and failed with "not available on any channel".
		const w = daemonWorld([contractBrick(BOB, 'Bob', { usb: 'lost', bt: 'available' })]);
		await connectPickedBrick(BOB, w.deps);
		assert.deepEqual(w.calls, [`pair ${BOB}`, `connect ${BOB}`]);
		assert.deepEqual(w.shown.errors, []);
	});

	it('does not pair a brick that is paired already, nor one a cable reaches', async () => {
		const paired = daemonWorld([contractBrick(BOB, 'Bob', { bt: 'available', paired: true })]);
		await connectPickedBrick(BOB, paired.deps);
		assert.deepEqual(paired.calls, [`connect ${BOB}`]);
		assert.deepEqual(paired.shown.titles, ['EVƎ Cockpit: connecting to Bob']);
		const cabled = daemonWorld([contractBrick(BOB, 'Bob', { usb: 'available', bt: 'available' })]);
		await connectPickedBrick(BOB, cabled.deps);
		assert.deepEqual(cabled.calls, [`connect ${BOB}`]);
	});

	it('connects a brick that is connected already over the channels it is not connected on, as the active brick', async () => {
		const w = daemonWorld([contractBrick(CCC, 'CCC', { usb: 'connected', bt: 'available', paired: true })]);
		await connectPickedBrick(CCC, w.deps);
		assert.deepEqual(w.calls, [`connect ${CCC}`]);
		assert.deepEqual(w.shown.info, ['EVƎ Cockpit: CCC is the active brick.']);
	});
});

describe('Connect a Brick — what a failed connect says, by the daemon\'s error code', () => {
	const cabled = () => [contractBrick(CCC, 'CCC', { usb: 'available', paired: true })];
	const btAlone = () => [contractBrick(CCC, 'CCC', { usb: 'lost', bt: 'available', paired: true })];

	for (const code of ['brick_unreachable', 'timeout']) {
		it(`${code}: the brick did not answer; the transport's own words stay in the log`, async () => {
			const w = daemonWorld(cabled(), { connect: () => failure(code, 'Winsock error 10060 on connect') });
			await connectPickedBrick(CCC, w.deps);
			assert.deepEqual(w.shown.errors, ['EVƎ Cockpit: CCC did not answer. Check that it is switched on and in range, then try again.']);
			assert.ok(w.shown.log.some((line) => line.startsWith(`Connecting to CCC [${CCC}] failed`)));
		});
	}

	it('connection_abandoned: the user disconnected it meanwhile; nothing failed, nothing is shown', async () => {
		const w = daemonWorld(cabled(), { connect: () => failure('connection_abandoned', 'disconnected while connecting') });
		await connectPickedBrick(CCC, w.deps);
		assert.deepEqual(w.shown.errors, []);
		assert.deepEqual(w.shown.info, []);
		assert.ok(w.shown.log.some((line) => /stopped: it was disconnected meanwhile/.test(line)));
	});

	it('any other code: says what the daemon said', async () => {
		const w = daemonWorld(cabled(), { connect: () => failure('brick_busy', 'VS Code (other window) is writing to it') });
		await connectPickedBrick(CCC, w.deps);
		assert.deepEqual(w.shown.errors, ['EVƎ Cockpit: could not connect to CCC — VS Code (other window) is writing to it']);
	});

	it('decides by the code, not by the class or the message', async () => {
		const w = daemonWorld(cabled(), { connect: () => Object.assign(new Error('BrickUnreachableError: timed out'), { name: 'BrickUnreachableError' }) });
		await connectPickedBrick(CCC, w.deps);
		assert.match(w.shown.errors[0], /could not connect to CCC — /);
	});

	it('over Bluetooth alone, adds that the pairing may be one-sided; out of reach only when the brick did answer something', async () => {
		const unanswered = daemonWorld(btAlone(), { connect: () => failure('brick_unreachable', 'no answer') });
		await connectPickedBrick(CCC, unanswered.deps);
		assert.match(unanswered.shown.errors[0], /did not answer\..* its pairing may be one-sided: connect it over USB or TCP/);
		assert.doesNotMatch(unanswered.shown.errors[0], /out of reach/);
		const other = daemonWorld(btAlone(), { connect: () => failure('connection_failed', 'refused') });
		await connectPickedBrick(CCC, other.deps);
		assert.match(other.shown.errors[0], /refused It may be out of reach\. If it keeps failing/);
		const viaCable = daemonWorld(cabled(), { connect: () => failure('brick_unreachable', 'no answer') });
		await connectPickedBrick(CCC, viaCable.deps);
		assert.doesNotMatch(viaCable.shown.errors[0], /one-sided/);
	});
});

describe('Connect a Brick — a pairing found broken on one side', () => {
	const removed = { brickId: CCC, found: 'computer-only' as const, removal: { status: 'removed' as const, channel: `bt:${CCC_MAC}` }, others: [] };

	it('says what was removed, and that the brick is pairing again when the daemon started that', () => {
		const again = describeRepair(removed, 'CCC', true);
		assert.equal(again.warning, false);
		assert.match(again.message, /This computer has CCC paired, but CCC no longer lists this computer\. The cockpit removed this computer's pairing and is pairing again/);
		assert.match(describeRepair(removed, 'CCC', false).message, /run "Connect a Brick" to pair again/);
	});

	it('warns when nothing could be removed, with the reason, and when it was found again after a repair', () => {
		const refused = describeRepair({ ...removed, removal: { status: 'refused', channel: `bt:${CCC_MAC}`, reason: 'error 5' } }, 'CCC', false);
		assert.equal(refused.warning, true);
		assert.match(refused.message, /could not remove this computer's pairing — error 5/);
		const sent = describeRepair({ ...removed, found: 'brick-only', removal: { status: 'sent', name: 'HOSTA', over: `bt:${CCC_MAC}`, detail: 'link closed' } }, 'CCC', false);
		assert.equal(sent.warning, true);
		assert.match(sent.message, /this computer's entry on CCC — link closed/);
		const repeated = describeRepair({ brickId: CCC, found: 'brick-only', others: ['HOSTB'], repeated: true }, 'CCC', false);
		assert.equal(repeated.warning, true);
		assert.match(repeated.message, /left it alone.*CCC also lists HOSTB/);
		for (const r of [again(), refused, sent, repeated]) { assert.doesNotMatch(r.message, /Windows/); }
		function again() { return describeRepair(removed, 'CCC', true); }
	});
});

describe('Connect a Brick — a live scan while the list is open, over the core', () => {
	/**
	 * The shipped Bluetooth discovery and presence monitor, over a radio the test controls.
	 * The monitor's change hook scans, as `createRuntime` wires it.
	 */
	function world() {
		const heard: ScannedBrick[] = [];
		let inquiryGate: Promise<void> | undefined;
		const queue = new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0 });
		const registry = new ProviderRegistry();
		const l = layers(registry);
		const presence = new BtPresenceMonitor({
			queue,
			check: async () => true,
			inquire: async () => { await inquiryGate; return [...heard]; },
			pairedWithoutSession: () => [],
			inquiryIntervalMs: 60_000,
			onChange: () => { void l.scheduler.scanOnce().catch(() => { /* a test failure shows elsewhere */ }); },
		});
		const bt = new BtTransportProvider({
			discoverDevices: async () => [{ mac: CCC_MAC, name: 'CCC', connected: false, remembered: true, authenticated: true }],
			presence,
		});
		registry.register(bt);
		const sighting = (mac: string, name: string): ScannedBrick => ({ mac, name, paired: false, signal: -50, atMs: 0 });
		return {
			...l, presence,
			hear: (mac: string, name: string) => heard.push(sighting(mac, name)),
			holdInquiry: () => { const g = gate(); inquiryGate = g.promise; return g.open; },
			done: () => { presence.dispose(); queue.dispose(); l.done(); },
		};
	}

	it('adds a brick the inquiry hears to the open list, and keeps the highlight on the brick it was on', async () => {
		const w = world();
		w.hear(ZED_MAC, 'Zed');
		await w.presence.runInquiry();
		await w.scheduler.scanOnce();
		const picker = fakePicker();

		// Bob is switched on just as the list opens; the inquiry the picker starts hears him.
		w.hear(BOB_MAC, 'Bob');
		const release = w.holdInquiry();
		const picked = pickBrick(picker.view, coreList(w.aggregator, w.bricks), () => w.presence.runInquiry());
		assert.deepEqual(picker.labels(), ['CCC', 'Zed']);
		assert.equal(picker.view.busy, true, 'the list did not say it is still looking');
		picker.arrowTo(idOf(ZED_MAC));

		release();
		await waitFor(() => picker.labels().includes('Bob'), 2000);

		assert.deepEqual(picker.labels(), ['CCC', 'Bob', 'Zed']);
		assert.match(picker.rowOf(idOf(BOB_MAC)).description, /BT available · new$/);
		assert.equal(picker.view.activeItems[0], picker.rowOf(idOf(ZED_MAC)),
			'the highlight moved off the brick the user had arrowed to');
		await waitFor(() => !picker.view.busy, 2000);
		assert.deepEqual(picker.state.busySeen, [true, false]);

		picker.pick(idOf(BOB_MAC));
		assert.equal(await picked, idOf(BOB_MAC));
		w.done();
	});

	it('stops following the list once the picker is closed', async () => {
		const w = world();
		await w.scheduler.scanOnce();
		const picker = fakePicker();
		const picked = pickBrick(picker.view, coreList(w.aggregator, w.bricks));
		picker.close();
		assert.equal(await picked, undefined);

		w.hear(BOB_MAC, 'Bob');
		await w.presence.runInquiry();
		await w.scheduler.scanOnce();
		assert.ok(w.aggregator.getBrick(idOf(BOB_MAC)), 'the list did not change, so this proves nothing');
		assert.equal(picker.state.writesAfterDispose, 0, 'a closed picker was still being redrawn');
		w.done();
	});
});

describe('Connect a Brick — pairing a new brick from the list, over the core', () => {
	/** A Bluetooth radio with one brick on it, and a pairing the test decides the outcome of. */
	function world(options: { paired: boolean; pairing?: PairingResult; listsPairingNever?: boolean }) {
		const bobKey = makeBrickKey(Transport.BT, BOB_MAC);
		const bob: DiscoveryItem = {
			brickKey: bobKey, displayName: 'Bob', nameSource: 'bt-cache', transport: Transport.BT,
			presenceState: PresenceState.Available, remembered: options.paired, paired: options.paired,
			connected: false, favorite: false, lastSeenAt: Date.now(),
		};
		const registry = new ProviderRegistry();
		/** The presence checks: the bricks whose last check did not hear them. */
		const presence = {
			unheard: new Set<string>(),
			forget(mac: string) { this.unheard.delete(mac); },
			notePaired(mac: string) { this.unheard.delete(mac); },
		};
		/** The pairing the brick layer runs; a test swaps `impl` to stage what happens during it. */
		const pairing = {
			impl: async (mac: string, onEvent?: (event: BtPairingEvent) => void, _signal?: AbortSignal): Promise<PairingResult> => {
				radio.pairedMacs.push(mac);
				onEvent?.({ type: 'found', id: mac, name: 'Bob', alreadyPaired: false });
				const result = options.pairing ?? { ok: true };
				// Windows knows the pairing at once; discovery lists it as paired from now on.
				if (result.ok && !options.listsPairingNever) { bob.paired = true; bob.remembered = true; }
				return result;
			},
		};
		const l = layers(registry, {
			pair: (mac, onEvent, signal) => pairing.impl(mac, onEvent, signal),
			btPresence: presence,
		});
		const radio = {
			connects: 0, discovers: 0, listedPairedAtConnect: [] as boolean[], pairedMacs: [] as string[],
			/** Holds the next discover's answer, which is read from Windows' list before the hold. */
			discoverGate: undefined as Promise<void> | undefined,
			/** The next discover lists the brick unpaired: Windows' list has not caught up yet. */
			unpairedNext: false,
			/** Discover lists nothing: the inquiry's sighting aged out, and Windows does not list it. */
			hidden: false,
			/** Connecting fails. */
			refuseConnect: false,
		};
		const provider: TransportProvider = {
			transport: Transport.BT,
			priority: 20,
			capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: false },
			async discover(): Promise<DiscoveryScanResult> {
				radio.discovers += 1;
				const item = radio.unpairedNext ? { ...bob, paired: false, remembered: false } : { ...bob };
				radio.unpairedNext = false;
				const items = radio.hidden ? [] : [presence.unheard.has(BOB_MAC) ? { ...item, heard: false } : item];
				const held = radio.discoverGate;
				radio.discoverGate = undefined;
				if (held) { await held; }
				return { transport: Transport.BT, items };
			},
			async connect(brickKey: BrickKey): Promise<SessionHandle> {
				radio.connects += 1;
				if (radio.refuseConnect) { throw new Error('the brick refused the link'); }
				radio.listedPairedAtConnect.push(l.aggregator.getBrick(idOf(BOB_MAC))?.paired ?? false);
				return { brickKey, transport: Transport.BT };
			},
			async disconnect(): Promise<void> { /* nothing held */ },
			async sendPacket(): Promise<Uint8Array> { return new Uint8Array(0); },
			createCommandChannel: () => ({ execute: async () => ({ kind: 'info', displayName: 'Bob' } as const) }),
			dispose(): void { /* nothing to release */ },
		};
		registry.register(provider);

		const shown = { titles: [] as string[], reports: [] as string[], info: [] as string[], errors: [] as string[] };
		const progress = async <T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> => {
			shown.titles.push(title);
			return task((message) => shown.reports.push(message));
		};
		const deps = {
			list: coreList(l.aggregator, l.bricks), bricks: coreConnect(l.aggregator, l.bricks), log: quiet, progress,
			showInfo: (message: string) => shown.info.push(message),
			showError: (message: string) => shown.errors.push(message),
		};
		// The extension shows every pairing's progress, whoever started it.
		l.bricks.onPairingStarted((event) => {
			void followPairing(contractPairingStarted(event), { list: deps.list, progress, showError: deps.showError });
		});
		return { ...l, radio, presence, pairing, shown, deps, bob: idOf(BOB_MAC), bobKey };
	}

	it('pairs a brick only an inquiry has heard, then connects it', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();

		await connectPickedBrick(w.bob, w.deps);

		assert.deepEqual(w.radio.pairedMacs, [BOB_MAC]);
		assert.deepEqual(w.shown.titles, ['EVƎ Cockpit: pairing Bob', 'EVƎ Cockpit: connecting to Bob']);
		assert.deepEqual(w.shown.reports, ['Confirm on the brick\'s display, then accept PIN 1234.']);
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		assert.equal(w.bricks.routeOf(w.bob), w.bobKey);
		assert.deepEqual(w.shown.info, ['EVƎ Cockpit: connected to Bob.']);
		assert.deepEqual(w.shown.errors, []);
		// The list learnt of the pairing before the connect, so the row no longer says new.
		assert.deepEqual(w.radio.listedPairedAtConnect, [true]);
		const row = brickPickRows(w.deps.list.bricks())[0];
		assert.equal(row.description, 'BT connected');
		w.done();
	});

	it('connects a freshly paired brick while a Bluetooth scan never answers', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();
		// A scan stuck in the operating system: nothing the connect does may wait for it.
		const held = gate();
		w.radio.discoverGate = held.promise;
		const stuck = w.scheduler.scanOnce().catch(() => { /* the connect is what is under test */ });

		const outcome = await Promise.race([
			connectPickedBrick(w.bob, w.deps).then(() => 'done'),
			new Promise((resolve) => setTimeout(() => resolve('waiting'), 1000)),
		]);
		held.open();
		await stuck;

		assert.equal(outcome, 'done', 'the connect waited for a scan');
		assert.deepEqual(w.shown.errors, []);
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		assert.equal(w.bricks.routeOf(w.bob), w.bobKey);
		assert.deepEqual(w.radio.listedPairedAtConnect, [true]);
		w.done();
	});

	it('connects a freshly paired brick without a scan showing the pairing', async () => {
		const w = world({ paired: false, listsPairingNever: true });
		await w.scheduler.scanOnce();

		await connectPickedBrick(w.bob, w.deps);

		assert.deepEqual(w.radio.pairedMacs, [BOB_MAC]);
		assert.equal(w.radio.discovers, 1, 'the pairing it made is known without reading it back');
		assert.deepEqual(w.shown.errors, []);
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		assert.equal(w.aggregator.getBrick(w.bob)?.paired, true);
		w.done();
	});

	it('keeps the pairing when a scan that read Windows\' list before it lands afterwards', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();
		const held = gate();
		w.radio.discoverGate = held.promise;
		w.radio.unpairedNext = true;
		const stale = w.scheduler.scanOnce().catch(() => { /* the connect is what is under test */ });

		await connectPickedBrick(w.bob, w.deps);
		held.open();
		await stale;

		assert.equal(w.aggregator.getBrick(w.bob)?.paired, true, 'an older reading undid the pairing');
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		w.done();
	});

	it('connects a freshly paired brick whose sighting the list dropped during the pairing', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();
		const pair = w.pairing.impl;
		// Pairing takes the brick's owner tens of seconds; an inquiry sighting can expire meanwhile.
		w.pairing.impl = async (mac, onEvent) => {
			w.scheduler.forget([w.bobKey]);
			w.aggregator.forget(w.bob);
			return pair(mac, onEvent);
		};

		await connectPickedBrick(w.bob, w.deps);

		assert.deepEqual(w.shown.errors, []);
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		assert.equal(w.bricks.routeOf(w.bob), w.bobKey);
		w.done();
	});

	it('connects a freshly paired brick though a scan that began before the pairing lands empty just before the sign-in', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();   // the inquiry's sighting
		w.radio.hidden = true;
		await w.scheduler.scanOnce();   // aged out: one miss
		// One more scan reads the empty list before the pairing; a second miss would take the channel.
		const held = gate();
		w.radio.discoverGate = held.promise;
		const stale = w.scheduler.scanOnce().catch(() => { /* the connect is what is under test */ });
		w.radio.hidden = false;
		const deps = {
			...w.deps,
			progress: async <T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> => {
				if (title.startsWith('EVƎ Cockpit: connecting')) { held.open(); await stale; }
				return w.deps.progress(title, task);
			},
		};

		await connectPickedBrick(w.bob, deps);

		assert.deepEqual(w.shown.errors, [], 'an older scan took the freshly paired brick\'s channel away');
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		w.done();
	});

	it('connects a freshly paired brick that a presence check missed while its owner was confirming', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();   // the inquiry's sighting
		const held = gate();
		let stale: Promise<void> | undefined;
		const pair = w.pairing.impl;
		w.pairing.impl = async (mac, onEvent) => {
				const result = await pair(mac, onEvent);
				// Windows lists the pairing before the helper reports it, and the presence check of a
				// brick still busy with the ceremony did not hear it.
				assert.ok(w.scheduler.getTrackedBricks().get(w.bobKey), 'the sighting is not tracked, so this test shows nothing');
				w.presence.unheard.add(BOB_MAC);
				await w.scheduler.scanOnce();
				// One more scan reads that list before the pairing is recorded, and lands after it.
				w.radio.discoverGate = held.promise;
				stale = w.scheduler.scanOnce().catch(() => { /* the connect is what is under test */ });
				return result;
		};
		const deps = {
			...w.deps,
			progress: async <T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> => {
				if (title.startsWith('EVƎ Cockpit: connecting')) { held.open(); await stale; }
				return w.deps.progress(title, task);
			},
		};

		await connectPickedBrick(w.bob, deps);

		assert.deepEqual(w.shown.errors, [], 'a presence check older than the pairing took the channel away');
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		w.done();
	});

	it('connects a freshly paired brick though a scan after the pairing carries a presence check from before it', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();   // the inquiry's sighting
		const pair = w.pairing.impl;
		w.pairing.impl = async (mac, onEvent) => {
			// The presence check ran while the owner was confirming on the brick, and missed it.
			w.presence.unheard.add(BOB_MAC);
			return pair(mac, onEvent);
		};
		const deps = {
			...w.deps,
			progress: async <T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> => {
				// A scan that starts after the pairing lands just before the sign-in.
				if (title.startsWith('EVƎ Cockpit: connecting')) { await w.scheduler.scanOnce(); }
				return w.deps.progress(title, task);
			},
		};

		await connectPickedBrick(w.bob, deps);

		assert.deepEqual(w.shown.errors, [], 'a presence check older than the pairing took the channel away');
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		w.done();
	});

	it('lets a brick it paired but could not connect expire once nothing lists it', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();
		w.radio.refuseConnect = true;
		const pair = w.pairing.impl;
		w.pairing.impl = async (mac, onEvent) => {
			// The sighting expires while the owner confirms, and nothing lists the brick afterwards.
			w.scheduler.forget([w.bobKey]);
			w.aggregator.forget(w.bob);
			w.radio.hidden = true;
			return pair(mac, onEvent);
		};

		await connectPickedBrick(w.bob, w.deps);
		assert.equal(w.shown.errors.length, 1, 'the connect did not fail, so this test shows nothing');
		for (let scan = 0; scan < 8; scan++) { await w.scheduler.scanOnce(); }

		assert.equal(w.aggregator.getBrick(w.bob), undefined, 'the paired row stays in the list for ever');
		w.done();
	});

	it('runs one pairing for two callers that pair the same brick at once', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();
		const held = gate();
		const pair = w.pairing.impl;
		w.pairing.impl = async (mac, onEvent) => { await held.promise; return pair(mac, onEvent); };
		let started = 0;
		w.bricks.onPairingStarted(() => { started += 1; });

		const first = w.bricks.pair(w.bob);
		const second = w.bricks.pair(w.bob);
		held.open();
		const [a, b] = await Promise.all([first, second]);

		assert.deepEqual(w.radio.pairedMacs, [BOB_MAC], 'the brick was paired twice');
		assert.deepEqual(a, b);
		assert.equal(started, 1, 'two pairings were announced');
		w.done();
	});

	it('records a pairing it made: the list says paired, the channel is available, older presence checks are dropped', async () => {
		const w = world({ paired: false, listsPairingNever: true });
		await w.scheduler.scanOnce();
		w.presence.unheard.add(BOB_MAC);

		const result = await w.bricks.pair(w.bob);

		assert.equal(result.ok, true);
		const entry = w.aggregator.getBrick(w.bob);
		assert.equal(entry?.paired, true);
		assert.equal(entry?.channels.find((c) => c.transport === Transport.BT)?.state, ChannelState.Available);
		assert.equal(w.presence.unheard.has(BOB_MAC), false, 'a presence check from before the pairing survived it');
		w.done();
	});

	it('records nothing from a pairing that ends after the brick was forgotten', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();
		const pair = w.pairing.impl;
		// The person accepts on the brick just as the forget stops the pairing: it completes anyway.
		w.pairing.impl = async (mac, onEvent, signal) => {
			await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
			return pair(mac, onEvent);
		};

		const pairing = w.bricks.pair(w.bob);
		await new Promise((resolve) => setImmediate(resolve));
		await w.bricks.forget(w.bob);
		const result = await pairing;

		assert.equal(result.ok, false);
		assert.equal(w.aggregator.getBrick(w.bob)?.paired ?? false, false, 'the forgotten brick came back paired');
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(w.shown.errors, [], 'a pairing the forget stopped was reported as a failure');
		w.done();
	});

	it('records nothing, and throws nothing, from a pairing that ends after the brick layer was disposed', async () => {
		const w = world({ paired: false });
		await w.scheduler.scanOnce();
		const held = gate();
		const pair = w.pairing.impl;
		w.pairing.impl = async (mac, onEvent) => { await held.promise; return pair(mac, onEvent); };

		const pairing = w.bricks.pair(w.bob);
		w.bricks.dispose();
		held.open();
		const result = await pairing;

		assert.equal(result.ok, false);
		assert.equal(w.aggregator.getBrick(w.bob)?.paired, false);
		w.done();
	});

	it('connects nothing when the pairing fails, and says why', async () => {
		const w = world({ paired: false, pairing: { ok: false, reason: 'the brick did not confirm' } });
		await w.scheduler.scanOnce();

		await connectPickedBrick(w.bob, w.deps);

		assert.deepEqual(w.shown.errors, ['EVƎ Cockpit: could not pair Bob — the brick did not confirm']);
		assert.deepEqual(w.shown.titles, ['EVƎ Cockpit: pairing Bob']);
		assert.equal(w.radio.connects, 0);
		assert.equal(w.bricks.isSignedIn(w.bob), false);
		w.done();
	});

	it('pairs a brick an inquiry has heard whose only other channel is lost, then connects it', async () => {
		// 01.11.2026: AAA, unplugged after a cable session, showed "USB lost · BT available · new";
		// the connect skipped the pairing and failed with "not available on any channel".
		const w = world({ paired: false });
		await w.scheduler.scanOnce();
		const usbKey = makeBrickKey(Transport.USB, w.bob);
		w.aggregator.updateChannelSession(usbKey, ConnectionState.Connected);
		w.aggregator.updateChannelSession(usbKey, ConnectionState.Reconnecting);
		assert.equal(w.aggregator.getBrick(w.bob)?.channels.find((c) => c.transport === Transport.USB)?.state,
			ChannelState.Lost, 'the USB channel is not lost, so this test shows nothing');

		await connectPickedBrick(w.bob, w.deps);

		assert.deepEqual(w.radio.pairedMacs, [BOB_MAC], 'the brick was not paired');
		assert.deepEqual(w.shown.errors, []);
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		assert.equal(w.bricks.routeOf(w.bob), w.bobKey);
		w.done();
	});

	it('does not pair a brick that is paired already', async () => {
		const w = world({ paired: true });
		await w.scheduler.scanOnce();

		await connectPickedBrick(w.bob, w.deps);

		assert.deepEqual(w.radio.pairedMacs, []);
		assert.deepEqual(w.shown.titles, ['EVƎ Cockpit: connecting to Bob']);
		assert.equal(w.bricks.isSignedIn(w.bob), true);
		w.done();
	});
});
