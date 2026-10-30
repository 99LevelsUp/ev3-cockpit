/**
 * Bluetooth presence in discovery (step-2 plan, U7).
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { Transport } from '../contracts';
import { BackendUnavailableError } from '../errors/CockpitError';
import { BtConnectionQueue } from '../transports/btConnectionQueue';
import { BtPresenceMonitor } from '../transports/btPresence';
import { BtTransportProvider } from '../transports/btTransportProvider';
import { ScannedBrick } from '../transports/btPairingHelper';

const AAA = '00:16:53:5D:7E:2D';
const BBB = '00:16:53:51:87:39';
const STRANGER = '00:16:53:00:00:99';

function monitor(options: {
	answers?: Map<string, boolean[]>;
	inquiry?: ScannedBrick[];
	targets?: string[];
	queue?: BtConnectionQueue;
	check?: (mac: string) => Promise<boolean>;
	onUnavailable?: (reason: string) => void;
	inquiryIntervalMs?: number;
}) {
	const calls: string[] = [];
	const queue = options.queue ?? new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0 });
	const presence = new BtPresenceMonitor({
		queue,
		check: options.check ?? (async (mac) => {
			calls.push(mac);
			return options.answers?.get(mac)?.shift() ?? false;
		}),
		inquire: async () => options.inquiry ?? [],
		pairedWithoutSession: () => options.targets ?? [],
		missesBeforeNotHeard: 3,
		inquiryIntervalMs: options.inquiryIntervalMs ?? 60_000,
		onUnavailable: options.onUnavailable,
	});
	return { presence, calls, queue };
}

describe('BtPresenceMonitor — paired bricks', () => {
	it('counts a brick heard on its first answer and not heard only after three misses in a row', async () => {
		const { presence } = monitor({ targets: [AAA], answers: new Map([[AAA, [false, false, false, true]]]) });

		await presence.runChecks();
		await presence.runChecks();
		assert.equal(presence.presenceOf(AAA)?.heard, true, 'two misses may be the adapter, not the brick');
		await presence.runChecks();
		assert.equal(presence.presenceOf(AAA)?.heard, false);

		await presence.runChecks();
		assert.equal(presence.presenceOf(AAA)?.heard, true);
		assert.ok(presence.presenceOf(AAA)?.heardAt);
		presence.dispose();
	});

	it('knows nothing about a brick before its first check', () => {
		const { presence } = monitor({ targets: [AAA] });
		assert.equal(presence.presenceOf(AAA), undefined);
	});

	it('does not start a round while the previous one is still running', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		const seen: string[] = [];
		const { presence } = monitor({
			targets: [AAA],
			check: async (mac) => { seen.push(mac); await held; return true; },
		});
		const first = presence.runChecks();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await presence.runChecks();   // returns at once
		release();
		await first;
		assert.deepEqual(seen, [AAA]);
		presence.dispose();
	});

	it('forgets what it knew about a brick once that brick has a session', async () => {
		const targets = [AAA];
		const { presence } = monitor({ targets, answers: new Map([[AAA, [false, false, false]]]) });
		for (let i = 0; i < 3; i++) { await presence.runChecks(); }
		assert.equal(presence.presenceOf(AAA)?.heard, false);

		targets.length = 0;   // the brick connected
		await presence.runChecks();
		assert.equal(presence.presenceOf(AAA), undefined);
		presence.dispose();
	});

	it('does not hold up a connect queued behind a full round with a switched-off brick', async () => {
		// The shipped cooldowns: 15 s after a release, 30 s after a failure.
		const queue = new BtConnectionQueue();
		const { presence } = monitor({
			queue,
			targets: [AAA, BBB],
			check: async (mac) => { await new Promise((resolve) => setTimeout(resolve, 30)); return mac !== BBB; },
		});
		const round = presence.runChecks();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const queuedAt = Date.now();
		const release = await queue.acquire('user connect');
		const waited = Date.now() - queuedAt;
		release();
		await round;

		assert.ok(waited < 500, `the connect waited ${waited} ms behind presence checks`);
		presence.dispose();
		queue.dispose();
	});

	it('stops and says so once when the helper cannot run', async () => {
		const reasons: string[] = [];
		const { presence } = monitor({
			targets: [AAA],
			check: async () => { throw new BackendUnavailableError('helper missing'); },
			onUnavailable: (reason) => reasons.push(reason),
		});
		await presence.runChecks();
		await presence.runChecks();
		assert.deepEqual(reasons, ['helper missing']);
		presence.dispose();
	});
});

describe('BtPresenceMonitor — inquiry', () => {
	const sighting = (mac: string, paired: boolean): ScannedBrick => ({ mac, name: 'Stranger', paired, signal: -40, atMs: 0 });

	it('keeps the unpaired bricks an inquiry heard, and leaves the paired ones to their checks', async () => {
		const { presence } = monitor({ inquiry: [sighting(STRANGER, false), sighting(AAA, true)] });
		await presence.runInquiry();
		assert.deepEqual(presence.unpairedBricks().map((b) => b.mac), [STRANGER]);
		presence.dispose();
	});

	it('drops a brick two inquiry intervals went by without hearing', async () => {
		const inquiry = [sighting(STRANGER, false)];
		const { presence } = monitor({ inquiry, inquiryIntervalMs: 10 });
		await presence.runInquiry();
		inquiry.length = 0;
		await new Promise((resolve) => setTimeout(resolve, 30));
		await presence.runInquiry();
		assert.deepEqual(presence.unpairedBricks(), []);
		presence.dispose();
	});
});

describe('BtTransportProvider — discovery with presence', () => {
	function provider(presence: BtPresenceMonitor) {
		return new BtTransportProvider({
			discoverDevices: async () => [
				{ mac: AAA, name: 'AAA', connected: false, remembered: true, authenticated: true },
			],
			presence,
		});
	}

	it('keeps listing a paired brick that stopped answering, flagged as not heard', async () => {
		const { presence } = monitor({ targets: [AAA], answers: new Map([[AAA, [false, false, false]]]) });
		for (let i = 0; i < 3; i++) { await presence.runChecks(); }
		const bt = provider(presence);

		const items = (await bt.discover()).items;
		assert.equal(items.length, 1);
		assert.equal(items[0].heard, false);
		bt.dispose(); presence.dispose();
	});

	it('lists an unpaired brick the inquiry heard, with its signal', async () => {
		const { presence } = monitor({ inquiry: [{ mac: STRANGER, name: 'XYZ', paired: false, signal: -55, atMs: 0 }] });
		await presence.runInquiry();
		const bt = provider(presence);

		const stranger = (await bt.discover()).items.find((i) => i.brickKey === `${Transport.BT}:${STRANGER}`);
		assert.equal(stranger?.paired, false);
		assert.equal(stranger?.displayName, 'XYZ');
		assert.deepEqual(stranger?.signalInfo, { rssi: -55 });
		bt.dispose(); presence.dispose();
	});

	it('names the paired bricks without a session as the ones to check', async () => {
		const { presence } = monitor({});
		const bt = provider(presence);
		await bt.discover();
		assert.deepEqual(bt.pairedWithoutSession(), [AAA]);
		bt.dispose(); presence.dispose();
	});
});

describe('BtConnectionQueue — hold-only slots', () => {
	it('starts no cooldown when a hold-only slot is released', async () => {
		const queue = new BtConnectionQueue({ interConnectionCooldownMs: 10_000 });
		const held = await queue.acquire('presence', { holdOnly: true });
		held();
		const at = Date.now();
		const release = await queue.acquire('connect');
		assert.ok(Date.now() - at < 200);
		release();
		queue.dispose();
	});

	it('counts no error when a hold-only slot is released with one', async () => {
		const queue = new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 10_000 });
		const held = await queue.acquire('presence', { holdOnly: true });
		held(new Error('not heard'));
		const at = Date.now();
		const release = await queue.acquire('connect');
		assert.ok(Date.now() - at < 200);
		release();
		queue.dispose();
	});
});
