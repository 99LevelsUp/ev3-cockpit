/**
 * TCP transport adapter for Wi-Fi/Ethernet EV3 brick communication.
 *
 * Supports optional UDP beacon discovery to locate the brick on the
 * network and performs the EV3 TCP "unlock" handshake (VMTP1.0) before
 * allowing command traffic.
 */

import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { TransportAdapter, SendOptions } from './transportAdapter';
import { TransportError, TimeoutError } from '../errors/CockpitError';
import {
	PendingReply,
	drainPendingReply,
	rejectPendingReply,
	extractLengthPrefixedPacket
} from './pendingReply';
import { TCP } from './transportConstants';

/** Grace period (ms) for TCP socket close before forcing completion. */
const SOCKET_CLOSE_GRACE_MS = 250;

/** Maximum receive buffer size (bytes) before forcibly closing the connection. */
const MAX_RECEIVE_BUFFER_SIZE = 1_048_576; // 1 MB

interface PendingHandshake {
	resolve: (response: string) => void;
	reject: (error: unknown) => void;
	timeout: NodeJS.Timeout;
}

/** Result of a UDP beacon discovery scan. */
export interface TcpDiscoveryInfo {
	ip: string;
	port: number;
	serialNumber: string;
	protocol: string;
	name: string;
}

/** Parsed EV3 beacon fields (excluding sender IP). */
export interface BeaconFields {
	serialNumber: string;
	port: number;
	protocol: string;
	name: string;
}

/**
 * Parse key-value fields from an EV3 UDP beacon message.
 * Shared by both the adapter (internal discovery) and the provider (scan).
 */
