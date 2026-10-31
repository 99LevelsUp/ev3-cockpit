/**
 * The "Connect a Brick" command (step-2 plan, R18): a brick an inquiry hears while the list
 * is open gets a row, and picking a brick nobody has paired pairs it before it connects.
 *
 * Runs the real scheduler, aggregator and brick layer; only the picker, the notifications and
 * the providers underneath are fakes.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { BrickId, BrickKey, PresenceState, Transport, brickIdOf, makeBrickKey } from '../contracts';
import type { DiscoveryItem, DiscoveryScanResult, SessionHandle, TransportProvider } from '../contracts';
import { ProviderRegistry } from '../transports/providerRegistry';
import { BtConnectionQueue } from '../transports/btConnectionQueue';
import { BtPresenceMonitor } from '../transports/btPresence';
import { BtTransportProvider } from '../transports/btTransportProvider';
import type { PairingResult } from '../transports/btClassicDiscovery';
import type { BtPairingEvent, ScannedBrick } from '../transports/btPairingHelper';
import { DiscoveryScheduler } from '../runtime/discoveryScheduler';
import { PresenceAggregator } from '../runtime/presenceAggregator';
import { SessionManager } from '../runtime/sessionManager';
import { BrickManager } from '../runtime/brickManager';
import { BrickPickRow, brickPickRows } from '../ui/brickPickRows';
import { BrickPickerView, connectPickedBrick, pickBrick } from '../ui/connectBrick';
import { waitFor } from './waitFor';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const CCC_MAC = '00:16:53:42:D9:F2';
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

function layers(registry: ProviderRegistry) {
	const scheduler = new DiscoveryScheduler(registry);
	const aggregator = new PresenceAggregator(scheduler, registry);
	const sessionManager = new SessionManager({ providerRegistry: registry, heartbeatIntervalMs: 60_000 });
	const bricks = new BrickManager({ sessionManager, aggregator, providerRegistry: registry });
	const done = () => {
		bricks.dispose(); sessionManager.dispose(); aggregator.dispose(); scheduler.dispose(); registry.dispose();
	};
	return { scheduler, aggregator, sessionManager, bricks, done };
}

describe('Connect a Brick — a live scan while the list is open (R18)', () => {
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
		const picked = pickBrick(picker.view, w.aggregator, (id) => w.bricks.isSignedIn(id), () => w.presence.runInquiry());
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
		const picked = pickBrick(picker.view, w.aggregator, (id) => w.bricks.isSignedIn(id));
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

describe('Connect a Brick — pairing a new brick from the list (R18)', () => {
	/** A Bluetooth radio with one brick on it, and a pairing the test decides the outcome of. */
	function world(options: { paired: boolean; pairing?: PairingResult }) {
		const bobKey = makeBrickKey(Transport.BT, BOB_MAC);
		const bob: DiscoveryItem = {
			brickKey: bobKey, displayName: 'Bob', nameSource: 'bt-cache', transport: Transport.BT,
			presenceState: PresenceState.Available, remembered: options.paired, paired: options.paired,
			connected: false, favorite: false, lastSeenAt: Date.now(),
		};
		const registry = new ProviderRegistry();
		const l = layers(registry);
		const radio = { connects: 0, listedPairedAtConnect: [] as boolean[], pairedMacs: [] as string[] };
		const provider: TransportProvider = {
			transport: Transport.BT,
			priority: 20,
			capabilities: { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: false },
			async discover(): Promise<DiscoveryScanResult> { return { transport: Transport.BT, items: [{ ...bob }] }; },
			async connect(brickKey: BrickKey): Promise<SessionHandle> {
				radio.connects += 1;
				radio.listedPairedAtConnect.push(l.aggregator.getBrick(idOf(BOB_MAC))?.paired ?? false);
				return { brickKey, transport: Transport.BT };
			},
			async disconnect(): Promise<void> { /* nothing held */ },
			async sendPacket(): Promise<Uint8Array> { return new Uint8Array(0); },
			createCommandChannel: () => ({ execute: async () => ({ kind: 'info', displayName: 'Bob' } as const) }),
			dispose(): void { /* nothing to release */ },
		};
		registry.register(provider);

		const pair = async (mac: string, onEvent?: (event: BtPairingEvent) => void): Promise<PairingResult> => {
			radio.pairedMacs.push(mac);
			onEvent?.({ type: 'found', id: mac, name: 'Bob', alreadyPaired: false });
			const result = options.pairing ?? { ok: true };
			// Windows knows the pairing at once; discovery lists it as paired from now on.
			if (result.ok) { bob.paired = true; bob.remembered = true; }
			return result;
		};
		const shown = { titles: [] as string[], reports: [] as string[], info: [] as string[], errors: [] as string[] };
		const deps = {
			aggregator: l.aggregator, bricks: l.bricks, scheduler: l.scheduler, log: quiet, pair,
			progress: async <T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> => {
				shown.titles.push(title);
				return task((message) => shown.reports.push(message));
			},
			showInfo: (message: string) => shown.info.push(message),
			showError: (message: string) => shown.errors.push(message),
		};
		return { ...l, radio, shown, deps, bob: idOf(BOB_MAC), bobKey };
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
		const row = brickPickRows(w.aggregator.getDiscoveryList(), (id) => w.bricks.isSignedIn(id))[0];
		assert.equal(row.description, 'BT connected');
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
