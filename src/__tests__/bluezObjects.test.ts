/**
 * BlueZ's objects as the cockpit keeps them (step-7 plan, U4, KTD4): one GetManagedObjects, then the
 * ObjectManager and Properties signals, so the synchronous seams — the paired bricks for discovery,
 * this computer's Bluetooth name — answer from memory without a bus round trip.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BluezObjectCache, type BusLike } from '../transports/bluezObjects';
import { bluezListDevices, bluezRadioName } from '../transports/bluezDiscovery';
import { Variant, type DBusValue } from '../transports/dbus/wire';
import { MessageType, type DBusMessage } from '../transports/dbus/message';
import { DBusError } from '../transports/dbus/connection';
import { BtClassicDiscovery } from '../transports/btClassicDiscovery';

const AAA = '/org/bluez/hci0/dev_00_16_53_F0_0A_0A';
const BBB = '/org/bluez/hci0/dev_00_16_53_F0_0B_0B';

function device(name: string, mac: string, paired: boolean): Map<string, Variant> {
	return new Map<string, Variant>([
		['Address', new Variant('s', mac)],
		['Name', new Variant('s', name)],
		['Alias', new Variant('s', name)],
		['Class', new Variant('u', 2052)],
		['Paired', new Variant('b', paired)],
		['Bonded', new Variant('b', paired)],
		['Connected', new Variant('b', false)],
	]);
}

function managed(): Map<string, Map<string, Map<string, Variant>>> {
	return new Map([
		['/org/bluez/hci0', new Map([['org.bluez.Adapter1', new Map<string, Variant>([
			['Address', new Variant('s', '00:00:00:00:00:00')],
			['Alias', new Variant('s', 'HOSTC')],
			['Powered', new Variant('b', true)],
		])]])],
		[AAA, new Map([['org.bluez.Device1', device('AAA', '00:16:53:F0:0A:0A', true)]])],
	]);
}

class FakeBus implements BusLike {
	matches: string[] = [];
	calls: string[] = [];
	/** Matches and calls in the order they happened. */
	order: string[] = [];
	private handlers = new Set<(m: DBusMessage) => void>();
	private closeHandlers = new Set<() => void>();
	objects: DBusValue = managed();
	failWith?: Error;
	/** Signals the bus delivers in the same chunk, right after the GetManagedObjects reply. */
	afterReply: [string, string, string, DBusValue[]][] = [];
	/** Closes the bus in the same chunk, right after the reply. */
	closeAfterReply = false;
	get signalHandlers(): number { return this.handlers.size; }
	get closeHandlerCount(): number { return this.closeHandlers.size; }

	async call(o: { member: string; interface: string }): Promise<DBusValue[]> {
		this.calls.push(`${o.interface}.${o.member}`);
		this.order.push(o.member);
		if (this.failWith) { throw this.failWith; }
		if (!this.afterReply.length && !this.closeAfterReply) { return [this.objects]; }
		// As connection.ts dispatches one chunk: the reply settles, then the signals run, all before
		// the caller's await continues.
		return new Promise<DBusValue[]>((resolve) => {
			setTimeout(() => {
				resolve([this.objects]);
				for (const [path, iface, member, body] of this.afterReply) { this.signal(path, iface, member, body); }
				if (this.closeAfterReply) { this.close(); }
			}, 0);
		});
	}
	async addMatch(rule: string): Promise<void> { this.matches.push(rule); this.order.push('AddMatch'); }
	onSignal(handler: (m: DBusMessage) => void): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
	onClose(handler: () => void): () => void { this.closeHandlers.add(handler); return () => this.closeHandlers.delete(handler); }

	signal(path: string, iface: string, member: string, body: DBusValue[], sender = ':1.2'): void {
		for (const h of this.handlers) { h({ type: MessageType.Signal, flags: 0, serial: 9, path, interface: iface, member, sender, body }); }
	}
	close(): void { for (const h of this.closeHandlers) { h(); } }
}

