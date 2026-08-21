/**
 * USB HID transport adapter using node-hid for EV3 brick communication.
 *
 * Handles HID report framing, report-ID stripping on incoming data,
 * and EV3 packet reassembly from the receive buffer.
 */

import { TransportAdapter, SendOptions } from './transportAdapter';
import { TransportError } from '../errors/CockpitError';
import {
	PendingReply,
	drainPendingReply,
	rejectPendingReply,
	createPendingReply
} from './pendingReply';
import { USB } from './transportConstants';

// ── node-hid interfaces (duck-typed to avoid hard import) ───────────

interface HidDeviceInfo {
	path?: string;
	vendorId?: number;
	productId?: number;
	serialNumber?: string;
	product?: string;
}

interface HidDeviceLike {
	write(data: number[]): number;
	close(): void;
	removeAllListeners(event?: string): this;
	on(event: 'data', listener: (data: Buffer) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
}

interface NodeHidModule {
	devices(vendorId?: number, productId?: number): HidDeviceInfo[];
	HID: new (path: string) => HidDeviceLike;
}

/** Configuration options for {@link UsbHidAdapter}. */
export interface UsbHidAdapterOptions {
	/** Explicit HID device path, or `serial:<hex12>` to match by serial number. */
	path?: string;
	/** USB vendor ID (default: LEGO 0x0694). */
	vendorId?: number;
	/** USB product ID (default: EV3 0x0005). */
	productId?: number;
	/** HID report ID prepended to every write (default: 0). */
	reportId?: number;
	/** Total HID report size in bytes including the report ID byte. */
	reportSize?: number;
}

function loadNodeHid(): NodeHidModule {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('node-hid') as Partial<NodeHidModule>;
		if (!mod || typeof mod.devices !== 'function' || typeof mod.HID !== 'function') {
			throw new Error('Invalid node-hid module shape.');
		}
		return mod as NodeHidModule;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new TransportError(`USB transport requires package "node-hid". (${detail})`);
	}
}

function toHex(value: number): string {
	return `0x${value.toString(16).padStart(4, '0')}`;
}

/**
 * Transport adapter that communicates with an EV3 brick over USB HID.
 *
 * Handles HID report framing, report-ID stripping on incoming data,
 * and EV3 packet reassembly from the receive buffer.
 */
export class UsbHidAdapter implements TransportAdapter {
	private readonly path?: string;
	private readonly vendorId: number;
	private readonly productId: number;
	private readonly reportId: number;
	private readonly reportSize: number;

	private device?: HidDeviceLike;
	private _isOpen = false;
	private opening?: Promise<void>;
	private closing = false;
	private receiveBuffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;

