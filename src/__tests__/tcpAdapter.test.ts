import assert from 'node:assert/strict';
import * as net from 'node:net';
import test from 'node:test';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { TcpAdapter } from '../transport/tcpAdapter';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeServerOptions {
	handshakeResponse: string;
	onPacket?: (socket: net.Socket, packet: Uint8Array) => void;
}

async function startFakeEv3Server(options: FakeServerOptions): Promise<{
	port: number;
	close: () => Promise<void>;
	receivedHandshake: () => string;
}> {
	let handshakeRaw = '';
	const server = net.createServer((socket) => {
		let handshakeDone = false;
		let handshakeBuffer = Buffer.alloc(0);
		let packetBuffer = Buffer.alloc(0);

		const handlePacketData = (chunk: Buffer) => {
			packetBuffer = Buffer.concat([packetBuffer, chunk]);
			while (packetBuffer.length >= 2) {
				const bodyLength = packetBuffer.readUInt16LE(0);
				const totalLength = 2 + bodyLength;
				if (packetBuffer.length < totalLength) {
					return;
				}

				const packet = new Uint8Array(Buffer.from(packetBuffer.subarray(0, totalLength)));
				packetBuffer = packetBuffer.subarray(totalLength);
				options.onPacket?.(socket, packet);
			}
		};

		socket.on('data', (chunk: Buffer) => {
			if (!handshakeDone) {
				handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
				const marker = handshakeBuffer.indexOf('\r\n\r\n');
				if (marker < 0) {
					return;
				}

				const handshakeBytes = handshakeBuffer.subarray(0, marker + 4);
				handshakeRaw = handshakeBytes.toString('utf8');
				handshakeDone = true;
				socket.write(options.handshakeResponse, 'utf8');

				const leftover = handshakeBuffer.subarray(marker + 4);
				handshakeBuffer = Buffer.alloc(0);
				if (leftover.length > 0) {
					handlePacketData(leftover);
				}
				return;
			}

			handlePacketData(chunk);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('Failed to acquire fake EV3 server address.');
	}

	return {
		port: address.port,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
		receivedHandshake: () => handshakeRaw
	};
}

test('TcpAdapter performs unlock handshake and packet roundtrip', async () => {
	const server = await startFakeEv3Server({
		handshakeResponse: 'HTTP/1.1 200 OK\r\nAccept: EV340\r\n\r\n',
		onPacket: (socket, packet) => {
			const decoded = decodeEv3Packet(packet);
			const reply = encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x99]));
			socket.write(Buffer.from(reply.subarray(0, 3)));
			setTimeout(() => socket.write(Buffer.from(reply.subarray(3))), 3);
		}
	});

	const adapter = new TcpAdapter({
		host: '127.0.0.1',
		port: server.port,
		serialNumber: 'SERIAL-123',
		handshakeTimeoutMs: 500
	});

	try {
		await adapter.open();
		assert.match(server.receivedHandshake(), /GET \/target\?sn=SERIAL-123 VMTP1\.0/);
		assert.match(server.receivedHandshake(), /Protocol: WiFi/);

		const packet = encodeEv3Packet(42, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x10]));
		const reply = await adapter.send(packet, {
			timeoutMs: 100,
			signal: new AbortController().signal
		});

		const decodedReply = decodeEv3Packet(reply);
		assert.equal(decodedReply.messageCounter, 42);
		assert.equal(decodedReply.type, EV3_REPLY.DIRECT_REPLY);
		assert.deepEqual(Array.from(decodedReply.payload), [0x99]);
	} finally {
		await adapter.close();
		await server.close();
	}
});