describe('BluezObjectCache', () => {
	it('subscribes to the ObjectManager and Properties signals before it reads the objects', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus);
		await cache.start();
		assert.equal(bus.matches.length, 2);
		assert.ok(bus.matches.some((m) => m.includes("interface='org.freedesktop.DBus.ObjectManager'") && m.includes("sender='org.bluez'")));
		assert.ok(bus.matches.some((m) => m.includes("interface='org.freedesktop.DBus.Properties'") && m.includes("member='PropertiesChanged'")));
		assert.deepEqual(bus.calls, ['org.freedesktop.DBus.ObjectManager.GetManagedObjects']);
		assert.deepEqual(bus.order, ['AddMatch', 'AddMatch', 'GetManagedObjects'], 'no change may fall between the read and the subscription');
		assert.equal(cache.ready, true);
	});

	it('answers the devices and the adapter from memory', async () => {
		const cache = new BluezObjectCache(new FakeBus());
		await cache.start();
		const devices = cache.devices();
		assert.equal(devices.length, 1);
		assert.deepEqual(devices[0], {
			path: AAA, address: '00:16:53:F0:0A:0A', name: 'AAA', alias: 'AAA', classOfDevice: 2052,
			paired: true, bonded: true, trusted: false, connected: false, rssi: undefined,
		});
		assert.equal(cache.adapter()?.alias, 'HOSTC');
		assert.equal(cache.adapter()?.path, '/org/bluez/hci0');
	});

	it('adds an object InterfacesAdded announces, and drops one InterfacesRemoved removes', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus);
		await cache.start();
		let changes = 0;
		cache.onChange(() => { changes += 1; });
		bus.signal('/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', [BBB, new Map([['org.bluez.Device1', device('BBB', '00:16:53:F0:0B:0B', false)]])]);
		assert.deepEqual(cache.devices().map((d) => d.name).sort(), ['AAA', 'BBB']);
		bus.signal('/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved', [AAA, ['org.bluez.Device1']]);
		assert.deepEqual(cache.devices().map((d) => d.name), ['BBB']);
		assert.equal(changes, 2);
	});

	it('applies PropertiesChanged, including invalidated properties', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus);
		await cache.start();
		bus.signal(AAA, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', ['org.bluez.Device1', new Map([['Connected', new Variant('b', true)], ['RSSI', new Variant('n', -48)]]), ['Name']]);
		const aaa = cache.devices()[0];
		assert.equal(aaa.connected, true);
		assert.equal(aaa.rssi, -48);
		assert.equal(aaa.name, undefined, 'an invalidated property is no longer known');
		bus.signal('/org/bluez/hci0', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', ['org.bluez.Adapter1', new Map([['Alias', new Variant('s', 'Renamed')]]), []]);
		assert.equal(cache.adapter()?.alias, 'Renamed');
	});

	it('ignores signals from anyone but BlueZ, and about objects it does not hold', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus, { bluezOwner: () => ':1.2' });
		await cache.start();
		bus.signal(AAA, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', ['org.bluez.Device1', new Map([['Connected', new Variant('b', true)]]), []], ':1.99');
		assert.equal(cache.devices()[0].connected, false, 'a signal from another sender changes nothing');
		bus.signal('/org/bluez/hci0/dev_X', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', ['org.bluez.Device1', new Map([['Connected', new Variant('b', true)]]), []]);
		assert.equal(cache.devices().length, 1, 'no object is made up from a PropertiesChanged');
	});

	it('survives a signal with a body of the wrong shape', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus);
		await cache.start();
		bus.signal('/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', ['only a path']);
		bus.signal(AAA, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', [42, 'x', 'y']);
		assert.equal(cache.devices().length, 1);
	});

	it('is not ready, and says why, when BlueZ refuses or the bus closes', async () => {
		const bus = new FakeBus();
		bus.failWith = new DBusError('org.freedesktop.DBus.Error.AccessDenied', 'Rejected send message');
		const cache = new BluezObjectCache(bus);
		await assert.rejects(() => cache.start(), /AccessDenied/);
		assert.equal(cache.ready, false);
		const ok = new FakeBus();
		const live = new BluezObjectCache(ok);
		await live.start();
		ok.close();
		assert.equal(live.ready, false);
		assert.deepEqual(live.devices(), []);
	});
});

describe('BlueZ discovery and the radio name (the seams BtClassicDiscovery takes)', () => {
	it('lists BlueZ devices as Windows-shaped device records: lower-case hex, paired as remembered', async () => {
		const cache = new BluezObjectCache(new FakeBus());
		await cache.start();
		assert.deepEqual(bluezListDevices(cache)(), [{
			mac: '001653f00a0a', name: 'AAA', connected: false, remembered: true, authenticated: true, classOfDevice: 2052,
		}]);
	});

	it('refuses to list before the cache is ready, so discovery reports it once rather than an empty list', () => {
		const cache = new BluezObjectCache(new FakeBus());
		assert.throws(() => bluezListDevices(cache)(), /not ready/);
	});

	it('reads this computer\'s name from the adapter\'s Alias, and has none without an adapter', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus);
		await cache.start();
		assert.equal(bluezRadioName(cache)(), 'HOSTC');
		const empty = new FakeBus();
		empty.objects = new Map();
		const none = new BluezObjectCache(empty);
		await none.start();
		assert.equal(bluezRadioName(none)(), undefined);
	});
});

