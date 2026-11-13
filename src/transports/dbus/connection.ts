/**
 * A connection to the D-Bus system bus, the cockpit's own (step-7 plan, U3, owner decision D1).
 *
 * Only what BlueZ needs: the `EXTERNAL` handshake (the bus knows the user from the socket),
 * `Hello`, method calls matched to their replies by serial, signals after an `AddMatch`, and
 * objects this side exports for BlueZ to call — the pairing agent. Measured on HOSTC (13.11.2026):
 * the default D-Bus policy lets a desktop user talk to `org.bluez` with no group and no `sudo`.
 */

import * as net from 'net';
import type { Duplex } from 'stream';

import { DBusValue } from './wire';
import { DBusMessage, FLAG_NO_REPLY_EXPECTED, MessageType, decodeMessage, encodeMessage } from './message';

/** The system bus socket, unless `DBUS_SYSTEM_BUS_ADDRESS` names another `unix:path=`. */
export const SYSTEM_BUS_SOCKET = '/run/dbus/system_bus_socket';

const BUS_NAME = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
const DEFAULT_CALL_TIMEOUT_MS = 25_000;

/** An error the other side answered with, or one this side answers with. */
export class DBusError extends Error {
	constructor(readonly dbusName: string, readonly detail: string) {
		super(`${dbusName}: ${detail}`);
		this.name = 'DBusError';
	}
}

export interface DBusConnectionOptions {
	/** An already-open stream to the bus. Default: the system bus socket. For tests. */
	stream?: Duplex;
	/** The socket path (default: {@link systemBusSocketPath}). */
	socketPath?: string;
	/** The uid the handshake names (default: this process's). */
	uid?: number;
	/** How long a call waits for its reply (default 25 s, the D-Bus convention). */
	callTimeoutMs?: number;
}

export interface CallOptions {
	destination: string;
	path: string;
	interface: string;
	member: string;
	signature?: string;
	body?: DBusValue[];
	timeoutMs?: number;
}

/** A method this side exports: its reply signature and what answers it. */
export interface ExportedMethod {
	/** The reply's signature; '' for an empty reply. */
	returns: string;
	handler: (args: DBusValue[], message: DBusMessage) => DBusValue[] | Promise<DBusValue[]>;
}

interface PendingCall {
	resolve: (body: DBusValue[]) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Where the system bus listens. */
export function systemBusSocketPath(env: NodeJS.ProcessEnv = process.env): string {
	const address = env.DBUS_SYSTEM_BUS_ADDRESS;
	const match = address?.match(/(?:^|;)unix:path=([^,;]+)/);
	return match ? match[1] : SYSTEM_BUS_SOCKET;
}

export class DBusConnection {
	/** The name the bus gave this connection (`:1.77`). */
	uniqueName = '';

	private buffer = Buffer.alloc(0);
	private serial = 0;
	private closed = false;
	private readonly pending = new Map<number, PendingCall>();
	private readonly signalHandlers = new Set<(message: DBusMessage) => void>();
	private readonly closeHandlers = new Set<() => void>();
	private readonly exported = new Map<string, { interface: string; methods: Record<string, ExportedMethod> }>();
	private authWaiter?: { line: (text: string) => void; fail: (error: Error) => void };
	private authenticated = false;

	private constructor(private readonly stream: Duplex, private readonly callTimeoutMs: number) {
		stream.on('data', (chunk: Buffer) => this.onData(chunk));
		const gone = (): void => this.shutDown(new Error('D-Bus connection closed.'));
		stream.on('end', gone);
		stream.on('close', gone);
		stream.on('error', (error: Error) => this.shutDown(new Error(`D-Bus connection closed: ${error.message}`)));
	}

