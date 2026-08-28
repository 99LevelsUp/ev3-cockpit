/**
 * What Bluetooth discovery reports once it reads the Windows device cache.
 *
 * What is being pinned: a brick Windows knows about is listed whether or not it has an
 * outgoing COM port. That gap is the reason this exists, and it opened the moment the runtime
 * stopped going through a serial port.
 *
 * Naming is deliberately not pinned to the cache. `szName` is filled only for a device
 * Windows is connected to, so a remembered brick arrives unnamed and the port scan's
 * `EV3 [address]` is what survives — which the test below states, so the next reader does not
 * re-derive the disappointment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BtClassicDiscovery } from '../transports/btClassicDiscovery';
import { BluetoothDeviceInfo, isLikelyEv3 } from '../transports/windowsBluetooth';
import { BtDiscoveryDevice } from '../transports/btTransportProvider';

const LEGO_OUI = '001653';

function cached(over: Partial<BluetoothDeviceInfo> = {}): BluetoothDeviceInfo {
	return {
		mac: '00165342d9f2',
		name: 'CCC',
		connected: false,
		remembered: true,
		authenticated: true,
		classOfDevice: 0x000804,
		...over,
	};
}

function scanned(over: Partial<BtDiscoveryDevice> = {}): BtDiscoveryDevice {
	return {
		mac: '00:16:53:42:D9:F2',
		name: 'EV3 [00:16:53:42:D9:F2]',
		connected: false,
		remembered: true,
		authenticated: false,
		...over,
	};
}

describe('isLikelyEv3', () => {
	it('accepts a brick by its Toy device class even when renamed', () => {
		assert.equal(
			isLikelyEv3(cached({ name: 'Robot brick', mac: 'aabbccddeeff' }), LEGO_OUI),
			true
		);
	});

	it('accepts a brick by LEGO OUI when Windows never learned a class', () => {
		assert.equal(isLikelyEv3(cached({ name: '', classOfDevice: 0 }), LEGO_OUI), true);
	});

	it('accepts a brick by name alone', () => {
		assert.equal(
			isLikelyEv3(cached({ name: 'EV3', mac: 'aabbccddeeff', classOfDevice: 0 }), LEGO_OUI),
			true
		);
	});

	it('ignores a phone', () => {
		assert.equal(
			isLikelyEv3(
				cached({ name: 'Headphones', mac: 'aabbccddeeff', classOfDevice: 0x240404 }),
				LEGO_OUI
			),
			false
		);
	});
});

describe('BtClassicDiscovery', () => {
	it('lists a paired brick that has no COM port at all', async () => {
		const discovery = new BtClassicDiscovery({
			listDevices: () => [cached()],
			portScan: () => Promise.resolve([]),
		});

		const found = await discovery.discover();

		// The whole reason this class exists: the port scan sees nothing and the transport
		// could open this brick without trouble.
		assert.equal(found.length, 1);
		assert.equal(found[0].mac, '00:16:53:42:D9:F2');
	});

	it('uses the cached name when Windows has one', async () => {
		const discovery = new BtClassicDiscovery({
			listDevices: () => [cached({ name: 'CCC' })],
			portScan: () => Promise.resolve([scanned()]),
		});

		const [brick] = await discovery.discover();

		assert.equal(brick.name, 'CCC');
	});

	it('falls back to the address when the cache has no name, which is the usual case', async () => {
		const discovery = new BtClassicDiscovery({
			listDevices: () => [cached({ name: '' })],
			portScan: () => Promise.resolve([scanned()]),
		});

		const [brick] = await discovery.discover();

		// Measured on all three bricks: Windows fills szName only while connected, so a
		// remembered brick arrives unnamed. This file briefly claimed otherwise.
		assert.equal(brick.name, 'EV3 [00:16:53:42:D9:F2]');
	});

	it('falls back to the port scan when the cache cannot be read', async () => {
		const reasons: string[] = [];
		const discovery = new BtClassicDiscovery({
			listDevices: () => { throw new Error('koffi is not installed'); },
			portScan: () => Promise.resolve([scanned()]),
			onCacheUnavailable: (reason) => reasons.push(reason),
		});

		const found = await discovery.discover();

		assert.equal(found.length, 1);
		assert.equal(found[0].name, 'EV3 [00:16:53:42:D9:F2]');
		assert.deepEqual(reasons, ['koffi is not installed']);
	});

	it('keeps the port scan result when the cache lists no brick', async () => {
		const discovery = new BtClassicDiscovery({
			listDevices: () => [cached({ mac: 'aabbccddeeff', name: 'Headphones', classOfDevice: 0x240404 })],
			portScan: () => Promise.resolve([scanned()]),
		});

		const found = await discovery.discover();

		// An empty cache is not proof there is no brick — no inquiry has run, and a pairing
		// made long ago can age out. Discarding a port the scan can see would lose a brick.
		assert.equal(found.length, 1);
		assert.equal(found[0].mac, '00:16:53:42:D9:F2');
	});

	it('runs the port scan even when the cache answers', async () => {
		let scans = 0;
		const discovery = new BtClassicDiscovery({
			listDevices: () => [cached()],
			portScan: () => { scans += 1; return Promise.resolve([scanned()]); },
		});

		await discovery.discover();

		// BtSppBackend builds its adapters from what it last saw, so a scan skipped here
		// leaves the fallback backend with no port to open.
		assert.equal(scans, 1);
	});

	it('survives a port scan that throws', async () => {
		const discovery = new BtClassicDiscovery({
			listDevices: () => [cached()],
			portScan: () => Promise.reject(new Error('serialport is missing')),
		});

		const found = await discovery.discover();

		assert.equal(found.length, 1);
	});
});

// ════════════════════════════════════════════════════════════════════
// Pairing
// ════════════════════════════════════════════════════════════════════

describe('BtClassicDiscovery — pairing', () => {
	it('reports a cancelled pairing rather than throwing', async () => {
		const discovery = new BtClassicDiscovery({
			pairDevice: () => Promise.resolve({ ok: false, reason: 'Windows refused the pairing (error 1223).' }),
		});

		const result = await discovery.pair('00:16:53:42:D9:F2');

		// A user closing the dialog is an answer, not a fault.
		assert.equal(result.ok, false);
		assert.match(result.reason ?? '', /1223/);
	});

	it('turns a thrown binding failure into a reason', async () => {
		const discovery = new BtClassicDiscovery({
			pairDevice: () => Promise.reject(new Error('koffi is not installed')),
		});

		const result = await discovery.pair('00:16:53:42:D9:F2');

		assert.deepEqual(result, { ok: false, reason: 'koffi is not installed' });
	});

	it('unpairs through the binding', () => {
		const asked: string[] = [];
		const discovery = new BtClassicDiscovery({
			unpairDevice: (mac) => { asked.push(mac); return { ok: true }; },
		});

		assert.deepEqual(discovery.unpair('00:16:53:42:D9:F2'), { ok: true });
		assert.deepEqual(asked, ['00:16:53:42:D9:F2']);
	});
});