describe('BluezObjectCache — the start, the close and the end (U4 review)', () => {
	it('applies signals that arrive with the snapshot after it, in bus order, never under it', async () => {
		const bus = new FakeBus();
		const CCC = '/org/bluez/hci0/dev_00_16_53_F0_0C_0C';
		bus.objects = new Map([...managed(), [BBB, new Map([['org.bluez.Device1', device('BBB', '00:16:53:F0:0B:0B', false)]])]]);
		bus.afterReply = [
			['/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved', [AAA, ['org.bluez.Device1']]],
			[BBB, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', ['org.bluez.Device1', new Map([['Paired', new Variant('b', true)]]), []]],
			['/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', [CCC, new Map([['org.bluez.Device1', device('CCC', '00:16:53:F0:0C:0C', false)]])]],
		];
		const cache = new BluezObjectCache(bus);
		await cache.start();
		const names = cache.devices().map((d) => d.name).sort();
		assert.deepEqual(names, ['BBB', 'CCC'], 'AAA stays removed, CCC stays added');
		assert.equal(cache.devices().find((d) => d.name === 'BBB')?.paired, true, 'the change is not lost');
	});

	it('is not ready, and start fails, when the bus closes between the reply and the continuation', async () => {
		const bus = new FakeBus();
		bus.closeAfterReply = true;
		const cache = new BluezObjectCache(bus);
		await assert.rejects(() => cache.start(), /closed/);
		assert.equal(cache.ready, false);
		assert.deepEqual(cache.devices(), []);
	});

	it('tells its listeners when the snapshot is in, and when the bus closes', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus);
		let changes = 0;
		cache.onChange(() => { changes += 1; });
		await cache.start();
		assert.equal(changes, 1);
		bus.close();
		assert.equal(changes, 2);
	});

	it('leaves no handler behind when start fails, and refuses a second start', async () => {
		const bus = new FakeBus();
		bus.failWith = new DBusError('org.freedesktop.DBus.Error.AccessDenied', 'Rejected send message');
		const failed = new BluezObjectCache(bus);
		await assert.rejects(() => failed.start());
		assert.equal(bus.signalHandlers, 0);
		assert.equal(bus.closeHandlerCount, 0);
		const ok = new FakeBus();
		const cache = new BluezObjectCache(ok);
		await cache.start();
		await assert.rejects(() => cache.start(), /already/);
		assert.equal(ok.signalHandlers, 1);
	});

	it('refuses to start once disposed, touching neither the bus nor its handlers', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus);
		cache.dispose();
		await assert.rejects(() => cache.start(), /disposed/);
		assert.deepEqual(bus.order, []);
		assert.equal(bus.signalHandlers, 0);
		assert.equal(bus.closeHandlerCount, 0);
	});

	it('lets go of the bus on dispose, once, and is no longer ready', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus);
		await cache.start();
		cache.dispose();
		cache.dispose();
		assert.equal(bus.signalHandlers, 0);
		assert.equal(bus.closeHandlerCount, 0);
		assert.equal(cache.ready, false);
		assert.deepEqual(cache.devices(), []);
	});

	it('keeps the last known value of a boolean BlueZ invalidates, and forgets any other', async () => {
		const bus = new FakeBus();
		const cache = new BluezObjectCache(bus);
		await cache.start();
		bus.signal(AAA, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', ['org.bluez.Device1', new Map([['RSSI', new Variant('n', -40)]]), []]);
		bus.signal(AAA, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', ['org.bluez.Device1', new Map(), ['Paired', 'RSSI']]);
		const aaa = cache.devices()[0];
		assert.equal(aaa.paired, true);
		assert.equal(aaa.rssi, undefined);
	});
});

describe('BlueZ discovery through BtClassicDiscovery — only bricks reach the list (U4)', () => {
	it('drops headphones, a phone and an unpaired stranger; keeps a LEGO-OUI brick and a toy-class brick', async () => {
		const bus = new FakeBus();
		const dev = (name: string, mac: string, paired: boolean, cls: number): Map<string, Variant> => {
			const m = device(name, mac, paired);
			m.set('Class', new Variant('u', cls));
			return m;
		};
		bus.objects = new Map([
			['/org/bluez/hci0', new Map([['org.bluez.Adapter1', new Map<string, Variant>([['Alias', new Variant('s', 'HOSTC')]])]])],
			['/p1', new Map([['org.bluez.Device1', dev('Headphones', 'AA:BB:CC:00:00:01', true, 0x240404)]])],
			['/p2', new Map([['org.bluez.Device1', dev('Phone', 'AA:BB:CC:00:00:02', true, 0x5a020c)]])],
			['/p3', new Map([['org.bluez.Device1', dev('Speaker', 'AA:BB:CC:00:00:03', false, 0x240414)]])],
			['/b1', new Map([['org.bluez.Device1', dev('AAA', '00:16:53:F0:0A:0A', true, 0)]])],
			['/b2', new Map([['org.bluez.Device1', dev('Robot', 'AA:BB:CC:00:00:04', true, 0x000804)]])],
		]);
		const cache = new BluezObjectCache(bus);
		await cache.start();
		const discovery = new BtClassicDiscovery({ listDevices: bluezListDevices(cache) });
		const bricks = await discovery.discover();
		assert.deepEqual(bricks.map((b) => [b.mac, b.name]).sort(), [
			['00:16:53:F0:0A:0A', 'AAA'],
			['AA:BB:CC:00:00:04', 'Robot'],
		]);
	});

	it('gives a device without a Name no name, not the dashed address BlueZ puts in Alias', async () => {
		const bus = new FakeBus();
		const nameless = device('x', '00:16:53:F0:0D:0D', true);
		nameless.delete('Name');
		nameless.set('Alias', new Variant('s', '00-16-53-F0-0D-0D'));
		bus.objects = new Map([['/n', new Map([['org.bluez.Device1', nameless]])]]);
		const cache = new BluezObjectCache(bus);
		await cache.start();
		assert.equal(bluezListDevices(cache)()[0].name, '');
	});
});
