import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../../protocol/ev3Packet';
import {
	buildCapabilityReplyPayload,
	DownloadSession,
	executeFakeSystemCommand,
	FakeEv3CommandContext,
	FakeRemoteFsState,
	UploadSession
} from './fakeEv3Protocol';

export async function startFakeEv3TcpServer(): Promise<{
	port: number;
	getRunProgramCommandCount: () => number;
	getAcceptedConnectionCount: () => number;
	close: () => Promise<void>;
}> {
	const sockets = new Set<net.Socket>();
	const capabilityPayload = buildCapabilityReplyPayload();
	let runProgramCommandCount = 0;
	let acceptedConnectionCount = 0;
	const commandContext: FakeEv3CommandContext = {
		fs: new FakeRemoteFsState(),
		uploads: new Map<number, UploadSession>(),
		downloads: new Map<number, DownloadSession>(),
		nextHandle: 1
	};
	const server = net.createServer((socket) => {
		acceptedConnectionCount += 1;
		sockets.add(socket);
		let handshakeComplete = false;
		let receiveBuffer = Buffer.alloc(0);

		socket.on('close', () => {
			sockets.delete(socket);
		});

		socket.on('data', (chunk: Buffer) => {
			if (!handshakeComplete) {
				const text = chunk.toString('utf8');
				if (text.includes('GET /target?sn=')) {
					socket.write('Accept: EV340\r\n\r\n');
					handshakeComplete = true;
				}
				return;
			}

			receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
			while (receiveBuffer.length >= 2) {
				const bodyLength = receiveBuffer.readUInt16LE(0);
				const totalLength = bodyLength + 2;
				if (receiveBuffer.length < totalLength) {
					return;
				}

				const packet = new Uint8Array(receiveBuffer.subarray(0, totalLength));
				receiveBuffer = receiveBuffer.subarray(totalLength);
				const request = decodeEv3Packet(packet);
				let replyType: number = EV3_REPLY.SYSTEM_REPLY;
				let replyPayload: Uint8Array = new Uint8Array();
				if (
					request.type === EV3_COMMAND.SYSTEM_COMMAND_REPLY ||
					request.type === EV3_COMMAND.SYSTEM_COMMAND_NO_REPLY
				) {
					const opcode = request.payload[0] ?? 0x00;
					const commandPayload = request.payload.subarray(1);
					replyPayload = executeFakeSystemCommand(commandContext, opcode, commandPayload);
					replyType = replyPayload[1] === 0x00 || replyPayload[1] === 0x08
						? EV3_REPLY.SYSTEM_REPLY
						: EV3_REPLY.SYSTEM_REPLY_ERROR;
				} else {
					replyType = EV3_REPLY.DIRECT_REPLY;
					const directPayloadText = Buffer.from(request.payload).toString('utf8').toLowerCase();
					if (directPayloadText.includes('.rbf')) {
						runProgramCommandCount += 1;
					}
					replyPayload = Uint8Array.from(capabilityPayload);
				}

				socket.write(Buffer.from(encodeEv3Packet(request.messageCounter, replyType, replyPayload)));
			}
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
		throw new Error('Fake EV3 TCP server failed to expose listen address.');
	}

	return {
		port: address.port,
		getRunProgramCommandCount: () => runProgramCommandCount,
		getAcceptedConnectionCount: () => acceptedConnectionCount,
		close: async () => {
			for (const socket of sockets) {
				socket.end();
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			for (const socket of sockets) {
				if (!socket.destroyed) {
					socket.destroy();
				}
			}
			sockets.clear();
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => resolve(), 5_000);
				server.close(() => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}
	};
}

export function startFakeDiscoveryBeacon(discoveryPort: number, tcpPort: number): () => void {
	const socket = dgram.createSocket('udp4');
	const beacon = Buffer.from(
		`Serial-Number: 0016535D7E2D\r\nPort: ${tcpPort}\r\nProtocol: WiFi\r\nName: EV3\r\n\r\n`
	);
	const timer = setInterval(() => {
		socket.send(beacon, discoveryPort, '127.0.0.1');
	}, 80);

	return () => {
		clearInterval(timer);
		socket.close();
	};
}
