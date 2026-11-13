/**
 * Bluetooth presence on Linux (step-7 plan, U6, KTD9, D2).
 *
 * Measured on HOSTC (U0, 13.11.2026): an L2CAP connect to PSM 1 (SDP) of a paired brick that is on
 * lands in 2.9–4.1 s and shows nothing on the brick; one that is off fails with EHOSTDOWN after
 * 5.12 s. The inquiry is a BR/EDR discovery; a brick counts as heard when BlueZ reports a fresh RSSI.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	createBluezPresenceCheck, createBluezInquiry, sockaddrL2, SDP_PSM, type InquiryBus, type InquiryCache,
} from '../transports/bluezPresence';
import {
	AF_BLUETOOTH, BTPROTO_L2CAP, SOCK_SEQPACKET, SOCK_NONBLOCK, SOCK_CLOEXEC,
	EINPROGRESS, EHOSTDOWN, type LinuxBtSocketApi, type ConnectState,
} from '../transports/linuxBluetoothSocket';
import { BackendUnavailableError } from '../errors/CockpitError';
import { BtPresenceMonitor } from '../transports/btPresence';
import { BtConnectionQueue } from '../transports/btConnectionQueue';
import type { BluezDevice } from '../transports/bluezObjects';
import { DBusError } from '../transports/dbus/connection';
import type { DBusValue, Variant } from '../transports/dbus/wire';

const MAC = '00:16:53:F0:0A:0A';

/** A libc that answers a connect as the test says. */
class FakeSocket implements Partial<LinuxBtSocketApi> {
	opened: { family: number; type: number; protocol: number }[] = [];
	connected: Uint8Array[] = [];
	closed: number[] = [];
	socketResult = 7;
	socketErrno = 0;
	connectResult = -1;
	errno = EINPROGRESS;
	/** What connectState answers, poll by poll; the last one repeats. */
	states: ConnectState[] = [{ state: 'connected', error: 0 }];
	polls = 0;

	socket(family: number, type: number, protocol: number): number {
		this.opened.push({ family, type, protocol });
		if (this.socketResult < 0) { this.errno = this.socketErrno; }
		return this.socketResult;
	}
	connect(_fd: number, address: Uint8Array): number { this.connected.push(address); return this.connectResult; }
	connectState(): ConnectState { const s = this.states[Math.min(this.polls, this.states.length - 1)]; this.polls += 1; return s; }
	close(fd: number): number { this.closed.push(fd); return 0; }
	lastError(): number { return this.errno; }
}

const check = (fake: FakeSocket, timeoutMs = 500) =>
	createBluezPresenceCheck({ api: () => fake as unknown as LinuxBtSocketApi, timeoutMs, pollMs: 5 });

