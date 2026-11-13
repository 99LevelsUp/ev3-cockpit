/**
 * USB transport provider — composes UsbHidAdapter + EV3 protocol layer.
 *
 * Implements {@link TransportProvider} by combining USB HID discovery,
 * the USB adapter for raw I/O, and the protocol layer for command encoding/response parsing.
 */

import { Transport, BrickKey, makeBrickKey, brickKeyId, describeChannel } from '../contracts';
import {
	TransportProvider, TransportCapabilities, SessionHandle,
	DiscoveryScanResult, DiscoveryItem, SendCommandOptions,
	PresenceState, ProbeLink,
} from '../contracts';
import { TransportError, ConnectionError, DevicePermissionError } from '../errors/CockpitError';
import { TransportAdapter } from './transportAdapter';
import { UsbHidAdapter, UsbHidAdapterOptions } from './usbHidAdapter';
import {
	UsbLibusbAdapter, UsbLibusbAdapterOptions, UsbDeviceLocation, LINUX_UDEV_RULE_PATH
} from './usbLibusbAdapter';
import { USB } from './transportConstants';
import { listLegoUsbDevices } from './usbNodeUsb';
import * as fs from 'fs';

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

/** `fs.accessSync` for read and write: EACCES or EPERM is a refusal. */
function defaultHidAccess(path: string): 'denied' | 'ok' | 'unknown' {
	try {
		fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK);
		return 'ok';
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unknown';
	}
}

/** Why the libusb link did not open; a refused device carries its permission error. */
interface LibusbFailure {
	readonly message: string;
	readonly permission?: DevicePermissionError;
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
	/**
	 * Injection seams for the two device enumerations discovery reads names from.
	 *
	 * Both exist because the names they return disagree, and which one wins is a decision
	 * worth testing: libusb reads the product string off the hardware, node-hid returns the
	 * Windows descriptor cache, and on this machine that cache calls two of three bricks
	 * "Xfer data to and from EV3 brick".
	 */
	listUsbDevices?: typeof listLegoUsbDevices;
	listHidDevices?: () => { path?: string; serialNumber?: string; product?: string }[];
	/** The platform whose discovery rules apply (default: this one). For tests. */
	platform?: NodeJS.Platform;
	/**
	 * Whether this user may open a hidraw node (Linux). node-hid's open failure carries no
	 * errno, so the node itself is asked. Default: `fs.accessSync` for read and write.
	 */
	hidAccess?: (path: string) => 'denied' | 'ok' | 'unknown';
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
	/** A cable means the brick is on this desk: the strongest channel there is. */
	readonly priority = 30;
	readonly capabilities: TransportCapabilities = { supportsSignalInfo: false, supportsForget: false, supportsTelemetryFrames: true };

	private readonly sessions = new Map<BrickKey, UsbSession>();

	/**
	 * Brick names read from the hardware, keyed by lower-cased serial.
	 *
	 * Kept across scans because discovery deliberately skips a brick whose interface this
	 * provider has claimed, and the only name left for such a brick is the Windows descriptor
	 * cache — which is stale. Two of the three bricks here are cached as "Xfer data to and
	 * from EV3 brick", so without this a brick renames itself to that on connect.
	 *
	 * Never cleared: a serial is a brick for good, and a name that was true once is a better
	 * answer than a name that was never true.
	 */
	private readonly nameBySerial = new Map<string, string>();
	private readonly log?: UsbProviderLog;
	private readonly makeLibusbAdapter: (options: UsbLibusbAdapterOptions) => UsbLibusbAdapter;
	private readonly makeHidAdapter: (options: UsbHidAdapterOptions) => UsbHidAdapter;
	private readonly listUsbDevices: typeof listLegoUsbDevices;
	private readonly listHidDevices?: () => { path?: string; serialNumber?: string; product?: string }[];
	private readonly platform: NodeJS.Platform;
	private readonly hidAccess: (path: string) => 'denied' | 'ok' | 'unknown';
	private disposed = false;
	/** The closes {@link disposeAsync} started, for a second caller to wait on too. */
	private disposing: Promise<void> = Promise.resolve();
	/**
	 * Probe links open now, with where each one sits. Their devices count as in use, so
	 * discovery and a connect leave them alone until they close.
	 */
	private readonly probes = new Map<UsbLibusbAdapter, UsbDeviceLocation | undefined>();
	/**
	 * Devices whose link is closing. Still in use until the close resolves: it waits for libusb
	 * to hand back transfers in flight, and opening the device meanwhile pulls the handle out
	 * from under them.
	 */
	private readonly closing = new Set<UsbDeviceLocation>();
	/** Per brick, the tail of the queue that connects and probes wait in. */
	private readonly locks = new Map<BrickKey, Promise<void>>();
	/** The tail of the queue every opening of a device waits in, whichever brick it is for. */
	private busTail: Promise<void> = Promise.resolve();
	/** Guard against concurrent discover() calls overlapping on the same device. */
	private discovering = false;

