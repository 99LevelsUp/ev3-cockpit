/**
 * Shared pending-reply logic used by TCP, USB HID, and Bluetooth SPP transport adapters.
 */

export interface PendingReply {
	resolve: (packet: Uint8Array) => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
	expectedMessageCounter?: number;
}

export function getMessageCounter(packet: Uint8Array): number {
	if (packet.length < 4) {
		return -1;
	}
	return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(2, true);
}

/**
 * Drains a pending reply from the receive buffer by calling extractNextPacket
 * in a loop and matching against the expected message counter.
 *
 * Returns the new pendingReply state (undefined if resolved).
 */
export function drainPendingReply(
	pendingReply: PendingReply | undefined,
	extractNextPacket: () => Uint8Array | undefined
): PendingReply | undefined {
	if (!pendingReply) {
		return undefined;
	}

	let packet = extractNextPacket();
	while (packet) {
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
 * Rejects a pending reply with the given error.
 * Returns undefined (the new pendingReply state).
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
 * Used by TCP and Bluetooth SPP adapters which share the same framing.
 *
 * Returns the extracted packet and updated buffer, or undefined if incomplete.
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

	const packet = Buffer.from(receiveBuffer.subarray(0, totalLength));
	const remaining = receiveBuffer.subarray(totalLength);
	return { packet: new Uint8Array(packet), remaining: Buffer.from(remaining) };
}
