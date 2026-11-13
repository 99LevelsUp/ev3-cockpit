/**
 * Bluetooth RFCOMM transport over a BlueZ socket on Linux (step-7 plan, U2, KTD3).
 *
 * The Linux counterpart of {@link BtWinsockAdapter}, and shaped like it on purpose: one attempt
 * per open, a non-blocking connect checked from a timer on this thread (a blocking connect on a
 * koffi worker could not be aborted on Windows, DESIGN §4.1.1), a fast receive poll while an
 * exchange is outstanding and a slow one otherwise, and replies found by their length prefix.
 *
 * Nothing here paces connections: the provider's per-brick gap after a close
 * (`BT.RECONNECT_GAP_AFTER_CLOSE_MS`) and its `BtConnectionQueue`, with the queue's own gaps
 * between connects, do. Measured on HOSTC (11.11.2026, three bricks): a reconnect 0 s after a
 * close answers `EBUSY`, within 2 s `ECONNREFUSED`, from 2.5 s it connects.
 */

import { describeAddress } from '../contracts';
import { TransportAdapter, SendOptions, OpenOptions } from './transportAdapter';
import { TransportError, TimeoutError, BackendUnavailableError, BrickUnreachableError } from '../errors/CockpitError';
import {
	PendingReply,
	createPendingReply,
	drainPendingReply,
	rejectPendingReply,
	extractLengthPrefixedPacket,
} from './pendingReply';
import { BT } from './transportConstants';
import {
	LinuxBtSocketApi,
	loadLinuxBtSocket,
	sockaddrRc,
	AF_BLUETOOTH,
	BTPROTO_RFCOMM,
	SOCK_STREAM,
	SOCK_NONBLOCK,
	SOCK_CLOEXEC,
	EINPROGRESS,
	EINTR,
	EAGAIN,
	EBUSY,
	ECONNREFUSED,
	EHOSTDOWN,
	EHOSTUNREACH,
	ETIMEDOUT,
} from './linuxBluetoothSocket';

/** The brick's only service, Serial Port, is on RFCOMM channel 1 (HOSTC, 11.11.2026). */
export const EV3_RFCOMM_CHANNEL_LINUX = 1;

/** How often a connect in progress is checked (ms); each check is one zero-timeout `poll`. */
const CONNECT_POLL_MS = 50;

/** Receive poll while an exchange is outstanding (ms); a reply takes 42–107 ms on Linux. */
const ACTIVE_POLL_MS = 5;

/** Receive poll with nothing outstanding (ms): the brick never speaks unprompted. */
const IDLE_POLL_MS = 250;

/** How often a write that would block checks whether the socket can take more (ms). */
const WRITE_POLL_MS = 5;

/** Receive buffer per `recv`: twice the firmware's frame, so a full reply lands whole. */
const RECV_CHUNK_BYTES = 2048;

/** The connect errors that mean the brick did not answer: off, out of range, or busy. */
const UNANSWERED = new Set([EHOSTDOWN, EHOSTUNREACH, ETIMEDOUT, ECONNREFUSED, EBUSY]);

/** Configuration for {@link BtBluezAdapter}. */
export interface BtBluezAdapterOptions {
	/** The brick's MAC address. Any separator, or none. */
	mac: string;
	/** RFCOMM channel (default: {@link EV3_RFCOMM_CHANNEL_LINUX}). */
	channel?: number;
	/** Deadline for the connect (default: `BT.CONNECT_TIMEOUT_MS`). */
	connectTimeoutMs?: number;
	/** Overrides the libc bindings, so every path can be driven without a radio. */
	socketApi?: LinuxBtSocketApi;
}

/** BT RFCOMM transport adapter over a BlueZ socket. */
export class BtBluezAdapter implements TransportAdapter {
	private readonly mac: string;
	private readonly channel: number;
	private readonly connectTimeoutMs: number;
	private readonly injectedApi?: LinuxBtSocketApi;

	private api?: LinuxBtSocketApi;
	private fd?: number;
	private _isOpen = false;
	private closing = false;
	private receiveBuffer: Buffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;
	private pollTimer?: ReturnType<typeof setTimeout>;
	/** The open in flight, which a second open() waits on rather than starting another. */
	private opening?: Promise<void>;
	/** Bumped by every close, so an open still waiting knows it was overtaken. */
	private generation = 0;

