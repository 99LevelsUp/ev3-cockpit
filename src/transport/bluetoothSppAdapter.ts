import {
	PendingReply,
	drainPendingReply,
	rejectPendingReply,
	extractLengthPrefixedPacket
} from './pendingReply';
import { TransportAdapter, TransportRequestOptions } from './transportAdapter';

/** Default baud rate for EV3 Bluetooth SPP (Serial Port Profile). */
const DEFAULT_BAUD_RATE = 115_200;

/** Grace period for serial port close before forcing completion. */
const PORT_CLOSE_GRACE_MS = 500;

/** Delay after open() before the port is considered stable. */
const DEFAULT_POST_OPEN_DELAY_MS = 120;

interface SerialPortLike {
	write(data: Buffer, callback?: (error?: Error | null) => void): boolean;
	close(callback?: (error?: Error | null) => void): void;
	open(callback?: (error?: Error | null) => void): void;
	on(event: 'data', listener: (data: Buffer) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
	on(event: 'close', listener: () => void): this;
	removeAllListeners(event?: string): this;
	isOpen: boolean;
	set(options: { dtr?: boolean; rts?: boolean }, callback?: (error?: Error | null) => void): void;
}

interface SerialPortConstructor {
	new (options: { path: string; baudRate: number; autoOpen: boolean }): SerialPortLike;
}

interface SerialPortModule {
	SerialPort?: SerialPortConstructor;
}

export interface BluetoothSppAdapterOptions {
	portPath: string;
	baudRate?: number;
	dtr?: boolean;
	postOpenDelayMs?: number;
	/** @internal For testing only — override the SerialPort constructor. */
	_serialPortFactory?: SerialPortConstructor;
}

function loadSerialPort(): SerialPortConstructor {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('serialport') as SerialPortModule;
		if (!mod?.SerialPort || typeof mod.SerialPort !== 'function') {
			throw new Error('Invalid serialport module shape.');
		}
		return mod.SerialPort;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`BT transport requires package "serialport". (${detail})`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BluetoothSppAdapter implements TransportAdapter {
	private readonly portPath: string;
	private readonly baudRate: number;
	private readonly dtr: boolean;
	private readonly postOpenDelayMs: number;
	private readonly serialPortFactory?: SerialPortConstructor;

	private port?: SerialPortLike;
	private opened = false;
	private opening?: Promise<void>;
	private closing = false;
	private receiveBuffer: Buffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;

	public constructor(options: BluetoothSppAdapterOptions) {
		this.portPath = options.portPath.trim();
		this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
		this.dtr = options.dtr ?? false;
		this.postOpenDelayMs = options.postOpenDelayMs ?? DEFAULT_POST_OPEN_DELAY_MS;
		this.serialPortFactory = options._serialPortFactory;
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
		this.rejectPendingReply(new Error('BT transport closed while waiting for reply.'));
		this.receiveBuffer = Buffer.alloc(0);

		const port = this.port;
		this.port = undefined;
		if (!port) {
			this.closing = false;
			return;
		}

		port.removeAllListeners();

		if (!port.isOpen) {
			this.closing = false;
			return;
		}

		await new Promise<void>((resolve) => {
			let settled = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
					timeoutHandle = undefined;
				}
				resolve();
			};
			port.close((error) => {
				if (error) {
					// Ignore close errors — port may already be dead
				}
				finish();
			});
			timeoutHandle = setTimeout(finish, PORT_CLOSE_GRACE_MS);
			timeoutHandle.unref?.();
		});

		this.closing = false;
	}

	public async send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array> {
		const port = this.requireReadyPort();
		if (this.pendingReply) {
			throw new Error('BT transport already has in-flight send request.');
		}
		if (options.signal.aborted) {
			throw new Error('BT send aborted before dispatch.');
		}

		return new Promise<Uint8Array>((resolve, reject) => {
			const onAbort = () => {
				this.rejectPendingReply(new Error('BT send aborted.'));
			};
			const cleanup = () => options.signal.removeEventListener('abort', onAbort);
			options.signal.addEventListener('abort', onAbort, { once: true });

			this.pendingReply = {
				resolve,
				reject,
				cleanup,
				expectedMessageCounter: options.expectedMessageCounter
			};

			port.write(Buffer.from(packet), (error?: Error | null) => {
				if (error) {
					this.rejectPendingReply(error);
					return;
				}
				this.drainPendingReply();
			});
		});
	}

	private async openInternal(): Promise<void> {
		if (!this.portPath) {
			throw new Error('BT adapter requires a non-empty port path (e.g. COM5).');
		}

		const SerialPort = this.serialPortFactory ?? loadSerialPort();
		const port = new SerialPort({
			path: this.portPath,
			baudRate: this.baudRate,
			autoOpen: false
		});

		await new Promise<void>((resolve, reject) => {
			port.open((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});

		// Set DTR signal for EV3 firmware settling
		await new Promise<void>((resolve, reject) => {
			port.set({ dtr: this.dtr }, (error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});

		if (this.postOpenDelayMs > 0) {
			await sleep(this.postOpenDelayMs);
		}

		this.port = port;
		this.receiveBuffer = Buffer.alloc(0);
		this.opened = true;

		port.on('data', (chunk: Buffer) => {
			this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
			this.drainPendingReply();
		});
		port.on('error', (error) => this.handleFailure(error));
		port.on('close', () => this.handleFailure(new Error('BT serial port closed.')));
	}

	private extractNextPacket(): Uint8Array | undefined {
		const result = extractLengthPrefixedPacket(this.receiveBuffer);
		if (!result) {
			return undefined;
		}
		this.receiveBuffer = result.remaining;
		return result.packet;
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

	private requireReadyPort(): SerialPortLike {
		if (!this.port || !this.opened) {
			throw new Error('BT transport is not open.');
		}
		return this.port;
	}
}
