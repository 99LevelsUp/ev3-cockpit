/**
 * USB transport adapter that talks to the brick's interrupt endpoints through libusb.
 *
 * This exists because the HID path cannot carry a full EV3 frame. The brick's own HID
 * report descriptor declares `Report Count 0` for both reports, so Windows derives no
 * usable report length and a write delivers 64 bytes whatever it is handed — while the
 * interrupt endpoints underneath advertise `wMaxPacketSize` 1024. Going straight at the
 * endpoints reaches the firmware's real frame.
 *
 * One measured quirk shapes the whole adapter: a transfer must be **exactly**
 * `wMaxPacketSize`. A 16-byte write fails with `LIBUSB_ERROR_IO`; the same packet padded
 * to 1024 succeeds. Reads come back full-length too, so a reply is located by its own
 * length prefix rather than by the size of the transfer that carried it.
 */

import { TransportAdapter, SendOptions, OpenOptions } from './transportAdapter';
import { TransportError, TimeoutError, DevicePermissionError } from '../errors/CockpitError';
import { extractLengthPrefixedPacket } from '../protocol/ev3Packet';
import { getMessageCounter } from './pendingReply';
import { USB } from './transportConstants';

// ── node-usb interfaces (duck-typed so the native module stays optional) ──

interface UsbEndpointDescriptor {
	bEndpointAddress: number;
	bmAttributes: number;
	wMaxPacketSize: number;
}

interface UsbEndpointLike {
	direction: 'in' | 'out';
	descriptor: UsbEndpointDescriptor;
	timeout: number;
	/** Resets the endpoint's halt and data toggle on both ends (CLEAR_FEATURE ENDPOINT_HALT). */
	clearHalt?(callback: (error?: Error) => void): void;
	transfer(
		lengthOrData: number | Buffer,
		callback: (error: Error | undefined, data?: Buffer) => void,
	): void;
}

interface UsbInterfaceLike {
	endpoints: UsbEndpointLike[];
	claim(): void;
	release(closeEndpoints: boolean, callback: (error?: Error) => void): void;
	/** Linux: whether a kernel driver (an EV3's is `usbhid`) holds the interface. */
	isKernelDriverActive?(): boolean;
	detachKernelDriver?(): void;
	attachKernelDriver?(): void;
}

interface UsbDeviceLike {
	deviceDescriptor: { idVendor: number; idProduct: number; iSerialNumber: number };
	busNumber: number;
	deviceAddress: number;
	open(): void;
	close(): void;
	interface(index: number): UsbInterfaceLike;
	getStringDescriptor(
		index: number,
		callback: (error: Error | undefined, value?: string) => void,
	): void;
	/**
	 * libusb's auto-detach: the claim detaches the kernel driver and the release gives it back.
	 * Not on every platform libusb supports, so optional.
	 */
	setAutoDetachKernelDriver?(enable: boolean): void;
}

interface UsbModuleLike {
	getDeviceList(): UsbDeviceLike[];
}

/** Where a device sits on the bus. Identifies it without reading its serial number. */
export interface UsbDeviceLocation {
	readonly busNumber: number;
	readonly deviceAddress: number;
}

/** Configuration options for {@link UsbLibusbAdapter}. */
export interface UsbLibusbAdapterOptions {
	/** Brick serial to connect to. Omitted means the first EV3 on the bus. */
	serial?: string;
	/** USB vendor ID (default: LEGO 0x0694). */
	vendorId?: number;
	/** USB product ID (default: EV3 0x0005). */
	productId?: number;
	/** Interface to claim (default: 0, the HID-class interface carrying the channel). */
	interfaceNumber?: number;
	/**
	 * Devices another session already holds, which must not be opened while searching.
	 *
	 * Resolving a serial means opening the device to read its string descriptor, and libusb
	 * hands out one handle per device: opening and closing an already-claimed brick drops
	 * that handle and every later transfer on it fails with "Device is not open". Verified
	 * on hardware — connecting a second brick killed the first.
	 */
	inUse?: (location: UsbDeviceLocation) => boolean;
	/**
	 * Bytes asked for on top of the frame in every read. Defaults to {@link READ_OVERRUN_SLACK}
	 * for this platform; tests set it to pin one behaviour.
	 */
	readSlackBytes?: number;
	/** Injection seam for tests, which have no brick to enumerate. */
	moduleLoader?: () => UsbModuleLike;
	/** The platform whose kernel-driver rules apply (default: this one). For tests. */
	platform?: NodeJS.Platform;
}

