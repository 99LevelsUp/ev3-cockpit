/**
 * TCP transport provider — composes TcpSocketAdapter + EV3 protocol layer.
 *
 * Implements {@link TransportProvider} by combining UDP beacon discovery,
 * TCP socket communication, and the protocol layer for command encoding/response parsing.
 */

import {
	Transport, BrickKey, makeBrickKey, brickKeyId,
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, SendCommandOptions,
	PresenceState, describeChannel,
} from '../contracts';
import { TransportError, ConnectionError } from '../errors/CockpitError';
import { TcpSocketAdapter, TcpAdapterOptions, TcpDiscoveryInfo, parseBeaconMessage } from './tcpSocketAdapter';
import { TCP } from './transportConstants';

import * as dgram from 'node:dgram';
import * as os from 'node:os';

/** One harmless byte, sent only to open the inbound path. */
const BEACON_PROBE = Buffer.from([0x00]);

/**
 * Derives the broadcast address for an interface, or undefined when the mask makes
 * one meaningless — a /32 as VPN adapters commonly report.
 */
export function toBroadcastAddress(address: string, netmask: string): string | undefined {
	const a = address.split('.').map(Number);
	const m = netmask.split('.').map(Number);
	if (a.length !== 4 || m.length !== 4 || a.some(isNaN) || m.some(isNaN)) { return undefined; }
	// /32 has no broadcast address, and an all-zero mask would produce the limited
	// broadcast 255.255.255.255 — some tunnel adapters report 0.0.0.0 while connecting,
	// and blasting every attached network is not what this is for.
	if (m.every(part => part === 255)) { return undefined; }
	if (m.every(part => part === 0)) { return undefined; }
	// Narrower than /8 keeps the probe on plausible LAN segments.
	if (m[0] !== 255) { return undefined; }
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
	/**
	 * Enable UDP beacon discovery (default: true).
	 *
	 * When false the provider binds nothing and broadcasts nothing, and `discover()`
	 * rejects with a `TransportError` naming that. It deliberately does not resolve
	 * with an empty list: that reads identically to "no bricks on this network" and
	 * would leave the scheduler polling a provider that can never answer.
	 */
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
	/** Wi-Fi is the slowest and least steady link the brick has. */
	readonly priority = 10;
	readonly capabilities: TransportCapabilities = { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: true };

	private readonly options: TcpTransportProviderOptions;
	private readonly sessions = new Map<BrickKey, TcpSession>();
	private beaconSocket?: dgram.Socket;
	private beaconBindError?: Error;
	private beaconPrimeTimer?: ReturnType<typeof setInterval>;
	private beaconSocketReady = false;
	private lastScanAt = 0;
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
		if (this.options.useDiscovery === false) {
			// Say so rather than resolving empty. A caller cannot tell silence from an
			// empty network, and the scheduler would keep scanning a provider that has
			// nothing listening — the same ambiguity the bind-failure branch below fixes.
			return Promise.reject(new TransportError(
				'TCP discovery is disabled for this provider (useDiscovery: false), so no '
				+ 'beacon listener is bound. Connect by host instead, or construct the '
				+ 'provider with discovery enabled.'
			));
		}
		// Priming starts on the first scan and stops once scanning does. Running it from
		// construction meant every window held inbound UDP 3015 open on every attached
		// network for the whole session, whether or not anyone was looking for a brick.
		this.ensureBeaconPriming();
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
				// The beacon follows a rename within seconds (measured 29.10.2026).
				nameSource: info.name ? 'beacon' : 'fallback',
				transport: Transport.TCP,
				presenceState: PresenceState.Available,
				remembered: false,
				connected: this.sessions.has(brickKey),
				favorite: false,
				lastSeenAt: entry.receivedAt,
			});
		}

		return Promise.resolve({ transport: Transport.TCP, items });
	}

	async connect(brickKey: BrickKey): Promise<SessionHandle> {
		this.assertNotDisposed();
		if (this.sessions.has(brickKey)) {
			throw new ConnectionError(`${describeChannel(brickKey)} is already connected.`);
		}

		const adapterOptions = this.buildAdapterOptions(brickKey);
		const adapter = new TcpSocketAdapter(adapterOptions);
		try {
			await adapter.open();
		} catch (error) {
			throw new ConnectionError(
				`Connect failed for ${describeChannel(brickKey)}: ${error instanceof Error ? error.message : String(error)}`,
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

	async sendPacket(
		brickKey: BrickKey,
		packet: Uint8Array,
		options?: SendCommandOptions & { expectedMessageCounter?: number },
	): Promise<Uint8Array> {
		this.assertNotDisposed();
		const session = this.sessions.get(brickKey);
		if (!session) {
			throw new TransportError(`${describeChannel(brickKey)} is not connected.`);
		}
		return session.adapter.send(packet, options);
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
			throw new ConnectionError(
				`No address known for ${describeChannel(brickKey)}. Its beacon has expired — wait for the next `
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
			this.acceptBeacon(parsed);
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
			this.beaconSocketReady = true;
		});
		this.beaconSocket = socket;
	}

	/**
	 * Records a beacon, treating its contents as untrusted.
	 *
	 * Everything here arrived in a datagram anyone on the subnet can send, and
	 * `connect()` later takes both the address and the port from this cache. So a
	 * forged announcement claiming a real brick's serial would decide where a user's
	 * "connect to my brick" actually goes, and the VMTP unlock handshake authenticates
	 * nothing that would catch it. Three rules follow:
	 *
	 * - the serial must look like an EV3's (12 hex digits, which is its BT MAC), so
	 *   arbitrary strings cannot occupy the identity space;
	 * - a still-fresh identity is never silently repointed at a different address —
	 *   the incumbent wins and the conflict is recorded, because the alternative is
	 *   last-writer-wins on an attacker-chosen key;
	 * - the map is capped, or one datagram per invented serial fills it.
	 *
	 * This is defence in depth, not a complete answer: identity is still unverified
	 * until a session checks `COM_GET / GET_ID` against the serial it asked for.
	 */
	private acceptBeacon(info: TcpDiscoveryInfo): void {
		const serial = (info.serialNumber ?? '').toLowerCase();
		if (!/^[0-9a-f]{12}$/.test(serial)) {
			return;
		}

		const existing = this.beaconCache.get(serial);
		const now = Date.now();
		if (existing && now - existing.receivedAt <= TCP.BEACON_FRESH_MS
			&& existing.info.ip !== info.ip) {
			this.beaconConflicts.set(serial, now);
			return;
		}

		if (!existing && this.beaconCache.size >= TCP.BEACON_CACHE_MAX) {
			let oldestKey: string | undefined;
			let oldestAt = Infinity;
			for (const [k, v] of this.beaconCache) {
				if (v.receivedAt < oldestAt) { oldestAt = v.receivedAt; oldestKey = k; }
			}
			if (oldestKey !== undefined) { this.beaconCache.delete(oldestKey); }
		}

		this.beaconCache.set(serial, { info, receivedAt: now });
	}

	/**
	 * Serials seen announcing from more than one address while both claims were fresh,
	 * against the time we saw the clash.
	 *
	 * Timestamped rather than a bare set: a brick that takes a new DHCP lease inside
	 * the freshness window looks exactly like a spoof, and a conflict that never
	 * expired would make an ordinary lease renewal take that brick permanently out of
	 * service. It expires on the same clock as the cache entry that caused it.
	 */
	private readonly beaconConflicts = new Map<string, number>();

	/** Freshest cached beacon for this identity, if it is still within the window. */
	private findCachedBeacon(serialNumber: string): TcpDiscoveryInfo | undefined {
		const key = serialNumber.toLowerCase();
		// Two addresses claimed this identity, so we cannot tell which is the brick —
		// but only while the clash is recent. Past the freshness window the older claim
		// would have expired from the cache anyway, and holding the conflict beyond it
		// would keep a re-addressed brick unreachable for the provider's whole life.
		const conflictAt = this.beaconConflicts.get(key);
		if (conflictAt !== undefined) {
			if (Date.now() - conflictAt <= TCP.BEACON_FRESH_MS) { return undefined; }
			this.beaconConflicts.delete(key);
		}
		const entry = this.beaconCache.get(key);
		if (!entry) { return undefined; }
		return Date.now() - entry.receivedAt > TCP.BEACON_FRESH_MS ? undefined : entry.info;
	}

	/**
	 * Starts the prime loop on demand, and lets it lapse when scanning stops.
	 *
	 * The loop exists to keep the host firewall's inbound mapping open, so running it
	 * unconditionally from construction also keeps port 3015 reachable from every host
	 * on every attached subnet for as long as the editor is open. Tying it to actual
	 * discovery bounds that exposure to the time a user is genuinely looking.
	 */
	private ensureBeaconPriming(): void {
		this.lastScanAt = Date.now();
		const socket = this.beaconSocket;
		if (!socket || !this.beaconSocketReady || this.beaconPrimeTimer) { return; }

		const port = this.options.discoveryPort ?? TCP.BEACON_PORT;
		this.primeBeaconPath(socket, port);
		this.beaconPrimeTimer = setInterval(() => {
			if (Date.now() - this.lastScanAt > TCP.BEACON_FRESH_MS) {
				if (this.beaconPrimeTimer) {
					clearInterval(this.beaconPrimeTimer);
					this.beaconPrimeTimer = undefined;
				}
				return;
			}
			this.primeBeaconPath(socket, port);
		}, TCP.BEACON_PRIME_INTERVAL_MS);
		this.beaconPrimeTimer.unref?.();
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
