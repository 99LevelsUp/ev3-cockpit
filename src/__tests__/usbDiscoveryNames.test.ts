/**
 * Which name a discovered brick gets, and why it must not change on connect.
 *
 * Two enumerations feed this and they disagree. libusb reads the product string off the
 * hardware; node-hid returns the Windows descriptor cache. On the machine this was found on,
 * that cache calls two bricks of three "Xfer data to and from EV3 brick", and the bricks
 * themselves — asked over a session — answer AAA, BBB and CCC.
 *
 * The trap is that discovery deliberately skips a brick whose interface the provider has
 * claimed, so a *connected* brick has no libusb name to offer and falls through to the cache.
 * A brick therefore renamed itself to nonsense at the moment someone connected to it, and
 * back again on disconnect. Seen across a power cycle in a hardware run before it was fixed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UsbTransportProvider } from '../transports/usbTransportProvider';

const SERIAL = '00165300000A';

/** What node-hid reports: present, but carrying the stale cached product string. */
const hidDevice = {
	path: 'hid-path-1',
	serialNumber: SERIAL,
	product: 'Xfer data to and from EV3 brick',
};

/** What libusb reports when it is allowed to read the device. */
const usbDevice = {
	serialNumber: SERIAL,
	product: 'AAA',
	location: { busNumber: 1, deviceAddress: 4 },
};

function providerWith(usbDevices: () => unknown[]) {
	return new UsbTransportProvider({
		log: { info: () => { /* quiet */ }, warn: () => { /* quiet */ } },
		listHidDevices: () => [hidDevice],
		listUsbDevices: (() => Promise.resolve(usbDevices())) as never,
	});
}

describe('USB discovery — display names', () => {
	it('prefers the name read off the hardware over the Windows cache', async () => {
		const provider = providerWith(() => [usbDevice]);
		try {
			const scan = await provider.discover();
			assert.equal(scan.items[0].displayName, 'AAA');
		} finally {
			provider.dispose();
		}
	});

	it('keeps that name when the device is skipped on a later scan', async () => {
		// The second scan returns nothing from libusb, which is exactly what happens once
		// this provider holds the interface: `skip` excludes it. Without a remembered name
		// the brick falls back to the cache and renames itself mid-session.
		let allowLibusb = true;
		const provider = providerWith(() => (allowLibusb ? [usbDevice] : []));
		try {
			const first = await provider.discover();
			assert.equal(first.items[0].displayName, 'AAA');

			allowLibusb = false;
			const second = await provider.discover();
			assert.equal(second.items[0].displayName, 'AAA',
				'a connected brick must not rename itself to the cached string');
		} finally {
			provider.dispose();
		}
	});

	it('falls back to the cache only when the hardware has never been read', async () => {
		// On Linux and macOS there is no descriptor cache and node-hid's product is correct,
		// so the fallback has to stay — it is the last resort, not the second choice.
		const provider = providerWith(() => []);
		try {
			const scan = await provider.discover();
			assert.equal(scan.items[0].displayName, 'Xfer data to and from EV3 brick');
		} finally {
			provider.dispose();
		}
	});

	it('falls back to the serial when neither source offers a name', async () => {
		const provider = new UsbTransportProvider({
			log: { info: () => { /* quiet */ }, warn: () => { /* quiet */ } },
			listHidDevices: () => [{ path: 'hid-path-1', serialNumber: SERIAL }],
			listUsbDevices: (() => Promise.resolve([])) as never,
		});
		try {
			const scan = await provider.discover();
			assert.equal(scan.items[0].displayName, SERIAL);
		} finally {
			provider.dispose();
		}
	});
});

describe('USB discovery — a brick libusb holds (Linux, HOSTC 13.11.2026)', () => {
	// On Linux the libusb claim takes the interface from `usbhid`, and the brick's hidraw node
	// goes with it: node-hid stops listing a brick the moment it is connected. Measured on HOSTC
	// with the detach fix: "while AAA held: CCC, BBB", AAA back after the release.
	it('still lists a connected brick that node-hid no longer sees, under its known name', async () => {
		let hidSeesIt = true;
		const provider = new UsbTransportProvider({
			log: { info: () => { /* quiet */ }, warn: () => { /* quiet */ } },
			listHidDevices: () => (hidSeesIt ? [hidDevice] : []),
			listUsbDevices: (() => Promise.resolve(hidSeesIt ? [usbDevice] : [])) as never,
			createLibusbAdapter: (() => ({
				open: () => Promise.resolve(), close: () => Promise.resolve(),
				send: () => Promise.resolve(new Uint8Array()), isOpen: true, maxPacketBytes: 1024,
				deviceLocation: usbDevice.location,
			})) as never,
		});
		try {
			const first = await provider.discover();
			await provider.connect(first.items[0].brickKey);

			hidSeesIt = false;
			const held = await provider.discover();
			assert.equal(held.items.length, 1, 'a connected brick must not vanish from discovery');
			assert.equal(held.items[0].brickKey, first.items[0].brickKey);
			assert.equal(held.items[0].displayName, 'AAA');
			assert.equal(held.items[0].connected, true);
		} finally {
			provider.dispose();
		}
	});

	it('lists such a brick once when node-hid does still see it, as on Windows', async () => {
		const provider = new UsbTransportProvider({
			log: { info: () => { /* quiet */ }, warn: () => { /* quiet */ } },
			listHidDevices: () => [hidDevice],
			listUsbDevices: (() => Promise.resolve([usbDevice])) as never,
			createLibusbAdapter: (() => ({
				open: () => Promise.resolve(), close: () => Promise.resolve(),
				send: () => Promise.resolve(new Uint8Array()), isOpen: true, maxPacketBytes: 1024,
				deviceLocation: usbDevice.location,
			})) as never,
		});
		try {
			const first = await provider.discover();
			await provider.connect(first.items[0].brickKey);
			const again = await provider.discover();
			assert.equal(again.items.length, 1);
			assert.equal(again.items[0].connected, true);
		} finally {
			provider.dispose();
		}
	});
});
