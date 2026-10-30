/**
 * BT discovery over the serial ports Windows creates for paired peers.
 *
 * Driven by an injected port list rather than the machine's own, because the interesting
 * cases are the ones this machine does not have: a headset alongside a brick, a PnP id whose
 * GUID is also a long hex run, a MAC asked for before any scan has seen it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BtSppBackend, macFromPnpId, formatMac } from '../transports/btSppDiscovery';

/** A Windows Bluetooth SPP port, spelled the way the OS spells one. */
const brickPort = {
	path: 'COM5',
	friendlyName: 'Standard Serial over Bluetooth link (COM5)',
	pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805f9b34fb}_LOCALMFG&0000\\7&2a1b3c4d&0&001653AABBCC_C00000000',
};

/** A paired headset: same port shape, an address that is not LEGO's. */
const headsetPort = {
	path: 'COM3',
	friendlyName: 'Standard Serial over Bluetooth link (COM3)',
	pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805f9b34fb}_LOCALMFG&0000\\7&9f8e7d6c&0&AC1122334455_C00000000',
};

/** A plain USB serial adapter, which has no Bluetooth address at all. */
const usbSerialPort = {
	path: 'COM1',
	friendlyName: 'USB Serial Device (COM1)',
	pnpId: 'USB\\VID_1234&PID_5678\\ABCDEF',
};

describe('macFromPnpId', () => {
	it('pulls a LEGO address out of a Windows PnP id', () => {
		assert.equal(macFromPnpId(brickPort.pnpId), '001653AABBCC');
	});

	it('ignores an address that is not LEGO\'s', () => {
		// A headset is a perfectly good SPP peer. Matching any twelve hex digits would take
		// it, and then the adapter factory would open a port to someone's earphones.
		assert.equal(macFromPnpId(headsetPort.pnpId), undefined);
	});

	it('is not fooled by the GUID in the same string', () => {
		// The service GUID is a longer hex run than the address and comes first. A pattern
		// that matched any run would return part of it.
		const mac = macFromPnpId(brickPort.pnpId);
		assert.equal(mac, '001653AABBCC');
		assert.ok(!mac?.startsWith('0000'), 'that would be the GUID, not the address');
	});

	it('returns nothing for a port with no address', () => {
		assert.equal(macFromPnpId(usbSerialPort.pnpId), undefined);
		assert.equal(macFromPnpId(undefined), undefined);
	});
});

describe('formatMac', () => {
	it('spells an address the way the rest of the transports do', () => {
		assert.equal(formatMac('001653aabbcc'), '00:16:53:AA:BB:CC');
	});
});

describe('BtSppBackend — discovery', () => {
	it('reports only the LEGO peers among the serial ports', async () => {
		const backend = new BtSppBackend(() =>
			Promise.resolve([usbSerialPort, headsetPort, brickPort]));

		const devices = await backend.discover();

		assert.equal(devices.length, 1);
		assert.equal(devices[0].mac, '00:16:53:AA:BB:CC');
	});

	it('says remembered but never connected, because a port list cannot know', async () => {
		const backend = new BtSppBackend(() => Promise.resolve([brickPort]));
		const [device] = await backend.discover();

		assert.equal(device.remembered, true);
		// The outgoing port exists whether or not a link is up — opening it is what makes
		// one. Reporting `connected: true` here would make presence claim a live brick from
		// nothing more than a pairing record.
		assert.equal(device.connected, false);
	});

	it('names the brick by its address, never by the port description', async () => {
		// Windows describes every outgoing SPP port as "Standard Serial over Bluetooth link",
		// and localises it: on a Czech machine this port really is called "Standardni seriova
		// linka pomoci protokolu Bluetooth". An earlier version filtered the English phrase
		// only and reported a brick by that name. The description names the mechanism in every
		// language, so none of it is worth keeping.
		const localised = {
			...brickPort,
			friendlyName: 'Standardni seriova linka pomoci protokolu Bluetooth (COM5)',
		};
		const backend = new BtSppBackend(() => Promise.resolve([localised]));
		const [device] = await backend.discover();

		assert.equal(device.name, '001653AABBCC');
	});

	it('ignores the local incoming port, whose address is all zeros', async () => {
		// Windows creates one of these alongside the outgoing ports. It has no peer, so a
		// connect attempt would open a port that answers nothing.
		const incoming = {
			path: 'COM3',
			friendlyName: 'Standard Serial over Bluetooth link (COM3)',
			pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805f9b34fb}_LOCALMFG&0000\\8&2e3ee818&0&000000000000_0000006E',
		};
		const backend = new BtSppBackend(() => Promise.resolve([incoming, brickPort]));

		const devices = await backend.discover();

		assert.equal(devices.length, 1);
		assert.equal(devices[0].mac, '00:16:53:AA:BB:CC');
	});

	it('drops a peer that has gone away since the last scan', async () => {
		let ports = [brickPort];
		const backend = new BtSppBackend(() => Promise.resolve(ports));

		await backend.discover();
		assert.ok(backend.peerFor('00:16:53:AA:BB:CC'));

		ports = [];
		await backend.discover();
		assert.equal(backend.peerFor('00:16:53:AA:BB:CC'), undefined,
			'a stale port would be opened long after the pairing was removed');
	});
});

describe('BtSppBackend — adapter factory', () => {
	it('refuses a MAC no scan has seen rather than guessing a port', async () => {
		const backend = new BtSppBackend(() => Promise.resolve([brickPort, headsetPort]));
		await backend.discover();

		assert.throws(
			() => backend.adapterFor('00:16:53:99:88:77'),
			/Pair the brick with this computer first/,
		);
	});

	it('accepts an address written either way', async () => {
		const backend = new BtSppBackend(() => Promise.resolve([brickPort]));
		await backend.discover();

		assert.ok(backend.peerFor('00:16:53:AA:BB:CC'), 'colon-separated');
		assert.ok(backend.peerFor('001653AABBCC'), 'bare');
		assert.equal(backend.peerFor('001653aabbcc')?.portPath, 'COM5', 'lower case');
	});
});
