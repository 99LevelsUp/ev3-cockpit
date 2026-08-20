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
	extractLengthPrefixedPacket,
	createPendingReply
} from './pendingReply';
import { BT } from './transportConstants';
import { TimeoutError } from '../errors/CockpitError';

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
	/** Deadline for open and DTR assert (default: `BT.CONNECT_TIMEOUT_MS`). */
	connectTimeoutMs?: number;
	/**
	 * Overrides how the serial port is constructed.
	 *
	 * Exists so the open deadline can be tested without a paired brick: the timeout
	 * path has been fixed wrongly three times, each time for a different reason, and
	 * every one of those would have been caught by a test.
	 */
	serialPortFactory?: (options: {
		path: string;
		baudRate: number;
		autoOpen: boolean;
	}) => SerialPortLike;
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
	private readonly connectTimeoutMs: number;
	private readonly serialPortFactory?: BtSppAdapterOptions['serialPortFactory'];

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
		this.connectTimeoutMs = options.connectTimeoutMs ?? BT.CONNECT_TIMEOUT_MS;
		this.serialPortFactory = options.serialPortFactory;
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	async open(): Promise<void> {
		if (this._isOpen) {
			return;
		}

		const portOptions = {
			path: this.portPath,
			baudRate: this.baudRate,
			autoOpen: false,
		};
		const port = this.serialPortFactory
			? this.serialPortFactory(portOptions)
			: new (loadSerialPort())(portOptions);

		// Opening an RFCOMM port can hang, and the caller is holding the only BT
		// connection slot while it does. This was the one adapter whose open() had no
		// deadline: TCP already races its handshake timeout and USB's open is synchronous.
		const deadline = <T>(work: Promise<T>, step: string): Promise<T> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expiry = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new TimeoutError(
						`BT SPP ${step} on ${this.portPath} timed out after ${this.connectTimeoutMs} ms.`
					)),
					this.connectTimeoutMs
				);
				timer.unref?.();
			});
			return Promise.race([work, expiry]).finally(() => { if (timer) { clearTimeout(timer); } });
		};

		// Releasing the port on timeout is harder than it looks, and the two previous
		// attempts at it were both wrong. Closing inside the catch is a no-op: open is
		// still in flight, so serialport just answers "Port is not open" and the OS
		// handle is orphaned when the open callback succeeds a moment later. So the
		// party that actually ends up holding an opened port is the one that closes it.
		let abandoned = false;
		const releaseOrphan = () => {
			// Callback signature only; the handle is going away either way.
			port.close(() => { /* nothing left to report to */ });
		};

		try {
			await deadline(new Promise<void>((resolve, reject) => {
				port.open((err) => {
					if (err) { reject(err); return; }
					if (abandoned) {
						// We gave up before this landed, and nothing references the port now.
						releaseOrphan();
						return;
					}
					resolve();
				});
			}), 'open');
		} catch (error) {
			abandoned = true;
			// Covers the other ordering: the port opened between the timer firing and this
			// line, so the callback saw abandoned === false and left it to us.
			if (port.isOpen) { releaseOrphan(); }
			throw error;
		}

		// Adopt the port before anything that can still fail. It used to be assigned only
		// after the DTR and settle steps, so a failed DTR left an open OS handle with no
		// reference: close() bails out on a missing port, and on Windows the next open of
		// that COM port then failed with access-denied until the extension host restarted.
		this.port = port;

		try {
			if (this.assertDtr) {
				await deadline(new Promise<void>((resolve, reject) => {
					port.set({ dtr: true }, (err) => {
						if (err) { reject(err); } else { resolve(); }
					});
				}), 'DTR assert');
			}

			if (this.postOpenDelayMs > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, this.postOpenDelayMs));
			}
		} catch (error) {
			await this.close().catch(() => { /* best effort */ });
			throw error;
		}

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

		// EV3 is strictly request-reply on this channel, so nothing legitimate is in
		// the buffer between exchanges. A late fragment from an abandoned exchange is,
		// and it would desync every reply after it.
		this.receiveBuffer = Buffer.alloc(0);

		return new Promise<Uint8Array>((resolve, reject) => {
			this.pendingReply = createPendingReply({
				resolve,
				reject,
				fail: (error) => this.failExchange(error),
				timeoutMs: options?.timeoutMs ?? BT.SEND_TIMEOUT_MS,
				signal: options?.signal,
				expectedMessageCounter: options?.expectedMessageCounter,
				transport: 'BT SPP',
			});

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
}
