/**
 * TCP transport provider — composes TcpSocketAdapter + EV3 protocol layer.
 *
 * Implements {@link TransportProvider} by combining UDP beacon discovery,
 * TCP socket communication, and the protocol layer for command encoding/response parsing.
 */

import {
	Transport, BrickKey, makeBrickKey, brickKeyId,
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, BrickCommand, BrickResponse,
	PresenceState,
} from '../contracts';
import { TransportError, ConnectionError } from '../errors/CockpitError';
import { TcpSocketAdapter, TcpAdapterOptions, TcpDiscoveryInfo, parseBeaconMessage } from './tcpSocketAdapter';
import { TCP } from './transportConstants';
import { sendCommandViaAdapter } from './protocolBridge';

import * as dgram from 'node:dgram';
import * as os from 'node:os';

/** One harmless byte, sent only to open the inbound path. */
const BEACON_PROBE = Buffer.from([0x00]);

/**
 * Derives the broadcast address for an interface, or undefined when the mask makes
 * one meaningless — a /32 as VPN adapters commonly report.
 */
function toBroadcastAddress(address: string, netmask: string): string | undefined {
	const a = address.split('.').map(Number);
	const m = netmask.split('.').map(Number);
	if (a.length !== 4 || m.length !== 4 || a.some(isNaN) || m.some(isNaN)) { return undefined; }
	if (m.every(part => part === 255)) { return undefined; }
	return a.map((part, i) => (part & m[i]) | (~m[i] & 0xff)).join('.');
}

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
	private beaconPrimeTimer?: ReturnType<typeof setInterval>;
	/** Local IPv4 addresses, so the provider ignores the echo of its own probe. */
	private readonly localAddresses = new Set<string>();
	private readonly beaconCache = new Map<string, { info: TcpDiscoveryInfo; receivedAt: number }>();
	private disposed = false;

	constructor(options?: TcpTransportProviderOptions) {
		this.options = options ?? {};
		// A provider told not to discover has no business binding the beacon port or
		// broadcasting every few seconds. It used to do both regardless.
		if (this.options.useDiscovery ?? true) {
			this.startBeaconListener();
		}
	}

	discover(): Promise<DiscoveryScanResult> {
		this.assertNotDisposed();
		if (this.beaconBindError) {
			// The port may since have been freed, so try again before giving up -- a
			// one-off collision at startup must not disable TCP discovery for the rest
			// of the session. The error still surfaces for this scan.
			const previous = this.beaconBindError;
			this.beaconBindError = undefined;
			this.startBeaconListener();
			return Promise.reject(new TransportError(
				`TCP beacon port ${this.options.discoveryPort ?? TCP.BEACON_PORT} is unavailable: `
				+ previous.message + ' (rebinding for the next scan)',
				previous
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
		if (this.beaconPrimeTimer) {
			clearInterval(this.beaconPrimeTimer);
			this.beaconPrimeTimer = undefined;
		}
		try { this.beaconSocket?.close(); } catch { /* socket may already be dead */ }
		this.beaconSocket = undefined;
		for (const [, session] of this.sessions) {
			void session.adapter.close();
		}
		this.sessions.clear();
	}

	// ── Internal ────────────────────────────────────────────────────

	private buildAdapterOptions(brickKey: BrickKey): TcpAdapterOptions {
		const identifier = brickKeyId(brickKey) ?? '';
		const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(identifier);

		// A key built from a serial carries no address, but this provider already heard
		// the beacon that named it — so answer from the cache rather than asking the
		// adapter to rediscover. It cannot: this provider holds the beacon port, so the
		// adapter's own listener would never bind, and connect failed every time a
		// brick was found by discovery rather than configured by hand.
		const cached = isIp ? undefined : this.findCachedBeacon(identifier);
		const host = isIp ? identifier : (cached?.ip ?? this.options.host ?? '');

		if (!host) {
			// Falling back to adapter-side discovery here cannot work: while this
			// provider is listening it owns the beacon port, so the adapter's own bind
			// fails with EADDRINUSE and the caller gets that instead of the real reason.
			throw new TransportError(
				`No address known for ${brickKey}. Its beacon has expired — wait for the next `
				+ 'announcement, or configure a host explicitly.'
			);
		}

		return {
			host,
			port: this.options.port ?? cached?.port ?? TCP.PORT,
			serialNumber: isIp ? '' : identifier,
			// The address is resolved, so the adapter must not try to discover again.
			useDiscovery: false,
			discoveryPort: this.options.discoveryPort ?? TCP.BEACON_PORT,
			discoveryTimeoutMs: this.options.discoveryTimeoutMs ?? TCP.BEACON_TIMEOUT_MS,
		};
	}

	private startBeaconListener(): void {
		const socket = dgram.createSocket('udp4');

		socket.on('message', (msg, rinfo) => {
			// Our own broadcast probe comes back to us; it is not a brick.
			if (this.localAddresses.has(rinfo.address)) { return; }
			const parsed = this.parseBeacon(msg.toString('utf8'), rinfo.address);
			if (!parsed) { return; }
			// Keyed by identity alone. Keying on address-and-serial meant a brick that
			// changed address appeared twice, and an address DHCP moved between bricks
			// kept the previous owner listed until its entry aged out — at which point
			// connecting the stale row opened whichever brick now holds that address.
			const key = (parsed.serialNumber || parsed.ip).toLowerCase();
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

		const port = this.options.discoveryPort ?? TCP.BEACON_PORT;
		socket.bind(port, () => {
			// dispose() may have run while the bind was still in flight. It cannot clear a
			// timer this callback has not created yet, so without this the provider would
			// leave an interval broadcasting on a closed socket for the life of the process.
			if (this.disposed) { return; }
			try { socket.setBroadcast(true); } catch { /* not fatal */ }
			this.primeBeaconPath(socket, port);
			this.beaconPrimeTimer = setInterval(
				() => this.primeBeaconPath(socket, port),
				TCP.BEACON_PRIME_INTERVAL_MS
			);
			this.beaconPrimeTimer.unref?.();
		});
		this.beaconSocket = socket;
	}

	/** Freshest cached beacon for this identity, if it is still within the window. */
	private findCachedBeacon(serialNumber: string): TcpDiscoveryInfo | undefined {
		const entry = this.beaconCache.get(serialNumber.toLowerCase());
		if (!entry) { return undefined; }
		return Date.now() - entry.receivedAt > TCP.BEACON_FRESH_MS ? undefined : entry.info;
	}

	/**
	 * Sends a one-byte datagram to each local subnet's broadcast address.
	 *
	 * The brick broadcasts its beacon every 5 seconds whether or not anyone is
	 * listening, but a host firewall filtering unsolicited inbound UDP drops it —
	 * measured on a default Windows install, where the brick was announcing the whole
	 * time and discovery saw nothing for half an hour. Sending outbound first puts
	 * this socket in the firewall's stateful table and the beacons arrive.
	 *
	 * This changes no firewall configuration; it is the ordinary outbound-then-inbound
	 * pattern any discovery client uses.
	 */
	private primeBeaconPath(socket: dgram.Socket, port: number): void {
		if (this.disposed) { return; }
		for (const target of this.broadcastTargets()) {
			socket.send(BEACON_PROBE, port, target, () => { /* best effort */ });
		}
	}

	/** Broadcast address of every non-internal IPv4 interface. */
	private broadcastTargets(): string[] {
		const targets: string[] = [];
		for (const list of Object.values(os.networkInterfaces())) {
			for (const iface of list ?? []) {
				if (iface.family !== 'IPv4' || iface.internal) { continue; }
				this.localAddresses.add(iface.address);
				const broadcast = toBroadcastAddress(iface.address, iface.netmask);
				if (broadcast) { targets.push(broadcast); }
			}
		}
		return targets;
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
