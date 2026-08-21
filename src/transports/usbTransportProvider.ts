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
import { TransportAdapter } from './transportAdapter';
import { UsbHidAdapter, UsbHidAdapterOptions } from './usbHidAdapter';
import {
	UsbLibusbAdapter, UsbLibusbAdapterOptions, UsbDeviceLocation
} from './usbLibusbAdapter';
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

/** Which wire a session ended up on. Reported, because the two are not equivalent. */
export type UsbBackend = 'libusb' | 'hid';

interface UsbSession {
	adapter: TransportAdapter;
	backend: UsbBackend;
	/** Set for libusb sessions, so discovery can leave a claimed device alone. */
	location?: UsbDeviceLocation;
	messageCounter: number;
}

/** Somewhere to report a backend choice. A `vscode.LogOutputChannel` satisfies this. */
export interface UsbProviderLog {
	info(message: string): void;
	warn(message: string): void;
}

/** Construction options for {@link UsbTransportProvider}. */
export interface UsbTransportProviderOptions {
	/** Where to report which backend a connection ended up on, and why. */
	log?: UsbProviderLog;
	/** Injection seam for tests, which have no brick on the bus. */
	createLibusbAdapter?: (options: UsbLibusbAdapterOptions) => UsbLibusbAdapter;
	/** Injection seam for tests. */
	createHidAdapter?: (options: UsbHidAdapterOptions) => UsbHidAdapter;
}

/**
 * USB transport provider.
 *
 * Discovery enumerates over HID, which needs no handle on the device. A connection
 * prefers libusb, which reaches the brick's full 1024-byte frame, and falls back to HID
 * — loudly — when libusb cannot claim the interface.
 */
export class UsbTransportProvider implements TransportProvider {
	readonly transport = Transport.USB;
	readonly capabilities: TransportCapabilities = { supportsSignalInfo: false, supportsForget: false };

	private readonly sessions = new Map<BrickKey, UsbSession>();
	private readonly log?: UsbProviderLog;
	private readonly makeLibusbAdapter: (options: UsbLibusbAdapterOptions) => UsbLibusbAdapter;
	private readonly makeHidAdapter: (options: UsbHidAdapterOptions) => UsbHidAdapter;
	private disposed = false;
	/** Guard against concurrent discover() calls overlapping on the same device. */
	private discovering = false;

	constructor(options: UsbTransportProviderOptions = {}) {
		this.log = options.log;
		this.makeLibusbAdapter = options.createLibusbAdapter
			?? ((o) => new UsbLibusbAdapter(o));
		this.makeHidAdapter = options.createHidAdapter ?? ((o) => new UsbHidAdapter(o));
	}

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
		//
		// A brick with a live libusb session is skipped rather than reopened: discovery runs
		// on a 1.2 s timer and would otherwise be prying at a device its own transport holds
		// claimed. Such a brick keeps the HID product string, which is what it had before.
		const nodeUsbDevices = await listLegoUsbDevices({
			skip: (location) => this.isInUse(location),
		}).catch(() => []);
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

		// libusb first: it is the only path that carries a whole EV3 frame, and `copy` and
		// `move` do not fit a HID write at all.
		const libusbFailure = await this.tryLibusb(brickKey, serial);
		if (!libusbFailure) {
			return { brickKey, transport: Transport.USB };
		}
		return this.connectOverHid(brickKey, serial, libusbFailure);
	}

	/** Opens the libusb link, returning the failure detail rather than throwing. */
	private async tryLibusb(
		brickKey: BrickKey,
		serial: string | undefined,
	): Promise<string | undefined> {
		const libusb = this.makeLibusbAdapter({
			...(serial ? { serial } : {}),
			inUse: (location) => this.isInUse(location),
		});
		try {
			await libusb.open();
		} catch (error) {
			await libusb.close().catch(() => { /* nothing to unwind */ });
			return error instanceof Error ? error.message : String(error);
		}
		this.sessions.set(brickKey, {
			adapter: libusb,
			backend: 'libusb',
			location: libusb.deviceLocation,
			messageCounter: 0,
		});
		this.log?.info(
			`USB ${brickKey} connected over libusb, ${libusb.maxPacketBytes}-byte frames.`
		);
		return undefined;
	}

	/**
	 * Falls back to the HID link, which works but is not equivalent.
	 *
	 * Announced rather than silent: on this path transfers run about forty times slower
	 * and two-path commands cannot be expressed at all.
	 */
	private async connectOverHid(
		brickKey: BrickKey,
		serial: string | undefined,
		libusbFailure: string,
	): Promise<SessionHandle> {
		this.log?.warn(
			`USB ${brickKey}: libusb unavailable (${libusbFailure}). Falling back to HID, `
			+ `which delivers ${USB.MAX_WRITE_PACKET_BYTES} bytes per packet — transfers run `
			+ 'about forty times slower and copy/move cannot be sent at all.'
		);

		const hid = this.makeHidAdapter(
			serial ? { path: `serial:${serial.toLowerCase()}` } : {}
		);
		try {
			await hid.open();
		} catch (hidError) {
			// Name both failures: "USB connect failed" against a working brick usually
			// means the libusb claim lost to something, and only that message says so.
			throw new ConnectionError(
				`USB connect failed for ${brickKey}. libusb: ${libusbFailure}. HID: `
				+ `${hidError instanceof Error ? hidError.message : String(hidError)}`,
				hidError
			);
		}
		this.sessions.set(brickKey, { adapter: hid, backend: 'hid', messageCounter: 0 });
		return { brickKey, transport: Transport.USB };
	}

	/**
	 * Largest packet the live link to this brick carries.
	 *
	 * Read from the session rather than from the transport, because the answer depends on
	 * which backend the connection landed on.
	 */
	maxPacketBytes(brickKey: BrickKey): number | undefined {
		return this.sessions.get(brickKey)?.adapter.maxPacketBytes;
	}

	/** Which wire this brick is connected over, for diagnostics. */
	backendFor(brickKey: BrickKey): UsbBackend | undefined {
		return this.sessions.get(brickKey)?.backend;
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

	/** Whether a session already holds the device at this bus address. */
	private isInUse(location: { busNumber: number; deviceAddress: number }): boolean {
		for (const session of this.sessions.values()) {
			if (session.location
				&& session.location.busNumber === location.busNumber
				&& session.location.deviceAddress === location.deviceAddress) {
				return true;
			}
		}
		return false;
	}

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