describe('BlueZ presence check — an L2CAP connect to PSM 1 (D2)', () => {
	it('lays out sockaddr_l2: family, PSM, the address reversed, no CID, BR/EDR', () => {
		const bytes = sockaddrL2(MAC, SDP_PSM)!;
		assert.equal(bytes.length, 14);
		assert.equal(bytes.readUInt16LE(0), AF_BLUETOOTH);
		assert.equal(bytes.readUInt16LE(2), 1);
		assert.deepEqual([...bytes.subarray(4, 10)], [0x0a, 0x0a, 0xf0, 0x53, 0x16, 0x00]);
		assert.equal(bytes.readUInt16LE(10), 0);
		assert.equal(bytes.readUInt8(12), 0);
		assert.equal(sockaddrL2('not a mac', 1), undefined);
	});

	it('hears a brick whose connect lands, opening a non-blocking L2CAP seqpacket socket, and closes it', async () => {
		const fake = new FakeSocket();
		fake.states = [{ state: 'pending', error: 0 }, { state: 'pending', error: 0 }, { state: 'connected', error: 0 }];
		assert.equal(await check(fake)(MAC), true);
		assert.deepEqual(fake.opened, [{ family: AF_BLUETOOTH, type: SOCK_SEQPACKET | SOCK_NONBLOCK | SOCK_CLOEXEC, protocol: BTPROTO_L2CAP }]);
		assert.deepEqual([...fake.connected[0]], [...sockaddrL2(MAC, SDP_PSM)!]);
		assert.deepEqual(fake.closed, [7]);
	});

	it('hears a brick whose connect lands at once', async () => {
		const fake = new FakeSocket();
		fake.connectResult = 0;
		assert.equal(await check(fake)(MAC), true);
		assert.deepEqual(fake.closed, [7]);
	});

	it('does not hear a brick that is off (EHOSTDOWN), and closes the socket', async () => {
		const fake = new FakeSocket();
		fake.states = [{ state: 'pending', error: 0 }, { state: 'failed', error: EHOSTDOWN }];
		assert.equal(await check(fake)(MAC), false);
		assert.deepEqual(fake.closed, [7]);
	});

	it('does not hear a brick on the errnos that mean it did not answer, at once or after the connect', async () => {
		for (const errno of [EHOSTDOWN, 113, 111, 110, 104]) {
			const now = new FakeSocket();
			now.errno = errno;
			assert.equal(await check(now)(MAC), false, `connect errno ${errno}`);
			assert.deepEqual(now.closed, [7]);
			const later = new FakeSocket();
			later.states = [{ state: 'failed', error: errno }];
			assert.equal(await check(later)(MAC), false, `SO_ERROR ${errno}`);
		}
	});

	it('fails the round, not the brick, on any other errno: a local failure or the adapter down', async () => {
		for (const errno of [11, 16, 12, 100, 101, 22, 0]) {
			const now = new FakeSocket();
			now.errno = errno;
			await assert.rejects(() => check(now)(MAC), (e: Error) => !(e instanceof BackendUnavailableError) && e.message.includes(`errno ${errno}`), `connect errno ${errno}`);
			assert.deepEqual(now.closed, [7]);
			const later = new FakeSocket();
			later.states = [{ state: 'failed', error: errno }];
			await assert.rejects(() => check(later)(MAC), (e: Error) => e.message.includes(`errno ${errno}`), `SO_ERROR ${errno}`);
			assert.deepEqual(later.closed, [7]);
		}
	});

	it('measures its deadline on a monotonic clock', async () => {
		const fake = new FakeSocket();
		fake.states = [{ state: 'pending', error: 0 }];
		const realNow = Date.now;
		// A wall clock that stands still (or is set back) must not stretch the check.
		const frozen = realNow();
		Date.now = () => frozen;
		try {
			const outcome = await Promise.race([
				check(fake, 60)(MAC),
				new Promise<string>((resolve) => { const t = setTimeout(() => resolve('still running'), 1000); t.unref(); }),
			]);
			assert.equal(outcome, false);
		} finally {
			Date.now = realNow;
		}
	});

	it('gives up at its deadline, and closes the socket, which abandons the connect', async () => {
		const fake = new FakeSocket();
		fake.states = [{ state: 'pending', error: 0 }];
		const started = Date.now();
		assert.equal(await check(fake, 60)(MAC), false);
		assert.ok(Date.now() - started < 500);
		assert.deepEqual(fake.closed, [7]);
	});

	it('says the backend is unavailable when this kernel has no Bluetooth sockets (EAFNOSUPPORT)', async () => {
		const fake = new FakeSocket();
		fake.socketResult = -1;
		fake.socketErrno = 97;
		await assert.rejects(() => check(fake)(MAC), BackendUnavailableError);
		assert.deepEqual(fake.closed, []);
	});

	it('fails the round, not the brick, on another socket failure', async () => {
		const fake = new FakeSocket();
		fake.socketResult = -1;
		fake.socketErrno = 24; // EMFILE
		await assert.rejects(() => check(fake)(MAC), (e: Error) => !(e instanceof BackendUnavailableError) && /24/.test(e.message));
	});

	it('does not hear an address that is not one, touching no socket', async () => {
		const fake = new FakeSocket();
		assert.equal(await check(fake)('zz'), false);
		assert.deepEqual(fake.opened, []);
	});

	it('turns a brick that is off "not heard" only after the monitor\'s misses in a row', async () => {
		const fake = new FakeSocket();
		fake.states = [{ state: 'failed', error: EHOSTDOWN }];
		const monitor = new BtPresenceMonitor({
			queue: new BtConnectionQueue(),
			check: check(fake),
			inquire: async () => [],
			pairedWithoutSession: () => [MAC],
			missesBeforeNotHeard: 3,
		});
		try {
			await monitor.runChecks();
			await monitor.runChecks();
			assert.equal(monitor.presenceOf(MAC)?.heard, true);
			await monitor.runChecks();
			assert.equal(monitor.presenceOf(MAC)?.heard, false);
			fake.states = [{ state: 'connected', error: 0 }];
			fake.polls = 0;
			await monitor.runChecks();
			assert.equal(monitor.presenceOf(MAC)?.heard, true, 'one answer makes it heard again');
		} finally {
			monitor.dispose();
		}
	});
});

