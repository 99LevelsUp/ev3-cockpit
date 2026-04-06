/**
 * Bluetooth transport provider — composes BT adapters + EV3 protocol layer.
 *
 * Supports multiple BT backends with automatic fallback:
 * - WinRT StreamSocket (primary on Windows with .NET)
 * - Winsock AF_BTH RFCOMM via koffi (fallback on Windows)
 * - SPP via serialport (last resort, cross-platform)
 *
 * BT connections are serialized through {@link BtConnectionQueue} to respect
 * the Windows RFCOMM single-channel bottleneck.
 */

import {
	Transport, BrickKey, makeBrickKey,
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, BrickCommand, BrickResponse,
	PresenceState,
} from '../contracts';
import { TransportError, ConnectionError } from '../errors/CockpitError';
import { TransportAdapter } from './transportAdapter';
import { BtConnectionQueue } from './btConnectionQueue';
import { BT } from './transportConstants';
import { sendCommandViaAdapter } from './protocolBridge';

// ── BT backend types ────────────────────────────────────────────────

export type BtBackend = 'winrt' | 'winsock' | 'spp';

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
	queueRelease?: () => void;
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
	readonly capabilities: TransportCapabilities = { supportsSignalInfo: false };

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
		} catch {
			// Discovery failures are non-fatal.
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
		let queueRelease: (() => void) | undefined;
		if (this.connectionQueue) {
			queueRelease = await this.connectionQueue.acquire(mac);
		}

		try {
			const { adapter, backend } = await this.connectWithFallback(mac);
			this.sessions.set(brickKey, { adapter, backend, messageCounter: 0, queueRelease });
			this.preferredBackend.set(mac, backend);
			return { brickKey, transport: Transport.BT };
		} catch (error) {
			queueRelease?.();
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

	async send(brickKey: BrickKey, command: BrickCommand): Promise<BrickResponse> {
		this.assertNotDisposed();
		const session = this.sessions.get(brickKey);
		if (!session) {
			throw new TransportError(`BT brick ${brickKey} is not connected.`);
		}

		session.messageCounter = (session.messageCounter + 1) & 0xffff;
		return sendCommandViaAdapter(session.adapter, command, session.messageCounter, 'BT');
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

	private async connectWithFallback(mac: string): Promise<{ adapter: TransportAdapter; backend: BtBackend }> {
		if (this.backends.size === 0) {
			throw new ConnectionError('No BT backends configured.');
		}

		// Try preferred backend first if known
		const preferred = this.preferredBackend.get(mac);
		const orderedBackends = this.getOrderedBackends(preferred);

		const errors: string[] = [];
		for (const [backend, factory] of orderedBackends) {
			try {
				const adapter = factory(mac);
				await adapter.open();
				return { adapter, backend };
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				errors.push(`${backend}: ${msg}`);
			}
		}

		throw new ConnectionError(
			`All BT backends failed for ${mac}:\n${errors.join('\n')}`
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
		const parts = brickKey.split(':');
		const mac = parts.length > 1 ? parts.slice(1).join(':') : undefined;
		return mac && mac.replace(/[:-]/g, '').length >= 12 ? mac : undefined;
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new TransportError('BtTransportProvider has been disposed.');
		}
	}
}
