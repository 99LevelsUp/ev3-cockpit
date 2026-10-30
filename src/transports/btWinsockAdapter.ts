/**
 * Bluetooth RFCOMM transport over a Winsock2 `AF_BTH` socket.
 *
 * The preferred BT backend. The testlab compared the candidates against live bricks and
 * chose this one; {@link BtSppAdapter} stays behind it as the path that needs no FFI.
 *
 * Nothing here paces connections. That belongs to `BtTransportProvider` and its
 * `BtConnectionQueue`, where every brick's attempts are visible at once; an adapter that also
 * queued would either deadlock against the provider's slot or serve a second cooldown on top.
 */

import { describeAddress } from '../contracts';
import { TransportAdapter, SendOptions } from './transportAdapter';
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
	Winsock2Api,
	SocketHandle,
	loadWinsock2,
	macToBtAddr,
	isInvalidSocket,
	AF_BTH,
	BTHPROTO_RFCOMM,
	SOCK_STREAM,
	SOCKET_ERROR,
	EV3_RFCOMM_CHANNEL,
	WSAEWOULDBLOCK,
} from './windowsWinsock';

/** How often a connect in progress is checked (ms). Each check is two zero-timeout `select`s. */
const CONNECT_POLL_MS = 50;

/** WSAETIMEDOUT, WSAEHOSTDOWN, WSAEHOSTUNREACH: a connect the brick never answered. */
const WSA_UNANSWERED = new Set([10060, 10064, 10065]);

/**
 * Receive poll interval while an exchange is outstanding (ms).
 *
 * The measured round trip is 55–70 ms, so this adds under a tenth of it to the reply.
 */
const ACTIVE_POLL_MS = 5;

/**
 * Receive poll interval with nothing outstanding (ms).
 *
 * A deliberate divergence from the testlab original, which polls every 5 ms for as long as
 * the socket is open. That is right for a CLI run that lasts a minute and wrong for an
 * extension host that stays up all day: 200 wakeups a second per connected brick, to read
 * a channel that by protocol has nothing to say.
 *
 * The link is strictly request-reply — the brick never speaks unprompted — so idle really
 * does mean no data is expected. The only thing the slower tick delays is noticing that the
 * peer went away, by at most this interval, and a quarter of a second is far inside the
 * heartbeat that acts on it.
 */
const IDLE_POLL_MS = 250;

/** Receive buffer per `recv` call. Twice the firmware's frame, so a full reply lands whole. */
const RECV_CHUNK_BYTES = 2048;

/** Configuration for {@link BtWinsockAdapter}. */
export interface BtWinsockAdapterOptions {
	/** Peer MAC address. Any separator, or none. */
	mac: string;
	/** RFCOMM channel (default: {@link EV3_RFCOMM_CHANNEL}). */
	channel?: number;
	/** Deadline for the connect (default: `BT.CONNECT_TIMEOUT_MS`). */
	connectTimeoutMs?: number;
	/**
	 * Overrides the Winsock bindings.
	 *
	 * Exists so the paths that matter can be exercised without a radio: a connect that
	 * never returns, a write the stack only partly accepts, a peer that closes mid-exchange.
	 * All three are hard to stage on hardware and each one has a recovery that is wrong
	 * until something proves otherwise.
	 */
	winsockApi?: Winsock2Api;
}

/**
 * BT RFCOMM transport adapter over Winsock2.
 */
export class BtWinsockAdapter implements TransportAdapter {
	private readonly mac: string;
	private readonly channel: number;
	private readonly connectTimeoutMs: number;
	private readonly injectedApi?: Winsock2Api;

	private api?: Winsock2Api;
	private socket?: SocketHandle;
	private _isOpen = false;
	private closing = false;
	private receiveBuffer: Buffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;
	private pollTimer?: ReturnType<typeof setTimeout>;

