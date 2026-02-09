import {
	PendingReply,
	drainPendingReply,
	rejectPendingReply
} from './pendingReply';
import { TransportAdapter, TransportRequestOptions } from './transportAdapter';

interface HidDeviceInfo {
	path: string;
	vendorId?: number;
	productId?: number;
}

interface HidDeviceLike {
	write(data: number[]): number;
	close(): void;
	removeAllListeners(event?: string): this;
	on(event: 'data', listener: (data: Buffer) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
}

interface NodeHidModuleLike {
	devices(vendorId?: number, productId?: number): HidDeviceInfo[];
	HID: new (path: string) => HidDeviceLike;
}

export interface UsbHidAdapterOptions {
	path?: string;
	vendorId?: number;
	productId?: number;
	reportId?: number;
	reportSize?: number;
}

function loadNodeHid(): NodeHidModuleLike {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('node-hid') as Partial<NodeHidModuleLike>;
		if (!mod || typeof mod.devices !== 'function' || typeof mod.HID !== 'function') {
			throw new Error('Invalid node-hid module shape.');
		}
		return mod as NodeHidModuleLike;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`USB transport requires package "node-hid". (${detail})`);
	}
}

function toHex(value: number): string {
	return `0x${value.toString(16).padStart(4, '0')}`;
}

export class UsbHidAdapter implements TransportAdapter {
	private readonly path?: string;
	private readonly vendorId: number;
	private readonly productId: number;
	private readonly reportId: number;
	private readonly reportSize: number;

	private device?: HidDeviceLike;
	private opened = false;
	private opening?: Promise<void>;
	private closing = false;
	private receiveBuffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;

	public constructor(options: UsbHidAdapterOptions = {}) {
		this.path = options.path?.trim() || undefined;
		this.vendorId = options.vendorId ?? 0x0694;
		this.productId = options.productId ?? 0x0005;
		this.reportId = options.reportId ?? 0;
		this.reportSize = options.reportSize ?? 1025;
	}

	public async open(): Promise<void> {
		if (this.opened) {
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

	public async close(): Promise<void> {
		this.opened = false;
		this.closing = true;
		this.rejectPendingReply(new Error('USB transport closed while waiting for reply.'));
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

	public async send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array> {
		const device = this.requireDevice();
		if (this.pendingReply) {
			throw new Error('USB transport already has in-flight send request.');
		}

		if (options.signal.aborted) {
			throw new Error('USB send aborted before dispatch.');
		}

		return new Promise<Uint8Array>((resolve, reject) => {
			const onAbort = () => {
				this.rejectPendingReply(new Error('USB send aborted.'));
			};
			const cleanup = () => options.signal.removeEventListener('abort', onAbort);
			options.signal.addEventListener('abort', onAbort, { once: true });
			this.pendingReply = {
				resolve,
				reject,
				cleanup,
				expectedMessageCounter: options.expectedMessageCounter
			};

			try {
				device.write(this.formatWriteBuffer(packet));
				this.drainPendingReply();
			} catch (error) {
				this.rejectPendingReply(error);
			}
		});
	}

	private async openInternal(): Promise<void> {
		const hid = loadNodeHid();
		const targetPath = this.path ?? this.findDefaultPath(hid);
		const device = new hid.HID(targetPath);

		this.device = device;
		this.receiveBuffer = Buffer.alloc(0);
		this.opened = true;

		device.on('data', (data) => {
			const normalized = this.normalizeIncomingChunk(data);
			if (normalized.length === 0) {
				return;
			}

			this.receiveBuffer = Buffer.concat([this.receiveBuffer, normalized]);
			this.drainPendingReply();
		});
		device.on('error', (error) => this.handleFailure(error));
	}

	private findDefaultPath(hid: NodeHidModuleLike): string {
		const devices = hid.devices(this.vendorId, this.productId);
		const found = devices.find((entry) => Boolean(entry.path));
		if (!found?.path) {
			throw new Error(
				`No EV3 USB HID device found (vendor=${toHex(this.vendorId)}, product=${toHex(this.productId)}).`
			);
		}
		return found.path;
	}

	private formatWriteBuffer(packet: Uint8Array): number[] {
		const maxPayload = this.reportSize - 1;
		if (packet.length > maxPayload) {
			throw new Error(
				`USB packet too large for HID report (payload=${packet.length}, max=${maxPayload}, reportSize=${this.reportSize}).`
			);
		}

		const report = new Array<number>(this.reportSize).fill(0);
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

			// USB HID reports are often padded with trailing 0x00 bytes.
			// Skip impossible headers to avoid interpreting padding as a packet.
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

	private drainPendingReply(): void {
		this.pendingReply = drainPendingReply(this.pendingReply, () => this.extractNextPacket());
	}

	private rejectPendingReply(error: unknown): void {
		this.pendingReply = rejectPendingReply(this.pendingReply, error);
	}

	private handleFailure(error: unknown): void {
		if (this.closing) {
			return;
		}

		this.opened = false;
		this.rejectPendingReply(error);
	}

	private requireDevice(): HidDeviceLike {
		if (!this.device || !this.opened) {
			throw new Error('USB transport is not open.');
		}

		return this.device;
	}
}