function device(mac: string, name: string, paired: boolean, rssi?: number): BluezDevice {
	return {
		path: `/org/bluez/hci0/dev_${mac.replace(/:/g, '_')}`, address: mac, name, alias: name,
		classOfDevice: 2052, paired, bonded: paired, trusted: false, connected: false, rssi,
	};
}

class World implements InquiryBus, InquiryCache {
	calls: string[] = [];
	known: BluezDevice[] = [];
	handlers = new Set<() => void>();
	failOn?: { member: string; error: Error };
	/** What discovery brings in, applied after StartDiscovery. */
	heard: BluezDevice[] = [];
	/** Another client is already discovering. */
	discovering = false;
	/** BlueZ sends no signal for these: an RSSI change under its 8 dBm threshold. */
	silent = false;

	devices(): BluezDevice[] { return this.known; }
	adapter() { return { path: '/org/bluez/hci0', address: undefined, alias: 'HOSTC', powered: true, discovering: this.discovering }; }
	onChange(h: () => void): () => void { this.handlers.add(h); return () => this.handlers.delete(h); }
	async call(o: { member: string; body?: DBusValue[] }): Promise<DBusValue[]> {
		this.calls.push(o.member === 'SetDiscoveryFilter'
			? `SetDiscoveryFilter ${JSON.stringify([...(o.body![0] as Map<string, Variant>)].map(([k, v]) => [k, v.value]))}`
			: o.member);
		if (this.failOn?.member === o.member) { throw this.failOn.error; }
		if (o.member === 'StartDiscovery') {
			setTimeout(() => {
				for (const d of this.heard) {
					this.known = [...this.known.filter((k) => k.path !== d.path), d];
					if (!this.silent) { for (const h of this.handlers) { h(); } }
				}
			}, 5);
		}
		return [];
	}
}

