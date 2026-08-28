/**
 * Bluetooth transport provider — composes BT adapters + EV3 protocol layer.
 *
 * Two BT backends, in this order:
 * - Winsock2 AF_BTH RFCOMM via koffi — the testlab's chosen runtime, preferred here.
 * - SPP over the paired brick's serial port — fallback, and the only path where the
 *   FFI cannot load.
 *
 * A WinRT StreamSocket backend was once planned and is excluded: it needs a .NET helper
 * process, which the testlab ruled out for extension compatibility. See DESIGN §4.1.1.
 *
 * BT connections are serialized through {@link BtConnectionQueue} to respect
 * the Windows RFCOMM single-channel bottleneck.
 */

import {
	Transport, BrickKey, makeBrickKey, brickKeyId,
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, SendCommandOptions,
	PresenceState,
} from '../contracts';
import { TransportError, ConnectionError, BackendUnavailableError } from '../errors/CockpitError';
import { TransportAdapter } from './transportAdapter';
import { BtConnectionQueue } from './btConnectionQueue';
import { BT } from './transportConstants';

// ── BT backend types ────────────────────────────────────────────────

export type BtBackend = 'winsock' | 'spp';

/** Factory that creates a transport adapter for a specific BT backend. */
export type BtAdapterFactory = (mac: string) => TransportAdapter;

/** Discovery result for a single BT device. */
export interface BtDiscoveryDevice {
	mac: string;
	name: string;
	connected: boolean;
	remembered: boolean;
	authenticated: boolean;
}

/** Function that discovers BT devices (e.g. via koffi bthprops worker). */
export type BtDiscoveryFunction = () => Promise<BtDiscoveryDevice[]>;

// ── Session tracking ────────────────────────────────────────────────

interface BtSession {
	adapter: TransportAdapter;
	backend: BtBackend;
	messageCounter: number;
	queueRelease?: (error?: unknown) => void;
}

// ── LEGO OUI filter ─────────────────────────────────────────────────

const LEGO_OUI = BT.LEGO_OUI.toLowerCase();

function isLegoMac(mac: string): boolean {
	return mac.replace(/[:-]/g, '').toLowerCase().startsWith(LEGO_OUI);
}

/** Configuration for {@link BtTransportProvider}. */
export interface BtTransportProviderOptions {
	/** BT adapter factories keyed by backend name, in priority order. */
	backends?: Map<BtBackend, BtAdapterFactory>;
	/** Discovery function (platform-specific). */
	discoverDevices?: BtDiscoveryFunction;
	/** Connection queue (shared across BT providers). */
	connectionQueue?: BtConnectionQueue;
}

/**
 * Bluetooth transport provider.
 *
 * Supports multiple backends with automatic fallback and per-brick
 * backend preference learning.
 */
export class BtTransportProvider implements TransportProvider {
	readonly transport = Transport.BT;
	// supportsForget stays false until forget() actually unpairs at the OS level.
	// Today it disconnects and drops the preferred-backend cache entry, which leaves
	// the pairing in place -- see plan task 6.6.6.
	readonly capabilities: TransportCapabilities = { supportsSignalInfo: false, supportsForget: false };

	private readonly backends: Map<BtBackend, BtAdapterFactory>;
	private readonly discoverDevices?: BtDiscoveryFunction;
	private readonly connectionQueue?: BtConnectionQueue;
	private readonly sessions = new Map<BrickKey, BtSession>();
	private readonly preferredBackend = new Map<string, BtBackend>();
	private disposed = false;

	constructor(options?: BtTransportProviderOptions) {
		this.backends = options?.backends ?? new Map<BtBackend, BtAdapterFactory>();
		this.discoverDevices = options?.discoverDevices;
		this.connectionQueue = options?.connectionQueue;
	}

	async discover(): Promise<DiscoveryScanResult> {
		this.assertNotDisposed();
		const items: DiscoveryItem[] = [];
		const now = Date.now();

		if (!this.discoverDevices) {
			return { transport: Transport.BT, items };
		}

		try {
			const devices = await this.discoverDevices();
			for (const dev of devices) {
				if (!isLegoMac(dev.mac)) { continue; }
				const brickKey = makeBrickKey(Transport.BT, dev.mac);
				items.push({
					brickKey,
					displayName: dev.name || `EV3 [${dev.mac}]`,
					transport: Transport.BT,
					presenceState: PresenceState.Available,
					remembered: dev.remembered,
					connected: this.sessions.has(brickKey),
					favorite: false,
					availableTransports: [Transport.BT],
					lastSeenAt: now,
				});
			}
		} catch (error) {
			// Reporting an empty scan here would be a lie the scheduler acts on: it
			// would count a miss against every tracked BT brick and walk them toward
			// Unavailable, while onScanFailed stayed silent. A failed scan is not an
			// empty one.
			throw new TransportError(
				`BT discovery failed: ${error instanceof Error ? error.message : String(error)}`,
				error
			);
		}

		return { transport: Transport.BT, items };
	}