test('TcpAdapter ignores stale messageCounter packets and resolves expected reply', async () => {
	const server = await startFakeEv3Server({
		handshakeResponse: 'HTTP/1.1 200 OK\r\nAccept: EV340\r\n\r\n',
		onPacket: (socket, packet) => {
			const decoded = decodeEv3Packet(packet);
			const stale = encodeEv3Packet((decoded.messageCounter + 1) & 0xffff, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0xaa]));
			const valid = encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0xbb]));
			socket.write(Buffer.from(stale));
			setTimeout(() => socket.write(Buffer.from(valid)), 3);
		}
	});

	const adapter = new TcpAdapter({
		host: '127.0.0.1',
		port: server.port,
		handshakeTimeoutMs: 500
	});

	try {
		await adapter.open();
		const reply = await adapter.send(encodeEv3Packet(22, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x10])), {
			timeoutMs: 100,
			signal: new AbortController().signal,
			expectedMessageCounter: 22
		});

		const decodedReply = decodeEv3Packet(reply);
		assert.equal(decodedReply.messageCounter, 22);
		assert.deepEqual(Array.from(decodedReply.payload), [0xbb]);
	} finally {
		await adapter.close();
		await server.close();
	}
});

test('TcpAdapter accepts compact EV3 unlock response without CRLF framing', async () => {
	const server = await startFakeEv3Server({
		handshakeResponse: 'Accept:EV340',
		onPacket: (socket, packet) => {
			const decoded = decodeEv3Packet(packet);
			const reply = encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x66]));
			socket.write(Buffer.from(reply));
		}
	});

	const adapter = new TcpAdapter({
		host: '127.0.0.1',
		port: server.port,
		handshakeTimeoutMs: 500
	});

	try {
		await adapter.open();
		const reply = await adapter.send(encodeEv3Packet(12, EV3_COMMAND.DIRECT_COMMAND_REPLY), {
			timeoutMs: 100,
			signal: new AbortController().signal
		});
		const decodedReply = decodeEv3Packet(reply);
		assert.equal(decodedReply.messageCounter, 12);
		assert.deepEqual(Array.from(decodedReply.payload), [0x66]);
	} finally {
		await adapter.close();
		await server.close();
	}
});

test('TcpAdapter fails open when unlock response has no EV3 Accept line', async () => {
	const server = await startFakeEv3Server({
		handshakeResponse: 'HTTP/1.1 200 OK\r\nAccept: UNKNOWN\r\n\r\n'
	});

	const adapter = new TcpAdapter({
		host: '127.0.0.1',
		port: server.port,
		handshakeTimeoutMs: 300
	});

	try {
		await assert.rejects(adapter.open(), /unlock handshake failed/i);
	} finally {
		await adapter.close();
		await server.close();
	}
});

test('TcpAdapter send rejects when request is aborted before reply', async () => {
	const server = await startFakeEv3Server({
		handshakeResponse: 'HTTP/1.1 200 OK\r\nAccept: EV340\r\n\r\n',
		onPacket: async () => {
			await sleep(100);
		}
	});

	const adapter = new TcpAdapter({
		host: '127.0.0.1',
		port: server.port,
		handshakeTimeoutMs: 500
	});

	try {
		await adapter.open();

		const controller = new AbortController();
		const request = adapter.send(encodeEv3Packet(7, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array()), {
			timeoutMs: 100,
			signal: controller.signal
		});

		setTimeout(() => controller.abort(new Error('test abort')), 20);
		await assert.rejects(request, /aborted/i);
	} finally {
		await adapter.close();
		await server.close();
	}
});