describe('BlueZ inquiry — a BR/EDR discovery window (KTD9)', () => {
	it('runs a BR/EDR discovery for its window, then stops it, and hears the LEGO bricks that answered', async () => {
		const w = new World();
		w.heard = [device(MAC, 'AAA', false, -50), device('00:16:53:F0:0B:0B', 'BBB', true, -60), device('AA:BB:CC:00:00:01', 'Phone', false, -40)];
		const heard = await createBluezInquiry({ bus: w, cache: w, windowMs: 40 })();
		assert.deepEqual(w.calls, ['SetDiscoveryFilter [["Transport","bredr"]]', 'StartDiscovery', 'StopDiscovery']);
		assert.deepEqual(heard.map((b) => [b.mac, b.name, b.paired, b.signal]), [
			[MAC, 'AAA', false, -50],
			['00:16:53:F0:0B:0B', 'BBB', true, -60],
		]);
		assert.ok(heard.every((b) => b.atMs >= 0));
		assert.equal(w.handlers.size, 0);
	});

	it('does not count a device whose RSSI was already there before the window: that is an old sighting', async () => {
		const w = new World();
		w.known = [device(MAC, 'AAA', false, -50)];
		// Something else changes during the window, so the old sighting is looked at, and passed over.
		w.heard = [device('00:16:53:F0:0B:0B', 'BBB', false, -60)];
		const heard = await createBluezInquiry({ bus: w, cache: w, windowMs: 30 })();
		assert.deepEqual(heard.map((b) => b.name), ['BBB']);
	});

	it('counts a device whose RSSI changes during the window', async () => {
		const w = new World();
		w.known = [device(MAC, 'AAA', false, -50)];
		w.heard = [device(MAC, 'AAA', false, -47)];
		const heard = await createBluezInquiry({ bus: w, cache: w, windowMs: 30 })();
		assert.deepEqual(heard.map((b) => b.mac), [MAC]);
	});

	it('stops the discovery even when the window fails, and fails the round', async () => {
		const w = new World();
		w.failOn = { member: 'StartDiscovery', error: new DBusError('org.bluez.Error.NotReady', 'Resource Not Ready') };
		await assert.rejects(() => createBluezInquiry({ bus: w, cache: w, windowMs: 30 })(), /NotReady/);
		assert.deepEqual(w.calls.slice(-1), ['StopDiscovery']);
		assert.equal(w.handlers.size, 0);
	});

	it('fails the round when this computer has no adapter', async () => {
		const w = new World();
		w.adapter = () => undefined as never;
		await assert.rejects(() => createBluezInquiry({ bus: w, cache: w, windowMs: 30 })(), /adapter/);
		assert.deepEqual(w.calls, []);
	});
	it('hears a brick whose RSSI holds steady while another client was already discovering (the desktop panel open)', async () => {
		const w = new World();
		w.discovering = true;
		w.known = [device(MAC, 'AAA', false, -50)];
		w.silent = true;
		const heard = await createBluezInquiry({ bus: w, cache: w, windowMs: 30 })();
		assert.deepEqual(heard.map((b) => b.mac), [MAC]);
	});

	it('does not count a same-value RSSI signal as a sighting when nobody else was discovering', async () => {
		const w = new World();
		w.known = [device(MAC, 'AAA', false, -50)];
		w.heard = [device(MAC, 'AAA', false, -50)];
		const heard = await createBluezInquiry({ bus: w, cache: w, windowMs: 30 })();
		assert.deepEqual(heard, []);
	});

	it('names a brick without a Name nothing, not the dashed address BlueZ puts in Alias', async () => {
		const w = new World();
		const nameless = { ...device(MAC, 'x', false, -50), name: undefined, alias: '00-16-53-F0-0A-0A' };
		w.heard = [nameless];
		const heard = await createBluezInquiry({ bus: w, cache: w, windowMs: 30 })();
		assert.equal(heard[0].name, '');
	});

	it('says so when StopDiscovery fails for any reason but "not discovering"', async () => {
		const said: string[] = [];
		const quiet = new World();
		quiet.failOn = { member: 'StopDiscovery', error: new DBusError('org.bluez.Error.Failed', 'No discovery started') };
		await createBluezInquiry({ bus: quiet, cache: quiet, windowMs: 10, log: (m) => said.push(m) })();
		assert.equal(said.length, 0);
		const loud = new World();
		loud.failOn = { member: 'StopDiscovery', error: new DBusError('org.freedesktop.DBus.Error.NoReply', 'no reply') };
		await createBluezInquiry({ bus: loud, cache: loud, windowMs: 10, log: (m) => said.push(m) })();
		assert.equal(said.length, 1);
		assert.match(said[0], /StopDiscovery.*NoReply/);
	});
});
