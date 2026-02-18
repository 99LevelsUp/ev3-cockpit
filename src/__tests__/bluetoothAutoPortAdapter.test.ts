import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransportAdapter, TransportRequestOptions } from '../transport/transportAdapter';
import { BluetoothAutoPortAdapter } from '../transport/bluetoothAutoPortAdapter';

// ── helpers ──

class FakeAdapter implements TransportAdapter {
	opened = false;
	closed = false;
	sendResult: Uint8Array = new Uint8Array([1, 2, 3]);
	openError?: Error;
	probeCallCount = 0;

	async open(): Promise<void> {
		if (this.openError) { throw this.openError; }
		this.opened = true;
	}
	async close(): Promise<void> { this.closed = true; this.opened = false; }
	async send(_packet: Uint8Array, _options: TransportRequestOptions): Promise<Uint8Array> {
		return this.sendResult;
	}
}

function fakePorts(paths: string[]) {
	return async () => paths.map((p) => ({ path: p }));
}

function fakeProbeOk(_adapter: TransportAdapter, _timeout: number): Promise<boolean> {
	return Promise.resolve(true);
}

function fakeProbeReject(_adapter: TransportAdapter, _timeout: number): Promise<boolean> {
	return Promise.resolve(false);
}

// ── open ──

test('BluetoothAutoPortAdapter open succeeds with first COM port', async () => {
	const adapters: FakeAdapter[] = [];
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false],
		rediscoveryAttempts: 0,
		portAttempts: 1,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: fakePorts(['COM3']),
		_createAdapter: () => { const a = new FakeAdapter(); adapters.push(a); return a; },
		_probeEv3: fakeProbeOk,
	});

	await auto.open();
	assert.equal(auto.connectedPort, 'COM3');
	assert.ok(adapters[0].opened);
	await auto.close();
});

test('BluetoothAutoPortAdapter skips port on probe negative, tries next', async () => {
	let probeCallIndex = 0;
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false],
		rediscoveryAttempts: 0,
		portAttempts: 1,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: fakePorts(['COM3', 'COM5']),
		_createAdapter: () => new FakeAdapter(),
		_probeEv3: async () => {
			probeCallIndex++;
			return probeCallIndex >= 2; // first port fails, second succeeds
		},
	});

	await auto.open();
	assert.equal(auto.connectedPort, 'COM5');
	await auto.close();
});

test('BluetoothAutoPortAdapter retries on transient error', async () => {
	let attemptCount = 0;
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false],
		rediscoveryAttempts: 0,
		portAttempts: 3,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: fakePorts(['COM5']),
		_createAdapter: () => {
			const a = new FakeAdapter();
			attemptCount++;
			if (attemptCount < 3) {
				a.openError = new Error('Opening COM5: error code 121');
			}
			return a;
		},
		_probeEv3: fakeProbeOk,
	});

	await auto.open();
	assert.equal(attemptCount, 3); // 2 failures + 1 success
	assert.equal(auto.connectedPort, 'COM5');
	await auto.close();
});

test('BluetoothAutoPortAdapter skips port on permanent error', async () => {
	let createCount = 0;
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false],
		rediscoveryAttempts: 0,
		portAttempts: 3,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: fakePorts(['COM3', 'COM5']),
		_createAdapter: () => {
			createCount++;
			const a = new FakeAdapter();
			if (createCount === 1) {
				a.openError = new Error('permanent hardware failure');
			}
			return a;
		},
		_probeEv3: fakeProbeOk,
	});

	await auto.open();
	// COM3 fails permanently (1 attempt), then COM5 succeeds (1 attempt) = 2 total
	assert.equal(createCount, 2);
	assert.equal(auto.connectedPort, 'COM5');
	await auto.close();
});

test('BluetoothAutoPortAdapter throws when no ports found', async () => {
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false],
		rediscoveryAttempts: 0,
		portAttempts: 1,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: fakePorts([]),
		_createAdapter: () => new FakeAdapter(),
		_probeEv3: fakeProbeOk,
	});

	await assert.rejects(
		() => auto.open(),
		{ message: /no EV3 found/ }
	);
});

test('BluetoothAutoPortAdapter throws when all probes fail', async () => {
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false],
		rediscoveryAttempts: 0,
		portAttempts: 1,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: fakePorts(['COM3']),
		_createAdapter: () => new FakeAdapter(),
		_probeEv3: fakeProbeReject,
	});

	await assert.rejects(
		() => auto.open(),
		{ message: /no EV3 found/ }
	);
});

// ── send / close ──

test('BluetoothAutoPortAdapter send delegates to inner adapter', async () => {
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false],
		rediscoveryAttempts: 0,
		portAttempts: 1,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: fakePorts(['COM5']),
		_createAdapter: () => {
			const a = new FakeAdapter();
			a.sendResult = new Uint8Array([0xAA, 0xBB]);
			return a;
		},
		_probeEv3: fakeProbeOk,
	});

	await auto.open();
	const controller = new AbortController();
	const result = await auto.send(new Uint8Array([1]), { timeoutMs: 100, signal: controller.signal });
	assert.deepEqual(result, new Uint8Array([0xAA, 0xBB]));
	await auto.close();
});

test('BluetoothAutoPortAdapter send rejects when not open', async () => {
	const auto = new BluetoothAutoPortAdapter();
	const controller = new AbortController();
	await assert.rejects(
		() => auto.send(new Uint8Array([1]), { timeoutMs: 100, signal: controller.signal }),
		{ message: /not open/ }
	);
});

test('BluetoothAutoPortAdapter close is idempotent', async () => {
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false],
		rediscoveryAttempts: 0,
		portAttempts: 1,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: fakePorts(['COM5']),
		_createAdapter: () => new FakeAdapter(),
		_probeEv3: fakeProbeOk,
	});

	await auto.open();
	await auto.close();
	await auto.close(); // should not throw
	assert.equal(auto.connectedPort, undefined);
});

test('BluetoothAutoPortAdapter tries second DTR profile on failure', async () => {
	let dtrValues: boolean[] = [];
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false, true],
		rediscoveryAttempts: 0,
		portAttempts: 1,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: fakePorts(['COM5']),
		_createAdapter: (opts) => {
			dtrValues.push(opts.dtr ?? false);
			const a = new FakeAdapter();
			return a;
		},
		_probeEv3: async () => dtrValues.length >= 2, // fail first DTR, pass second
	});

	await auto.open();
	assert.deepEqual(dtrValues, [false, true]);
	await auto.close();
});

test('BluetoothAutoPortAdapter uses rediscovery passes', async () => {
	let listCallCount = 0;
	const auto = new BluetoothAutoPortAdapter({
		dtrProfiles: [false],
		rediscoveryAttempts: 1,
		rediscoveryDelayMs: 0,
		portAttempts: 1,
		retryDelayMs: 0,
		postOpenDelayMs: 0,
		probeTimeoutMs: 100,
		_listPorts: async () => {
			listCallCount++;
			if (listCallCount < 2) { return []; }
			return [{ path: 'COM7' }];
		},
		_createAdapter: () => new FakeAdapter(),
		_probeEv3: fakeProbeOk,
	});

	await auto.open();
	assert.equal(listCallCount, 2);
	assert.equal(auto.connectedPort, 'COM7');
	await auto.close();
});