	/**
	 * Connects, authenticates and says `Hello`.
	 *
	 * @throws When the bus cannot be reached, rejects the handshake, or does not answer `Hello`.
	 */
	static async open(options: DBusConnectionOptions = {}): Promise<DBusConnection> {
		const uid = options.uid ?? process.getuid?.();
		if (uid === undefined) { throw new Error('D-Bus: this platform has no uid to authenticate with.'); }
		const stream = options.stream ?? net.createConnection(options.socketPath ?? systemBusSocketPath());
		const connection = new DBusConnection(stream, options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
		try {
			await connection.authenticate(uid);
			const [name] = await connection.call({ destination: BUS_NAME, path: BUS_PATH, interface: BUS_NAME, member: 'Hello' });
			connection.uniqueName = String(name);
			return connection;
		} catch (error) {
			connection.close();
			throw error;
		}
	}

	/** Calls a method and resolves with the reply's body. @throws {DBusError} The error the callee answered. */
	call(options: CallOptions): Promise<DBusValue[]> {
		if (this.closed) { return Promise.reject(new Error('D-Bus connection closed.')); }
		const serial = this.nextSerial();
		return new Promise<DBusValue[]>((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? this.callTimeoutMs;
			const timer = setTimeout(() => {
				this.pending.delete(serial);
				reject(new Error(`D-Bus call ${options.interface}.${options.member} timed out after ${timeoutMs} ms.`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(serial, { resolve, reject, timer });
			try {
				this.write({
					type: MessageType.MethodCall, flags: 0, serial,
					destination: options.destination, path: options.path,
					interface: options.interface, member: options.member,
					...(options.signature ? { signature: options.signature } : {}),
					body: options.body ?? [],
				});
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(serial);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** Asks the bus to deliver signals matching `rule` to this connection. */
	async addMatch(rule: string): Promise<void> {
		await this.call({ destination: BUS_NAME, path: BUS_PATH, interface: BUS_NAME, member: 'AddMatch', signature: 's', body: [rule] });
	}

	/** Hears every signal delivered to this connection; the caller filters. @returns Removes the handler. */
	onSignal(handler: (message: DBusMessage) => void): () => void {
		this.signalHandlers.add(handler);
		return () => { this.signalHandlers.delete(handler); };
	}

	/** Told once when the connection ends, from either side. */
	onClose(handler: () => void): () => void {
		this.closeHandlers.add(handler);
		return () => { this.closeHandlers.delete(handler); };
	}

	/** Answers calls to `path` on `iface`. @returns Withdraws the object. */
	exportObject(path: string, iface: string, methods: Record<string, ExportedMethod>): () => void {
		const entry = { interface: iface, methods };
		this.exported.set(path, entry);
		return () => { if (this.exported.get(path) === entry) { this.exported.delete(path); } };
	}

	get isOpen(): boolean {
		return !this.closed;
	}

	close(): void {
		this.shutDown(new Error('D-Bus connection closed.'));
		this.stream.destroy();
	}

	// ── Internal ────────────────────────────────────────────────────

	private nextSerial(): number {
		this.serial = this.serial >= 0xffffffff ? 1 : this.serial + 1;
		return this.serial;
	}

	private write(message: DBusMessage): void {
		this.stream.write(encodeMessage(message));
	}

	private authenticate(uid: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('D-Bus authentication timed out.')), this.callTimeoutMs);
			timer.unref?.();
			this.authWaiter = {
				line: (text) => {
					clearTimeout(timer);
					this.authWaiter = undefined;
					if (text.startsWith('OK ')) {
						this.stream.write('BEGIN\r\n');
						this.authenticated = true;
						resolve();
						// Anything that came after the OK line is already a message.
						this.drainMessages();
					} else {
						reject(new Error(`D-Bus authentication rejected: ${text}`));
					}
				},
				fail: (error) => { clearTimeout(timer); reject(error); },
			};
			// The handshake begins with one NUL byte; the uid goes as hex digits of its decimal text.
			this.stream.write(Buffer.concat([Buffer.alloc(1), Buffer.from(`AUTH EXTERNAL ${Buffer.from(String(uid)).toString('hex')}\r\n`)]));
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (!this.authenticated) {
			const end = this.buffer.indexOf('\r\n');
			if (end < 0 || !this.authWaiter) { return; }
			const line = this.buffer.subarray(0, end).toString('latin1');
			this.buffer = this.buffer.subarray(end + 2);
			this.authWaiter.line(line);
			return;
		}
		this.drainMessages();
	}

	private drainMessages(): void {
		for (;;) {
			let next: ReturnType<typeof decodeMessage>;
			try {
				next = decodeMessage(this.buffer);
			} catch (error) {
				// A stream this client cannot read is a broken connection, not a message to skip.
				this.close();
				return;
			}
			if (!next) { return; }
			this.buffer = this.buffer.subarray(next.length);
			this.dispatch(next.message);
		}
	}

	private dispatch(message: DBusMessage): void {
		switch (message.type) {
		case MessageType.MethodReturn:
		case MessageType.Error: {
			const call = message.replySerial !== undefined ? this.pending.get(message.replySerial) : undefined;
			if (!call) { return; }
			this.pending.delete(message.replySerial!);
			clearTimeout(call.timer);
			if (message.type === MessageType.Error) {
				call.reject(new DBusError(message.errorName ?? 'org.freedesktop.DBus.Error.Failed', String(message.body[0] ?? '')));
			} else {
				call.resolve(message.body);
			}
			return;
		}
		case MessageType.Signal:
			for (const handler of [...this.signalHandlers]) {
				try { handler(message); } catch { /* one handler's bug must not starve the others */ }
			}
			return;
		case MessageType.MethodCall:
			void this.answer(message);
			return;
		}
	}

	private async answer(call: DBusMessage): Promise<void> {
		const wantsReply = (call.flags & FLAG_NO_REPLY_EXPECTED) === 0;
		const reply = (fields: Partial<DBusMessage>): void => {
			if (!wantsReply || this.closed) { return; }
			this.write({
				type: MessageType.MethodReturn, flags: 0, serial: this.nextSerial(),
				replySerial: call.serial, ...(call.sender ? { destination: call.sender } : {}), body: [], ...fields,
			});
		};
		const error = (name: string, text: string): void => reply({ type: MessageType.Error, errorName: name, signature: 's', body: [text] });

		const object = call.path !== undefined ? this.exported.get(call.path) : undefined;
		if (!object) { error('org.freedesktop.DBus.Error.UnknownObject', `No object at ${call.path}.`); return; }
		const method = (call.interface === undefined || call.interface === object.interface) ? object.methods[call.member ?? ''] : undefined;
		if (!method) { error('org.freedesktop.DBus.Error.UnknownMethod', `No method ${call.interface}.${call.member} at ${call.path}.`); return; }
		try {
			const body = await method.handler(call.body, call);
			reply(method.returns ? { signature: method.returns, body } : {});
		} catch (thrown) {
			if (thrown instanceof DBusError) { error(thrown.dbusName, thrown.detail); return; }
			error('org.freedesktop.DBus.Error.Failed', thrown instanceof Error ? thrown.message : String(thrown));
		}
	}

	private shutDown(reason: Error): void {
		if (this.closed) { return; }
		this.closed = true;
		this.authWaiter?.fail(reason);
		this.authWaiter = undefined;
		for (const [, call] of this.pending) {
			clearTimeout(call.timer);
			call.reject(reason);
		}
		this.pending.clear();
		this.signalHandlers.clear();
		this.exported.clear();
		for (const handler of [...this.closeHandlers]) {
			try { handler(); } catch { /* closing anyway */ }
		}
		this.closeHandlers.clear();
	}
}
