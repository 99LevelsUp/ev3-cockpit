/**
 * Raw I/O interface for transport adapters.
 *
 * Transport adapters handle only physical communication (open, close, send/receive bytes).
 * They know nothing about EV3 protocol encoding — that is handled by the protocol layer.
 * Each adapter implements a single transport wire: USB HID, TCP socket, or BT RFCOMM.
 */

export interface SendOptions {
	/** Per-command timeout in milliseconds. */
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
export interface TransportAdapter {
	/** Open the physical connection. */
	open(): Promise<void>;

	/** Close the physical connection and release resources. */
	close(): Promise<void>;

	/** Send a framed packet and receive the reply. */
	send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array>;

	/** Whether the adapter is currently open. */
	readonly isOpen: boolean;
}
