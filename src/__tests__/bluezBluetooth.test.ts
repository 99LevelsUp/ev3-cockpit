/**
 * The Linux Bluetooth factory (step-7 plan, U8, KTD8): one bus connection, BlueZ's owner tracked,
 * the object cache renewed when BlueZ restarts, and every seam the Windows backend fills.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBluezBluetooth, type BluezBus } from '../transports/bluezBluetooth';
import { BtBluezAdapter } from '../transports/btBluezAdapter';
import { DBusError, type ExportedMethod } from '../transports/dbus/connection';
import { MessageType, type DBusMessage } from '../transports/dbus/message';
import { Variant, type DBusValue } from '../transports/dbus/wire';
import { BackendUnavailableError } from '../errors/CockpitError';
import { BtConnectionQueue } from '../transports/btConnectionQueue';
import { BtClassicDiscovery } from '../transports/btClassicDiscovery';
import { BtPresenceMonitor } from '../transports/btPresence';

const AAA = '/org/bluez/hci0/dev_00_16_53_F0_0A_0A';
const BBB = '/org/bluez/hci0/dev_00_16_53_F0_0B_0B';
const DBUS = 'org.freedesktop.DBus';

function device(name: string, mac: string, paired: boolean): Map<string, Variant> {
	return new Map<string, Variant>([
		['Address', new Variant('s', mac)], ['Name', new Variant('s', name)], ['Alias', new Variant('s', name)],
		['Class', new Variant('u', 2052)], ['Paired', new Variant('b', paired)], ['Bonded', new Variant('b', paired)],
		['Connected', new Variant('b', false)],
	]);
}

function objects(...devices: [string, Map<string, Variant>][]): Map<string, Map<string, Map<string, Variant>>> {
	return new Map([
		['/org/bluez/hci0', new Map([['org.bluez.Adapter1', new Map<string, Variant>([['Alias', new Variant('s', 'HOSTC')], ['Address', new Variant('s', '00:00:00:00:00:01')]])]])],
		...devices.map(([path, props]) => [path, new Map([['org.bluez.Device1', props]])] as [string, Map<string, Map<string, Variant>>]),
	]);
}

class FakeBus implements BluezBus {
	calls: string[] = [];
	matches: string[] = [];
	owner: string | undefined = ':1.2';
	managed: DBusValue = objects([AAA, device('AAA', '00:16:53:F0:0A:0A', true)]);
	failManaged?: Error;
	closed = false;
	/** Discovery starts and stops, with the time, for the overlap test. */
	discovery: string[] = [];
	private signalHandlers = new Set<(m: DBusMessage) => void>();
	private closeHandlers = new Set<() => void>();

	async call(o: { member: string; path: string; body?: DBusValue[] }): Promise<DBusValue[]> {
		this.calls.push(o.member);
		if (o.member === 'GetNameOwner') {
			if (!this.owner) { throw new DBusError('org.freedesktop.DBus.Error.NameHasNoOwner', 'no owner'); }
			return [this.owner];
		}
		if (o.member === 'GetManagedObjects') {
			if (this.failManaged) { throw this.failManaged; }
			return [this.managed];
		}
		if (o.member === 'StartDiscovery' || o.member === 'StopDiscovery') { this.discovery.push(o.member); }
		if (o.member === 'Pair') { await new Promise((r) => setTimeout(r, 30)); }
		return [];
	}
	async addMatch(rule: string): Promise<void> { this.matches.push(rule); }
	onSignal(h: (m: DBusMessage) => void): () => void { this.signalHandlers.add(h); return () => this.signalHandlers.delete(h); }
	onClose(h: () => void): () => void { this.closeHandlers.add(h); return () => this.closeHandlers.delete(h); }
	exportObject(_p: string, _i: string, _m: Record<string, ExportedMethod>): () => void { return () => undefined; }
	close(): void { if (this.closed) { return; } this.closed = true; for (const h of [...this.closeHandlers]) { h(); } }

	signal(sender: string, path: string, iface: string, member: string, body: DBusValue[]): void {
		for (const h of [...this.signalHandlers]) { h({ type: MessageType.Signal, flags: 0, serial: 1, sender, path, interface: iface, member, body }); }
	}
	ownerChanged(oldOwner: string, newOwner: string, sender = DBUS): void {
		this.signal(sender, '/org/freedesktop/DBus', DBUS, 'NameOwnerChanged', ['org.bluez', oldOwner, newOwner]);
	}
}