	constructor(options: BtWinsockAdapterOptions) {
		if (!options.mac?.trim()) {
			throw new TransportError('BT Winsock adapter requires a MAC address.');
		}
		this.mac = options.mac.trim();
		this.channel = options.channel ?? EV3_RFCOMM_CHANNEL;
		this.connectTimeoutMs = options.connectTimeoutMs ?? BT.CONNECT_TIMEOUT_MS;
		this.injectedApi = options.winsockApi;
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	/**
	 * Opens the RFCOMM channel. One attempt — the pacing belongs to `BtConnectionQueue`.
	 *
	 * @throws {BackendUnavailableError} When this host cannot run the backend at all, which
	 *   tells the provider it may try the next one immediately. Every other failure touched
	 *   the radio and leaves the channel settling.
	 */
	async open(): Promise<void> {
		if (this._isOpen) { return; }

		// Before anything else, because both of these fail without touching the radio.
		const api = this.injectedApi ?? loadWinsock2();
		const btAddr = macToBtAddr(this.mac);
		if (btAddr === undefined) {
			throw new BackendUnavailableError(`Not a MAC address: ${this.mac}`);
		}

		const socket = api.socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM);
		if (isInvalidSocket(socket)) {
			throw new BackendUnavailableError(
				`Windows refused a Bluetooth socket (WSA error ${api.lastError()}). `
				+ 'Usually means the host has no Bluetooth radio, or it is switched off.'
			);
		}

		// Non-blocking, and checked from a timer on this thread. The blocking connect this
		// replaced ran on a koffi worker and was "aborted" by closing the socket from here;
		// measured 29.10.2026, that did not end the blocked call, and after four deadlines in
		// one process Bluetooth stopped working until the process exited. Nothing below
		// blocks, so a deadline is a plain `closesocket` on a socket nobody is waiting in.
		const failed = (code: number): TransportError => {
			api.closesocket(socket);
			const message = `BT connect to ${describeAddress(this.mac)} failed (WSA error ${code}).`;
			// Timed out, host down, host unreachable: the brick did not answer.
			return WSA_UNANSWERED.has(code) ? new BrickUnreachableError(message) : new TransportError(message);
		};
		if (api.setNonBlocking(socket, true) !== 0) {
			throw failed(api.lastError());
		}

		let started: number;
		try {
			started = api.connect(socket, {
				addressFamily: AF_BTH,
				btAddr,
				serviceClassId: new Uint8Array(16),
				port: this.channel,
			});
		} catch (error) {
			// The FFI itself threw. A handle left open here would have nothing referencing it.
			api.closesocket(socket);
			throw new TransportError(`BT connect to ${describeAddress(this.mac)} failed.`, error);
		}
		if (started === SOCKET_ERROR) {
			// Read on this thread, straight after the call: the error code is per thread, and
			// reading it anywhere else reports whatever that thread did last.
			const code = api.lastError();
			if (code !== WSAEWOULDBLOCK) { throw failed(code); }

			const deadline = Date.now() + this.connectTimeoutMs;
			for (;;) {
				const state = api.connectState(socket);
				if (state === 'connected') { break; }
				if (state === 'failed') { throw failed(api.socketError(socket)); }
				if (Date.now() >= deadline) {
					api.closesocket(socket);
					throw new TimeoutError(
						`BT connect to ${describeAddress(this.mac)} timed out after ${this.connectTimeoutMs} ms.`
					);
				}
				// Never sleep past the deadline: a connect that lands after it was given up on is
				// not adopted, because its socket is already closed by then.
				const pause = Math.max(0, Math.min(CONNECT_POLL_MS, deadline - Date.now()));
				await new Promise((resolve) => setTimeout(resolve, pause));
			}
		}

		// Back to blocking for the exchange path, which was written for it and polls with
		// `select` before every `recv` anyway.
		if (api.setNonBlocking(socket, false) !== 0) {
			throw failed(api.lastError());
		}

		this.api = api;
		this.socket = socket;
		this.receiveBuffer = Buffer.alloc(0);
		this.closing = false;
		this._isOpen = true;
		this.schedulePoll();
	}

