import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { listSerialCandidates, listUsbHidCandidates } from '../transport/discovery';

type ModuleLoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
type ModuleWithLoad = typeof Module & { _load: ModuleLoadFn };

async function withMockedRequire(
	request: string,
	resolver: () => unknown,
	run: () => Promise<void>
): Promise<void> {
	const moduleWithLoad = Module as ModuleWithLoad;
	const originalLoad = moduleWithLoad._load;
	moduleWithLoad._load = ((requested: string, parent: unknown, isMain: boolean) => {
		if (requested === request) {
			return resolver();
		}
		return originalLoad(requested, parent, isMain);
	}) as ModuleLoadFn;

	try {
		await run();
	} finally {
		moduleWithLoad._load = originalLoad;
	}
}

test('listUsbHidCandidates maps HID device fields', { concurrency: false }, async () => {
	await withMockedRequire(
		'node-hid',
		() => ({
			devices: () => [
				{
					path: 'hid://device-1',
					vendorId: 0x0694,
					productId: 0x0005,
					product: 'EV3',
					serialNumber: 'ABC123'
				}
			]
		}),
		async () => {
			const candidates = await listUsbHidCandidates();
			assert.deepEqual(candidates, [
				{
					path: 'hid://device-1',
					vendorId: 0x0694,
					productId: 0x0005,
					product: 'EV3',
					serialNumber: 'ABC123'
				}
			]);
		}
	);
});

test('listUsbHidCandidates returns empty array when node-hid is unavailable', { concurrency: false }, async () => {
	await withMockedRequire(
		'node-hid',
		() => {
			throw new Error('module missing');
		},
		async () => {
			const candidates = await listUsbHidCandidates();
			assert.deepEqual(candidates, []);
		}
	);
});

test('listSerialCandidates returns serial ports from serialport package', { concurrency: false }, async () => {
	await withMockedRequire(
		'serialport',
		() => ({
			SerialPort: {
				list: async () => [{ path: 'COM7', manufacturer: 'Test Vendor', serialNumber: 'SER1' }]
			}
		}),
		async () => {
			const candidates = await listSerialCandidates();
			assert.deepEqual(candidates, [{ path: 'COM7', manufacturer: 'Test Vendor', serialNumber: 'SER1' }]);
		}
	);
});

test('listSerialCandidates returns empty array when SerialPort.list is missing', { concurrency: false }, async () => {
	await withMockedRequire(
		'serialport',
		() => ({
			SerialPort: {}
		}),
		async () => {
			const candidates = await listSerialCandidates();
			assert.deepEqual(candidates, []);
		}
	);
});

test('listSerialCandidates returns empty array when serialport is unavailable', { concurrency: false }, async () => {
	await withMockedRequire(
		'serialport',
		() => {
			throw new Error('module missing');
		},
		async () => {
			const candidates = await listSerialCandidates();
			assert.deepEqual(candidates, []);
		}
	);
});