	constructor(options: BtBluezAdapterOptions) {
		if (!options.mac?.trim()) {
			throw new TransportError('BT BlueZ adapter requires a MAC address.');
		}
		this.mac = options.mac.trim();
		this.channel = options.channel ?? EV3_RFCOMM_CHANNEL_LINUX;
		this.connectTimeoutMs = options.connectTimeoutMs ?? BT.CONNECT_TIMEOUT_MS;
		this.injectedApi = options.socketApi;
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	/**
	 * Opens the RFCOMM channel. One attempt — the pacing belongs to the provider and its queue.
	 *
	 * @throws {BackendUnavailableError} When this host cannot run the backend at all (not Linux,
	 *   no koffi, no Bluetooth stack, not a MAC). Nothing touched the radio.
	 * @throws {BrickUnreachableError} When the brick did not answer.
	 */
	async open(options?: OpenOptions): Promise<void> {
		if (this._isOpen) { return; }
		if (this.opening) { return this.opening; }
		this.opening = this.openInternal(options?.signal).finally(() => { this.opening = undefined; });
		return this.opening;
	}

	private async openInternal(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		// Before anything else, because both fail without touching the radio.
		const api = this.injectedApi ?? loadLinuxBtSocket();
		const address = sockaddrRc(this.mac, this.channel);
		if (!address) {
			throw new BackendUnavailableError(`Not a MAC address and RFCOMM channel: ${this.mac}, ${this.channel}`);
		}

		const fd = api.socket(AF_BLUETOOTH, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, BTPROTO_RFCOMM);
		if (fd < 0) {
			throw new BackendUnavailableError(
				`Linux refused a Bluetooth socket (errno ${api.lastError()}). `
				+ 'Usually means there is no Bluetooth stack or radio, or it is switched off.'
			);
		}
		// Owned from the moment it exists: a close() from here on releases it, and an open it
		// overtook adopts nothing and closes nothing again.
		this.api = api;
		this.fd = fd;
		const generation = this.generation;
		const overtaken = (): boolean => generation !== this.generation;

		const failed = (code: number): TransportError => {
			this.releaseDescriptor();
			const busy = code === EBUSY ? ' — its channel was closed a moment ago' : '';
			const message = `BT connect to ${describeAddress(this.mac)} failed (errno ${code})${busy}.`;
			return UNANSWERED.has(code) ? new BrickUnreachableError(message) : new TransportError(message);
		};
		const closedWhileOpening = (): TransportError =>
			new TransportError(`BT connect to ${describeAddress(this.mac)} closed while it was opening.`);

		let started: number;
		try {
			started = api.connect(fd, address);
		} catch (error) {
			// The FFI itself threw; a descriptor left open here would have nothing referencing it.
			this.releaseDescriptor();
			throw new TransportError(`BT connect to ${describeAddress(this.mac)} failed.`, error);
		}
		if (started !== 0) {
			// Read straight after the call, on this thread: errno is per thread.
			const code = api.lastError();
			if (code !== EINPROGRESS) { throw failed(code); }

			const deadline = Date.now() + this.connectTimeoutMs;
			for (;;) {
				// State and error together: Linux clears SO_ERROR on reading it (review of 66cde2b).
				const { state, error } = api.connectState(fd);
				if (state === 'connected') { break; }
				if (state === 'failed') { throw failed(error); }
				if (Date.now() >= deadline) {
					this.releaseDescriptor();
					throw new TimeoutError(
						`BT connect to ${describeAddress(this.mac)} timed out after ${this.connectTimeoutMs} ms.`
					);
				}
				const pause = Math.max(0, Math.min(CONNECT_POLL_MS, deadline - Date.now()));
				await new Promise((resolve) => setTimeout(resolve, pause));
				// The close that overtook this open has already released the descriptor; an abort has
				// not, so this open does it.
				if (overtaken()) { throw closedWhileOpening(); }
				if (signal?.aborted) {
					this.releaseDescriptor();
					throw signal.reason;
				}
			}
		}

		this.receiveBuffer = Buffer.alloc(0);
		this.closing = false;
		this._isOpen = true;
		this.schedulePoll();
	}

	/** Closes the descriptor, including one still connecting. `close` returns at once (HOSTC: 0 ms). */
	close(): Promise<void> {
		this.generation += 1;
		this.closing = true;
		this._isOpen = false;

		if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
		this.doRejectPendingReply(new TransportError('BT BlueZ adapter closed while waiting for reply.'));
		this.receiveBuffer = Buffer.alloc(0);
		this.releaseDescriptor();

		this.closing = false;
		return Promise.resolve();
	}

	/** Closes the descriptor this adapter owns, once. */
	private releaseDescriptor(): void {
		const { api, fd } = this;
		this.api = undefined;
		this.fd = undefined;
		if (api && fd !== undefined) { api.close(fd); }
	}

	async send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array> {
		const { api, fd } = this;
		if (!api || fd === undefined || !this._isOpen) {
			throw new TransportError('BT BlueZ adapter is not open.');
		}
		if (this.pendingReply) {
			throw new TransportError('BT BlueZ adapter already has in-flight send request.');
		}
		if (options?.signal?.aborted) {
			throw new TransportError('BT BlueZ send aborted before dispatch.');
		}

		// Strictly request-reply: a late fragment from an abandoned exchange would desync the next.
		this.receiveBuffer = Buffer.alloc(0);

		return new Promise<Uint8Array>((resolve, reject) => {
			this.pendingReply = createPendingReply({
				resolve,
				reject,
				fail: (error) => this.failExchange(error),
				timeoutMs: options?.timeoutMs ?? BT.SEND_TIMEOUT_MS,
				signal: options?.signal,
				expectedMessageCounter: options?.expectedMessageCounter,
				transport: 'BT BlueZ',
			});

			const exchange = this.pendingReply;
			void this.writeAll(api, fd, packet, exchange).then(
				() => this.schedulePoll(),
				(error) => { if (this.pendingReply === exchange) { this.doRejectPendingReply(error); } },
			);
		});
	}

	// ── Internal ────────────────────────────────────────────────────

	/**
	 * Writes the whole packet on the non-blocking socket, waiting for room when it would block —
	 * within the exchange's own deadline and abort, which end it by settling `exchange`. A failure
	 * before the first byte fails the exchange only; one after it, or an exchange abandoned with
	 * part of the packet out, closes the link, because the brick would read the next packet as the
	 * tail of this one (ownership audit, round 4). Never blocks the extension host's thread.
	 */
	private async writeAll(api: LinuxBtSocketApi, fd: number, packet: Uint8Array, exchange: PendingReply | undefined): Promise<void> {
		const generation = this.generation;
		let sent = 0;
		const abandoned = (): boolean => generation !== this.generation || this.pendingReply !== exchange;
		const cut = (why: string): TransportError => {
			const error = new TransportError(`BT BlueZ ${why} after ${sent} of ${packet.length} bytes; link closed.`);
			if (generation === this.generation) { this.handleFailure(error); }
			return error;
		};
		while (sent < packet.length) {
			if (abandoned()) {
				// Timed out, aborted or closed: the exchange is already settled.
				if (sent > 0) { cut('send abandoned'); }
				return;
			}
			const written = api.send(fd, packet.subarray(sent), packet.length - sent);
			if (written > 0) { sent += written; continue; }
			const code = written < 0 ? api.lastError() : 0;
			if (written < 0 && code === EINTR) { continue; }
			if (written < 0 && code === EAGAIN) {
				while (!api.canWrite(fd) && !abandoned()) {
					await new Promise((resolve) => setTimeout(resolve, WRITE_POLL_MS));
				}
				continue;
			}
			const why = written < 0 ? `send failed (errno ${code})` : 'send stalled';
			if (sent === 0) { throw new TransportError(`BT BlueZ ${why}.`); }
			throw cut(why);
		}
	}

	private schedulePoll(): void {
		if (!this._isOpen || this.closing) { return; }
		if (this.pollTimer) { clearTimeout(this.pollTimer); }
		const delay = this.pendingReply ? ACTIVE_POLL_MS : IDLE_POLL_MS;
		this.pollTimer = setTimeout(() => this.pollReceive(), delay);
		this.pollTimer.unref?.();
	}

	private pollReceive(): void {
		this.pollTimer = undefined;
		const { api, fd } = this;
		if (!api || fd === undefined || !this._isOpen || this.closing) { return; }

		while (api.hasPendingData(fd)) {
			const chunk = Buffer.alloc(RECV_CHUNK_BYTES);
			const read = api.recv(fd, chunk, RECV_CHUNK_BYTES);

			if (read < 0) {
				const code = api.lastError();
				if (code === EINTR) { continue; }
				// The poll said readable and the read found nothing: nothing yet, not a failure.
				if (code === EAGAIN) { break; }
				this.handleFailure(new TransportError(`BT BlueZ receive failed (errno ${code}).`));
				return;
			}
			if (read === 0) {
				this.handleFailure(new TransportError('BT connection closed by the brick.'));
				return;
			}

			this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk.subarray(0, read)]);
			this.doDrainPendingReply();
		}

		this.schedulePoll();
	}

	private doDrainPendingReply(): void {
		this.pendingReply = drainPendingReply(this.pendingReply, () => this.extractNextPacket());
	}

	private extractNextPacket(): Uint8Array | undefined {
		const result = extractLengthPrefixedPacket(this.receiveBuffer);
		if (!result) { return undefined; }
		this.receiveBuffer = result.remaining;
		return result.packet;
	}

	/** Abandons the current exchange and leaves the adapter usable. */
	private failExchange(error: unknown): void {
		this.receiveBuffer = Buffer.alloc(0);
		this.doRejectPendingReply(error);
	}

	private doRejectPendingReply(error: unknown): void {
		this.pendingReply = rejectPendingReply(this.pendingReply, error);
	}

	private handleFailure(error: unknown): void {
		if (this.closing) { return; }
		this._isOpen = false;
		if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
		this.doRejectPendingReply(error);
		// The descriptor is useless now; release it rather than wait for a close nobody may send.
		this.releaseDescriptor();
	}
}