	/**
	 * Closes the socket.
	 *
	 * Synchronous underneath — `closesocket` returns immediately — and the promise is here
	 * only because {@link TransportAdapter} is written for links where it is not.
	 */
	close(): Promise<void> {
		this.closing = true;
		this._isOpen = false;

		if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
		this.doRejectPendingReply(new TransportError('BT Winsock adapter closed while waiting for reply.'));
		this.receiveBuffer = Buffer.alloc(0);

		const { api, socket } = this;
		this.api = undefined;
		this.socket = undefined;
		if (api && socket !== undefined) { api.closesocket(socket); }

		this.closing = false;
		return Promise.resolve();
	}

	async send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array> {
		const { api, socket } = this;
		if (!api || socket === undefined || !this._isOpen) {
			throw new TransportError('BT Winsock adapter is not open.');
		}
		if (this.pendingReply) {
			throw new TransportError('BT Winsock adapter already has in-flight send request.');
		}
		if (options?.signal?.aborted) {
			throw new TransportError('BT Winsock send aborted before dispatch.');
		}

		// EV3 is strictly request-reply on this channel, so nothing legitimate is in the
		// buffer between exchanges. A late fragment from an abandoned one is, and it would
		// desync every reply after it.
		this.receiveBuffer = Buffer.alloc(0);

		return new Promise<Uint8Array>((resolve, reject) => {
			this.pendingReply = createPendingReply({
				resolve,
				reject,
				fail: (error) => this.failExchange(error),
				timeoutMs: options?.timeoutMs ?? BT.SEND_TIMEOUT_MS,
				signal: options?.signal,
				expectedMessageCounter: options?.expectedMessageCounter,
				transport: 'BT Winsock',
			});

			try {
				this.writeAll(api, socket, packet);
			} catch (error) {
				this.doRejectPendingReply(error);
				return;
			}
			// A reply cannot already be here, but the wait should run at the fast cadence
			// from now rather than from whenever the idle tick next comes round.
			this.schedulePoll();
		});
	}

	// ── Internal ────────────────────────────────────────────────────

	/**
	 * Writes the whole packet, however many calls that takes.
	 *
	 * `send` is allowed to accept less than it was offered, and on a 115200-baud link with a
	 * full frame it will. Ignoring the return value would put a truncated command on the
	 * wire, which the brick answers with a parse error at best and acts on at worst.
	 */
	private writeAll(api: Winsock2Api, socket: SocketHandle, packet: Uint8Array): void {
		let sent = 0;
		while (sent < packet.length) {
			const written = api.send(socket, packet.subarray(sent), packet.length - sent);
			if (written === SOCKET_ERROR) {
				throw new TransportError(`BT Winsock send failed (WSA error ${api.lastError()}).`);
			}
			if (written <= 0) {
				throw new TransportError(
					`BT Winsock send stalled after ${sent} of ${packet.length} bytes.`
				);
			}
			sent += written;
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
		const { api, socket } = this;
		if (!api || socket === undefined || !this._isOpen || this.closing) { return; }

		while (api.hasPendingData(socket) > 0) {
			const chunk = Buffer.alloc(RECV_CHUNK_BYTES);
			const read = api.recv(socket, chunk, RECV_CHUNK_BYTES);

			if (read === SOCKET_ERROR) {
				this.handleFailure(new TransportError(
					`BT Winsock receive failed (WSA error ${api.lastError()}).`
				));
				return;
			}
			if (read === 0) {
				// Winsock reports a peer's orderly shutdown as a zero-length read.
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

	/**
	 * Abandon the current exchange and leave the adapter usable: drop the latch and discard
	 * the buffer, so a late or partial frame cannot bleed into the next send.
	 */
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
	}
}
