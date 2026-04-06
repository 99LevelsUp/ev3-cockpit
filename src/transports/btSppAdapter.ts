/**
 * Bluetooth SPP transport adapter using the `serialport` package.
 *
 * This is the lowest-priority BT backend (fallback after WinRT and Winsock).
 * It communicates with the EV3 brick over a COM/serial port using the
 * standard Serial Port Profile (SPP).
 */

import { TransportAdapter, SendOptions } from './transportAdapter';
import { TransportError } from '../errors/CockpitError';
import {
	PendingReply,
	drainPendingReply,
	rejectPendingReply,
	extractLengthPrefixedPacket
} from './pendingReply';

// ── serialport interfaces (duck-typed to avoid hard import) ─────────

interface SerialPortLike {
	open(callback?: (err?: Error | null) => void): void;
	close(callback?: (err?: Error | null) => void): void;
	write(data: Buffer | Uint8Array, callback?: (err?: Error | null) => void): boolean;
	on(event: 'data', listener: (data: Buffer) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
	on(event: 'close', listener: () => void): this;
	removeAllListeners(event?: string): this;
	set(options: { dtr?: boolean }, callback?: (err?: Error | null) => void): void;
	isOpen: boolean;
}

interface SerialPortConstructor {
	new (options: {
		path: string;
		baudRate: number;
		autoOpen: boolean;
	}): SerialPortLike;
}

/** Default baud rate for EV3 SPP communication. */
const DEFAULT_BAUD_RATE = 115_200;
/** Post-open delay for firmware settling (ms). */
const DEFAULT_POST_OPEN_DELAY_MS = 120;
/** Grace period for port close (ms). */
const PORT_CLOSE_GRACE_MS = 500;

/** Configuration for {@link BtSppAdapter}. */
export interface BtSppAdapterOptions {
	/** Serial/COM port path (e.g. "COM5" on Windows, "/dev/rfcomm0" on Linux). */
	portPath: string;
	/** Baud rate (default: 115200). */
	baudRate?: number;
	/** Assert DTR signal after open (default: false). */
	assertDtr?: boolean;
	/** Post-open delay in ms for firmware settling (default: 120). */
	postOpenDelayMs?: number;
}

function loadSerialPort(): SerialPortConstructor {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
		const mod: Record<string, unknown> = require('serialport');
		const Ctor = (mod?.SerialPort ?? (mod?.default as Record<string, unknown>)?.SerialPort) as
			SerialPortConstructor | undefined;
		if (typeof Ctor !== 'function') {
			throw new Error('Invalid serialport module shape.');
		}
		return Ctor;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new TransportError(`BT SPP transport requires package "serialport". (${detail})`);
	}
}

/**
 * BT SPP transport adapter — communicates with EV3 over a serial COM port.
 */
export class BtSppAdapter implements TransportAdapter {
	private readonly portPath: string;
	private readonly baudRate: number;
	private readonly assertDtr: boolean;
	private readonly postOpenDelayMs: number;

	private port?: SerialPortLike;
	private _isOpen = false;
	private closing = false;
	private receiveBuffer: Buffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;

	constructor(options: BtSppAdapterOptions) {
		if (!options.portPath?.trim()) {
			throw new TransportError('BT SPP adapter requires a non-empty port path.');
		}
		this.portPath = options.portPath.trim();
		this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
		this.assertDtr = options.assertDtr ?? false;
		this.postOpenDelayMs = options.postOpenDelayMs ?? DEFAULT_POST_OPEN_DELAY_MS;
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	async open(): Promise<void> {
		if (this._isOpen) {
			return;
		}

		const SerialPort = loadSerialPort();
		const port = new SerialPort({
			path: this.portPath,
			baudRate: this.baudRate,
			autoOpen: false
		});

		await new Promise<void>((resolve, reject) => {
			port.open((err) => {
				if (err) { reject(err); } else { resolve(); }
			});
		});

		if (this.assertDtr) {
			await new Promise<void>((resolve, reject) => {
				port.set({ dtr: true }, (err) => {
					if (err) { reject(err); } else { resolve(); }
				});
			});
		}

		if (this.postOpenDelayMs > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, this.postOpenDelayMs));
		}

		this.port = port;
		this.receiveBuffer = Buffer.alloc(0);
		this._isOpen = true;

		port.on('data', (data: Buffer) => {
			this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
			this.doDrainPendingReply();
		});
		port.on('error', (error) => this.handleFailure(error));
		port.on('close', () => this.handleFailure(new Error('BT SPP port closed.')));
	}

	async close(): Promise<void> {
		this._isOpen = false;
		this.closing = true;
		this.doRejectPendingReply(new Error('BT SPP adapter closed while waiting for reply.'));
		this.receiveBuffer = Buffer.alloc(0);

		const port = this.port;
		this.port = undefined;
		if (!port) {
			this.closing = false;
			return;
		}

		port.removeAllListeners();

		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) { return; }
				settled = true;
				resolve();
			};
			const timeout = setTimeout(finish, PORT_CLOSE_GRACE_MS);
			timeout.unref();
			try {
				port.close(() => {
					clearTimeout(timeout);
					finish();
				});
			} catch {
				clearTimeout(timeout);
				finish();
			}
		});

		this.closing = false;
	}

	async send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array> {
		if (!this.port || !this._isOpen) {
			throw new TransportError('BT SPP adapter is not open.');
		}
		if (this.pendingReply) {
			throw new TransportError('BT SPP adapter already has in-flight send request.');
		}
		if (options?.signal?.aborted) {
			throw new TransportError('BT SPP send aborted before dispatch.');
		}

		return new Promise<Uint8Array>((resolve, reject) => {
			const signal = options?.signal;
			const onAbort = () => {
				this.doRejectPendingReply(new TransportError('BT SPP send aborted.'));
			};
			const cleanup = () => signal?.removeEventListener('abort', onAbort);
			signal?.addEventListener('abort', onAbort, { once: true });

			this.pendingReply = {
				resolve,
				reject,
				cleanup,
				expectedMessageCounter: options?.expectedMessageCounter
			};

			this.port!.write(Buffer.from(packet), (error?: Error | null) => {
				if (error) {
					this.doRejectPendingReply(error);
					return;
				}
				this.doDrainPendingReply();
			});
		});
	}

	// ── Internal ────────────────────────────────────────────────────

	private doDrainPendingReply(): void {
		this.pendingReply = drainPendingReply(this.pendingReply, () => this.extractNextPacket());
	}

	private extractNextPacket(): Uint8Array | undefined {
		const result = extractLengthPrefixedPacket(this.receiveBuffer);
		if (!result) {
			return undefined;
		}
		this.receiveBuffer = result.remaining;
		return result.packet;
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
}
