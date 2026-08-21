/**
 * USB transport provider — composes UsbHidAdapter + EV3 protocol layer.
 *
 * Implements {@link TransportProvider} by combining USB HID discovery,
 * the USB adapter for raw I/O, and the protocol layer for command encoding/response parsing.
 */

import { Transport, BrickKey, makeBrickKey, brickKeyId } from '../contracts';
import {
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, SendCommandOptions,
	PresenceState
} from '../contracts';
import { TransportError, ConnectionError } from '../errors/CockpitError';
import { UsbHidAdapter, UsbHidAdapterOptions } from './usbHidAdapter';
import { USB } from './transportConstants';
import { listLegoUsbDevices } from './usbNodeUsb';

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
	readonly capabilities: TransportCapabilities = { supportsSignalInfo: false, supportsForget: false };

	private readonly sessions = new Map<BrickKey, UsbSession>();
	private disposed = false;
	/** Guard against concurrent discover() calls overlapping on the same device. */
	private discovering = false;

	async discover(): Promise<DiscoveryScanResult> {
		this.assertNotDisposed();
		if (this.discovering) {
			return { transport: Transport.USB, items: [] };
		}
		this.discovering = true;
		try {
			return await this.doDiscover();
		} finally {
			this.discovering = false;
		}
	}

	private async doDiscover(): Promise<DiscoveryScanResult> {
		const hid = tryLoadNodeHid();
		if (!hid) {
			return { transport: Transport.USB, items: [] };
		}

		// Read product strings directly from USB hardware via libusb — bypasses Windows USB descriptor cache.
		// Falls back to dev.product (node-hid) which is correct on Linux/macOS where no cache exists.
		const nodeUsbDevices = await listLegoUsbDevices().catch(() => []);
		const nameBySerial = new Map(
			nodeUsbDevices
				.filter(d => d.serialNumber)
				.map(d => [d.serialNumber!.toLowerCase(), d.product])
		);

		const devices = hid.devices(USB.VENDOR_ID, USB.PRODUCT_ID)
			// Trim in the filter, not just at the key: makeBrickKey throws on a blank
			// identifier now, and one device with a whitespace-only serial would take the
			// entire scan down with it instead of dropping itself.
			.filter(dev => Boolean(dev.path && dev.serialNumber?.trim()));
		const now = Date.now();
		const items: DiscoveryItem[] = [];

		for (const dev of devices) {
			const serial = dev.serialNumber!.trim().toUpperCase();
			const brickKey = makeBrickKey(Transport.USB, serial);
			const displayName = nameBySerial.get(serial.toLowerCase()) ?? dev.product?.trim() ?? serial;
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

	async sendPacket(
		brickKey: BrickKey,
		packet: Uint8Array,
		options?: SendCommandOptions & { expectedMessageCounter?: number },
	): Promise<Uint8Array> {
		this.assertNotDisposed();
		const session = this.sessions.get(brickKey);
		if (!session) {
			throw new TransportError(`USB brick ${brickKey} is not connected.`);
		}
		return session.adapter.send(packet, options);
	}

	dispose(): void {
		this.disposed = true;
		for (const [, session] of this.sessions) {
			void session.adapter.close();
		}
		this.sessions.clear();
	}

	// ── Internal ────────────────────────────────────────────────────

	private extractSerial(brickKey: BrickKey): string | undefined {
		const serial = brickKeyId(brickKey);
		return serial && /^[0-9a-f]{12}$/i.test(serial) ? serial : undefined;
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new TransportError('UsbTransportProvider has been disposed.');
		}
	}
}
