/**
 * The Linux Bluetooth factory (step-7 plan, U8, KTD8): one bus connection, BlueZ's owner tracked,
 * the object cache renewed when BlueZ restarts, and every seam the Windows backend fills.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
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
	return objectsOn('/org/bluez/hci0', ...devices);
}

function objectsOn(adapterPath: string, ...devices: [string, Map<string, Variant>][]): Map<string, Map<string, Map<string, Variant>>> {
	return new Map([
		[adapterPath, new Map([['org.bluez.Adapter1', new Map<string, Variant>([['Alias', new Variant('s', 'HOSTC')], ['Address', new Variant('s', '00:00:00:00:00:01')]])]])],
		...devices.map(([path, props]) => [path, new Map([['org.bluez.Device1', props]])] as [string, Map<string, Map<string, Variant>>]),
	]);
}

class FakeBus implements BluezBus {
	calls: string[] = [];
	matches: string[] = [];
	owner: string | undefined = ':1.2';
	managed: DBusValue = objects([AAA, device('AAA', '00:16:53:F0:0A:0A', true)]);
	failManaged?: Error;
	/** GetManagedObjects answers once this settles. */
	managedGate?: Promise<void>;
	/** GetNameOwner fails with this, when set. */
	ownerError?: Error;
	/** The first StartDiscovery takes effect once this settles. */
	deferStart?: Promise<void>;
	closed = false;
	/** Discovery starts and stops, with the time, for the overlap test. */
	discovery: string[] = [];
	private signalHandlers = new Set<(m: DBusMessage) => void>();
	private closeHandlers = new Set<() => void>();

	/** Each call as `member path`. */
	routes: string[] = [];
	async call(o: { member: string; path: string; body?: DBusValue[] }): Promise<DBusValue[]> {
		this.calls.push(o.member);
		this.routes.push(`${o.member} ${o.path}`);
		if (o.member === 'GetNameOwner') {
			if (this.ownerError) { throw this.ownerError; }
			if (!this.owner) { throw new DBusError('org.freedesktop.DBus.Error.NameHasNoOwner', 'no owner'); }
			return [this.owner];
		}
		if (o.member === 'GetManagedObjects') {
			if (this.failManaged) { throw this.failManaged; }
			if (this.managedGate) { await this.managedGate; }
			return [this.managed];
		}
		if (o.member === 'StartDiscovery' && this.deferStart) {
			const gate = this.deferStart;
			this.deferStart = undefined;
			await gate;
		}
		// Recorded when it takes effect, as BlueZ sees it.
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
const OM_RULE = "interface='org.freedesktop.DBus.ObjectManager'";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
/**
 * Waits for a condition rather than a fixed time: Windows timers tick in ~15.6 ms steps, so two
 * backoffs of 5 and 10 ms and a read did not fit a fixed 60 ms under the full suite's load
 * (merge of linux-backend, 13.11.2026).
 */
async function until(condition: () => boolean, limitMs = 2000): Promise<void> {
	const deadline = Date.now() + limitMs;
	while (!condition()) {
		if (Date.now() > deadline) { return; }
		await tick(5);
	}
}
const readyNow = (bt: { listDevices(): unknown[] }): boolean => { try { bt.listDevices(); return true; } catch { return false; } };

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
	it('a second start while a bus is held opens no other (U8 review #1)', async () => {
		const first = new FakeBus();
		let opened = 0;
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => { opened += 1; return opened === 1 ? first : new FakeBus(); } });
		await bt.start();
		await bt.start();
		assert.equal(opened, 1);
		assert.equal(first.closed, false);
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		bt.dispose();
		assert.equal(first.closed, true);
	});

	it('reconnects with a backoff when the system bus closes under it, and not after dispose (U8 review #2)', async () => {
		const first = new FakeBus();
		const second = new FakeBus();
		second.managed = objects([BBB, device('BBB', '00:16:53:F0:0B:0B', true)]);
		const opens: (() => Promise<BluezBus>)[] = [
			async () => first,
			async () => { throw new Error('connect ENOENT'); },
			async () => second,
		];
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: () => opens.shift()!(), reconnectMs: 5 });
		await bt.start();
		first.close();
		assert.throws(() => bt.listDevices(), /not ready/);
		await until(() => readyNow(bt));
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['BBB'], 'ready again on a new connection, after one failed try');
		assert.equal(opens.length, 0);
		bt.dispose();
		assert.equal(second.closed, true);
		let more = 0;
		const third = new FakeBus();
		const after = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => { more += 1; return third; }, reconnectMs: 5 });
		await after.start();
		after.dispose();
		await tick(30);
		assert.equal(more, 1, 'a dispose is not a loss');
	});

	it('drops the old daemon\'s objects at once when BlueZ hands over to a new owner (U8 review #3)', async () => {
		const bus = new FakeBus();
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus });
		await bt.start();
		const gate = deferred();
		bus.managedGate = gate.promise;
		bus.managed = objects([BBB, device('BBB', '00:16:53:F0:0B:0B', true)]);
		bus.ownerChanged(':1.2', ':1.7');
		assert.throws(() => bt.listDevices(), /not ready/, 'nothing of the old daemon while the new one is read');
		gate.resolve();
		await tick();
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['BBB']);
		bt.dispose();
	});

	it('tells a bus that refuses this user from BlueZ not running, at GetNameOwner too (U8 review #4)', async () => {
		const denied = new FakeBus();
		denied.ownerError = new DBusError('org.freedesktop.DBus.Error.AccessDenied', 'Rejected send message');
		const said: string[] = [];
		const offered: string[] = [];
		const bt = createBluezBluetooth({ log: { info: (m) => said.push(m), warn: (m) => said.push(m) }, platform: 'linux', openBus: async () => denied, username: () => 'alice', onAccessDenied: (c) => offered.push(c) });
		await bt.start();
		assert.deepEqual(offered, ['sudo usermod -aG bluetooth alice']);
		assert.ok(!said.some((m) => /not running/.test(m)), said.join(' | '));
		bt.dispose();

		const broken = new FakeBus();
		broken.ownerError = new DBusError('org.freedesktop.DBus.Error.NoMemory', 'out of memory');
		const told: string[] = [];
		const other = createBluezBluetooth({ log: { info: (m) => told.push(m), warn: (m) => told.push(m) }, platform: 'linux', openBus: async () => broken, onAccessDenied: () => offered.push('again') });
		await other.start();
		assert.ok(told.some((m) => /Bluetooth unavailable.*NoMemory/.test(m)), told.join(' | '));
		assert.ok(!told.some((m) => /not running/.test(m)));
		assert.equal(offered.length, 1);
		other.dispose();
	});

	it('keeps an inquiry from starting until a pairing search\'s late discovery is stopped (U8 review #5)', async () => {
		const bus = new FakeBus();
		bus.managed = objects();
		const late = deferred();
		bus.deferStart = late.promise;
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus, inquiryWindowMs: 20, searchMs: 20 });
		await bt.start();
		const queue = new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0 });
		const discovery = new BtClassicDiscovery({ listDevices: bt.listDevices, pairDevice: bt.pairDevice, connectionQueue: queue });
		const monitor = new BtPresenceMonitor({ queue, check: async () => true, inquire: bt.inquire, pairedWithoutSession: () => [] });
		const paired = await discovery.pair('00:16:53:F0:0C:0C');
		assert.equal(paired.ok, false, 'the search ran out before the discovery started');
		const inquiry = monitor.runInquiry();
		await tick(40);
		assert.equal(bus.calls.filter((c) => c === 'SetDiscoveryFilter').length, 1, `the inquiry waits for the late stop: ${bus.calls.join(',')}`);
		late.resolve();
		await inquiry;
		monitor.dispose();
		assert.deepEqual(bus.discovery, ['StartDiscovery', 'StopDiscovery', 'StartDiscovery', 'StopDiscovery']);
		bt.dispose();
	});

	it('ends an operation on the connection it started on, never on the next one (U8 review #6)', async () => {
		const first = new FakeBus();
		first.managed = objects();
		const late = deferred();
		first.deferStart = late.promise;
		const second = new FakeBus();
		const buses = [first, second];
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => buses.shift()!, searchMs: 20 });
		await bt.start();
		const result = await bt.pairDevice('00:16:53:F0:0C:0C');
		assert.equal(result.ok, false);
		await bt.retry();
		late.resolve();
		await tick(20);
		assert.ok(first.calls.includes('StopDiscovery'), 'the late discovery is stopped where it ran');
		assert.ok(!second.calls.includes('StopDiscovery'), second.calls.join(','));
		bt.dispose();
	});

	it('adds BlueZ\'s match rules once per connection, however often BlueZ restarts (U8 review #9)', async () => {
		const bus = new FakeBus();
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => bus });
		await bt.start();
		for (const owner of [':1.7', ':1.8', ':1.9']) {
			bus.ownerChanged('', owner);
			await tick();
		}
		assert.equal(bus.matches.filter((m) => m.includes(OM_RULE)).length, 1, bus.matches.join('\n'));
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		bt.dispose();
	});

	it('loads no native module when it is imported, so the runtime can import it anywhere (U8 review #7, the part here)', () => {
		const out = execFileSync(process.execPath, ['-e', "require('./out/transports/bluezBluetooth.js'); process.stdout.write(String(Object.keys(require.cache).filter((k) => /node_modules/.test(k)).length));"], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
		assert.equal(out, '0');
	});
	it('joins an open still pending instead of opening a second bus (U8 confirmation #1)', async () => {
		const first = new FakeBus();
		const pending = deferred();
		let opened = 0;
		const bt = createBluezBluetooth({
			log: silentLog, platform: 'linux', reconnectMs: 5,
			openBus: async () => { opened += 1; if (opened === 2) { await pending.promise; } return opened === 1 ? first : new FakeBus(); },
		});
		await bt.start();
		first.close();
		await tick(20);
		assert.equal(opened, 2, 'the reconnect is opening');
		const started = bt.start();
		pending.resolve();
		await started;
		await tick();
		assert.equal(opened, 2, 'start() joined it');
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		bt.dispose();
	});

	it('keeps trying when the system bus is unreachable at the first start (U8 confirmation #1)', async () => {
		const bus = new FakeBus();
		let tries = 0;
		const bt = createBluezBluetooth({
			log: silentLog, platform: 'linux', reconnectMs: 5,
			openBus: async () => { tries += 1; if (tries === 1) { throw new Error('connect ENOENT'); } return bus; },
		});
		await bt.start();
		assert.throws(() => bt.listDevices(), /not ready/);
		await tick(40);
		assert.equal(tries, 2);
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		bt.dispose();
	});

	it('a retry during a pending open that then fails still schedules a reconnect (U8 confirmation #1)', async () => {
		const bus = new FakeBus();
		const pending = deferred();
		let tries = 0;
		const bt = createBluezBluetooth({
			log: silentLog, platform: 'linux', reconnectMs: 5,
			// The pending open fails, and so does the next: something must still try again.
			openBus: async () => { tries += 1; if (tries === 1) { await pending.promise; } if (tries <= 2) { throw new Error('connect ECONNREFUSED'); } return bus; },
		});
		const started = bt.start();
		const retried = bt.retry();
		pending.resolve();
		await Promise.all([started, retried]);
		await tick(60);
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA']);
		bt.dispose();
	});

	it('an inquiry that waited for the gate reads the adapter and the bus of after the wait, together (U8 confirmation #2)', async () => {
		const first = new FakeBus();
		first.managed = objects();
		const late = deferred();
		first.deferStart = late.promise;
		const second = new FakeBus();
		second.managed = objectsOn('/org/bluez/hci1');
		const buses = [first, second];
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => buses.shift()!, searchMs: 20, inquiryWindowMs: 20 });
		await bt.start();
		assert.equal((await bt.pairDevice('00:16:53:F0:0C:0C')).ok, false);
		const inquiry = bt.inquire();
		await tick();
		await bt.retry();
		late.resolve();
		await inquiry;
		assert.ok(second.routes.includes('SetDiscoveryFilter /org/bluez/hci1'), second.routes.join(','));
		assert.ok(!second.routes.some((r) => r.endsWith('/org/bluez/hci0')), second.routes.join(','));
		bt.dispose();
	});
	it('a bus lost while BlueZ is still being read reconnects, and a retry then opens a new one', async () => {
		const first = new FakeBus();
		const gate = deferred();
		first.managedGate = gate.promise;
		const second = new FakeBus();
		const third = new FakeBus();
		const buses = [first, second, third];
		const bt = createBluezBluetooth({ log: silentLog, platform: 'linux', openBus: async () => buses.shift()!, reconnectMs: 5 });
		const started = bt.start();
		await tick();
		first.close();
		// The reconnect comes while the old read still waits.
		await tick(20);
		gate.resolve();
		await started;
		await tick(30);
		assert.deepEqual(bt.listDevices().map((d) => d.name), ['AAA'], 'ready on the reconnect');
		assert.equal(buses.length, 1);
		await bt.retry();
		assert.equal(buses.length, 0, 'retry opened a new bus');
		assert.equal(second.closed, true);
		bt.dispose();
	});
});