const silentLog = { info: (): void => undefined, warn: (): void => undefined };
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createBluezBluetooth — the factory (U8)', () => {
	it('is Linux-only', () => {
		assert.throws(() => createBluezBluetooth({ log: silentLog, platform: 'win32' }), BackendUnavailableError);
	});

	it('opens one bus, learns BlueZ\'s owner, watches it, and reads BlueZ\'s objects', async () => {
		const bus = new FakeBus();
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus });
		await bt.start();
		assert.equal(bus.calls[0], 'GetNameOwner');
		assert.ok(bus.matches.some((m) => m.includes("member='NameOwnerChanged'") && m.includes("arg0='org.bluez'") && m.includes(`sender='${DBUS}'`)));
		assert.ok(bus.calls.includes('GetManagedObjects'));
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		assert.equal(bt.radioName(), 'HOSTC');
		bt.dispose();
	});

	it('fills every seam: a BlueZ backend, pairing, forgetting, residue, presence', async () => {
		const bus = new FakeBus();
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus });
		await bt.start();
		assert.deepEqual([...bt.backends.keys()], ['bluez']);
		assert.ok(bt.backends.get('bluez')!('00:16:53:F0:0A:0A') instanceof BtBluezAdapter);
		assert.equal(typeof bt.pairDevice, 'function');
		assert.deepEqual(await bt.unpairDevice('00:16:53:F0:0A:0A'), { ok: true });
		assert.ok(bus.calls.includes('RemoveDevice'));
		assert.match(bt.forgetResidue('00:16:53:F0:0A:0A')[0].location, /^\/var\/lib\/bluetooth\/00:00:00:00:00:01\/cache\//);
		assert.equal(typeof bt.presenceCheck, 'function');
		assert.equal(typeof bt.inquire, 'function');
		bt.dispose();
	});

	it('takes signals only from BlueZ\'s current owner', async () => {
		const bus = new FakeBus();
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus });
		await bt.start();
		bus.signal(':1.99', '/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', [BBB, new Map([['org.bluez.Device1', device('BBB', '00:16:53:F0:0B:0B', true)]])]);
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		bus.signal(':1.2', '/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', [BBB, new Map([['org.bluez.Device1', device('BBB', '00:16:53:F0:0B:0B', true)]])]);
		assert.deepEqual(bt.listDevices().map((d) => d.name).sort(), ['AAA', 'BBB']);
		bt.dispose();
	});

	it('clears and tells its listeners when BlueZ goes, and reads afresh when it comes back', async () => {
		const bus = new FakeBus();
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus });
		await bt.start();
		let changes = 0;
		bt.onChange(() => { changes += 1; });
		bus.ownerChanged(':1.2', '');
		assert.throws(() => bt.listDevices(), /not ready/);
		assert.ok(changes >= 1, 'told of the loss');
		// While nobody owns the name, nothing is BlueZ's.
		bus.signal(':1.2', '/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', [BBB, new Map([['org.bluez.Device1', device('BBB', '00:16:53:F0:0B:0B', true)]])]);
		bus.managed = objects([BBB, device('BBB', '00:16:53:F0:0B:0B', true)]);
		const before = changes;
		bus.ownerChanged('', ':1.7');
		await tick();
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['BBB'], 'a fresh snapshot');
		assert.ok(changes > before, 'told of the return');
		bus.signal(':1.2', '/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved', [BBB, ['org.bluez.Device1']]);
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['BBB'], 'the old owner is nobody now');
		bt.dispose();
	});

	it('ignores a NameOwnerChanged that the bus itself did not send', async () => {
		const bus = new FakeBus();
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus });
		await bt.start();
		bus.ownerChanged(':1.2', '', ':1.66');
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		bt.dispose();
	});

	it('waits for BlueZ when it is not running, and reads it once it starts', async () => {
		const bus = new FakeBus();
		bus.owner = undefined;
		const said: string[] = [];
		const bt = createBluezBluetooth({ log: { info: (m) => said.push(m), warn: (m) => said.push(m) }, platform: 'linux', openBus: async () => bus });
		await bt.start();
		assert.throws(() => bt.listDevices(), /not ready/);
		assert.ok(said.some((m) => /not running/.test(m)));
		bus.ownerChanged('', ':1.3');
		await tick();
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		bt.dispose();
	});

	it('says when the policy keeps this user from BlueZ, offers the group command, and checks again on retry', async () => {
		const denied = new FakeBus();
		denied.failManaged = new DBusError('org.freedesktop.DBus.Error.AccessDenied', 'Rejected send message');
		const allowed = new FakeBus();
		const buses = [denied, allowed];
		const offered: string[] = [];
		const bt = createBluezBluetooth({
			log: silentLog, platform: 'linux', openBus: async () => buses.shift()!, username: () => 'alice',
			onAccessDenied: (command) => offered.push(command),
		});
		await bt.start();
		assert.deepEqual(offered, ['sudo usermod -aG bluetooth alice']);
		assert.throws(() => bt.listDevices(), /not ready/);
		// A new login's groups reach only a new connection: retry opens one, and closes the old.
		await bt.retry();
		assert.equal(denied.closed, true);
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		bt.dispose();
	});

	it('says why when there is no system bus, and stays not ready', async () => {
		const said: string[] = [];
		const bt = createBluezBluetooth({ log: { info: () => undefined, warn: (m) => said.push(m) }, platform: 'linux', openBus: async () => { throw new Error('connect ENOENT /run/dbus/system_bus_socket'); } });
		await bt.start();
		assert.ok(said.some((m) => /ENOENT/.test(m)));
		assert.throws(() => bt.listDevices(), /not ready/);
		bt.dispose();
	});

	it('closes the bus once on dispose, and is not ready after', async () => {
		const bus = new FakeBus();
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus });
		await bt.start();
		bt.dispose();
		bt.dispose();
		assert.equal(bus.closed, true);
		assert.throws(() => bt.listDevices(), /not ready/);
	});

	it('never lets an inquiry and a pairing search overlap: both go through the one Bluetooth queue (U6 review #8)', async () => {
		const bus = new FakeBus();
		bus.managed = objects();
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus, inquiryWindowMs: 40, searchMs: 40 });
		await bt.start();
		const queue = new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0 });
		const discovery = new BtClassicDiscovery({ listDevices: bt.listDevices, pairDevice: bt.pairDevice, connectionQueue: queue });
		const monitor = new BtPresenceMonitor({ queue, check: async () => true, inquire: bt.inquire, pairedWithoutSession: () => [] });
		await Promise.all([monitor.runInquiry(), discovery.pair('00:16:53:F0:0C:0C'), monitor.runInquiry(), discovery.pair('00:16:53:F0:0D:0D')]);
		monitor.dispose();
		assert.equal(bus.discovery.length, 6, bus.discovery.join(','));
		for (let i = 0; i < bus.discovery.length; i += 2) {
			assert.deepEqual(bus.discovery.slice(i, i + 2), ['StartDiscovery', 'StopDiscovery'], `discovery sessions nest: ${bus.discovery.join(',')}`);
		}
		bt.dispose();
	});
});
