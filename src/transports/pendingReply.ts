/**
 * Shared pending-reply logic used by USB HID, TCP, and Bluetooth transport adapters.
 *
 * Handles EV3 message counter matching, length-prefixed packet extraction,
 * and drain loops for receive buffers.
 */

/** State for a single outstanding send-and-wait-for-reply operation. */
export interface PendingReply {
	/** Called when the matching reply packet arrives. */
	resolve: (packet: Uint8Array) => void;
	/** Called on timeout, cancellation, or transport error. */
	reject: (error: unknown) => void;
	/** Releases any timers or abort listeners associated with this reply. */
	cleanup: () => void;
	/** EV3 message counter to match in the reply, or `undefined` to accept any. */
	expectedMessageCounter?: number;
}

/**
 * Reads the 16-bit EV3 message counter from bytes 2–3 of a raw packet.
 *
 * @returns The message counter, or `-1` if the packet is too short.
 */
export function getMessageCounter(packet: Uint8Array): number {
	if (packet.length < 4) {
		return -1;
	}
	return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(2, true);
}

/** Maximum packets to consume per drain call to prevent CPU spin. */
const MAX_DRAIN_ITERATIONS = 64;

/**
 * Drains a pending reply by extracting packets from the receive buffer
 * and matching against the expected message counter.
 *
 * @returns `undefined` if resolved, or the original pending reply if no match was found.
 */
export function drainPendingReply(
	pendingReply: PendingReply | undefined,
	extractNextPacket: () => Uint8Array | undefined
): PendingReply | undefined {
	if (!pendingReply) {
		return undefined;
	}

	let iterations = 0;
	let packet = extractNextPacket();
	while (packet && iterations < MAX_DRAIN_ITERATIONS) {
		iterations += 1;
		const expected = pendingReply.expectedMessageCounter;
		if (expected === undefined || getMessageCounter(packet) === expected) {
			pendingReply.cleanup();
			pendingReply.resolve(packet);
			return undefined;
		}
		packet = extractNextPacket();
	}
	return pendingReply;
}

/**
 * Rejects a pending reply with the given error, cleaning up resources.
 *
 * @returns Always `undefined` (the cleared state).
 */
export function rejectPendingReply(
	pendingReply: PendingReply | undefined,
	error: unknown
): undefined {
	if (!pendingReply) {
		return undefined;
	}
	pendingReply.cleanup();
	pendingReply.reject(error);
	return undefined;
}

/**
 * Extracts the next length-prefixed EV3 packet from a receive buffer.
 * Used by TCP and Bluetooth SPP adapters which share 2-byte LE length-prefix framing.
 *
 * @returns The extracted packet and remaining buffer, or `undefined` if incomplete.
 */
export function extractLengthPrefixedPacket(
	receiveBuffer: Buffer
): { packet: Uint8Array; remaining: Buffer } | undefined {
	if (receiveBuffer.length < 2) {
		return undefined;
	}

	const bodyLength = receiveBuffer.readUInt16LE(0);
	const totalLength = bodyLength + 2;
	if (receiveBuffer.length < totalLength) {
		return undefined;
	}

	const packetBuf = Buffer.alloc(totalLength);
	receiveBuffer.copy(packetBuf, 0, 0, totalLength);
	const remainBuf = Buffer.alloc(receiveBuffer.length - totalLength);
	receiveBuffer.copy(remainBuf, 0, totalLength);
	return { packet: new Uint8Array(packetBuf), remaining: remainBuf };
}
