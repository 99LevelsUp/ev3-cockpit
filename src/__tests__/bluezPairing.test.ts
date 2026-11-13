/**
 * Pairing a brick through BlueZ with an agent the cockpit owns (step-7 plan, U5, KTD5).
 *
 * Measured on HOSTC (U0, 13.11.2026): BlueZ asks the agent of the connection that called Pair even
 * with the desktop's own agent default; the brick shows a connection request, then a PIN keyboard;
 * our agent is asked "RequestPinCode" and answers 1234; an unanswered brick dialog ends after 60 s
 * with org.bluez.Error.AuthenticationRejected.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBluezPairing, type PairingBus, type PairingCache } from '../transports/bluezPairing';
import type { ExportedMethod } from '../transports/dbus/connection';
import { DBusError } from '../transports/dbus/connection';
import { Variant, type DBusValue } from '../transports/dbus/wire';
import type { BluezDevice } from '../transports/bluezObjects';
import { PAIRING_CANCELLED, type BtPairingEvent } from '../transports/btPairingHelper';

const MAC = '00:16:53:F0:0A:0A';
const DEV = '/org/bluez/hci0/dev_00_16_53_F0_0A_0A';
const OTHER = '/org/bluez/hci0/dev_00_16_53_F0_0B_0B';

function device(paired: boolean, path = DEV): BluezDevice {
	return { path, address: MAC, name: 'AAA', alias: 'AAA', classOfDevice: 2052, paired, bonded: paired, trusted: false, connected: false, rssi: undefined };
}

class World implements PairingBus, PairingCache {
	calls: string[] = [];
	/** Calls with the object path they went to. */
	targets: string[] = [];
	known: BluezDevice[] = [];
	agent?: Record<string, ExportedMethod>;
	agentPath?: string;
	withdrawn = false;
	/** BlueZ takes one agent per connection: a second RegisterAgent fails with AlreadyExists. */
	registered = false;
	/** What Pair does: answer when the test says, or fail with an error. */
	pair?: { resolve: () => void; reject: (e: Error) => void };
	pairs = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
	pairOutcome?: () => Promise<void>;
	/** CancelPairing is acknowledged but Pair keeps hanging. */
	cancelIgnored = false;
	/** Pair fails as the bus does when its own call timer runs out. */
	pairHonoursTimeout = false;
	/** This call answers only when the test says. */
	deferMember?: string;
	deferred?: () => void;
	failOn?: { member: string; error: Error };
	changeHandlers = new Set<() => void>();
	discoveryFinds?: BluezDevice;

	// PairingCache
	devices(): BluezDevice[] { return this.known; }
	adapter() { return { path: '/org/bluez/hci0', address: undefined, alias: 'HOSTC', powered: true, discovering: false }; }
	onChange(h: () => void): () => void { this.changeHandlers.add(h); return () => this.changeHandlers.delete(h); }

	// PairingBus
	exportObject(path: string, _iface: string, methods: Record<string, ExportedMethod>): () => void {
		this.agentPath = path;
		this.agent = methods;
		this.withdrawn = false;
		return () => { this.withdrawn = true; };
	}
	async call(o: { path: string; interface: string; member: string; body?: DBusValue[]; timeoutMs?: number }): Promise<DBusValue[]> {
		this.calls.push(`${o.member}${o.member === 'SetDiscoveryFilter' ? ' ' + JSON.stringify([...(o.body![0] as Map<string, Variant>)].map(([k, v]) => [k, v.value])) : ''}`);
		this.targets.push(`${o.member} ${o.path}`);
		if (this.failOn?.member === o.member) { throw this.failOn.error; }
		if (o.member === 'RegisterAgent') {
			if (this.registered) { throw new DBusError('org.bluez.Error.AlreadyExists', 'Already Exists'); }
			this.registered = true;
		}
		if (o.member === 'UnregisterAgent') { this.registered = false; }
		if (o.member === this.deferMember) {
			await new Promise<void>((resolve) => { this.deferred = resolve; });
		}
		if (o.member === 'StartDiscovery' && this.discoveryFinds) {
			const found = this.discoveryFinds;
			setTimeout(() => { this.known = [found]; for (const h of this.changeHandlers) { h(); } }, 20);
		}
		if (o.member === 'Pair') {
			if (this.pairOutcome) { await this.pairOutcome(); return []; }
			if (this.pairHonoursTimeout) {
				const ms = o.timeoutMs!;
				return new Promise<DBusValue[]>((_resolve, reject) => { setTimeout(() => reject(new Error(`D-Bus call Pair timed out after ${ms} ms.`)), ms); });
			}
			return new Promise<DBusValue[]>((resolve, reject) => {
				const entry = { resolve: () => resolve([]), reject };
				this.pair = entry;
				this.pairs.set(o.path, entry);
			});
		}
		if (o.member === 'CancelPairing' && !this.cancelIgnored) {
			const entry = this.pairs.get(o.path);
			entry?.reject(new DBusError('org.bluez.Error.AuthenticationCanceled', 'Authentication Canceled'));
		}
		return [];
	}
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('BlueZ pairing (U5)', () => {
	it('answers a brick already paired without touching the radio', async () => {
		const w = new World();
		w.known = [device(true)];
		const events: BtPairingEvent[] = [];
		const result = await createBluezPairing({ bus: w, cache: w })(MAC, (e) => events.push(e));
		assert.deepEqual(result, { ok: true, status: 'AlreadyPaired' });
		assert.deepEqual(w.calls, []);
		assert.deepEqual(events.map((e) => e.type), ['alreadyPaired']);
	});

	it('registers its agent (not as default), pairs, answers the PIN for this brick, and unregisters', async () => {
		const w = new World();
		w.known = [device(false)];
		const events: BtPairingEvent[] = [];
		const pairing = createBluezPairing({ bus: w, cache: w })(MAC, (e) => events.push(e));
		await tick();
		assert.deepEqual(w.calls, ['RegisterAgent', 'Pair']);
		assert.ok(!w.calls.includes('RequestDefaultAgent'));
		const pin = await w.agent!.RequestPinCode.handler([DEV], {} as never);
		assert.deepEqual(pin, ['1234']);
		w.pair!.resolve();
		const result = await pairing;
		assert.deepEqual(result, { ok: true, status: 'Paired' });
		assert.deepEqual(w.calls, ['RegisterAgent', 'Pair', 'UnregisterAgent']);
		assert.equal(w.withdrawn, true);
		assert.deepEqual(events.map((e) => e.type), ['found', 'pairingRequested', 'result']);
	});

	it('refuses to answer for any other device', async () => {
		const w = new World();
		w.known = [device(false)];
		const pairing = createBluezPairing({ bus: w, cache: w })(MAC);
		await tick();
		await assert.rejects(async () => w.agent!.RequestPinCode.handler([OTHER], {} as never), /Rejected/);
		await assert.rejects(async () => w.agent!.RequestConfirmation.handler([OTHER, 123456], {} as never), /Rejected/);
		await assert.rejects(async () => w.agent!.AuthorizeService.handler([OTHER, '00001101-0000-1000-8000-00805f9b34fb'], {} as never), /Rejected/);
		assert.deepEqual(await w.agent!.RequestConfirmation.handler([DEV, 123456], {} as never), []);
		w.pair!.resolve();
		await pairing;
	});

	it('finds a brick BlueZ does not know with a BR/EDR discovery first, then stops it', async () => {
		const w = new World();
		w.discoveryFinds = device(false);
		w.pairOutcome = async () => { /* paired */ };
		const events: BtPairingEvent[] = [];
		const result = await createBluezPairing({ bus: w, cache: w })(MAC, (e) => events.push(e));
		assert.equal(result.ok, true);
		assert.deepEqual(w.calls, ['SetDiscoveryFilter [["Transport","bredr"]]', 'StartDiscovery', 'StopDiscovery', 'RegisterAgent', 'Pair', 'UnregisterAgent']);
		assert.deepEqual(events.map((e) => e.type).slice(0, 2), ['searching', 'found']);
	});

	it('gives up when the search does not find the brick, and stops the discovery', async () => {
		const w = new World();
		const result = await createBluezPairing({ bus: w, cache: w, searchMs: 60 })(MAC);
		assert.equal(result.ok, false);
		assert.equal(result.status, 'NotFound');
		assert.match(result.reason!, /visible/);
		assert.deepEqual(w.calls, ['SetDiscoveryFilter [["Transport","bredr"]]', 'StartDiscovery', 'StopDiscovery']);
	});

	it('says what an unanswered brick dialog means', async () => {
		const w = new World();
		w.known = [device(false)];
		w.pairOutcome = async () => { throw new DBusError('org.bluez.Error.AuthenticationRejected', 'Authentication Rejected'); };
		const result = await createBluezPairing({ bus: w, cache: w })(MAC);
		assert.equal(result.ok, false);
		assert.equal(result.status, 'AuthenticationRejected');
		assert.match(result.reason!, /rejected the pairing.*often because its dialog was not confirmed in time.*may still be showing on the brick/);
		assert.ok(w.calls.includes('UnregisterAgent'), 'the agent goes whatever happened');
	});

	it('counts AlreadyExists as paired', async () => {
		const w = new World();
		w.known = [device(false)];
		w.pairOutcome = async () => { throw new DBusError('org.bluez.Error.AlreadyExists', 'Already Exists'); };
		assert.deepEqual(await createBluezPairing({ bus: w, cache: w })(MAC), { ok: true, status: 'AlreadyPaired' });
	});

	it('cancels a pairing in flight when aborted, and answers cancelled', async () => {
		const w = new World();
		w.known = [device(false)];
		const controller = new AbortController();
		const pairing = createBluezPairing({ bus: w, cache: w })(MAC, undefined, controller.signal);
		await tick();
		controller.abort();
		const result = await pairing;
		assert.deepEqual(result, { ok: false, reason: PAIRING_CANCELLED, status: 'Cancelled' });
		assert.ok(w.calls.includes('CancelPairing'));
		assert.ok(w.calls.includes('UnregisterAgent'));
	});

	it('answers cancelled at once for a signal already aborted, touching nothing', async () => {
		const w = new World();
		const controller = new AbortController();
		controller.abort();
		assert.deepEqual(await createBluezPairing({ bus: w, cache: w })(MAC, undefined, controller.signal),
			{ ok: false, reason: PAIRING_CANCELLED, status: 'Cancelled' });
		assert.deepEqual(w.calls, []);
	});

	it('refuses something that is not a MAC address', async () => {
		const w = new World();
		const result = await createBluezPairing({ bus: w, cache: w })('zz:00:16:53:F0:0A');
		assert.equal(result.ok, false);
		assert.deepEqual(w.calls, []);
	});
	it('pairs one brick at a time: a second waits for the first, and neither is told AlreadyPaired falsely', async () => {
		const w = new World();
		w.known = [device(false), device(false, OTHER)];
		const pair = createBluezPairing({ bus: w, cache: w });
		const first = pair(MAC);
		const second = pair('00:16:53:F0:0B:0B');
		await tick();
		assert.deepEqual(w.calls, ['RegisterAgent', 'Pair'], 'the second has not started');
		assert.deepEqual(await w.agent!.RequestPinCode.handler([DEV], {} as never), ['1234']);
		w.pairs.get(DEV)!.resolve();
		assert.deepEqual(await first, { ok: true, status: 'Paired' });
		await tick();
		assert.deepEqual(w.calls, ['RegisterAgent', 'Pair', 'UnregisterAgent', 'RegisterAgent', 'Pair']);
		assert.equal(w.withdrawn, false, 'the second brick has its agent');
		assert.deepEqual(await w.agent!.RequestPinCode.handler([OTHER], {} as never), ['1234']);
		w.pairs.get(OTHER)!.resolve();
		assert.deepEqual(await second, { ok: true, status: 'Paired' });
	});

	it('does not count an agent BlueZ refused as a paired brick', async () => {
		const w = new World();
		w.known = [device(false)];
		w.failOn = { member: 'RegisterAgent', error: new DBusError('org.bluez.Error.AlreadyExists', 'Already Exists') };
		const result = await createBluezPairing({ bus: w, cache: w })(MAC);
		assert.equal(result.ok, false);
		assert.equal(result.status, 'AlreadyExists');
	});

	it('says "found" for a brick BlueZ already holds unpaired, before pairing, so the user is told to watch it', async () => {
		const w = new World();
		w.known = [device(false)];
		const events: BtPairingEvent[] = [];
		const pairing = createBluezPairing({ bus: w, cache: w })(MAC, (e) => { events.push(e); if (e.type === 'found') { w.calls.push('(found)'); } });
		await tick();
		assert.deepEqual(events[0], { type: 'found', id: MAC, name: 'AAA', alreadyPaired: false });
		assert.deepEqual(w.calls, ['(found)', 'RegisterAgent', 'Pair']);
		w.pair!.resolve();
		await pairing;
	});

	it('answers a discovery the adapter refuses with a status and a result event, not a rejection', async () => {
		const w = new World();
		w.failOn = { member: 'StartDiscovery', error: new DBusError('org.bluez.Error.NotReady', 'Resource Not Ready') };
		const events: BtPairingEvent[] = [];
		const result = await createBluezPairing({ bus: w, cache: w })(MAC, (e) => events.push(e));
		assert.equal(result.ok, false);
		assert.equal(result.status, 'NotReady');
		assert.match(result.reason!, /Bluetooth.*off/i);
		assert.deepEqual(events.at(-1), { type: 'result', status: 'NotReady', ok: false });
		assert.equal(w.changeHandlers.size, 0, 'nothing is left listening');
	});

	it('sees an abort that comes while it says it is searching, and does not touch the radio', async () => {
		const w = new World();
		const controller = new AbortController();
		const started = Date.now();
		const result = await createBluezPairing({ bus: w, cache: w })(MAC, (e) => { if (e.type === 'searching') { controller.abort(); } }, controller.signal);
		assert.deepEqual(result, { ok: false, reason: PAIRING_CANCELLED, status: 'Cancelled' });
		assert.ok(Date.now() - started < 1000);
		assert.deepEqual(w.calls, [], 'the radio is not touched');
		assert.equal(w.changeHandlers.size, 0);
	});

	it('takes an address without separators, and pairs the right object', async () => {
		const w = new World();
		w.known = [device(false)];
		w.pairOutcome = async () => { /* paired */ };
		const result = await createBluezPairing({ bus: w, cache: w })('001653f00a0a');
		assert.deepEqual(result, { ok: true, status: 'Paired' });
		assert.ok(w.targets.includes(`Pair ${DEV}`));
	});

	it('cancels the pairing at BlueZ when Pair runs past its time here', async () => {
		const w = new World();
		w.known = [device(false)];
		w.cancelIgnored = true;
		const result = await createBluezPairing({ bus: w, cache: w, pairTimeoutMs: 50 })(MAC);
		assert.equal(result.ok, false);
		assert.equal(result.status, 'Timeout');
		assert.ok(w.calls.includes('CancelPairing'));
		assert.ok(w.calls.includes('UnregisterAgent'));
	});

	it('answers an abort within the pairing time even when BlueZ acknowledges CancelPairing and Pair keeps hanging', async () => {
		const w = new World();
		w.known = [device(false)];
		w.cancelIgnored = true;
		const controller = new AbortController();
		const started = Date.now();
		const pairing = createBluezPairing({ bus: w, cache: w, pairTimeoutMs: 80 })(MAC, undefined, controller.signal);
		await tick();
		controller.abort();
		assert.deepEqual(await pairing, { ok: false, reason: PAIRING_CANCELLED, status: 'Cancelled' });
		assert.ok(Date.now() - started < 1000);
		assert.ok(w.calls.includes('UnregisterAgent'));
	});

	it('answers only BlueZ itself when it knows who BlueZ is on the bus', async () => {
		const w = new World();
		w.known = [device(false)];
		const pairing = createBluezPairing({ bus: w, cache: w, bluezOwner: () => ':1.2' })(MAC);
		await tick();
		await assert.rejects(async () => w.agent!.RequestPinCode.handler([DEV], { sender: ':1.66' } as never), /Rejected/);
		assert.deepEqual(await w.agent!.RequestPinCode.handler([DEV], { sender: ':1.2' } as never), ['1234']);
		w.pair!.resolve();
		await pairing;
	});
	it('checks the caller of every agent method, the display ones, Cancel and Release too (U8 review #8)', async () => {
		const w = new World();
		w.known = [device(false)];
		const pairing = createBluezPairing({ bus: w, cache: w, bluezOwner: () => ':1.2' })(MAC);
		await tick();
		const agent = w.agent!;
		await assert.rejects(async () => agent.DisplayPinCode.handler([DEV, '1234'], { sender: ':1.66' } as never), /Rejected/);
		await assert.rejects(async () => agent.DisplayPasskey.handler([DEV, 1234, 0], { sender: ':1.66' } as never), /Rejected/);
		await assert.rejects(async () => agent.DisplayPinCode.handler(['/org/bluez/hci0/dev_00_16_53_F0_0B_0B', '1234'], { sender: ':1.2' } as never), /Rejected/);
		await assert.rejects(async () => agent.Cancel.handler([], { sender: ':1.66' } as never), /Rejected/);
		await assert.rejects(async () => agent.Release.handler([], { sender: ':1.66' } as never), /Rejected/);
		assert.deepEqual(await agent.DisplayPinCode.handler([DEV, '1234'], { sender: ':1.2' } as never), []);
		assert.deepEqual(await agent.Cancel.handler([], { sender: ':1.2' } as never), []);
		w.pair!.resolve();
		await pairing;
	});

	it('refuses Cancel and Release from anybody while BlueZ\'s owner is unknown', async () => {
		const w = new World();
		w.known = [device(false)];
		const pairing = createBluezPairing({ bus: w, cache: w, bluezOwner: () => undefined })(MAC);
		await tick();
		await assert.rejects(async () => w.agent!.Cancel.handler([], { sender: ':1.2' } as never), /Rejected/);
		await assert.rejects(async () => w.agent!.Release.handler([], { sender: ':1.2' } as never), /Rejected/);
		w.pair!.resolve();
		await pairing;
	});

	it('owns the pairing deadline: the bus call waits longer, so a slow brick is a Timeout, not a bus error', async () => {
		const w = new World();
		w.known = [device(false)];
		w.pairHonoursTimeout = true;
		const result = await createBluezPairing({ bus: w, cache: w, pairTimeoutMs: 40 })(MAC);
		assert.equal(result.status, 'Timeout');
		assert.ok(w.calls.includes('CancelPairing'));
	});

	it('answers an abort while BlueZ has not yet answered StartDiscovery, and stops a discovery that starts late', async () => {
		const w = new World();
		w.deferMember = 'StartDiscovery';
		const controller = new AbortController();
		const started = Date.now();
		const pairing = createBluezPairing({ bus: w, cache: w })(MAC, undefined, controller.signal);
		await tick();
		assert.deepEqual(w.calls.slice(-1), ['StartDiscovery']);
		controller.abort();
		assert.deepEqual(await pairing, { ok: false, reason: PAIRING_CANCELLED, status: 'Cancelled' });
		assert.ok(Date.now() - started < 1000);
		assert.ok(!w.calls.includes('StopDiscovery'), 'not yet: the discovery has not started');
		w.deferred!();
		await tick();
		assert.equal(w.calls.at(-1), 'StopDiscovery');
		assert.equal(w.changeHandlers.size, 0);
	});
	it('answers an abort while BlueZ has not yet answered SetDiscoveryFilter, and starts no discovery', async () => {
		const w = new World();
		w.deferMember = 'SetDiscoveryFilter';
		const controller = new AbortController();
		const started = Date.now();
		const pairing = createBluezPairing({ bus: w, cache: w })(MAC, undefined, controller.signal);
		await tick();
		controller.abort();
		assert.deepEqual(await pairing, { ok: false, reason: PAIRING_CANCELLED, status: 'Cancelled' });
		assert.ok(Date.now() - started < 1000);
		w.deferred!();
		await tick();
		assert.deepEqual(w.calls, ['SetDiscoveryFilter [["Transport","bredr"]]']);
	});
	it('answers nobody while BlueZ\'s owner is unknown, once it is tracked', async () => {
		const w = new World();
		w.known = [device(false)];
		const pairing = createBluezPairing({ bus: w, cache: w, bluezOwner: () => undefined })(MAC);
		await tick();
		await assert.rejects(async () => w.agent!.RequestPinCode.handler([DEV], { sender: ':1.2' } as never), /Rejected/);
		w.pair!.resolve();
		await pairing;
	});
});