test('TcpAdapter can reopen after remote close and continue sending', async () => {
	let connectionIndex = 0;
	const server = net.createServer((socket) => {
		connectionIndex += 1;
		const thisConnection = connectionIndex;
		let handshakeDone = false;
		let handshakeBuffer = Buffer.alloc(0);
		let packetBuffer = Buffer.alloc(0);

		const handlePacketData = (chunk: Buffer) => {
			packetBuffer = Buffer.concat([packetBuffer, chunk]);
			while (packetBuffer.length >= 2) {
				const bodyLength = packetBuffer.readUInt16LE(0);
				const totalLength = 2 + bodyLength;
				if (packetBuffer.length < totalLength) {
					return;
				}
				const packet = new Uint8Array(Buffer.from(packetBuffer.subarray(0, totalLength)));
				packetBuffer = packetBuffer.subarray(totalLength);
				const decoded = decodeEv3Packet(packet);
				const reply = encodeEv3Packet(
					decoded.messageCounter,
					EV3_REPLY.DIRECT_REPLY,
					new Uint8Array([thisConnection])
				);
				socket.write(Buffer.from(reply));
				if (thisConnection === 1) {
					setTimeout(() => socket.destroy(), 5);
				}
			}
		};

		socket.on('data', (chunk: Buffer) => {
			if (!handshakeDone) {
				handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
				const marker = handshakeBuffer.indexOf('\r\n\r\n');
				if (marker < 0) {
					return;
				}
				handshakeDone = true;
				socket.write('HTTP/1.1 200 OK\r\nAccept: EV340\r\n\r\n', 'utf8');
				const leftover = handshakeBuffer.subarray(marker + 4);
				handshakeBuffer = Buffer.alloc(0);
				if (leftover.length > 0) {
					handlePacketData(leftover);
				}
				return;
			}
			handlePacketData(chunk);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('Failed to start reconnect recovery TCP test server.');
	}

	const adapter = new TcpAdapter({
		host: '127.0.0.1',
		port: address.port,
		handshakeTimeoutMs: 500
	});

	try {
		await adapter.open();
		const firstReply = await adapter.send(encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY), {
			timeoutMs: 100,
			signal: new AbortController().signal
		});
		assert.deepEqual(Array.from(decodeEv3Packet(firstReply).payload), [1]);

		await sleep(25);
		await assert.rejects(
			adapter.send(encodeEv3Packet(2, EV3_COMMAND.DIRECT_COMMAND_REPLY), {
				timeoutMs: 100,
				signal: new AbortController().signal
			}),
			/not open/i
		);

		await adapter.open();
		const secondReply = await adapter.send(encodeEv3Packet(3, EV3_COMMAND.DIRECT_COMMAND_REPLY), {
			timeoutMs: 100,
			signal: new AbortController().signal
		});
		assert.deepEqual(Array.from(decodeEv3Packet(secondReply).payload), [2]);
	} finally {
		await adapter.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test('TcpAdapter close resolves when socket is already destroyed', async () => {
	const server = await startFakeEv3Server({
		handshakeResponse: 'HTTP/1.1 200 OK\r\nAccept: EV340\r\n\r\n',
		onPacket: (socket, packet) => {
			const decoded = decodeEv3Packet(packet);
			const reply = encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x55]));
			socket.write(Buffer.from(reply));
			setTimeout(() => socket.destroy(), 5);
		}
	});

	const adapter = new TcpAdapter({
		host: '127.0.0.1',
		port: server.port,
		handshakeTimeoutMs: 500
	});

	try {
		await adapter.open();
		await adapter.send(encodeEv3Packet(11, EV3_COMMAND.DIRECT_COMMAND_REPLY), {
			timeoutMs: 100,
			signal: new AbortController().signal
		});
		await sleep(40);

		const closeState = await Promise.race([
			adapter.close().then(() => 'closed'),
			sleep(300).then(() => 'timeout')
		]);
		assert.equal(closeState, 'closed');
	} finally {
		await adapter.close();
		await server.close();
	}
});

test('TcpAdapter allows empty host when discovery is enabled', async () => {
	const adapter = new TcpAdapter({
		host: '',
		useDiscovery: true,
		discoveryPort: 0,
		discoveryTimeoutMs: 30,
		handshakeTimeoutMs: 100
	});

	try {
		await assert.rejects(adapter.open(), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.doesNotMatch(error.message, /requires non-empty host/i);
			return true;
		});
	} finally {
		await adapter.close();
	}
});