	constructor(options: UsbTransportProviderOptions = {}) {
		this.log = options.log;
		this.makeLibusbAdapter = options.createLibusbAdapter
			?? ((o) => new UsbLibusbAdapter(o));
		this.makeHidAdapter = options.createHidAdapter ?? ((o) => new UsbHidAdapter(o));
		this.listUsbDevices = options?.listUsbDevices ?? listLegoUsbDevices;
		this.listHidDevices = options?.listHidDevices;
		this.platform = options.platform ?? process.platform;
		this.hidAccess = options.hidAccess ?? defaultHidAccess;
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
		const nodeUsbDevices = await this.onBus(() => this.listUsbDevices({
			skip: (location) => this.isInUse(location),
		})).catch(() => []);

		// Remember every name libusb manages to read, because a connected brick is skipped
		// above and would otherwise fall back to the Windows cache — which is wrong on this
		// machine for two bricks out of three, calling both of them "Xfer data to and from EV3
		// brick". Without the memory a brick renames itself to that the moment anyone connects
		// to it, and back again on disconnect. Measured across a power cycle: the same brick
		// appeared as "Xfer data to and from EV3 brick" while connected and as "AAA" after.
		for (const device of nodeUsbDevices) {
			const serial = device.serialNumber?.trim().toLowerCase();
			if (serial && device.product?.trim()) {
				this.nameBySerial.set(serial, device.product.trim());
			}
		}

		const devices = (this.listHidDevices?.() ?? hid.devices(USB.VENDOR_ID, USB.PRODUCT_ID))
			// Trim in the filter, not just at the key: makeBrickKey throws on a blank
			// identifier now, and one device with a whitespace-only serial would take the
			// entire scan down with it instead of dropping itself.
			.filter(dev => Boolean(dev.path && dev.serialNumber?.trim()));
		const now = Date.now();
		const items: DiscoveryItem[] = [];

		for (const dev of devices) {
			const serial = dev.serialNumber!.trim().toUpperCase();
			const brickKey = makeBrickKey(Transport.USB, serial);
			// node-hid's product string is the last resort, not the second choice: it comes
			// from the Windows descriptor cache, which is what libusb exists here to bypass.
			const descriptorName = this.nameBySerial.get(serial.toLowerCase()) ?? dev.product?.trim();
			const displayName = descriptorName ?? serial;
			items.push({
				brickKey,
				displayName,
				// The descriptor is fixed when the cable goes in; a rename since then is not in it.
				nameSource: descriptorName ? 'usb-descriptor' : 'fallback',
				transport: Transport.USB,
				presenceState: PresenceState.Available,
				remembered: false,
				connected: this.sessions.has(brickKey),
				favorite: false,
				lastSeenAt: now,
			});
		}

		// On Linux a brick can be on the bus with no hidraw node: an extension host that died
		// holding it never gave `usbhid` back (HOSTC, 13.11.2026, reproduced by `test:host`).
		// libusb still sees it, and a libusb connect needs no driver to detach.
		if (this.platform === 'linux') {
			const seen = new Set(items.map((item) => item.brickKey));
			for (const device of nodeUsbDevices) {
				const serial = device.serialNumber?.trim().toUpperCase();
				if (!serial) { continue; }
				const brickKey = makeBrickKey(Transport.USB, serial);
				if (seen.has(brickKey)) { continue; }
				seen.add(brickKey);
				const name = this.nameBySerial.get(serial.toLowerCase()) ?? device.product?.trim();
				items.push({
					brickKey,
					displayName: name || serial,
					nameSource: name ? 'usb-descriptor' : 'fallback',
					transport: Transport.USB,
					presenceState: PresenceState.Available,
					remembered: false,
					connected: this.sessions.has(brickKey),
					favorite: false,
					lastSeenAt: now,
				});
			}
		}

		// A brick this provider holds is on the cable whatever node-hid says. On Linux the libusb
		// claim takes the interface from `usbhid`, and the brick's hidraw node goes with it, so
		// node-hid stops listing a brick the moment it is connected (HOSTC, 13.11.2026).
		// Linux only, and only while libusb still finds it at its bus address: a pulled cable
		// drops it at once rather than at the next heartbeat (review of 2dacf24). Windows lists
		// from node-hid alone, as it always has.
		const listed = new Set(items.map((item) => item.brickKey));
		const onBus = (at: UsbDeviceLocation | undefined): boolean => at !== undefined && nodeUsbDevices.some(
			(device) => device.location?.busNumber === at.busNumber && device.location?.deviceAddress === at.deviceAddress);
		for (const [brickKey, session] of this.platform === 'linux' ? this.sessions : []) {
			if (listed.has(brickKey) || !onBus(session.location)) { continue; }
			const serial = this.extractSerial(brickKey);
			const knownName = serial ? this.nameBySerial.get(serial.toLowerCase()) : undefined;
			items.push({
				brickKey,
				displayName: knownName ?? serial ?? brickKeyId(brickKey) ?? brickKey,
				nameSource: knownName ? 'usb-descriptor' : 'fallback',
				transport: Transport.USB,
				presenceState: PresenceState.Available,
				remembered: false,
				connected: true,
				favorite: false,
				lastSeenAt: now,
			});
		}

		return { transport: Transport.USB, items };
	}

