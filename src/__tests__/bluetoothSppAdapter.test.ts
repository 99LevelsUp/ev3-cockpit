import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { encodeEv3Packet, EV3_REPLY, decodeEv3Packet, EV3_COMMAND } from '../protocol/ev3Packet';
import { BluetoothSppAdapter } from '../transport/bluetoothSppAdapter';
import { sleep } from './testHelpers';

class FakeSerialPort extends EventEmitter {
	public isOpen = false;
	public openCalled = false;
	public closeCalled = false;
	public writtenBuffers: Buffer[] = [];
	public setOptions: Array<{ dtr?: boolean; rts?: boolean }> = [];

	constructor(public options: { path: string; baudRate: number; autoOpen: boolean }) {
		super();
	}

	open(callback?: (error?: Error | null) => void): void {
		this.openCalled = true;
		this.isOpen = true;
		process.nextTick(() => callback?.());
	}

	close(callback?: (error?: Error | null) => void): void {
		this.closeCalled = true;
		this.isOpen = false;
		process.nextTick(() => callback?.());
	}

	write(data: Buffer, callback?: (error?: Error | null) => void): boolean {
		this.writtenBuffers.push(Buffer.from(data));
		process.nextTick(() => callback?.());
		return true;
	}

	set(options: { dtr?: boolean; rts?: boolean }, callback?: (error?: Error | null) => void): void {
		this.setOptions.push(options);
		process.nextTick(() => callback?.());
	}
}

let lastPort: FakeSerialPort | undefined;

function FakeSerialPortCtor(opts: { path: string; baudRate: number; autoOpen: boolean }): FakeSerialPort {
	lastPort = new FakeSerialPort(opts);
	return lastPort;
}

function createAdapter(portPath = 'COM5', dtr = false): BluetoothSppAdapter {
	return new BluetoothSppAdapter({
		portPath,
		dtr,
		postOpenDelayMs: 0,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		_serialPortFactory: FakeSerialPortCtor as any
	});
}

function getPort(): FakeSerialPort {
	if (!lastPort) {
		throw new Error('FakeSerialPort not yet created');
	}
	return lastPort;
}

function buildEv3Reply(messageCounter: number, payload: Buffer): Buffer {
	const packet = encodeEv3Packet(messageCounter, EV3_REPLY.DIRECT_REPLY, payload);
	return Buffer.from(packet);
}

test('BluetoothSppAdapter opens serial port with correct parameters', async () => {
	const adapter = createAdapter('COM7', true);
	await adapter.open();
	const port = getPort();
	assert.equal(port.options.path, 'COM7');
	assert.equal(port.options.baudRate, 115200);
	assert.equal(port.options.autoOpen, false);
	assert.ok(port.openCalled);
	assert.deepEqual(port.setOptions, [{ dtr: true }]);
	await adapter.close();
});

test('BluetoothSppAdapter send writes packet and resolves on reply', async () => {
	const adapter = createAdapter();
	await adapter.open();
	const port = getPort();

	const controller = new AbortController();
	const sendPromise = adapter.send(
		encodeEv3Packet(42, EV3_COMMAND.DIRECT_COMMAND_REPLY, Buffer.alloc(0)),
		{ timeoutMs: 1000, signal: controller.signal, expectedMessageCounter: 42 }
	);
	await sleep(10);

	const reply = buildEv3Reply(42, Buffer.from([0x02]));
	port.emit('data', reply);

	const result = await sendPromise;
	const decoded = decodeEv3Packet(result);
	assert.equal(decoded.messageCounter, 42);
	await adapter.close();
});

test('BluetoothSppAdapter rejects send when port is not open', async () => {
	const adapter = createAdapter();
	const controller = new AbortController();
	await assert.rejects(
		() => adapter.send(
			new Uint8Array([1, 2, 3]),
			{ timeoutMs: 1000, signal: controller.signal }
		),
		{ message: /BT transport is not open/ }
	);
});

