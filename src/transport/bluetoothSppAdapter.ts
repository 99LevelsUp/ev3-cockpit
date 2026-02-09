import {
	PendingReply,
	drainPendingReply,
	rejectPendingReply,
	extractLengthPrefixedPacket
} from './pendingReply';
import { TransportAdapter, TransportRequestOptions } from './transportAdapter';

interface SerialPortLike {
	open(callback: (error?: Error | null) => void): void;
	close(callback: (error?: Error | null) => void): void;
	write(data: Buffer, callback: (error?: Error | null) => void): void;
	removeAllListeners(event?: string): this;
	on(event: 'data', listener: (chunk: Buffer) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
	on(event: 'close', listener: () => void): this;
}

type SerialPortCtor = new (options: {
	path: string;
	baudRate: number;
	autoOpen: boolean;
	dtr?: boolean;
}) => SerialPortLike;

export interface BluetoothSppAdapterOptions {
	port: string;
	baudRate?: number;
	dtr?: boolean;
}

function loadSerialPortCtor(): SerialPortCtor {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('serialport') as
			| { SerialPort?: SerialPortCtor }
			| SerialPortCtor;

		if (typeof mod === 'function') {
			return mod;
		}

		if (mod && typeof mod === 'object' && typeof mod.SerialPort === 'function') {
			return mod.SerialPort;
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Bluetooth transport requires package "serialport". (${detail})`);
	}

	throw new Error('Bluetooth transport could not load serialport module.');
}

export class BluetoothSppAdapter implements TransportAdapter {
	private readonly portPath: string;
	private readonly baudRate: number;
	private readonly dtr: boolean;

	private port?: SerialPortLike;
	private opening?: Promise<void>;
	private opened = false;
	private closing = false;
	private receiveBuffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;

	public constructor(options: BluetoothSppAdapterOptions) {
		this.portPath = options.port;
		this.baudRate = options.baudRate ?? 115_200;
		this.dtr = options.dtr ?? false;
	}

	public async open(): Promise<void> {
		if (this.opened) {
			return;
		}

		if (!this.portPath) {
			throw new Error('Bluetooth SPP transport requires non-empty serial port path (for example COM5).');
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
		this.rejectPendingReply(new Error('Bluetooth SPP transport closed while waiting for reply.'));
		this.receiveBuffer = Buffer.alloc(0);

		const port = this.port;
		this.port = undefined;
		if (!port) {
			this.closing = false;
			return;
		}

		await new Promise<void>((resolve) => {
			port.close(() => resolve());
		});
		port.removeAllListeners();
		this.closing = false;
	}

	public async send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array> {
		const port = this.requirePort();
		if (this.pendingReply) {
			throw new Error('Bluetooth SPP transport already has in-flight send request.');
		}

		if (options.signal.aborted) {
			throw new Error('Bluetooth SPP send aborted before dispatch.');
		}

		return new Promise<Uint8Array>((resolve, reject) => {
			const onAbort = () => {
				this.rejectPendingReply(new Error('Bluetooth SPP send aborted.'));
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
		const SerialPort = loadSerialPortCtor();
		const port = new SerialPort({
			path: this.portPath,
			baudRate: this.baudRate,
			autoOpen: false,
			dtr: this.dtr
		});

		await new Promise<void>((resolve, reject) => {
			port.open((error?: Error | null) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});

		this.port = port;
		this.receiveBuffer = Buffer.alloc(0);
		this.opened = true;

		port.on('data', (chunk) => {
			this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
			this.drainPendingReply();
		});
		port.on('error', (error) => this.handleFailure(error));
		port.on('close', () => this.handleFailure(new Error('Bluetooth serial port closed.')));
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

	private requirePort(): SerialPortLike {
		if (!this.port || !this.opened) {
			throw new Error('Bluetooth SPP transport is not open.');
		}

		return this.port;
	}
}