/** Endpoint transfer type as encoded in `bmAttributes`. */
const TRANSFER_TYPE_INTERRUPT = 0x03;

/** How many stale replies to step over before declaring the channel desynchronised. */
const MAX_STALE_REPLIES = 4;

/**
 * Longest `close` waits for libusb to hand back transfers still in flight (ms). libusb calls each
 * back by its endpoint timeout, the send budget; this only bounds a transfer sent without one.
 */
const CLOSE_DRAIN_MAX_MS = 3000;

/**
 * One byte more than the frame on every read, on Windows only.
 *
 * libusb reaches the brick on Windows through its HID backend, which reads the report id
 * along with the data and then copies the whole report — id byte included in the count —
 * into the caller's buffer from one byte in: a 1024-byte read reports 1025 and writes one
 * byte past the end. Measured 20 reads out of 20 (30.10.2026). Under Node the byte landed in
 * slack and nobody saw it; in the extension host it hit memory that was not there and took
 * the host down with an access violation, at random, often 0.5 s after activation. Asking for
 * 1025 gives that byte somewhere to land, and the reply is found by its length prefix anyway.
 *
 * Not elsewhere: there libusb reads the endpoint itself, a full 1024-byte packet is not a
 * short one, and a 1025-byte read would sit waiting for more until it timed out.
 */
const READ_OVERRUN_SLACK = process.platform === 'win32' ? 1 : 0;

function loadUsbModule(): UsbModuleLike {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('usb') as Partial<UsbModuleLike>;
		if (!mod || typeof mod.getDeviceList !== 'function') {
			throw new Error('Invalid usb module shape.');
		}
		return mod as UsbModuleLike;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new TransportError(`USB libusb transport requires package "usb". (${detail})`);
	}
}

// Every libusb failure here surfaces as a TransportError, which is what the heartbeat
// already counts as link loss — it treats anything that is not a ProtocolError as a lost
// link. A second classifier for LIBUSB_ERROR_* codes would be a rule with no reader.

/**
 * Frees the interface from a kernel driver before the claim (Linux only).
 *
 * The kernel's `usbhid` binds an EV3's interface 0, so a bare claim fails with
 * LIBUSB_ERROR_BUSY and the connect lands on 64-byte HID (HOSTC, 13.11.2026, all three bricks).
 * Detaching needs no root. libusb's auto-detach is preferred: the release then gives the driver
 * back by itself. Without it the driver is detached by hand, and the caller gives it back.
 *
 * @returns true when it detached by hand, so the caller must reattach after the release.
 */
function freeFromKernelDriver(device: UsbDeviceLike, iface: UsbInterfaceLike): boolean {
	if (device.setAutoDetachKernelDriver) {
		try {
			device.setAutoDetachKernelDriver(true);
			return false;
		} catch {
			// This libusb build cannot; detach by hand below.
		}
	}
	if (iface.isKernelDriverActive?.() && iface.detachKernelDriver) {
		iface.detachKernelDriver();
		return true;
	}
	return false;
}

/** Gives the kernel driver back after a hand detach. A brick already unplugged has none to take. */
function reattachKernelDriver(iface: UsbInterfaceLike): void {
	try {
		iface.attachKernelDriver?.();
	} catch {
		// Gone with the device; the kernel binds a fresh one when it is plugged back in.
	}
}

/**
 * Clears an endpoint after the claim (Linux only).
 *
 * Taking the interface from `usbhid` leaves the interrupt endpoints' data toggle out of step
 * with the brick's, and the first reply after every detach was dropped as a duplicate: the
 * first exchange of each connect timed out and the second worked (HOSTC, 13.11.2026, all three
 * bricks). A clear-halt resets the toggle on both ends. Best effort: a brick that refuses it is
 * still worth trying.
 */
/** Longest one clear-halt may take before the open goes on without it (ms). */
const CLEAR_HALT_MAX_MS = 1000;

/** The udev rule the extension ships, relative to its install folder. */
export const LINUX_UDEV_RULE_PATH = 'native/linux/70-lego-ev3.rules';

/** libusb's refusal to open a device for this user. */
function isAccessDenied(error: unknown): boolean {
	return /LIBUSB_ERROR_ACCESS|EACCES/.test(error instanceof Error ? error.message : String(error));
}

