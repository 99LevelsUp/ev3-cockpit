/**
 * Forgetting a brick through BlueZ (step-7 plan, U7, KTD6, KTD7).
 *
 * Measured on HOSTC (U0, 13.11.2026): `RemoveDevice` drops the device directory with the link key;
 * BlueZ keeps only its name cache, `/var/lib/bluetooth/<adapter>/cache/<brick>`, root-owned.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBluezUnpair, bluezForgetResidue, type UnpairBus, type UnpairCache } from '../transports/bluezForget';
import { DBusError } from '../transports/dbus/connection';
import type { DBusValue } from '../transports/dbus/wire';
import type { BluezDevice } from '../transports/bluezObjects';
import { BtTransportProvider } from '../transports/btTransportProvider';
import { Transport, makeBrickKey } from '../contracts';

const MAC = '00:16:53:F0:0A:0A';
const DEV = '/org/bluez/hci0/dev_00_16_53_F0_0A_0A';

class World implements UnpairBus, UnpairCache {
	calls: { path: string; member: string; body?: DBusValue[] }[] = [];
	failWith?: Error;
	known: BluezDevice[] = [{
		path: DEV, address: MAC, name: 'AAA', alias: 'AAA', classOfDevice: 2052,
		paired: true, bonded: true, trusted: false, connected: false, rssi: undefined,
	}];
	adapterInfo: { path: string; address: string | undefined } | undefined = { path: '/org/bluez/hci0', address: '00:00:00:00:00:01' };

	devices(): BluezDevice[] { return this.known; }
	adapter() { return this.adapterInfo ? { ...this.adapterInfo, alias: 'HOSTC', powered: true, discovering: false } : undefined; }
	async call(o: { path: string; member: string; body?: DBusValue[] }): Promise<DBusValue[]> {
		this.calls.push({ path: o.path, member: o.member, body: o.body });
		if (this.failWith) { throw this.failWith; }
		return [];
	}
}

describe('BlueZ unpair — RemoveDevice through the cache (U7, KTD6)', () => {
	it('removes the device object BlueZ holds for the brick, on its adapter', async () => {
		const w = new World();
		assert.deepEqual(await createBluezUnpair({ bus: w, cache: w })(MAC), { ok: true });
		assert.deepEqual(w.calls, [{ path: '/org/bluez/hci0', member: 'RemoveDevice', body: [DEV] }]);
	});

	it('finds the object whatever the address\'s spelling', async () => {
		const w = new World();
		assert.deepEqual(await createBluezUnpair({ bus: w, cache: w })('001653f00a0a'), { ok: true });
		assert.deepEqual(w.calls.map((c) => c.body), [[DEV]]);
	});

	it('counts a brick BlueZ does not hold as already forgotten, as Windows counts ERROR_NOT_FOUND', async () => {
		const w = new World();
		w.known = [];
		assert.deepEqual(await createBluezUnpair({ bus: w, cache: w })(MAC), { ok: true });
		assert.deepEqual(w.calls, []);
		const gone = new World();
		gone.failWith = new DBusError('org.bluez.Error.DoesNotExist', 'Does Not Exist');
		assert.deepEqual(await createBluezUnpair({ bus: gone, cache: gone })(MAC), { ok: true });
	});

	it('reports a refusal with BlueZ\'s reason', async () => {
		const w = new World();
		w.failWith = new DBusError('org.bluez.Error.Failed', 'Device busy');
		const result = await createBluezUnpair({ bus: w, cache: w })(MAC);
		assert.equal(result.ok, false);
		assert.match(result.reason!, /BlueZ.*Device busy/);
	});

	it('reports a bus that refuses this user as such', async () => {
		const w = new World();
		w.failWith = new DBusError('org.freedesktop.DBus.Error.AccessDenied', 'Rejected send message');
		const result = await createBluezUnpair({ bus: w, cache: w })(MAC);
		assert.equal(result.ok, false);
		assert.match(result.reason!, /AccessDenied/);
	});

	it('removes only through the adapter that holds the brick, and says when another one does (U7 review #1)', async () => {
		const w = new World();
		const other = '/org/bluez/hci1/dev_00_16_53_F0_0A_0A';
		w.known = [{ ...w.known[0], path: other }];
		const result = await createBluezUnpair({ bus: w, cache: w })(MAC);
		assert.equal(result.ok, false);
		assert.match(result.reason!, /another adapter/);
		assert.deepEqual(w.calls, []);
		const both = new World();
		both.known = [{ ...both.known[0], path: other }, both.known[0]];
		assert.deepEqual(await createBluezUnpair({ bus: both, cache: both })(MAC), { ok: true });
		assert.deepEqual(both.calls.map((c) => c.body), [[DEV]]);
	});

	it('refuses something that is not an address, and a computer without an adapter', async () => {
		const w = new World();
		assert.equal((await createBluezUnpair({ bus: w, cache: w })('zz')).ok, false);
		w.adapterInfo = undefined;
		assert.deepEqual(await createBluezUnpair({ bus: w, cache: w })(MAC), { ok: false, reason: 'This computer has no Bluetooth adapter BlueZ knows.' });
		assert.deepEqual(w.calls, []);
	});
});

describe('BlueZ residue — what stays after RemoveDevice (U7, KTD7)', () => {
	it('names the name cache under this adapter, with the brick\'s address as BlueZ spells it', () => {
		const w = new World();
		w.adapterInfo = { path: '/org/bluez/hci0', address: 'aa:bb:cc:00:00:01' };
		const residue = bluezForgetResidue(w)('001653f00a0a');
		assert.equal(residue.length, 1);
		assert.equal(residue[0].location, '/var/lib/bluetooth/AA:BB:CC:00:00:01/cache/00:16:53:F0:0A:0A');
		assert.match(residue[0].reason, /root/);
		assert.match(residue[0].reason, /name/);
	});

	it('names the adapter generically when its address is not known', () => {
		const w = new World();
		w.adapterInfo = { path: '/org/bluez/hci0', address: undefined };
		assert.equal(bluezForgetResidue(w)(MAC)[0].location, '/var/lib/bluetooth/<adapter>/cache/00:16:53:F0:0A:0A');
	});

	it('reaches the user through the provider\'s forget', async () => {
		const w = new World();
		const provider = new BtTransportProvider({ unpairDevice: createBluezUnpair({ bus: w, cache: w }), forgetResidue: bluezForgetResidue(w) });
		const residue = await provider.forget(makeBrickKey(Transport.BT, MAC));
		assert.match(residue[0].location, /^\/var\/lib\/bluetooth\//);
		assert.equal(w.calls[0].member, 'RemoveDevice');
		provider.dispose();
	});
});
