/**
 * Which USB backend a connection lands on, and whether anyone is told.
 *
 * The two are not interchangeable: libusb carries the brick's full 1024-byte frame while
 * HID delivers 64, which is too little for `copy` or `move` to be expressed at all. A
 * silent fallback would look like a working connection and behave like a broken one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Transport, makeBrickKey } from '../contracts';
import { UsbTransportProvider } from '../transports/usbTransportProvider';
import { USB } from '../transports/transportConstants';

const KEY = makeBrickKey(Transport.USB, '001653AABBCC');

interface FakeAdapter {
	open(): Promise<void>;
	close(): Promise<void>;
	send(): Promise<Uint8Array>;
	readonly isOpen: boolean;
	readonly maxPacketBytes?: number;
	readonly deviceLocation?: { busNumber: number; deviceAddress: number };
}

function adapter(options: {
	failWith?: string;
	maxPacketBytes?: number;
	opened?: string[];
	label?: string;
}): FakeAdapter {
	let open = false;
	return {
		open(): Promise<void> {
			if (options.failWith) { return Promise.reject(new Error(options.failWith)); }
			open = true;
			options.opened?.push(options.label ?? 'adapter');
			return Promise.resolve();
		},
		close(): Promise<void> { open = false; return Promise.resolve(); },
		send(): Promise<Uint8Array> { return Promise.resolve(new Uint8Array()); },
		get isOpen(): boolean { return open; },
		get maxPacketBytes(): number | undefined { return open ? options.maxPacketBytes : undefined; },
		deviceLocation: { busNumber: 2, deviceAddress: 10 },
	};
}

function providerWith(config: {
	libusb: { failWith?: string; maxPacketBytes?: number };
	hid?: { failWith?: string };
	opened?: string[];
	log?: { info: string[]; warn: string[] };
}): UsbTransportProvider {
	const log = config.log;
	return new UsbTransportProvider({
		log: log && {
			info: (m: string) => log.info.push(m),
			warn: (m: string) => log.warn.push(m),
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createLibusbAdapter: () => adapter({
			...config.libusb, opened: config.opened, label: 'libusb',
		}) as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createHidAdapter: () => adapter({
			...(config.hid ?? {}), maxPacketBytes: USB.MAX_WRITE_PACKET_BYTES,
			opened: config.opened, label: 'hid',
		}) as any,
	});
}

describe('USB backend selection', () => {
	it('prefers libusb, and never opens the HID path when it succeeds', async () => {
		const opened: string[] = [];
		const provider = providerWith({ libusb: { maxPacketBytes: 1024 }, opened });
		await provider.connect(KEY);

		assert.deepEqual(opened, ['libusb']);
		assert.equal(provider.backendFor(KEY), 'libusb');
		assert.equal(provider.maxPacketBytes(KEY), 1024);
		provider.dispose();
	});

	it('falls back to HID and says what that costs', async () => {
		const log = { info: [] as string[], warn: [] as string[] };
		const provider = providerWith({
			libusb: { failWith: 'LIBUSB_ERROR_ACCESS' },
			log,
		});
		await provider.connect(KEY);

		assert.equal(provider.backendFor(KEY), 'hid');
		assert.equal(provider.maxPacketBytes(KEY), USB.MAX_WRITE_PACKET_BYTES);
		assert.equal(log.warn.length, 1, 'a degraded link must not be silent');
		assert.match(log.warn[0], /LIBUSB_ERROR_ACCESS/, 'the reason belongs in the message');
		assert.match(log.warn[0], /copy\/move cannot be sent at all/);
		provider.dispose();
	});

	it('names both failures when neither backend opens', async () => {
		const provider = providerWith({
			libusb: { failWith: 'LIBUSB_ERROR_ACCESS' },
			hid: { failWith: 'no HID device' },
		});
		// "USB connect failed" against a brick that is plainly attached is a dead end
		// unless the message says the libusb claim was refused first.
		await assert.rejects(
			() => provider.connect(KEY),
			/libusb: LIBUSB_ERROR_ACCESS\. HID: no HID device/
		);
		provider.dispose();
	});

	it('reports no packet size for a brick that is not connected', async () => {
		const provider = providerWith({ libusb: { maxPacketBytes: 1024 } });
		assert.equal(provider.maxPacketBytes(KEY), undefined);
		assert.equal(provider.backendFor(KEY), undefined);
		provider.dispose();
	});

	it('forgets the backend on disconnect', async () => {
		const provider = providerWith({ libusb: { maxPacketBytes: 1024 } });
		await provider.connect(KEY);
		await provider.disconnect(KEY);
		assert.equal(provider.maxPacketBytes(KEY), undefined);
		provider.dispose();
	});
});
