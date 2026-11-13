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
	known: BluezDevice[] = [];
	agent?: Record<string, ExportedMethod>;
	agentPath?: string;
	withdrawn = false;
	/** What Pair does: answer when the test says, or fail with an error. */
	pair?: { resolve: () => void; reject: (e: Error) => void };
	pairOutcome?: () => Promise<void>;
	private changeHandlers = new Set<() => void>();
	discoveryFinds?: BluezDevice;

	// PairingCache
	devices(): BluezDevice[] { return this.known; }
	adapter() { return { path: '/org/bluez/hci0', address: undefined, alias: 'HOSTC', powered: true, discovering: false }; }
	onChange(h: () => void): () => void { this.changeHandlers.add(h); return () => this.changeHandlers.delete(h); }

	// PairingBus
	exportObject(path: string, _iface: string, methods: Record<string, ExportedMethod>): () => void {
		this.agentPath = path;
		this.agent = methods;
		return () => { this.withdrawn = true; };
	}
	async call(o: { path: string; interface: string; member: string; body?: DBusValue[]; timeoutMs?: number }): Promise<DBusValue[]> {
		this.calls.push(`${o.member}${o.member === 'SetDiscoveryFilter' ? ' ' + JSON.stringify([...(o.body![0] as Map<string, Variant>)].map(([k, v]) => [k, v.value])) : ''}`);
		if (o.member === 'StartDiscovery' && this.discoveryFinds) {
			const found = this.discoveryFinds;
			setTimeout(() => { this.known = [found]; for (const h of this.changeHandlers) { h(); } }, 20);
		}
		if (o.member === 'Pair') {
			if (this.pairOutcome) { await this.pairOutcome(); return []; }
			return new Promise<DBusValue[]>((resolve, reject) => { this.pair = { resolve: () => resolve([]), reject }; });
		}
		if (o.member === 'CancelPairing' && this.pair) {
			this.pair.reject(new DBusError('org.bluez.Error.AuthenticationCanceled', 'Authentication Canceled'));
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
		assert.deepEqual(events.map((e) => e.type), ['pairingRequested', 'result']);
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
		assert.match(result.reason!, /not confirmed.*may still be showing on the brick/);
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
});
