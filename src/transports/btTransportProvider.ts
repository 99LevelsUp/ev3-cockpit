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
	/**
	 * Removes the OS-level pairing.
	 *
	 * When present, `forget()` actually forgets and `capabilities.supportsForget` is true.
	 * Without it forget only drops this provider's own bookkeeping, and the brick returns
	 * on the next scan as though nothing happened.
	 */
	unpairDevice?: (mac: string) => { ok: boolean; reason?: string };
	/**
	 * How long a brick gets after its connection is closed before the next connect to it
	 * (default {@link BT.RECONNECT_GAP_AFTER_CLOSE_MS}). Per brick: other bricks are not held.
	 */
	reconnectGapAfterCloseMs?: number;
}

/**
 * Bluetooth transport provider.
 *
 * Supports multiple backends with automatic fallback and per-brick
 * backend preference learning.
 */
export class BtTransportProvider implements TransportProvider {
	readonly transport = Transport.BT;
	// supportsForget follows whether an unpair hook was supplied: without one, forget()
	// drops this provider's bookkeeping and leaves the OS pairing in place, and a brick
	// that comes straight back is worse than a button that was never offered.
	readonly capabilities: TransportCapabilities;

	private readonly backends: Map<BtBackend, BtAdapterFactory>;
	private readonly discoverDevices?: BtDiscoveryFunction;
	private readonly connectionQueue?: BtConnectionQueue;
	private readonly unpairDevice?: (mac: string) => { ok: boolean; reason?: string };
	private readonly sessions = new Map<BrickKey, BtSession>();
	private readonly preferredBackend = new Map<string, BtBackend>();
	/** When each brick's last connection was closed, by MAC. */
	private readonly closedAt = new Map<string, number>();
	private readonly reconnectGapAfterCloseMs: number;
	private disposed = false;

	constructor(options?: BtTransportProviderOptions) {
		this.backends = options?.backends ?? new Map<BtBackend, BtAdapterFactory>();
		this.discoverDevices = options?.discoverDevices;
		this.connectionQueue = options?.connectionQueue;
		this.unpairDevice = options?.unpairDevice;
		this.reconnectGapAfterCloseMs = options?.reconnectGapAfterCloseMs ?? BT.RECONNECT_GAP_AFTER_CLOSE_MS;
		this.capabilities = {
			supportsSignalInfo: false,
			supportsForget: Boolean(this.unpairDevice),
			supportsTelemetryFrames: true,
		};
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

		// The queue serialises *opening*, not holding. Measured 29.10.2026 on this host's weakest
		// adapter: two sessions to two bricks held at once answered every request, so a session
		// that kept the slot for its whole life only stopped a second brick from connecting at
		// all (step-1 plan, U3.1; scripts/bt-radio-probe.js).
		// The brick needs a moment after a close before it accepts a new link: page scan comes
		// back only once its side of the old one is torn down. Measured 29.10.2026: a connect
		// 0-2 s after a clean close failed at once with WSA 10064, and it was always that
		// sequence that started the blocked-connect collapse the Winsock adapter now avoids.
		// Waited before taking the queue slot, so other bricks are not held up by it.
		const closedAt = this.closedAt.get(mac);
		if (closedAt !== undefined) {
			const wait = closedAt + this.reconnectGapAfterCloseMs - Date.now();
			if (wait > 0) { await new Promise((resolve) => setTimeout(resolve, wait)); }
		}

		let queueRelease: ((error?: unknown) => void) | undefined;
		if (this.connectionQueue) {
			queueRelease = await this.connectionQueue.acquire(mac);
		}

		try {
			const { adapter, backend } = await this.connectWithFallback(mac);
			this.sessions.set(brickKey, { adapter, backend, messageCounter: 0 });
			this.preferredBackend.set(mac, backend);
			queueRelease?.();
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
			const mac = this.extractMac(brickKey);
			if (mac) { this.closedAt.set(mac, Date.now()); }
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

	/**
	 * Disconnects and removes the pairing, when this provider was given a way to.
	 *
	 * @throws {TransportError} When the OS refused to remove the pairing. Reported rather
	 *   than swallowed: a forget that silently left the pairing in place is what made this
	 *   capability false in the first place.
	 */
	async forget(brickKey: BrickKey): Promise<void> {
		await this.disconnect(brickKey);
		const mac = this.extractMac(brickKey);
		if (!mac) { return; }

		this.preferredBackend.delete(mac);
		if (!this.unpairDevice) { return; }

		const result = this.unpairDevice(mac);
		if (!result.ok) {
			throw new TransportError(
				`Could not forget ${mac}: ${result.reason ?? 'the operating system refused.'}`
			);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const [, session] of this.sessions) {
			void session.adapter.close();
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
