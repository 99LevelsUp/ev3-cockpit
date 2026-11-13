/**
 * Raw I/O interface for transport adapters.
 *
 * Transport adapters handle only physical communication (open, close, send/receive bytes).
 * They know nothing about EV3 protocol encoding — that is handled by the protocol layer.
 * Each adapter implements a single transport wire: USB HID, TCP socket, or BT RFCOMM.
 */

export interface SendOptions {
	/**
	 * Round-trip budget in milliseconds. Defaults to the transport's
	 * `SEND_TIMEOUT_MS`. On expiry the send rejects with `TimeoutError` and the
	 * adapter discards the exchange so the next send starts clean.
	 *
	 * Zero or less disables the timer entirely and the send waits indefinitely.
	 */
	timeoutMs?: number;
	/** Abort signal for cooperative cancellation. */
	signal?: AbortSignal;
	/** Expected message counter in the reply (for validation). */
	expectedMessageCounter?: number;
}

/**
 * Raw transport adapter that sends and receives byte packets.
 *
 * Lifecycle: `open()` → `send()` (repeated) → `close()`.
 * Implementations must be safe to call `close()` even if `open()` was never called.
 */
/** Options for {@link TransportAdapter.open}. */
export interface OpenOptions {
	/** Aborted when whoever asked for the link no longer wants it: a dispose, a close. */
	signal?: AbortSignal;
}

export interface TransportAdapter {
	/**
	 * Open the physical connection.
	 *
	 * An adapter that waits while opening checks `signal` after each wait; aborted, it gives back
	 * what it took and rejects with the signal's reason (the provider's lifetime scope).
	 */
	open(options?: OpenOptions): Promise<void>;

	/** Close the physical connection and release resources. */
	close(): Promise<void>;

	/** Send a framed packet and receive the reply. */
	send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array>;

	/** Whether the adapter is currently open. */
	readonly isOpen: boolean;

	/**
	 * Largest packet this link carries, or `undefined` to use the firmware's own buffer.
	 *
	 * A property of the open link rather than of the transport: the same USB brick carries
	 * 1024 bytes over libusb and 64 over HID, and everything above — transfer chunking,
	 * and whether a two-path command fits at all — follows from which one is in use.
	 */
	readonly maxPacketBytes?: number;
}
