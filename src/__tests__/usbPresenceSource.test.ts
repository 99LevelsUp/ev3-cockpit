import assert from 'node:assert/strict';
import test from 'node:test';
import { UsbPresenceSource } from '../presence/usbPresenceSource';
import { TransportMode } from '../types/enums';

function createNoopLogger() {
	const noop = () => {};
	return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

function safeId(v: string): string {
	return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

test('UsbPresenceSource has USB transport', () => {
	const source = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	assert.equal(source.transport, TransportMode.USB);
});

test('UsbPresenceSource starts with empty map', () => {
	const source = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	assert.equal(source.getPresent().size, 0);
});

test('UsbPresenceSource stop is idempotent', () => {
	const source = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	source.stop();
	source.stop();
});

test('UsbPresenceSource onChange registers callback', () => {
	const source = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	let called = false;
	source.onChange(() => { called = true; });
	assert.equal(called, false);
});

test('UsbPresenceSource maps Windows EV3 PnP rows to one HID candidate per brick', () => {
	const source = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: safeId },
		createNoopLogger()
	);

	const devices = source['mapWindowsUsbRows']([
		{
			instanceId: 'HID\\VID_0694&PID_0005\\7&247A4A25&7&0000',
			parentId: 'USB\\VID_0694&PID_0005\\00165342D9F2',
			className: 'HIDClass',
			friendlyName: 'Dodavatelem definovane zarizeni standardu HID',
			manufacturer: '(Standard system devices)'
		},
		{
			instanceId: 'USB\\VID_0694&PID_0005\\0016535D7E2D',
			className: 'USB',
			friendlyName: 'Slozene zarizeni USB',
			manufacturer: '(Standard host controller)'
		},
		{
			instanceId: 'USB\\VID_0694&PID_0005&MI_00\\9&38595045&5&0000',
			parentId: 'USB\\VID_0694&PID_0005\\0016535D7E2D',
			className: 'HIDClass',
			friendlyName: 'Vstupni zarizeni USB',
			manufacturer: '(Standard system devices)'
		},
		{
			instanceId: 'SWD\\WPDBUSENUM\\_??_USBSTOR#DISK&VEN_LINUX&PROD_FILE-CD_GADGET&REV_0316#A&1BCFDA82&0&0016535D7E2D&0#{53F56307-B6BF-11D0-94F2-00A0C91EFB8B}',
			className: 'WPD',
			friendlyName: 'EV3',
			manufacturer: 'Linux'
		},
		{
			instanceId: 'USBSTOR\\DISK&VEN_LINUX&PROD_FILE-CD_GADGET&REV_0316\\A&1BCFDA82&0&0016535D7E2D&0',
			parentId: 'USB\\VID_0694&PID_0005&MI_01\\9&38595045&5&0001',
			className: 'DiskDrive',
			friendlyName: 'Linux File-CD Gadget USB Device',
			manufacturer: '(Standard disk drives)'
		}
	]);

	assert.equal(devices.length, 2);
	assert.deepEqual(
		devices
			.map((device) => ({ path: device.path, serialNumber: device.serialNumber, product: device.product }))
			.sort((a, b) => a.path.localeCompare(b.path)),
		[
			{ path: 'serial:00165342d9f2', serialNumber: '00165342d9f2', product: undefined },
			{ path: 'serial:0016535d7e2d', serialNumber: '0016535d7e2d', product: undefined }
		]
	);
});