	async connect(brickKey: BrickKey): Promise<SessionHandle> {
		this.assertNotDisposed();
		// Waits for a probe of this brick to close first. A connect that raced one would lose
		// the libusb claim to it and land, silently, on 64-byte HID.
		const release = await this.lock(brickKey);
		try {
			if (this.sessions.has(brickKey)) {
				throw new ConnectionError(`${describeChannel(brickKey)} is already connected.`);
			}

			const serial = this.extractSerial(brickKey);

			// libusb first: it is the only path that carries a whole EV3 frame, and `copy` and
			// `move` do not fit a HID write at all.
			const libusbFailure = await this.tryLibusb(brickKey, serial);
			if (libusbFailure === undefined) {
				return { brickKey, transport: Transport.USB };
			}
			return await this.connectOverHid(brickKey, serial, libusbFailure);
		} finally {
			release();
		}
	}

	/**
	 * Opens a libusb link outside any session, for one question such as the brick's name.
	 *
	 * The descriptor's name is fixed when the cable goes in, so a brick renamed since then
	 * shows its old name until somebody asks it (measured 29.10.2026, step-1 plan §4a). An
	 * open costs tens of milliseconds and nothing shared. libusb only: a HID probe could not
	 * carry the reply's 72 bytes in one packet, and is not worth a second path.
	 */
	async openProbe(brickKey: BrickKey): Promise<ProbeLink> {
		this.assertNotDisposed();
		const release = await this.lock(brickKey);
		let opened: UsbLibusbAdapter;
		try {
			if (this.sessions.has(brickKey)) {
				throw new ConnectionError(`${describeChannel(brickKey)} has a session; ask it instead.`);
			}
			const serial = this.extractSerial(brickKey);
			const adapter = this.makeLibusbAdapter({
				...(serial ? { serial } : {}),
				inUse: (location) => this.isInUse(location),
			});
			opened = await this.onBus(async () => {
				try {
					await adapter.open();
				} catch (error) {
					await adapter.close().catch(() => { /* nothing to unwind */ });
					throw error;
				}
				if (this.disposed) {
					// Landed after the dispose, which could not see it: give the device back.
					await adapter.close().catch(() => { /* disposing */ });
					throw new TransportError('UsbTransportProvider has been disposed.');
				}
				this.probes.set(adapter, adapter.deviceLocation);
				return adapter;
			});
		} catch (error) {
			release();
			throw error;
		}

		let closed = false;
		return {
			sendPacket: (packet, options) => opened.send(packet, options),
			close: async () => {
				if (closed) { return; }
				closed = true;
				const location = this.probes.get(opened);
				this.probes.delete(opened);
				try { await this.closeHeld(opened, location); } finally { release(); }
			},
		};
	}

