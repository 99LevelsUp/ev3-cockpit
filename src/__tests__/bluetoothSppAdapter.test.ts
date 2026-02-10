import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { BluetoothSppAdapter } from '../transport/bluetoothSppAdapter';

class FakeSerialPort {
	private readonly listeners = new Map<string, Array<(arg?: unknown) => void>>();

	public open(callback: (error?: Error | null) => void): void {
		callback(undefined);
	}

	public close(callback: (error?: Error | null) => void): void {
		callback(undefined);
	}

	public write(data: Buffer, callback: (error?: Error | null) => void): void {
		const packet = new Uint8Array(data);
		const decoded = decodeEv3Packet(packet);
		const reply = encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([decoded.messageCounter & 0xff]));
		setTimeout(() => this.emit('data', Buffer.from(reply)), 0);
		callback(undefined);
	}

	public removeAllListeners(event?: string): this {
		if (!event) {
			this.listeners.clear();
			return this;
		}
		this.listeners.delete(event);
		return this;
	}

	public on(event: string, listener: (arg?: unknown) => void): this {
		const current = this.listeners.get(event) ?? [];
		current.push(listener);
		this.listeners.set(event, current);
		return this;
	}

	public emit(event: string, payload?: unknown): void {
		const listeners = this.listeners.get(event) ?? [];
		if (event === 'error' && listeners.length === 0) {
			throw payload instanceof Error ? payload : new Error(String(payload ?? 'Unhandled error'));
		}
		for (const listener of listeners) {
			listener(payload);
		}
	}
}

test('BluetoothSppAdapter can reopen after serial close and continue sending', async () => {
	const adapter = new BluetoothSppAdapter({ port: 'COM4' }) as unknown as {
		open: () => Promise<void>;
		send: (packet: Uint8Array, options: { timeoutMs: number; signal: AbortSignal }) => Promise<Uint8Array>;
		close: () => Promise<void>;
		handleFailure: (error: unknown) => void;
		openInternal: () => Promise<void>;
		port?: FakeSerialPort;
		receiveBuffer: Buffer;
		opened: boolean;
	};

	const openedPorts: FakeSerialPort[] = [];
	let opens = 0;
	adapter.openInternal = async () => {
		const port = new FakeSerialPort();
		opens += 1;
		openedPorts.push(port);
		adapter.port = port;
		adapter.receiveBuffer = Buffer.alloc(0);
		adapter.opened = true;
		port.on('data', (arg) => {
			const chunk = arg as Buffer;
			adapter.receiveBuffer = Buffer.concat([adapter.receiveBuffer, chunk]);
			(adapter as unknown as { drainPendingReply: () => void }).drainPendingReply();
		});
		port.on('error', (arg) => adapter.handleFailure(arg as Error));
		port.on('close', () => adapter.handleFailure(new Error('Bluetooth serial port closed.')));
	};

	try {
		await adapter.open();
		const first = await adapter.send(
			encodeEv3Packet(5, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x10])),
			{
				timeoutMs: 100,
				signal: new AbortController().signal
			}
		);
		assert.deepEqual(Array.from(decodeEv3Packet(first).payload), [0x05]);

		openedPorts[0].emit('close');
		await assert.rejects(
			adapter.send(encodeEv3Packet(6, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x20])), {
				timeoutMs: 100,
				signal: new AbortController().signal
			}),
			/not open/i
		);

		await adapter.open();
		const second = await adapter.send(
			encodeEv3Packet(7, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x30])),
			{
				timeoutMs: 100,
				signal: new AbortController().signal
			}
		);
		assert.deepEqual(Array.from(decodeEv3Packet(second).payload), [0x07]);
		assert.equal(opens, 2);
	} finally {
		await adapter.close();
	}
});

test('BluetoothSppAdapter ignores stale messageCounter packets and resolves expected reply', async () => {
	const adapter = new BluetoothSppAdapter({ port: 'COM4' }) as unknown as {
		open: () => Promise<void>;
		send: (
			packet: Uint8Array,
			options: { timeoutMs: number; signal: AbortSignal; expectedMessageCounter?: number }
		) => Promise<Uint8Array>;
		close: () => Promise<void>;
		handleFailure: (error: unknown) => void;
		openInternal: () => Promise<void>;
		port?: FakeSerialPort;
		receiveBuffer: Buffer;
		opened: boolean;
	};

	adapter.openInternal = async () => {
		const port = new FakeSerialPort();
		adapter.port = port;
		adapter.receiveBuffer = Buffer.alloc(0);
		adapter.opened = true;
		port.on('data', (arg) => {
			const chunk = arg as Buffer;
			adapter.receiveBuffer = Buffer.concat([adapter.receiveBuffer, chunk]);
			(adapter as unknown as { drainPendingReply: () => void }).drainPendingReply();
		});
		port.on('error', (arg) => adapter.handleFailure(arg as Error));
		port.on('close', () => adapter.handleFailure(new Error('Bluetooth serial port closed.')));
		(port as unknown as { write: (data: Buffer, callback: (error?: Error | null) => void) => void }).write = (
			data: Buffer,
			callback: (error?: Error | null) => void
		) => {
			const decoded = decodeEv3Packet(new Uint8Array(data));
			const stale = encodeEv3Packet((decoded.messageCounter + 1) & 0xffff, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0xaa]));
			const valid = encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0xbb]));
			setTimeout(() => port.emit('data', Buffer.from(stale)), 0);
			setTimeout(() => port.emit('data', Buffer.from(valid)), 1);
			callback(undefined);
		};
	};

	try {
		await adapter.open();
		const reply = await adapter.send(
			encodeEv3Packet(10, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x01])),
			{
				timeoutMs: 100,
				signal: new AbortController().signal,
				expectedMessageCounter: 10
			}
		);
		const decoded = decodeEv3Packet(reply);
		assert.equal(decoded.messageCounter, 10);
		assert.deepEqual(Array.from(decoded.payload), [0xbb]);
	} finally {
		await adapter.close();
	}
});

test('BluetoothSppAdapter close keeps error listener to avoid unhandled late serial errors', async () => {
	const adapter = new BluetoothSppAdapter({ port: 'COM4' }) as unknown as {
		open: () => Promise<void>;
		close: () => Promise<void>;
		openInternal: () => Promise<void>;
		port?: FakeSerialPort;
		receiveBuffer: Buffer;
		opened: boolean;
		handleFailure: (error: unknown) => void;
	};

	let port: FakeSerialPort | undefined;
	adapter.openInternal = async () => {
		port = new FakeSerialPort();
		adapter.port = port;
		adapter.receiveBuffer = Buffer.alloc(0);
		adapter.opened = true;
		port.on('data', () => undefined);
		port.on('error', (arg) => adapter.handleFailure(arg as Error));
		port.on('close', () => adapter.handleFailure(new Error('Bluetooth serial port closed.')));
	};

	await adapter.open();
	await adapter.close();
	assert.doesNotThrow(() => port?.emit('error', new Error('late write abort')));
});
