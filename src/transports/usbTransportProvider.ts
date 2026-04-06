/**
 * USB transport provider — composes UsbHidAdapter + EV3 protocol layer.
 *
 * Implements {@link TransportProvider} by combining USB HID discovery,
 * the USB adapter for raw I/O, and the protocol layer for command encoding/response parsing.
 */

import { Transport, BrickKey, makeBrickKey } from '../contracts';
import {
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, BrickCommand, BrickResponse,
	PresenceState
} from '../contracts';
import { TransportError, ConnectionError } from '../errors/CockpitError';
import { UsbHidAdapter, UsbHidAdapterOptions } from './usbHidAdapter';
import { USB } from './transportConstants';
import { sendCommandViaAdapter } from './protocolBridge';

// ── node-hid discovery (duck-typed) ─────────────────────────────────

interface HidDeviceInfo {
	path?: string;
	vendorId?: number;
	productId?: number;
	serialNumber?: string;
	product?: string;
}

interface NodeHidModule {
	devices(vendorId?: number, productId?: number): HidDeviceInfo[];
}

function tryLoadNodeHid(): NodeHidModule | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('node-hid') as Partial<NodeHidModule>;
		if (typeof mod?.devices === 'function') {
			return mod as NodeHidModule;
		}
	} catch {
		// node-hid is optional
	}
	return undefined;
}

// ── Generic USB product names that don't reflect the brick's real name ──

const GENERIC_PRODUCT_NAMES = new Set([
	'Xfer data to and from EV3 brick',
]);

/** Timeout for a single name-resolution probe (ms). */
const NAME_PROBE_TIMEOUT_MS = 1500;

// ── Session tracking ────────────────────────────────────────────────

interface UsbSession {
	adapter: UsbHidAdapter;
	messageCounter: number;
}

/**
 * USB HID transport provider.
 */
export class UsbTransportProvider implements TransportProvider {
	readonly transport = Transport.USB;
	readonly capabilities: TransportCapabilities = { supportsSignalInfo: false };

	private readonly sessions = new Map<BrickKey, UsbSession>();
	/** Last known display name per serial — shown while a new probe is in flight. */
	private readonly lastKnownNames = new Map<string, string>();
	/** Serials currently being probed — prevents concurrent probes for the same brick. */
	private readonly probing = new Set<string>();
	private disposed = false;

	async discover(): Promise<DiscoveryScanResult> {
		this.assertNotDisposed();
		const hid = tryLoadNodeHid();
		if (!hid) {
			return { transport: Transport.USB, items: [] };
		}

		const devices = hid.devices(USB.VENDOR_ID, USB.PRODUCT_ID);
		const items: DiscoveryItem[] = [];
		const now = Date.now();

		for (const dev of devices) {
			if (!dev.path) { continue; }
			const serial = dev.serialNumber?.trim().toUpperCase() || dev.path;
			const serialLower = serial.toLowerCase();
			const brickKey = makeBrickKey(Transport.USB, serial);

			let displayName: string;
			if (!GENERIC_PRODUCT_NAMES.has(dev.product ?? '')) {
				// USB descriptor already contains the real brick name
				displayName = dev.product || `EV3 [${serial}]`;
			} else if (this.probing.has(serialLower)) {
				// Probe already in flight from a previous scan cycle —
				// show last known name, or skip entirely if this brick was never seen before
				if (!this.lastKnownNames.has(serialLower)) { continue; }
				displayName = this.lastKnownNames.get(serialLower)!;
			} else if (this.sessions.has(brickKey)) {
				// Brick is connected — session manager owns the current name
				displayName = this.lastKnownNames.get(serialLower) ?? `EV3 [${serial}]`;
			} else {
				// Probe the brick to get its real name
				displayName = await this.probeDisplayName(dev.path, serialLower) ?? `EV3 [${serial}]`;
			}

			items.push({
				brickKey,
				displayName,
				transport: Transport.USB,
				presenceState: PresenceState.Available,
				remembered: false,
				connected: this.sessions.has(brickKey),
				favorite: false,
				availableTransports: [Transport.USB],
				lastSeenAt: now,
			});
		}

		return { transport: Transport.USB, items };
	}

	async connect(brickKey: BrickKey): Promise<SessionHandle> {
		this.assertNotDisposed();
		if (this.sessions.has(brickKey)) {
			throw new ConnectionError(`USB brick ${brickKey} is already connected.`);
		}

		const serial = this.extractSerial(brickKey);
		const options: UsbHidAdapterOptions = serial
			? { path: `serial:${serial.toLowerCase()}` }
			: {};

		const adapter = new UsbHidAdapter(options);
		try {
			await adapter.open();
		} catch (error) {
			throw new ConnectionError(
				`USB connect failed for ${brickKey}: ${error instanceof Error ? error.message : String(error)}`,
				error
			);
		}

		this.sessions.set(brickKey, { adapter, messageCounter: 0 });
		return { brickKey, transport: Transport.USB };
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
			throw new TransportError(`USB brick ${brickKey} is not connected.`);
		}

		session.messageCounter = (session.messageCounter + 1) & 0xffff;
		return sendCommandViaAdapter(session.adapter, command, session.messageCounter, 'USB');
	}

	dispose(): void {
		this.disposed = true;
		for (const [, session] of this.sessions) {
			void session.adapter.close();
		}
		this.sessions.clear();
	}

	// ── Internal ────────────────────────────────────────────────────

	/**
	 * Opens the HID device briefly, sends an `info` command, and caches the
	 * brick's configured display name. The device is closed immediately after.
	 * The brick remains `available` (not connected) from the caller's perspective.
	 */
	private async probeDisplayName(path: string, serialLower: string): Promise<string | undefined> {
		this.probing.add(serialLower);
		const adapter = new UsbHidAdapter({ path: `serial:${serialLower}` });
		try {
			const timeoutSignal = AbortSignal.timeout(NAME_PROBE_TIMEOUT_MS);
			await adapter.open();
			const response = await Promise.race([
				sendCommandViaAdapter(adapter, { kind: 'info' }, 1, 'USB-probe'),
				new Promise<never>((_, reject) =>
					timeoutSignal.addEventListener('abort', () => reject(new Error('probe timeout')), { once: true })
				),
			]);
			if (response.kind === 'info' && response.displayName) {
				this.lastKnownNames.set(serialLower, response.displayName);
				return response.displayName;
			}
		} catch {
			// Probe failed — caller falls back to serial-based name
		} finally {
			await adapter.close().catch(() => { /* best-effort close */ });
			this.probing.delete(serialLower);
		}
		return undefined;
	}

	private extractSerial(brickKey: BrickKey): string | undefined {
		const parts = brickKey.split(':');
		const serial = parts.length > 1 ? parts.slice(1).join(':') : undefined;
		return serial && /^[0-9a-f]{12}$/i.test(serial) ? serial : undefined;
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new TransportError('UsbTransportProvider has been disposed.');
		}
	}
}
