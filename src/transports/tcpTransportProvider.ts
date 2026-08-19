/**
 * TCP transport provider — composes TcpSocketAdapter + EV3 protocol layer.
 *
 * Implements {@link TransportProvider} by combining UDP beacon discovery,
 * TCP socket communication, and the protocol layer for command encoding/response parsing.
 */

import {
	Transport, BrickKey, makeBrickKey,
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, BrickCommand, BrickResponse,
	PresenceState,
} from '../contracts';
import { TransportError, ConnectionError } from '../errors/CockpitError';
import { TcpSocketAdapter, TcpAdapterOptions, TcpDiscoveryInfo, parseBeaconMessage } from './tcpSocketAdapter';
import { TCP } from './transportConstants';
import { sendCommandViaAdapter } from './protocolBridge';

import * as dgram from 'node:dgram';

// ── Session tracking ────────────────────────────────────────────────

interface TcpSession {
	adapter: TcpSocketAdapter;
	messageCounter: number;
	discoveryInfo?: TcpDiscoveryInfo;
}

/** Configuration for {@link TcpTransportProvider}. */
export interface TcpTransportProviderOptions {
	/** Default host for direct connections (no discovery). */
	host?: string;
	/** Default TCP port (default: 5555). */
	port?: number;
	/** Enable UDP beacon discovery (default: true). */
	useDiscovery?: boolean;
	/** UDP discovery port (default: 3015). */
	discoveryPort?: number;
	/** Discovery timeout in ms (default: 4000). */
	discoveryTimeoutMs?: number;
}

/**
 * TCP/Wi-Fi transport provider.
 */
export class TcpTransportProvider implements TransportProvider {
	readonly transport = Transport.TCP;
	readonly capabilities: TransportCapabilities = { supportsSignalInfo: false, supportsForget: false };

	private readonly options: TcpTransportProviderOptions;
	private readonly sessions = new Map<BrickKey, TcpSession>();
	private beaconSocket?: dgram.Socket;
	private beaconBindError?: Error;
	private readonly beaconCache = new Map<string, { info: TcpDiscoveryInfo; receivedAt: number }>();
	private disposed = false;

	constructor(options?: TcpTransportProviderOptions) {
		this.options = options ?? {};
		this.startBeaconListener();
	}

	discover(): Promise<DiscoveryScanResult> {
		this.assertNotDisposed();
		if (this.beaconBindError) {
			return Promise.reject(new TransportError(
				`TCP beacon port ${this.options.discoveryPort ?? TCP.BEACON_PORT} is unavailable: `
				+ this.beaconBindError.message,
				this.beaconBindError
			));
		}
		const now = Date.now();
		const items: DiscoveryItem[] = [];
		const hostFilter = this.options.host;

		for (const [key, entry] of this.beaconCache) {
			if (now - entry.receivedAt > TCP.BEACON_FRESH_MS) {
				this.beaconCache.delete(key);
				continue;
			}
			if (hostFilter && entry.info.ip !== hostFilter) { continue; }
			const { info } = entry;
			const brickKey = makeBrickKey(Transport.TCP, info.serialNumber || info.ip);
			items.push({
				brickKey,
				displayName: info.name || `EV3 [${info.ip}]`,
				transport: Transport.TCP,
				presenceState: PresenceState.Available,
				remembered: false,
				connected: this.sessions.has(brickKey),
				favorite: false,
				availableTransports: [Transport.TCP],
				lastSeenAt: entry.receivedAt,
			});
		}

		return Promise.resolve({ transport: Transport.TCP, items });
	}

	async connect(brickKey: BrickKey): Promise<SessionHandle> {
		this.assertNotDisposed();
		if (this.sessions.has(brickKey)) {
			throw new ConnectionError(`TCP brick ${brickKey} is already connected.`);
		}

		const adapterOptions = this.buildAdapterOptions(brickKey);
		const adapter = new TcpSocketAdapter(adapterOptions);
		try {
			await adapter.open();
		} catch (error) {
			throw new ConnectionError(
				`TCP connect failed for ${brickKey}: ${error instanceof Error ? error.message : String(error)}`,
				error
			);
		}

		this.sessions.set(brickKey, { adapter, messageCounter: 0 });
		return { brickKey, transport: Transport.TCP };
	}

	async disconnect(brickKey: BrickKey): Promise<void> {
		const session = this.sessions.get(brickKey);
		if (!session) { return; }
		this.sessions.delete(brickKey);
		await session.adapter.close();
	}

	async send(brickKey: BrickKey, command: BrickCommand): Promise<BrickResponse> {
		this.assertNotDisposed();
		const session = this.sessions.get(brickKey);
		if (!session) {
			throw new TransportError(`TCP brick ${brickKey} is not connected.`);
		}

		session.messageCounter = (session.messageCounter + 1) & 0xffff;
		return sendCommandViaAdapter(session.adapter, command, session.messageCounter, 'TCP');
	}

	dispose(): void {
		this.disposed = true;
		try { this.beaconSocket?.close(); } catch { /* socket may already be dead */ }
		this.beaconSocket = undefined;
		for (const [, session] of this.sessions) {
			void session.adapter.close();
		}
		this.sessions.clear();
	}

	// ── Internal ────────────────────────────────────────────────────

	private buildAdapterOptions(brickKey: BrickKey): TcpAdapterOptions {
		const parts = brickKey.split(':');
		const identifier = parts.length > 1 ? parts.slice(1).join(':') : '';
		const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(identifier);

		return {
			host: isIp ? identifier : (this.options.host ?? ''),
			port: this.options.port ?? TCP.PORT,
			serialNumber: isIp ? '' : identifier,
			useDiscovery: this.options.useDiscovery ?? true,
			discoveryPort: this.options.discoveryPort ?? TCP.BEACON_PORT,
			discoveryTimeoutMs: this.options.discoveryTimeoutMs ?? TCP.BEACON_TIMEOUT_MS,
		};
	}

	private startBeaconListener(): void {
		const socket = dgram.createSocket('udp4');

		socket.on('message', (msg, rinfo) => {
			const parsed = this.parseBeacon(msg.toString('utf8'), rinfo.address);
			if (!parsed) { return; }
			const key = `${parsed.ip}:${parsed.serialNumber || parsed.ip}`;
			this.beaconCache.set(key, { info: parsed, receivedAt: Date.now() });
		});

		socket.on('error', (err: NodeJS.ErrnoException) => {
			// Swallow — on Windows, UDP sockets receive spurious ICMP errors.
			// On non-recoverable bind failure (EADDRINUSE), release the reference
			// so dispose() doesn't try to close a broken socket.
			if (err.code === 'EADDRINUSE' && this.beaconSocket === socket) {
				// Nothing will ever arrive on this socket. Recording it lets discover()
				// report the transport as broken instead of returning an empty list
				// forever, which reads identically to "no bricks on the network".
				this.beaconBindError = err;
				this.beaconSocket = undefined;
				try { socket.close(); } catch { /* ignore */ }
			}
		});

		socket.bind(this.options.discoveryPort ?? TCP.BEACON_PORT);
		this.beaconSocket = socket;
	}

	private parseBeacon(message: string, senderIp: string): TcpDiscoveryInfo | undefined {
		const fields = parseBeaconMessage(message);
		if (!fields) { return undefined; }
		return { ip: senderIp, ...fields };
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new TransportError('TcpTransportProvider has been disposed.');
		}
	}
}