/** What a Linux user without the udev rule reads, with what to do about it. */
function linuxPermissionError(detail: string, cause?: unknown): DevicePermissionError {
	return new DevicePermissionError(
		`This user may not open the EV3's USB device (${detail}). Install the udev rule that ships `
		+ `with the extension, ${LINUX_UDEV_RULE_PATH} in its folder: copy it to /etc/udev/rules.d/, `
		+ 'run "sudo udevadm control --reload", then plug the brick in again.',
		cause,
	);
}

function readStringDescriptor(device: UsbDeviceLike, index: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			device.getStringDescriptor(index, (error, value) => {
				resolve(error ? undefined : value?.trim());
			});
		} catch {
			resolve(undefined);
		}
	});
}

/**
 * Transport adapter that communicates with an EV3 brick over libusb interrupt transfers.
 *
 * Reaches the firmware's full 1024-byte frame, which the HID path cannot: `copy` and
 * `move` carry two paths and do not fit 64 bytes at all, and bulk transfer runs about
 * forty times faster.
 */
export class UsbLibusbAdapter implements TransportAdapter {
	private readonly serial?: string;
	private readonly vendorId: number;
	private readonly productId: number;
	private readonly interfaceNumber: number;
	private readonly moduleLoader: () => UsbModuleLike;
	private readonly inUse: (location: UsbDeviceLocation) => boolean;
	private readonly readSlack: number;
	private readonly platform: NodeJS.Platform;

	private device?: UsbDeviceLike;
	private claimed?: UsbInterfaceLike;
	/** Set when this adapter detached the kernel driver by hand; it gives it back on close. */
	private detachedKernelDriver = false;
	/** Bumped by every close, so an open still awaiting something knows it was overtaken. */
	private generation = 0;
	/** The close in progress, which a second close() waits on. */
	private closingPromise?: Promise<void>;
	private inEndpoint?: UsbEndpointLike;
	private outEndpoint?: UsbEndpointLike;
	private frameBytes = 0;
	private _isOpen = false;
	private opening?: Promise<void>;
	private inFlight = false;
	/** Transfers handed to libusb and not yet called back; `close` waits for none. */
	private pendingTransfers = 0;
	private readonly drainWaiters: (() => void)[] = [];