	async connect(brickKey: BrickKey): Promise<SessionHandle> {
		this.assertNotDisposed();
		if (this.sessions.has(brickKey)) {
			throw new ConnectionError(`BT brick ${brickKey} is already connected.`);
		}

		const mac = this.extractMac(brickKey);
		if (!mac) {
			throw new ConnectionError(`Cannot extract MAC address from brick key: ${brickKey}`);
		}

		// Acquire connection queue slot (serialized RFCOMM)
		let queueRelease: ((error?: unknown) => void) | undefined;
		if (this.connectionQueue) {
			queueRelease = await this.connectionQueue.acquire(mac);
		}

		try {
			const { adapter, backend } = await this.connectWithFallback(mac);
			this.sessions.set(brickKey, { adapter, backend, messageCounter: 0, queueRelease });
			this.preferredBackend.set(mac, backend);
			return { brickKey, transport: Transport.BT };
		} catch (error) {
			// Tell the queue it failed, so the next attempt waits out the longer recovery
			// rather than the ordinary gap between connections.
			queueRelease?.(error);
			throw error;
		}
	}

	async disconnect(brickKey: BrickKey): Promise<void> {
		const session = this.sessions.get(brickKey);
		if (!session) { return; }
		this.sessions.delete(brickKey);
		try {
			await session.adapter.close();
		} finally {
			session.queueRelease?.();
		}
	}

	async sendPacket(
		brickKey: BrickKey,
		packet: Uint8Array,
		options?: SendCommandOptions & { expectedMessageCounter?: number },
	): Promise<Uint8Array> {
		this.assertNotDisposed();
		const session = this.sessions.get(brickKey);
		if (!session) {
			throw new TransportError(`BT brick ${brickKey} is not connected.`);
		}
		return session.adapter.send(packet, options);
	}

	async recover(brickKey: BrickKey): Promise<SessionHandle> {
		await this.disconnect(brickKey);
		return this.connect(brickKey);
	}

	async forget(brickKey: BrickKey): Promise<void> {
		await this.disconnect(brickKey);
		const mac = this.extractMac(brickKey);
		if (mac) {
			this.preferredBackend.delete(mac);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const [, session] of this.sessions) {
			void session.adapter.close();
			session.queueRelease?.();
		}
		this.sessions.clear();
		this.connectionQueue?.dispose();
	}

	// ── Internal ────────────────────────────────────────────────────

	/**
	 * Opens the first backend that can serve this host.
	 *
	 * Falling through is **only** for a backend that could not run at all — no radio, an
	 * FFI that will not load, the wrong platform. Those never touch the air, so the next
	 * one may go immediately.
	 *
	 * A backend that did touch the air and failed ends the attempt. Windows carries one
	 * RFCOMM channel and a failed connection leaves it settling for tens of seconds, so a
	 * second backend arriving straight afterwards is the impatient retry that was deleted
	 * from `BtSppAdapter`, wearing a different name. The caller waits out the queue's error
	 * cooldown and tries again, which is where that recovery belongs.
	 */
	private async connectWithFallback(mac: string): Promise<{ adapter: TransportAdapter; backend: BtBackend }> {
		if (this.backends.size === 0) {
			throw new ConnectionError('No BT backends configured.');
		}

		const ordered = this.getOrderedBackends(this.preferredBackend.get(mac));
		const unavailable: string[] = [];

		for (const [backend, factory] of ordered) {
			try {
				const adapter = factory(mac);
				await adapter.open();
				return { adapter, backend };
			} catch (error) {
				if (!(error instanceof BackendUnavailableError)) {
					throw error;
				}
				unavailable.push(`${backend}: ${error.message}`);
			}
		}

		throw new ConnectionError(
			`No BT backend can run on this host for ${mac}: ${unavailable.join('; ')}`
		);
	}

	private getOrderedBackends(preferred?: BtBackend): Array<[BtBackend, BtAdapterFactory]> {
		const entries = [...this.backends.entries()];
		if (!preferred) {
			return entries;
		}

		// Move preferred to front
		const idx = entries.findIndex(([name]) => name === preferred);
		if (idx > 0) {
			const [entry] = entries.splice(idx, 1);
			entries.unshift(entry);
		}
		return entries;
	}

	private extractMac(brickKey: BrickKey): string | undefined {
		const mac = brickKeyId(brickKey);
		return mac && mac.replace(/[:-]/g, '').length >= 12 ? mac : undefined;
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new TransportError('BtTransportProvider has been disposed.');
		}
	}
}
