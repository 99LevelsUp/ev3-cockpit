import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { UsbHidAdapter } from '../transport/usbHidAdapter';

class FakeHidDevice {
	private readonly listeners = new Map<string, Array<(arg: unknown) => void>>();

	public write(data: number[]): number {
		const reportId = data[0] ?? 0;
		const body = Buffer.from(data.slice(1));
		const packet = new Uint8Array(body.subarray(0, (body.readUInt16LE(0) ?? 0) + 2));
		const decoded = decodeEv3Packet(packet);
		const reply = encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([decoded.messageCounter & 0xff]));

		const payload = Buffer.concat([Buffer.from([reportId]), Buffer.from(reply)]);
		setTimeout(() => this.emit('data', payload), 0);
		return data.length;
	}

	public close(): void {}

	public removeAllListeners(event?: string): this {
		if (!event) {
			this.listeners.clear();
			return this;
		}
		this.listeners.delete(event);
		return this;
	}

	public on(event: string, listener: (arg: unknown) => void): this {
		const current = this.listeners.get(event) ?? [];
		current.push(listener);
		this.listeners.set(event, current);
		return this;
	}

	public emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(payload);
		}
	}
}

test('UsbHidAdapter packet parser skips HID zero padding between packets', () => {
	const adapter = new UsbHidAdapter({ reportSize: 1025 }) as unknown as {
		receiveBuffer: Buffer;
		extractNextPacket: () => Uint8Array | undefined;
	};

	const first = encodeEv3Packet(1, EV3_REPLY.SYSTEM_REPLY, new Uint8Array([0x9d, 0x00]));
	const second = encodeEv3Packet(2, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0xaa, 0xbb]));
	const padding = new Uint8Array(20);

	adapter.receiveBuffer = Buffer.concat([Buffer.from(first), Buffer.from(padding), Buffer.from(second)]);

	const firstOut = adapter.extractNextPacket();
	assert.ok(firstOut);
	assert.equal(decodeEv3Packet(firstOut).messageCounter, 1);

	const secondOut = adapter.extractNextPacket();
	assert.ok(secondOut);
	const decodedSecond = decodeEv3Packet(secondOut);
	assert.equal(decodedSecond.messageCounter, 2);
	assert.equal(decodedSecond.type, EV3_REPLY.DIRECT_REPLY);
	assert.deepEqual(Array.from(decodedSecond.payload), [0xaa, 0xbb]);
});

test('UsbHidAdapter packet parser drops impossible short headers', () => {
	const adapter = new UsbHidAdapter({ reportSize: 1025 }) as unknown as {
		receiveBuffer: Buffer;
		extractNextPacket: () => Uint8Array | undefined;
	};

	const packet = encodeEv3Packet(7, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x10]));
	adapter.receiveBuffer = Buffer.concat([Buffer.from([0x01, 0x00, 0x00]), Buffer.from(packet)]);

	const out = adapter.extractNextPacket();
	assert.ok(out);
	const decoded = decodeEv3Packet(out);
	assert.equal(decoded.messageCounter, 7);
	assert.deepEqual(Array.from(decoded.payload), [0x10]);
});

test('UsbHidAdapter can reopen after driver-level error and continue sending', async () => {
	const adapter = new UsbHidAdapter({ reportId: 0, reportSize: 64 }) as unknown as {
		open: () => Promise<void>;
		send: (packet: Uint8Array, options: { timeoutMs: number; signal: AbortSignal }) => Promise<Uint8Array>;
		close: () => Promise<void>;
		handleFailure: (error: unknown) => void;
		openInternal: () => Promise<void>;
		device?: FakeHidDevice;
		receiveBuffer: Buffer;
		opened: boolean;
	};

	let opens = 0;
	const openedDevices: FakeHidDevice[] = [];
	adapter.openInternal = async () => {
		const device = new FakeHidDevice();
		opens += 1;
		openedDevices.push(device);
		adapter.device = device;
		adapter.receiveBuffer = Buffer.alloc(0);
		adapter.opened = true;
		device.on('data', (arg) => {
			const data = arg as Buffer;
			const normalized = data[0] === 0 && data.length > 1 ? data.subarray(1) : data;
			adapter.receiveBuffer = Buffer.concat([adapter.receiveBuffer, normalized]);
			(adapter as unknown as { drainPendingReply: () => void }).drainPendingReply();
		});
		device.on('error', (arg) => adapter.handleFailure(arg as Error));
	};

	try {
		await adapter.open();
		const first = await adapter.send(
			encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x10])),
			{
				timeoutMs: 100,
				signal: new AbortController().signal
			}
		);
		assert.deepEqual(Array.from(decodeEv3Packet(first).payload), [0x01]);

		openedDevices[0].emit('error', new Error('driver disconnect'));
		await assert.rejects(
			adapter.send(encodeEv3Packet(2, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x20])), {
				timeoutMs: 100,
				signal: new AbortController().signal
			}),
			/not open/i
		);

		await adapter.open();
		const second = await adapter.send(
			encodeEv3Packet(3, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x30])),
			{
				timeoutMs: 100,
				signal: new AbortController().signal
			}
		);
		assert.deepEqual(Array.from(decodeEv3Packet(second).payload), [0x03]);
		assert.equal(opens, 2);
	} finally {
		await adapter.close();
	}
});

test('UsbHidAdapter ignores stale messageCounter packets and resolves expected reply', async () => {
	const adapter = new UsbHidAdapter({ reportId: 0, reportSize: 64 }) as unknown as {
		open: () => Promise<void>;
		send: (
			packet: Uint8Array,
			options: { timeoutMs: number; signal: AbortSignal; expectedMessageCounter?: number }
		) => Promise<Uint8Array>;
		close: () => Promise<void>;
		handleFailure: (error: unknown) => void;
		openInternal: () => Promise<void>;
		device?: FakeHidDevice;
		receiveBuffer: Buffer;
		opened: boolean;
	};

	adapter.openInternal = async () => {
		const device = new FakeHidDevice();
		adapter.device = device;
		adapter.receiveBuffer = Buffer.alloc(0);
		adapter.opened = true;
		device.on('data', (arg) => {
			const data = arg as Buffer;
			const normalized = data[0] === 0 && data.length > 1 ? data.subarray(1) : data;
			adapter.receiveBuffer = Buffer.concat([adapter.receiveBuffer, normalized]);
			(adapter as unknown as { drainPendingReply: () => void }).drainPendingReply();
		});
		device.on('error', (arg) => adapter.handleFailure(arg as Error));
		device.write = (data: number[]) => {
			const reportId = data[0] ?? 0;
			const stale = encodeEv3Packet(0x1234, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0xaa]));
			const valid = encodeEv3Packet(10, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0xbb]));
			setTimeout(() => device.emit('data', Buffer.concat([Buffer.from([reportId]), Buffer.from(stale)])), 0);
			setTimeout(() => device.emit('data', Buffer.concat([Buffer.from([reportId]), Buffer.from(valid)])), 1);
			return data.length;
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
