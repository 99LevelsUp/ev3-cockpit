import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { TransportAdapter, TransportRequestOptions } from './transportAdapter';

const DEFAULT_TCP_PORT = 5555;
const DEFAULT_DISCOVERY_PORT = 3015;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 7_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;

interface PendingReply {
	resolve: (packet: Uint8Array) => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
	expectedMessageCounter?: number;
}

interface PendingHandshake {
	resolve: (response: string) => void;
	reject: (error: unknown) => void;
	timeout: NodeJS.Timeout;
}

interface DiscoveryInfo {
	ip: string;
	port: number;
	serialNumber: string;
	protocol: string;
	name: string;
}

export interface TcpAdapterOptions {
	host: string;
	port?: number;
	serialNumber?: string;
	useDiscovery?: boolean;
	discoveryPort?: number;
	discoveryTimeoutMs?: number;
	handshakeTimeoutMs?: number;
}

export class TcpAdapter implements TransportAdapter {
	private readonly host: string;
	private readonly port: number;
	private readonly serialNumber: string;
	private readonly useDiscovery: boolean;
	private readonly discoveryPort: number;
	private readonly discoveryTimeoutMs: number;
	private readonly handshakeTimeoutMs: number;

	private socket?: net.Socket;
	private openPromise?: Promise<void>;
	private closing = false;
	private opened = false;
	private receiveBuffer = Buffer.alloc(0);
	private handshakeBuffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;
	private pendingHandshake?: PendingHandshake;

	public constructor(options: TcpAdapterOptions) {
		this.host = options.host;
		this.port = options.port ?? DEFAULT_TCP_PORT;
		this.serialNumber = options.serialNumber ?? '';
		this.useDiscovery = options.useDiscovery ?? false;
		this.discoveryPort = options.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
		this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	}

	public async open(): Promise<void> {
		if (this.opened) {
			return;
		}

		if (!this.host && !this.useDiscovery) {
			throw new Error('TCP adapter requires non-empty host unless discovery is enabled.');
		}

		if (this.openPromise) {
			return this.openPromise;
		}

		this.openPromise = this.openInternal().finally(() => {
			this.openPromise = undefined;
		});

		return this.openPromise;
	}

	public async close(): Promise<void> {
		this.opened = false;
		this.closing = true;
		this.rejectPendingReply(new Error('TCP adapter closed while waiting for reply.'));
		this.rejectPendingHandshake(new Error('TCP adapter closed during handshake.'));

		const socket = this.socket;
		this.socket = undefined;
		this.receiveBuffer = Buffer.alloc(0);
		this.handshakeBuffer = Buffer.alloc(0);

		if (!socket) {
			this.closing = false;
			return;
		}

		await new Promise<void>((resolve) => {
			socket.once('close', () => resolve());
			socket.destroy();
		});

		this.closing = false;
	}

	public async send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array> {
		const socket = this.requireReadySocket();
		if (this.pendingReply) {
			throw new Error('TCP adapter already has in-flight send request.');
		}

		if (options.signal.aborted) {
			throw new Error('TCP send aborted before dispatch.');
		}

		return new Promise<Uint8Array>((resolve, reject) => {
			const onAbort = () => {
				this.rejectPendingReply(new Error('TCP send aborted.'));
			};

			const cleanup = () => {
				options.signal.removeEventListener('abort', onAbort);
			};
			options.signal.addEventListener('abort', onAbort, { once: true });

			this.pendingReply = {
				resolve,
				reject,
				cleanup,
				expectedMessageCounter: options.expectedMessageCounter
			};

			socket.write(Buffer.from(packet), (error?: Error | null) => {
				if (error) {
					this.rejectPendingReply(error);
					return;
				}

				this.drainPendingReply();
			});
		});
	}

