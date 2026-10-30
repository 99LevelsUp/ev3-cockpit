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

import { TransportAdapter, SendOptions } from './transportAdapter';
import { TransportError, TimeoutError } from '../errors/CockpitError';
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
	transfer(
		lengthOrData: number | Buffer,
		callback: (error: Error | undefined, data?: Buffer) => void,
	): void;
}

interface UsbInterfaceLike {
	endpoints: UsbEndpointLike[];
	claim(): void;
	release(closeEndpoints: boolean, callback: (error?: Error) => void): void;
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
	/** Injection seam for tests, which have no brick to enumerate. */
	moduleLoader?: () => UsbModuleLike;
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

	private device?: UsbDeviceLike;
	private claimed?: UsbInterfaceLike;
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

	async open(): Promise<void> {
		if (this._isOpen) { return; }
		if (this.opening) { return this.opening; }
		this.opening = this.openInternal().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	async close(): Promise<void> {
		this._isOpen = false;
		const device = this.device;
		const claimed = this.claimed;
		this.device = undefined;
		this.claimed = undefined;
		this.inEndpoint = undefined;
		this.outEndpoint = undefined;
		this.frameBytes = 0;
		this.inFlight = false;

		if (!device) { return; }

		// A send that gave up on the JS side — a timeout, an abort — leaves its libusb transfer
		// pending until libusb's own endpoint timeout calls it back. Releasing the interface and
		// closing the device under it let that late callback land in freed native memory: the
		// extension host died with an access violation in node-usb, minutes after a name probe
		// had timed out (30.10.2026). So wait for libusb to hand every transfer back first.
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

	private async openInternal(): Promise<void> {
		const usb = this.moduleLoader();
		const device = await this.findDevice(usb);

		device.open();
		let claimed: UsbInterfaceLike;
		try {
			claimed = device.interface(this.interfaceNumber);
			claimed.claim();
		} catch (error) {
			try { device.close(); } catch { /* opening failed; nothing to unwind */ }
			const detail = error instanceof Error ? error.message : String(error);
			throw new TransportError(
				`Could not claim USB interface ${this.interfaceNumber} on the brick. (${detail})`
			);
		}

		const inEndpoint = claimed.endpoints.find(
			(ep) => ep.direction === 'in' && (ep.descriptor.bmAttributes & 0x03) === TRANSFER_TYPE_INTERRUPT
		);
		const outEndpoint = claimed.endpoints.find(
			(ep) => ep.direction === 'out' && (ep.descriptor.bmAttributes & 0x03) === TRANSFER_TYPE_INTERRUPT
		);
		if (!inEndpoint || !outEndpoint) {
			this.device = device;
			this.claimed = claimed;
			await this.close();
			throw new TransportError(
				`USB interface ${this.interfaceNumber} has no interrupt endpoint pair.`
			);
		}

		// Both directions advertise the same size on an EV3, but take the smaller if a
		// device ever disagrees: a transfer must match its endpoint exactly.
		this.frameBytes = Math.min(
			outEndpoint.descriptor.wMaxPacketSize,
			inEndpoint.descriptor.wMaxPacketSize,
		);
		if (this.frameBytes <= 0) {
			this.device = device;
			this.claimed = claimed;
			await this.close();
			throw new TransportError('USB interrupt endpoint advertises no packet size.');
		}

		this.device = device;
		this.claimed = claimed;
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
			} catch {
				// Inaccessible device: it cannot be the one we want.
			} finally {
				if (opened) {
					try { candidate.close(); } catch { /* already gone */ }
				}
			}
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

		for (let attempt = 0; attempt <= MAX_STALE_REPLIES; attempt += 1) {
			const reply = await this.transferIn(options, timeoutMs);
			const expected = options?.expectedMessageCounter;
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

	private transferIn(
		options: SendOptions | undefined,
		timeoutMs: number,
	): Promise<Uint8Array> {
		return this.withCancellation<Uint8Array>(
			(resolve, reject) => {
				this.submit(reject, (done) => this.inEndpoint!.transfer(this.frameBytes, (error, data) => {
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