test('BluetoothSppAdapter rejects in-flight request on abort', async () => {
	const adapter = createAdapter();
	await adapter.open();

	const controller = new AbortController();
	const sendPromise = adapter.send(
		encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY, Buffer.alloc(0)),
		{ timeoutMs: 5000, signal: controller.signal, expectedMessageCounter: 1 }
	);
	await sleep(10);
	controller.abort();

	await assert.rejects(sendPromise, { message: /BT send aborted/ });
	await adapter.close();
});

test('BluetoothSppAdapter close rejects pending reply', async () => {
	const adapter = createAdapter();
	await adapter.open();

	const controller = new AbortController();
	const sendPromise = adapter.send(
		encodeEv3Packet(7, EV3_COMMAND.DIRECT_COMMAND_REPLY, Buffer.alloc(0)),
		{ timeoutMs: 5000, signal: controller.signal, expectedMessageCounter: 7 }
	);
	await sleep(10);
	await adapter.close();

	await assert.rejects(sendPromise, { message: /BT transport closed/ });
});

test('BluetoothSppAdapter handles chunked receive data', async () => {
	const adapter = createAdapter();
	await adapter.open();
	const port = getPort();

	const controller = new AbortController();
	const sendPromise = adapter.send(
		encodeEv3Packet(99, EV3_COMMAND.DIRECT_COMMAND_REPLY, Buffer.alloc(0)),
		{ timeoutMs: 1000, signal: controller.signal, expectedMessageCounter: 99 }
	);
	await sleep(10);

	const reply = buildEv3Reply(99, Buffer.from([0x00]));
	port.emit('data', reply.subarray(0, 3));
	await sleep(5);
	port.emit('data', reply.subarray(3));

	const result = await sendPromise;
	const decoded = decodeEv3Packet(result);
	assert.equal(decoded.messageCounter, 99);
	await adapter.close();
});

test('BluetoothSppAdapter rejects duplicate in-flight send', async () => {
	const adapter = createAdapter();
	await adapter.open();

	const controller = new AbortController();
	const p = adapter.send(
		encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY, Buffer.alloc(0)),
		{ timeoutMs: 5000, signal: controller.signal, expectedMessageCounter: 1 }
	);
	await sleep(10);

	const controller2 = new AbortController();
	await assert.rejects(
		() => adapter.send(
			encodeEv3Packet(2, EV3_COMMAND.DIRECT_COMMAND_REPLY, Buffer.alloc(0)),
			{ timeoutMs: 1000, signal: controller2.signal, expectedMessageCounter: 2 }
		),
		{ message: /already has in-flight/ }
	);

	controller.abort();
	try { await p; } catch { /* expected abort */ }
	await adapter.close();
});

test('BluetoothSppAdapter rejects send on pre-aborted signal', async () => {
	const adapter = createAdapter();
	await adapter.open();

	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		() => adapter.send(
			new Uint8Array([1, 2, 3]),
			{ timeoutMs: 1000, signal: controller.signal }
		),
		{ message: /BT send aborted before dispatch/ }
	);
	await adapter.close();
});

test('BluetoothSppAdapter rejects open with empty portPath', async () => {
	const adapter = new BluetoothSppAdapter({ portPath: '  ' });
	await assert.rejects(
		() => adapter.open(),
		{ message: /non-empty port path/ }
	);
});

test('BluetoothSppAdapter idempotent open returns same promise', async () => {
	const adapter = createAdapter();
	const p1 = adapter.open();
	const p2 = adapter.open();
	await Promise.all([p1, p2]);
	assert.ok(getPort().openCalled);
	await adapter.close();
});

test('BluetoothSppAdapter handles port error event', async () => {
	const adapter = createAdapter();
	await adapter.open();
	const port = getPort();

	const controller = new AbortController();
	const sendPromise = adapter.send(
		encodeEv3Packet(10, EV3_COMMAND.DIRECT_COMMAND_REPLY, Buffer.alloc(0)),
		{ timeoutMs: 5000, signal: controller.signal, expectedMessageCounter: 10 }
	);
	await sleep(10);

	port.emit('error', new Error('device disconnected'));

	await assert.rejects(sendPromise, { message: /device disconnected/ });
	await adapter.close();
});