	constructor(options: UsbHidAdapterOptions = {}) {
		this.path = options.path?.trim() || undefined;
		this.vendorId = options.vendorId ?? USB.VENDOR_ID;
		this.productId = options.productId ?? USB.PRODUCT_ID;
		this.reportId = options.reportId ?? USB.REPORT_ID;
		this.reportSize = options.reportSize ?? USB.REPORT_SIZE;
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	/**
	 * What a HID write actually delivers, which is far below the frame the brick's own
	 * endpoints advertise. See {@link USB.MAX_WRITE_PACKET_BYTES} for why.
	 */
	get maxPacketBytes(): number {
		return USB.MAX_WRITE_PACKET_BYTES;
	}

	async open(): Promise<void> {
		if (this._isOpen) {
			return;
		}
		if (this.opening) {
			return this.opening;
		}
		this.opening = this.openInternal().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async close(): Promise<void> {
		this._isOpen = false;
		this.closing = true;
		this.doRejectPendingReply(new Error('USB transport closed while waiting for reply.'));
		this.receiveBuffer = Buffer.alloc(0);

		const device = this.device;
		this.device = undefined;
		if (!device) {
			this.closing = false;
			return;
		}

		device.removeAllListeners();
		try {
			device.close();
		} finally {
			this.closing = false;
		}
	}

	async send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array> {
		const device = this.requireDevice();
		if (this.pendingReply) {
			throw new TransportError('USB transport already has in-flight send request.');
		}

		if (options?.signal?.aborted) {
			throw new TransportError('USB send aborted before dispatch.');
		}

		// EV3 is strictly request-reply on this channel, so nothing legitimate is in
		// the buffer between exchanges. A late fragment from an abandoned exchange is,
		// and it would desync every reply after it.
		this.receiveBuffer = Buffer.alloc(0);

		return new Promise<Uint8Array>((resolve, reject) => {
			this.pendingReply = createPendingReply({
				resolve,
				reject,
				fail: (error) => this.failExchange(error),
				timeoutMs: options?.timeoutMs ?? USB.SEND_TIMEOUT_MS,
				signal: options?.signal,
				expectedMessageCounter: options?.expectedMessageCounter,
				transport: 'USB',
			});

			try {
				const report = this.formatWriteBuffer(packet);
				const written = device.write(report);
				// A short write is silent corruption, not a slow path: the OS drops the tail
				// and the brick still advances its file pointer by the length we declared, so
				// a truncated upload reports success and lands zero padding.
				if (typeof written === 'number' && written < report.length) {
					throw new TransportError(
						`USB HID write delivered ${written} of ${report.length} bytes. `
						+ `Packets must stay within ${USB.MAX_WRITE_PACKET_BYTES} bytes on this `
						+ 'transport.'
					);
				}
				this.doDrainPendingReply();
			} catch (error) {
				this.doRejectPendingReply(error);
			}
		});
	}

	// ── Internal ────────────────────────────────────────────────────

	// eslint-disable-next-line @typescript-eslint/require-await
	private async openInternal(): Promise<void> {
		const hid = loadNodeHid();
		const targetPath = this.resolveTargetPath(hid);
		const device = new hid.HID(targetPath);

		this.device = device;
		this.receiveBuffer = Buffer.alloc(0);
		this._isOpen = true;

		device.on('data', (data) => {
			const normalized = this.normalizeIncomingChunk(data);
			if (normalized.length === 0) {
				return;
			}
			this.receiveBuffer = Buffer.concat([this.receiveBuffer, normalized]);
			this.doDrainPendingReply();
		});
		device.on('error', (error) => this.handleFailure(error));
	}

	private resolveTargetPath(hid: NodeHidModule): string {
		if (!this.path) {
			return this.findDefaultPath(hid);
		}
		const serialMatch = this.path.match(/^serial:([0-9a-f]{12})$/i);
		if (!serialMatch) {
			return this.path;
		}
		return this.findPathBySerial(hid, serialMatch[1].toLowerCase());
	}

	private findDefaultPath(hid: NodeHidModule): string {
		const devices = hid.devices(this.vendorId, this.productId);
		const found = devices.find((entry) => Boolean(entry.path));
		if (!found?.path) {
			throw new TransportError(
				`No EV3 USB HID device found (vendor=${toHex(this.vendorId)}, product=${toHex(this.productId)}).`
			);
		}
		return found.path;
	}

	private findPathBySerial(hid: NodeHidModule, serial: string): string {
		const devices = hid.devices();
		const found = devices.find((entry) =>
			entry.vendorId === this.vendorId
			&& entry.productId === this.productId
			&& entry.serialNumber?.trim().toLowerCase() === serial
			&& Boolean(entry.path)
		);
		if (!found?.path) {
			throw new TransportError(
				`No EV3 USB HID device found for serial ${serial.toUpperCase()} `
				+ `(vendor=${toHex(this.vendorId)}, product=${toHex(this.productId)}).`
			);
		}
		return found.path;
	}

	private formatWriteBuffer(packet: Uint8Array): number[] {
		if (packet.length > USB.MAX_WRITE_PACKET_BYTES) {
			throw new TransportError(
				`USB packet of ${packet.length} bytes exceeds the `
				+ `${USB.MAX_WRITE_PACKET_BYTES} bytes a HID write delivers on this transport. `
				+ 'Split it, or move bulk transfer to the libusb path.'
			);
		}

		// Sized to what actually goes out rather than to REPORT_SIZE: handing the OS a
		// 1025-byte report it truncates to 65 is what hid this for so long.
		const report = new Array<number>(USB.MAX_WRITE_PACKET_BYTES + 1).fill(0);
		report[0] = this.reportId & 0xff;
		for (let i = 0; i < packet.length; i += 1) {
			report[i + 1] = packet[i];
		}
		return report;
	}

	private normalizeIncomingChunk(data: Buffer): Buffer {
		if (data.length === 0) {
			return Buffer.alloc(0);
		}
		// Most EV3 HID reads include reportId as first byte on Windows.
		if (data[0] === this.reportId && data.length > 1) {
			return Buffer.from(data.subarray(1));
		}
		return Buffer.from(data);
	}

	private extractNextPacket(): Uint8Array | undefined {
		while (this.receiveBuffer.length >= 2) {
			const bodyLength = this.receiveBuffer.readUInt16LE(0);

			// USB HID reports are padded with trailing 0x00 — skip impossible headers.
			if (bodyLength < 3) {
				this.receiveBuffer = this.receiveBuffer.subarray(1);
				continue;
			}

			const totalLength = bodyLength + 2;
			if (totalLength > this.reportSize) {
				this.receiveBuffer = this.receiveBuffer.subarray(1);
				continue;
			}

			if (this.receiveBuffer.length < totalLength) {
				return undefined;
			}

			const packet = Buffer.from(this.receiveBuffer.subarray(0, totalLength));
			this.receiveBuffer = this.receiveBuffer.subarray(totalLength);
			return new Uint8Array(packet);
		}
		return undefined;
	}

	private doDrainPendingReply(): void {
		this.pendingReply = drainPendingReply(this.pendingReply, () => this.extractNextPacket());
	}

	/**
	 * Abandon the current exchange and leave the adapter usable: drop the latch and
	 * discard the buffer, so a late or partial frame cannot bleed into the next send.
	 */
	private failExchange(error: unknown): void {
		this.receiveBuffer = Buffer.alloc(0);
		this.doRejectPendingReply(error);
	}

	private doRejectPendingReply(error: unknown): void {
		this.pendingReply = rejectPendingReply(this.pendingReply, error);
	}

	private handleFailure(error: unknown): void {
		if (this.closing) {
			return;
		}
		this._isOpen = false;
		this.doRejectPendingReply(error);
	}

	private requireDevice(): HidDeviceLike {
		if (!this.device || !this._isOpen) {
			throw new TransportError('USB transport is not open.');
		}
		return this.device;
	}
}