	private async openInternal(): Promise<void> {
		let connectHost = this.host;
		let connectPort = this.port;
		let serial = this.serialNumber;
		let protocol = 'WiFi';

		if (this.useDiscovery) {
			try {
				const discovery = await this.waitForBeaconAndAck();
				connectHost = connectHost || discovery.ip;
				connectPort = discovery.port;
				serial = serial || discovery.serialNumber || 'n/a';
				protocol = discovery.protocol || protocol;
			} catch (error) {
				if (!connectHost) {
					throw error;
				}
				// Discovery can fail on some networks. If host is configured, continue with direct TCP connect.
			}
		} else {
			serial = serial || 'n/a';
		}

		if (!connectHost) {
			throw new Error('TCP adapter could not resolve host. Set ev3-cockpit.transport.tcp.host or enable discovery.');
		}

		const socket = await this.connectSocket(connectHost, connectPort);
		this.socket = socket;
		this.receiveBuffer = Buffer.alloc(0);
		this.handshakeBuffer = Buffer.alloc(0);

		socket.on('data', (chunk: Buffer) => this.onSocketData(chunk));
		socket.on('error', (error) => this.handleSocketFailure(error));
		socket.on('close', () => this.handleSocketFailure(new Error('TCP socket closed.')));

		try {
			await this.performUnlockHandshake(socket, serial, protocol);
			this.opened = true;
		} catch (error) {
			socket.destroy();
			this.socket = undefined;
			throw error;
		}
	}

	private connectSocket(host: string, port: number): Promise<net.Socket> {
		return new Promise<net.Socket>((resolve, reject) => {
			const socket = net.createConnection({
				host,
				port
			});

			const timeout = setTimeout(() => {
				cleanup();
				socket.destroy();
				reject(new Error(`TCP connect timeout after ${this.handshakeTimeoutMs}ms (${host}:${port}).`));
			}, this.handshakeTimeoutMs);

			const onError = (error: Error) => {
				cleanup();
				socket.destroy();
				reject(error);
			};

			const onConnect = () => {
				cleanup();
				socket.setNoDelay(true);
				resolve(socket);
			};

			const cleanup = () => {
				clearTimeout(timeout);
				socket.removeListener('error', onError);
				socket.removeListener('connect', onConnect);
			};

			socket.once('error', onError);
			socket.once('connect', onConnect);
		});
	}

	private async performUnlockHandshake(socket: net.Socket, serialNumber: string, protocol: string): Promise<void> {
		const serial = encodeURIComponent(serialNumber || 'n/a');
		const requestCandidates = [
			`GET /target?sn=${serial} VMTP1.0\r\nProtocol: ${protocol}\r\n\r\n`,
			`GET /target?sn=${serial} VMTP1.0\nProtocol: ${protocol}`
		];

		let lastError: unknown;
		for (const request of requestCandidates) {
			try {
				const response = await this.sendUnlockRequest(socket, request);
				if (this.isAcceptResponse(response)) {
					return;
				}
				lastError = new Error(`Unexpected unlock response "${response.trim()}".`);
			} catch (error) {
				lastError = error;
			}
		}

		const detail = lastError instanceof Error ? lastError.message : String(lastError);
		throw new Error(`TCP unlock handshake failed: ${detail}`);
	}

