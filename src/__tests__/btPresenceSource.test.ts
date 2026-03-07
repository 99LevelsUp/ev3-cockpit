import assert from 'node:assert/strict';
import test from 'node:test';
import {
	BtPresenceSource,
	mergeBluetoothDeviceInfos,
	parseWindowsKnownLegoDevices,
	parseWindowsKnownLegoMacs
} from '../presence/btPresenceSource';
import { TransportMode } from '../types/enums';

function createNoopLogger() {
	const noop = () => {};
	return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

function safeId(v: string): string {
	return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function flushAsyncWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

test('BtPresenceSource has BT transport', () => {
	const source = new BtPresenceSource(
		{ fastIntervalMs: 1000, inquiryIntervalMs: 30000, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	assert.equal(source.transport, TransportMode.BT);
});

test('BtPresenceSource starts with empty map', () => {
	const source = new BtPresenceSource(
		{ fastIntervalMs: 1000, inquiryIntervalMs: 30000, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	assert.equal(source.getPresent().size, 0);
});

test('BtPresenceSource stop is idempotent', () => {
	const source = new BtPresenceSource(
		{ fastIntervalMs: 1000, inquiryIntervalMs: 30000, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	source.stop();
	source.stop();
});

test('BtPresenceSource onChange registers callback', () => {
	const source = new BtPresenceSource(
		{ fastIntervalMs: 1000, inquiryIntervalMs: 30000, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	let called = false;
	source.onChange(() => { called = true; });
	assert.equal(called, false);
});

test('BtPresenceSource runs immediate fast and inquiry scans on start', async () => {
	const calls: boolean[] = [];
	const source = new BtPresenceSource(
		{
			fastIntervalMs: 1000,
			inquiryIntervalMs: 30000,
			toSafeIdentifier: safeId,
			_listBluetoothCandidates: async (issueInquiry) => {
				calls.push(issueInquiry);
				return [];
			}
		},
		createNoopLogger()
	);

	source.start();
	await flushAsyncWork();
	source.stop();

	assert.deepEqual(calls.slice(0, 2), [false, true]);
});

test('parseWindowsKnownLegoMacs keeps LEGO MACs from registry payload', () => {
	const raw = JSON.stringify(['00165342D9F2', '001653518739', '1382B17FFC2A', 'not-a-mac']);
	assert.deepEqual(parseWindowsKnownLegoMacs(raw), ['00165342d9f2', '001653518739']);
});

test('parseWindowsKnownLegoDevices keeps LEGO registry names', () => {
	const raw = JSON.stringify([
		{ mac: '00165342D9F2', name: 'TRZTINA' },
		{ mac: '001653518739', name: 'BUMBLBEE' },
		{ mac: '1382B17FFC2A', name: 'GOGHBTM45' }
	]);
	assert.deepEqual(parseWindowsKnownLegoDevices(raw), [
		{ mac: '00165342d9f2', name: 'TRZTINA' },
		{ mac: '001653518739', name: 'BUMBLBEE' }
	]);
});

test('mergeBluetoothDeviceInfos unions cached and inquiry results by MAC', () => {
	const merged = mergeBluetoothDeviceInfos(
		[
			{
				mac: '001653518739',
				name: 'BUMBLBEE',
				connected: false,
				remembered: true,
				authenticated: true
			},
			{
				mac: '00165342d9f2',
				name: '',
				connected: false,
				remembered: false,
				authenticated: false
			}
		],
		[
			{
				mac: '00165342d9f2',
				name: 'TRZTINA',
				connected: true,
				remembered: false,
				authenticated: false
			},
			{
				mac: '0016535d7e2d',
				name: 'Szalinka',
				connected: false,
				remembered: false,
				authenticated: false
			}
		]
	);

	assert.deepEqual(merged, [
		{
			mac: '001653518739',
			name: 'BUMBLBEE',
			connected: false,
			remembered: true,
			authenticated: true
		},
		{
			mac: '00165342d9f2',
			name: 'TRZTINA',
			connected: true,
			remembered: false,
			authenticated: false
		},
		{
			mac: '0016535d7e2d',
			name: 'Szalinka',
			connected: false,
			remembered: false,
			authenticated: false
		}
	]);
});