	/**
	 * Runs one opening of a device alone on the bus.
	 *
	 * Finding a brick by serial opens every EV3 on the bus in turn, and so does discovery. Two
	 * of those at once, or one beside a link still opening, closed a device another probe had
	 * just claimed with a transfer in flight, and libusb's callback for it landed in freed
	 * memory: the extension host died 0.5 s after activation, when three name probes started
	 * together (30.10.2026, traced). The per-brick lock cannot see that, the bricks differ.
	 * Whatever `fn` opens must be registered as in use before it returns.
	 */
	private onBus<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.busTail.then(fn);
		this.busTail = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Closes a link, keeping its device in use until libusb has let go of it. */
	private async closeHeld(adapter: TransportAdapter, location?: UsbDeviceLocation): Promise<void> {
		if (location) { this.closing.add(location); }
		try {
			await adapter.close();
		} finally {
			if (location) { this.closing.delete(location); }
		}
	}

	/** Waits its turn among the connects and probes of one brick; resolves to a release. */
	private async lock(brickKey: BrickKey): Promise<() => void> {
		const previous = this.locks.get(brickKey) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.then(() => mine);
		this.locks.set(brickKey, tail);
		await previous;
		return () => {
			release();
			if (this.locks.get(brickKey) === tail) { this.locks.delete(brickKey); }
		};
	}