export function parseBeaconMessage(message: string): BeaconFields | undefined {
	const lines = message.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	const map = new Map<string, string>();
	for (const line of lines) {
		const index = line.indexOf(':');
		if (index < 0) { continue; }
		map.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
	}

	const serialNumber = map.get('serial-number') ?? '';
	const portRaw = map.get('port') ?? '';
	const protocol = map.get('protocol') ?? 'WiFi';
	const name = map.get('name') ?? '';
	const parsedPort = Number.parseInt(portRaw, 10);
	if (!Number.isFinite(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
		return undefined;
	}

	return { serialNumber, port: parsedPort, protocol, name };
}

/** Configuration for {@link TcpSocketAdapter}. */
export interface TcpAdapterOptions {
	/** IP address or hostname of the EV3 brick. */
	host: string;
	port?: number;
	serialNumber?: string;
	useDiscovery?: boolean;
	discoveryPort?: number;
	discoveryTimeoutMs?: number;
	handshakeTimeoutMs?: number;
}

/**
 * TCP transport adapter for Wi-Fi/Ethernet EV3 communication.
 */
export class TcpSocketAdapter implements TransportAdapter {
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
	private _isOpen = false;
	private receiveBuffer: Buffer = Buffer.alloc(0);
	private handshakeBuffer: Buffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;
	private pendingHandshake?: PendingHandshake;

	constructor(options: TcpAdapterOptions) {
		this.host = options.host;
		this.port = options.port ?? TCP.PORT;
		this.serialNumber = options.serialNumber ?? '';
		this.useDiscovery = options.useDiscovery ?? false;
		this.discoveryPort = options.discoveryPort ?? TCP.BEACON_PORT;
		this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? TCP.BEACON_TIMEOUT_MS;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? TCP.UNLOCK_TIMEOUT_MS;
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	async open(): Promise<void> {
		if (this._isOpen) {
			return;
		}
		if (!this.host && !this.useDiscovery) {
			throw new TransportError('TCP adapter requires non-empty host unless discovery is enabled.');
		}
		if (this.openPromise) {
			return this.openPromise;
		}
		this.openPromise = this.openInternal().finally(() => {
			this.openPromise = undefined;
		});
		return this.openPromise;
	}

	async close(): Promise<void> {
		this._isOpen = false;
		this.closing = true;
		this.doRejectPendingReply(new Error('TCP adapter closed while waiting for reply.'));
		this.doRejectPendingHandshake(new Error('TCP adapter closed during handshake.'));

		const socket = this.socket;
		this.socket = undefined;
		this.receiveBuffer = Buffer.alloc(0);
		this.handshakeBuffer = Buffer.alloc(0);

		if (!socket || socket.destroyed) {
			this.closing = false;
			return;
		}

		await new Promise<void>((resolve) => {
			let settled = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const finish = () => {
				if (settled) { return; }
				settled = true;
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
					timeoutHandle = undefined;
				}
				resolve();
			};
			socket.once('close', () => finish());
			socket.once('error', () => finish());
			socket.destroy();
			timeoutHandle = setTimeout(finish, SOCKET_CLOSE_GRACE_MS);
			timeoutHandle.unref();
		});

		this.closing = false;
	}

	async send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array> {
		const socket = this.requireReadySocket();
		if (this.pendingReply) {
			throw new TransportError('TCP adapter already has in-flight send request.');
		}
		if (options?.signal?.aborted) {
			throw new TransportError('TCP send aborted before dispatch.');
		}

		return new Promise<Uint8Array>((resolve, reject) => {
			const signal = options?.signal;
			const onAbort = () => {
				this.doRejectPendingReply(new TransportError('TCP send aborted.'));
			};
			const cleanup = () => signal?.removeEventListener('abort', onAbort);
			signal?.addEventListener('abort', onAbort, { once: true });

			this.pendingReply = {
				resolve,
				reject,
				cleanup,
				expectedMessageCounter: options?.expectedMessageCounter
			};

			socket.write(Buffer.from(packet), (error?: Error | null) => {
				if (error) {
					this.doRejectPendingReply(error);
					return;
				}
				this.doDrainPendingReply();
			});
		});
	}

	// ── Internal ────────────────────────────────────────────────────

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
			} catch {
				if (!connectHost) {
					throw new TransportError(
						'TCP adapter could not discover EV3 brick. Set host or enable discovery.'
					);
				}
			}
		} else {
			serial = serial || 'n/a';
		}

		if (!connectHost) {
			throw new TransportError(
				'TCP adapter could not resolve host. Set ev3-cockpit.transport.tcp.host or enable discovery.'
			);
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
			this._isOpen = true;
		} catch (error) {
			socket.destroy();
			this.socket = undefined;
			throw error;
		}
	}

	private connectSocket(host: string, port: number): Promise<net.Socket> {
		return new Promise<net.Socket>((resolve, reject) => {
			const socket = net.createConnection({ host, port });

			const timeout = setTimeout(() => {
				cleanup();
				socket.destroy();
				reject(new TimeoutError(
					`TCP connect timeout after ${this.handshakeTimeoutMs}ms (${host}:${port}).`
				));
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

	private async performUnlockHandshake(
		socket: net.Socket, serialNumber: string, protocol: string
	): Promise<void> {
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
		throw new TransportError(`TCP unlock handshake failed: ${detail}`);
	}

	private sendUnlockRequest(socket: net.Socket, request: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingHandshake = undefined;
				reject(new TimeoutError(
					`TCP unlock handshake timeout after ${this.handshakeTimeoutMs}ms.`
				));
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
					this.doRejectPendingHandshake(error);
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
				this.handshakeBuffer = Buffer.alloc(0);
				this.pendingHandshake.resolve(handshakeText);
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
				this.doDrainPendingReply();
			}
			return;
		}

		this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
		if (this.receiveBuffer.length > MAX_RECEIVE_BUFFER_SIZE) {
			this.doRejectPendingReply(
				new TransportError(`TCP receive buffer exceeded ${MAX_RECEIVE_BUFFER_SIZE} bytes — closing.`)
			);
			this.receiveBuffer = Buffer.alloc(0);
			void this.close();
			return;
		}
		this.doDrainPendingReply();
	}

	private doDrainPendingReply(): void {
		this.pendingReply = drainPendingReply(this.pendingReply, () => this.extractNextPacket());
	}

	private extractNextPacket(): Uint8Array | undefined {
		const result = extractLengthPrefixedPacket(this.receiveBuffer);
		if (!result) {
			return undefined;
		}
		this.receiveBuffer = result.remaining;
		return result.packet;
	}

	private requireReadySocket(): net.Socket {
		if (!this.socket || !this._isOpen || this.socket.destroyed) {
			throw new TransportError('TCP adapter is not open.');
		}
		return this.socket;
	}

	private doRejectPendingReply(error: unknown): void {
		this.pendingReply = rejectPendingReply(this.pendingReply, error);
	}

	private doRejectPendingHandshake(error: unknown): void {
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
		this._isOpen = false;
		this.doRejectPendingHandshake(error);
		this.doRejectPendingReply(error);
	}

	// ── UDP Beacon Discovery ────────────────────────────────────────

	private waitForBeaconAndAck(): Promise<TcpDiscoveryInfo> {
		return new Promise<TcpDiscoveryInfo>((resolve, reject) => {
			const socket = dgram.createSocket('udp4');
			const timeout = setTimeout(() => {
				cleanup();
				reject(new TimeoutError(
					`UDP discovery timeout after ${this.discoveryTimeoutMs}ms.`
				));
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
				socket.send(Buffer.from([TCP.BEACON_ACK]), rinfo.port, rinfo.address, (error?: Error | null) => {
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

	private parseBeacon(
		message: string
	): BeaconFields | undefined {
		return parseBeaconMessage(message);
	}
}