	private async sendUnlockRequest(socket: net.Socket, request: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingHandshake = undefined;
				reject(new Error(`TCP unlock handshake timeout after ${this.handshakeTimeoutMs}ms.`));
			}, this.handshakeTimeoutMs);

			this.pendingHandshake = {
				resolve: (reply) => {
					clearTimeout(timeout);
					this.pendingHandshake = undefined;
					resolve(reply);
				},
				reject: (error) => {
					clearTimeout(timeout);
					this.pendingHandshake = undefined;
					reject(error);
				},
				timeout
			};

			socket.write(request, 'utf8', (error?: Error | null) => {
				if (error) {
					this.rejectPendingHandshake(error);
				}
			});
		});
	}

	private isAcceptResponse(response: string): boolean {
		return /accept\s*:\s*ev3/i.test(response);
	}

	private onSocketData(chunk: Buffer): void {
		if (this.pendingHandshake) {
			this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
			const handshakeText = this.handshakeBuffer.toString('utf8');
			if (this.isAcceptResponse(handshakeText)) {
				const response = handshakeText;
				this.handshakeBuffer = Buffer.alloc(0);
				this.pendingHandshake.resolve(response);
				return;
			}

			const markerIndex = this.handshakeBuffer.indexOf('\r\n\r\n');
			if (markerIndex < 0) {
				return;
			}

			const responseBytes = this.handshakeBuffer.subarray(0, markerIndex + 4);
			const leftover = this.handshakeBuffer.subarray(markerIndex + 4);
			this.handshakeBuffer = Buffer.alloc(0);
			this.pendingHandshake.resolve(responseBytes.toString('utf8'));
			if (leftover.length > 0) {
				this.receiveBuffer = Buffer.concat([this.receiveBuffer, leftover]);
				this.drainPendingReply();
			}
			return;
		}

		this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
		this.drainPendingReply();
	}

	private drainPendingReply(): void {
		if (!this.pendingReply) {
			return;
		}

		let packet = this.extractNextPacket();
		while (packet) {
			const expected = this.pendingReply?.expectedMessageCounter;
			if (expected === undefined || this.getMessageCounter(packet) === expected) {
				const pending = this.pendingReply;
				this.pendingReply = undefined;
				pending.cleanup();
				pending.resolve(packet);
				return;
			}
			packet = this.extractNextPacket();
		}
	}

	private extractNextPacket(): Uint8Array | undefined {
		if (this.receiveBuffer.length < 2) {
			return undefined;
		}

		const bodyLength = this.receiveBuffer.readUInt16LE(0);
		const totalLength = 2 + bodyLength;
		if (this.receiveBuffer.length < totalLength) {
			return undefined;
		}

		const packet = Buffer.from(this.receiveBuffer.subarray(0, totalLength));
		this.receiveBuffer = this.receiveBuffer.subarray(totalLength);
		return new Uint8Array(packet);
	}

	private requireReadySocket(): net.Socket {
		if (!this.socket || !this.opened || this.socket.destroyed) {
			throw new Error('TCP adapter is not open.');
		}
		return this.socket;
	}

	private getMessageCounter(packet: Uint8Array): number {
		if (packet.length < 4) {
			return -1;
		}
		return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(2, true);
	}

	private rejectPendingReply(error: unknown): void {
		if (!this.pendingReply) {
			return;
		}
		const pending = this.pendingReply;
		this.pendingReply = undefined;
		pending.cleanup();
		pending.reject(error);
	}

	private rejectPendingHandshake(error: unknown): void {
		if (!this.pendingHandshake) {
			return;
		}

		const pending = this.pendingHandshake;
		this.pendingHandshake = undefined;
		clearTimeout(pending.timeout);
		pending.reject(error);
	}

	private handleSocketFailure(error: unknown): void {
		if (this.closing) {
			return;
		}

		this.opened = false;
		this.rejectPendingHandshake(error);
		this.rejectPendingReply(error);
	}

	private waitForBeaconAndAck(): Promise<DiscoveryInfo> {
		return new Promise<DiscoveryInfo>((resolve, reject) => {
			const socket = dgram.createSocket('udp4');
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`UDP discovery timeout after ${this.discoveryTimeoutMs}ms.`));
			}, this.discoveryTimeoutMs);

			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};

			const onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
				if (this.host && rinfo.address !== this.host) {
					return;
				}

				const parsed = this.parseBeacon(msg.toString('utf8'));
				if (!parsed) {
					return;
				}

				socket.send(Buffer.from([0x00]), rinfo.port, rinfo.address, (error?: Error | null) => {
					cleanup();
					if (error) {
						reject(error);
						return;
					}
					resolve({
						ip: rinfo.address,
						port: parsed.port,
						serialNumber: parsed.serialNumber,
						protocol: parsed.protocol,
						name: parsed.name
					});
				});
			};

			const cleanup = () => {
				clearTimeout(timeout);
				socket.removeListener('error', onError);
				socket.removeListener('message', onMessage);
				socket.close();
			};

			socket.once('error', onError);
			socket.on('message', onMessage);
			socket.bind(this.discoveryPort);
		});
	}

	private parseBeacon(message: string): { serialNumber: string; port: number; protocol: string; name: string } | undefined {
		const lines = message.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
		const map = new Map<string, string>();
		for (const line of lines) {
			const index = line.indexOf(':');
			if (index < 0) {
				continue;
			}
			const key = line.slice(0, index).trim().toLowerCase();
			const value = line.slice(index + 1).trim();
			map.set(key, value);
		}

		const serialNumber = map.get('serial-number') ?? '';
		const portRaw = map.get('port') ?? '';
		const protocol = map.get('protocol') ?? 'WiFi';
		const name = map.get('name') ?? '';
		const parsedPort = Number.parseInt(portRaw, 10);
		if (!Number.isFinite(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
			return undefined;
		}

		return {
			serialNumber,
			port: parsedPort,
			protocol,
			name
		};
	}
}