	/** Opens the libusb link, returning the failure detail rather than throwing. */
	private async tryLibusb(
		brickKey: BrickKey,
		serial: string | undefined,
	): Promise<LibusbFailure | undefined> {
		const libusb = this.makeLibusbAdapter({
			...(serial ? { serial } : {}),
			inUse: (location) => this.isInUse(location),
		});
		const failure = await this.onBus(async () => {
			try {
				await libusb.open();
			} catch (error) {
				await libusb.close().catch(() => { /* nothing to unwind */ });
				return {
					message: error instanceof Error ? error.message : String(error),
					...(error instanceof DevicePermissionError ? { permission: error } : {}),
				};
			}
			if (this.disposed) {
				// Landed after the dispose, which could not see it: give the device back.
				await libusb.close().catch(() => { /* disposing */ });
				throw new TransportError('UsbTransportProvider has been disposed.');
			}
			this.sessions.set(brickKey, {
				adapter: libusb,
				backend: 'libusb',
				location: libusb.deviceLocation,
				messageCounter: 0,
			});
			return undefined;
		});
		if (failure !== undefined) { return failure; }
		this.log?.info(
			`${describeChannel(brickKey)} connected over libusb, ${libusb.maxPacketBytes}-byte frames.`
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
		libusbFailure: LibusbFailure,
	): Promise<SessionHandle> {
		const hid = this.makeHidAdapter(
			serial ? { path: `serial:${serial.toLowerCase()}` } : {}
		);
		try {
			await hid.open();
		} catch (hidError) {
			// Name both failures: "USB connect failed" against a working brick usually
			// means the libusb claim lost to something, and only that message says so.
			const hidMessage = hidError instanceof Error ? hidError.message : String(hidError);
			// Permission from either backend, by its own code: libusb's LIBUSB_ERROR_ACCESS, and on
			// Linux the hidraw node itself. Not when that node is open to this user and HID failed
			// for another reason: then the rule is in place and something else is wrong.
			const hid = this.platform === 'linux' ? this.hidNodeAccess(serial) : 'unknown';
			if ((libusbFailure.permission || hid === 'denied') && hid !== 'ok') {
				throw new DevicePermissionError(
					`Connect failed for ${describeChannel(brickKey)}: this user may not open the EV3's USB `
					+ `device. Install the udev rule that ships with the extension, ${LINUX_UDEV_RULE_PATH} in `
					+ 'its folder: copy it to /etc/udev/rules.d/, run "sudo udevadm control --reload", then '
					+ `plug the brick in again. libusb: ${libusbFailure.message}. HID: ${hidMessage}`,
					hidError
				);
			}
			throw new ConnectionError(
				`Connect failed for ${describeChannel(brickKey)}. libusb: ${libusbFailure.message}. HID: `
				+ hidMessage,
				hidError
			);
		}
		this.sessions.set(brickKey, { adapter: hid, backend: 'hid', messageCounter: 0 });
		// Said only once the fallback has actually happened: while a cable is out, every
		// reconnect attempt fails both ways, and warning about a fallback that never came
		// filled the log with a cost nobody was paying.
		this.log?.warn(
			`${describeChannel(brickKey)}: libusb unavailable (${libusbFailure.message}). Fell back to HID, `
			+ `which delivers ${USB.MAX_WRITE_PACKET_BYTES} bytes per packet — transfers run `
			+ 'about forty times slower and copy/move cannot be sent at all.'
		);
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
		await this.closeHeld(session.adapter, session.location);
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
		void this.disposeAsync();
	}

	/**
	 * Closes every session and probe, and resolves once each has given its device back.
	 *
	 * On Linux an open libusb link holds the brick with `usbhid` detached, and only its release
	 * gives the driver back. The synchronous {@link dispose} starts the closes and returns, and an
	 * extension host that exits right after leaves the brick with no driver (HOSTC, 13.11.2026:
	 * one brick after every `npm run test:host`). A deactivate that awaits this does not.
	 */
	async disposeAsync(): Promise<void> {
		if (this.disposed) { return this.disposing; }
		this.disposed = true;
		const closes: Promise<void>[] = [];
		for (const [, session] of this.sessions) {
			closes.push(this.closeHeld(session.adapter, session.location).catch(() => { /* disposing */ }));
		}
		this.sessions.clear();
		// Probes too: one left open is a brick left without its driver.
		for (const [probe, location] of this.probes) {
			closes.push(this.closeHeld(probe, location).catch(() => { /* disposing */ }));
		}
		this.probes.clear();
		this.disposing = Promise.all(closes).then(() => undefined);
		return this.disposing;
	}

	// ── Internal ────────────────────────────────────────────────────

	/** Whether this user may open the brick's hidraw node, found by its serial. */
	private hidNodeAccess(serial: string | undefined): 'denied' | 'ok' | 'unknown' {
		if (!serial) { return 'unknown'; }
		const devices = this.listHidDevices?.() ?? tryLoadNodeHid()?.devices(USB.VENDOR_ID, USB.PRODUCT_ID) ?? [];
		const path = devices.find((device) => device.serialNumber?.trim().toUpperCase() === serial.toUpperCase())?.path;
		return path ? this.hidAccess(path) : 'unknown';
	}

	/** Whether a session, an open probe or a closing link holds the device at this bus address. */
	private isInUse(location: { busNumber: number; deviceAddress: number }): boolean {
		const held = [
			...[...this.sessions.values()].map((session) => session.location),
			...this.probes.values(),
			...this.closing,
		];
		return held.some((at) => at !== undefined
			&& at.busNumber === location.busNumber
			&& at.deviceAddress === location.deviceAddress);
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