	constructor(options: UsbLibusbAdapterOptions = {}) {
		this.serial = options.serial?.trim().toLowerCase() || undefined;
		this.vendorId = options.vendorId ?? USB.VENDOR_ID;
		this.productId = options.productId ?? USB.PRODUCT_ID;
		this.interfaceNumber = options.interfaceNumber ?? 0;
		this.moduleLoader = options.moduleLoader ?? loadUsbModule;
		this.inUse = options.inUse ?? (() => false);
		this.readSlack = options.readSlackBytes ?? READ_OVERRUN_SLACK;
		this.platform = options.platform ?? process.platform;
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	/**
	 * Largest packet this link carries, read from the endpoint rather than assumed.
	 *
	 * Undefined until the adapter is open, because until then nothing has said what the
	 * hardware advertises.
	 */
	get maxPacketBytes(): number | undefined {
		return this._isOpen && this.frameBytes > 0 ? this.frameBytes : undefined;
	}

	/** Where the claimed device sits, so discovery can leave it alone while in use. */
	get deviceLocation(): UsbDeviceLocation | undefined {
		return this.device
			? { busNumber: this.device.busNumber, deviceAddress: this.device.deviceAddress }
			: undefined;
	}

	async open(options?: OpenOptions): Promise<void> {
		if (this._isOpen) { return; }
		if (this.opening) { return this.opening; }
		this.opening = this.openInternal(options?.signal).finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	/**
	 * Releases the interface, gives the kernel driver back and closes the device. One close at a
	 * time: a second call while the first still waits for libusb gets the same promise.
	 */
	close(): Promise<void> {
		if (!this.closingPromise) {
			this.closingPromise = this.closeInternal().finally(() => { this.closingPromise = undefined; });
		}
		return this.closingPromise;
	}

	private async closeInternal(): Promise<void> {
		this.generation += 1;
		this._isOpen = false;
		const device = this.device;
		const claimed = this.claimed;
		const reattach = this.detachedKernelDriver;
		this.device = undefined;
		this.claimed = undefined;
		this.detachedKernelDriver = false;
		this.inEndpoint = undefined;
		this.outEndpoint = undefined;
		this.frameBytes = 0;
		this.inFlight = false;

		if (!device) { return; }

		// A send that gave up on the JS side — a timeout, an abort — leaves its libusb transfer
		// pending until libusb's own endpoint timeout calls it back, and node-usb refuses to close
		// a device with a request pending. So wait for libusb to hand every transfer back first.
		// (This was first blamed for the extension host's access violations of 30.10.2026; the
		// cause turned out to be the read overrun, see READ_OVERRUN_SLACK.)
		await this.waitForTransfers(CLOSE_DRAIN_MAX_MS);

		// Release before close, and never let either failure mask the other: a device
		// unplugged mid-session fails both, and leaking the handle would keep the next
		// connect from claiming it.
		if (claimed) {
			await new Promise<void>((resolve) => {
				try {
					claimed.release(true, () => resolve());
				} catch {
					resolve();
				}
			});
			if (reattach) { reattachKernelDriver(claimed); }
		}
		try {
			device.close();
		} catch {
			// The device is already gone; nothing left to release.
		}
	}

	async send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array> {
		if (!this._isOpen || !this.inEndpoint || !this.outEndpoint) {
			throw new TransportError('USB transport is not open.');
		}
		if (this.inFlight) {
			throw new TransportError('USB transport already has in-flight send request.');
		}
		if (packet.length > this.frameBytes) {
			throw new TransportError(
				`USB packet of ${packet.length} bytes exceeds the ${this.frameBytes}-byte frame `
				+ 'this endpoint carries.'
			);
		}
		if (options?.signal?.aborted) {
			throw new TransportError('USB send aborted before dispatch.');
		}

		const timeoutMs = options?.timeoutMs ?? USB.SEND_TIMEOUT_MS;
		this.inEndpoint.timeout = timeoutMs > 0 ? timeoutMs : 0;
		this.outEndpoint.timeout = timeoutMs > 0 ? timeoutMs : 0;

		this.inFlight = true;
		try {
			return await this.exchange(packet, options, timeoutMs);
		} finally {
			this.inFlight = false;
		}
	}

	// ── Internal ────────────────────────────────────────────────────

	private async openInternal(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const usb = this.moduleLoader();
		const generation = this.generation;
		/**
		 * After every wait: a close that overtook this open has already given everything back; an
		 * abort has not, so this open does it before it rejects.
		 */
		const stillWanted = async (): Promise<void> => {
			if (generation !== this.generation) {
				throw new TransportError('USB link closed while it was opening.');
			}
			if (signal?.aborted) {
				await this.close();
				throw signal.reason;
			}
		};
		const device = await this.findDevice(usb);
		// The lookup has closed every device it opened; nothing is owned yet.
		if (generation !== this.generation) {
			throw new TransportError('USB link closed while it was opening.');
		}
		signal?.throwIfAborted();

		try {
			device.open();
		} catch (error) {
			if (this.platform === 'linux' && isAccessDenied(error)) {
				throw linuxPermissionError(error instanceof Error ? error.message : String(error), error);
			}
			throw error;
		}
		let claimed: UsbInterfaceLike | undefined;
		let detached = false;
		try {
			claimed = device.interface(this.interfaceNumber);
			if (this.platform === 'linux') { detached = freeFromKernelDriver(device, claimed); }
			claimed.claim();
		} catch (error) {
			if (detached && claimed) { reattachKernelDriver(claimed); }
			try { device.close(); } catch { /* opening failed; nothing to unwind */ }
			const detail = error instanceof Error ? error.message : String(error);
			throw new TransportError(
				`Could not claim USB interface ${this.interfaceNumber} on the brick. (${detail})`
			);
		}

		// Owned from here: whatever happens next, a close() releases the interface, gives the
		// kernel driver back and closes the device — including a close while this open still waits.
		this.device = device;
		this.claimed = claimed;
		this.detachedKernelDriver = detached;

		const inEndpoint = claimed.endpoints.find(
			(ep) => ep.direction === 'in' && (ep.descriptor.bmAttributes & 0x03) === TRANSFER_TYPE_INTERRUPT
		);
		const outEndpoint = claimed.endpoints.find(
			(ep) => ep.direction === 'out' && (ep.descriptor.bmAttributes & 0x03) === TRANSFER_TYPE_INTERRUPT
		);
		if (!inEndpoint || !outEndpoint) {
			await this.close();
			throw new TransportError(
				`USB interface ${this.interfaceNumber} has no interrupt endpoint pair.`
			);
		}

		// Both directions advertise the same size on an EV3, but take the smaller if a
		// device ever disagrees: a transfer must match its endpoint exactly.
		const frameBytes = Math.min(
			outEndpoint.descriptor.wMaxPacketSize,
			inEndpoint.descriptor.wMaxPacketSize,
		);
		if (frameBytes <= 0) {
			await this.close();
			throw new TransportError('USB interrupt endpoint advertises no packet size.');
		}

		if (this.platform === 'linux') {
			await this.clearHaltCounted(inEndpoint);
			await stillWanted();
			await this.clearHaltCounted(outEndpoint);
		}
		await stillWanted();

		this.frameBytes = frameBytes;
		this.inEndpoint = inEndpoint;
		this.outEndpoint = outEndpoint;
		this._isOpen = true;
	}

	private async findDevice(usb: UsbModuleLike): Promise<UsbDeviceLike> {
		const candidates = usb.getDeviceList().filter(
			(d) => d.deviceDescriptor.idVendor === this.vendorId
				&& d.deviceDescriptor.idProduct === this.productId
		);
		if (candidates.length === 0) {
			throw new TransportError('No EV3 found on the USB bus.');
		}
		if (!this.serial) {
			return candidates[0];
		}

		// Reading a serial means opening the device, so close every one that is not the
		// brick we were asked for — leaving handles open would block a later connect.
		let refused: unknown;
		for (const candidate of candidates) {
			// Never touch a brick another session is holding: opening and closing it drops
			// the handle that session is using.
			if (this.inUse({
				busNumber: candidate.busNumber,
				deviceAddress: candidate.deviceAddress,
			})) {
				continue;
			}
			let opened = false;
			try {
				candidate.open();
				opened = true;
				const serial = await readStringDescriptor(
					candidate, candidate.deviceDescriptor.iSerialNumber
				);
				if (serial && serial.toLowerCase() === this.serial) {
					// Returned still-open only in the sense that `finally` closes it once,
					// below. Closing here as well would leave libusb's handle count wrong:
					// the later claim then succeeds and every transfer fails with
					// LIBUSB_ERROR_IO — verified, and it cost a debugging round.
					return candidate;
				}
			} catch (error) {
				// Inaccessible device: it cannot be the one we want — unless it was refused, in
				// which case its serial was never read and it may be exactly that one.
				if (isAccessDenied(error)) { refused = error; }
			} finally {
				if (opened) {
					try { candidate.close(); } catch { /* already gone */ }
				}
			}
		}
		if (refused !== undefined && this.platform === 'linux') {
			throw linuxPermissionError(refused instanceof Error ? refused.message : String(refused), refused);
		}
		throw new TransportError(
			`No EV3 on the USB bus reports serial ${this.serial.toUpperCase()}.`
		);
	}

	/**
	 * One request-reply exchange.
	 *
	 * A reply whose message counter does not match belongs to an abandoned exchange, so
	 * step over it rather than handing it back — but only a bounded number of times, or
	 * a genuinely desynchronised channel would spin here forever.
	 */
	private async exchange(
		packet: Uint8Array,
		options: SendOptions | undefined,
		timeoutMs: number,
	): Promise<Uint8Array> {
		await this.transferOut(packet, options, timeoutMs);

		const expected = options?.expectedMessageCounter;
		// On Linux a freshly plugged brick has one packet of garbage waiting on its IN endpoint
		// (HOSTC, 13.11.2026): read at once, declaring a length the transfer cannot hold. While a
		// known counter is awaited, an unreadable reply is stepped over like a stale one.
		const tolerateUnreadable = this.platform === 'linux' && expected !== undefined;
		for (let attempt = 0; attempt <= MAX_STALE_REPLIES; attempt += 1) {
			const reply = await this.transferIn(options, timeoutMs, tolerateUnreadable);
			if (reply === undefined) { continue; }
			if (expected === undefined || getMessageCounter(reply) === expected) {
				return reply;
			}
		}
		throw new TransportError(
			`USB reply stream stayed out of step after ${MAX_STALE_REPLIES} stale replies.`
		);
	}

	private transferOut(
		packet: Uint8Array,
		options: SendOptions | undefined,
		timeoutMs: number,
	): Promise<void> {
		// Padded to the full frame: libusb refuses a short interrupt transfer outright,
		// and the brick reads the packet length from the packet itself.
		const frame = Buffer.alloc(this.frameBytes);
		Buffer.from(packet).copy(frame, 0);

		return this.withCancellation(
			(resolve, reject) => {
				this.submit(reject, (done) => this.outEndpoint!.transfer(frame, (error) => {
					done();
					if (error) {
						reject(new TransportError(`USB send failed: ${error.message}`, error));
					} else {
						resolve();
					}
				}));
			},
			options,
			timeoutMs,
		);
	}

	/** @returns undefined for an unreadable reply when `tolerateUnreadable` is set. */
	private transferIn(
		options: SendOptions | undefined,
		timeoutMs: number,
		tolerateUnreadable = false,
	): Promise<Uint8Array | undefined> {
		return this.withCancellation<Uint8Array | undefined>(
			(resolve, reject) => {
				this.submit(reject, (done) => this.inEndpoint!.transfer(this.frameBytes + this.readSlack, (error, data) => {
					done();
					if (error) {
						reject(new TransportError(`USB receive failed: ${error.message}`, error));
						return;
					}
					if (!data) {
						reject(new TransportError('USB receive returned no data.'));
						return;
					}
					// The transfer is frame-sized whatever the reply is, so trust the
					// length prefix and drop the padding behind it.
					const extracted = extractLengthPrefixedPacket(new Uint8Array(data));
					if (!extracted && tolerateUnreadable) {
						resolve(undefined);
						return;
					}
					if (!extracted) {
						reject(new TransportError(
							`USB reply of ${data.length} bytes is shorter than the packet it declares.`
						));
						return;
					}
					resolve(extracted.packet);
				}));
			},
			options,
			timeoutMs,
		);
	}

	/**
	 * Hands one transfer to libusb, counting it until libusb calls it back.
	 *
	 * The count is what `close` waits on; `done` must be the first thing the callback does.
	 */
	private submit(reject: (error: unknown) => void, transfer: (done: () => void) => void): void {
		this.pendingTransfers += 1;
		let finished = false;
		const done = (): void => {
			if (finished) { return; }
			finished = true;
			this.pendingTransfers -= 1;
			if (this.pendingTransfers === 0) {
				for (const resolve of this.drainWaiters.splice(0)) { resolve(); }
			}
		};
		try {
			transfer(done);
		} catch (error) {
			done();
			reject(error);
		}
	}

	/**
	 * Clears an endpoint after the claim (Linux only), counted as a transfer in flight until libusb
	 * really answers.
	 *
	 * Taking the interface from `usbhid` leaves the interrupt endpoints' data toggle out of step
	 * with the brick's, and the first reply after every detach was dropped as a duplicate (HOSTC,
	 * 13.11.2026). A clear-halt resets the toggle on both ends. Best effort, and the open waits at
	 * most {@link CLEAR_HALT_MAX_MS} for it — but the request stays counted until libusb calls it
	 * back, so a close waits for it rather than release the interface under it.
	 */
	private clearHaltCounted(endpoint: UsbEndpointLike): Promise<void> {
		if (!endpoint.clearHalt) { return Promise.resolve(); }
		return new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, CLEAR_HALT_MAX_MS);
			timer.unref?.();
			this.submit(() => { clearTimeout(timer); resolve(); }, (done) => {
				endpoint.clearHalt!(() => { done(); clearTimeout(timer); resolve(); });
			});
		});
	}

	/** Resolves once libusb has called back every transfer, or after `maxMs`, whichever is first. */
	private waitForTransfers(maxMs: number): Promise<void> {
		if (this.pendingTransfers === 0) { return Promise.resolve(); }
		return new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, maxMs);
			timer.unref?.();
			this.drainWaiters.push(() => { clearTimeout(timer); resolve(); });
		});
	}

	/**
	 * Wraps one libusb call with the caller's deadline and abort signal.
	 *
	 * libusb has its own timeout on the endpoint, but it cannot see an `AbortSignal`, and
	 * a transfer that never calls back would otherwise hang the queue behind it.
	 */
	private withCancellation<T>(
		start: (resolve: (value: T) => void, reject: (error: unknown) => void) => void,
		options: SendOptions | undefined,
		timeoutMs: number,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;

			const finish = (fn: () => void): void => {
				if (settled) { return; }
				settled = true;
				if (timer) { clearTimeout(timer); }
				options?.signal?.removeEventListener('abort', onAbort);
				fn();
			};

			function onAbort(): void {
				finish(() => reject(new TransportError('USB send aborted.')));
			}

			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					finish(() => reject(new TimeoutError(
						`USB exchange exceeded its ${timeoutMs} ms budget.`
					)));
				}, timeoutMs);
			}
			options?.signal?.addEventListener('abort', onAbort, { once: true });

			start(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
		});
	}
}
