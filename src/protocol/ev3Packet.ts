/**
 * Parsed EV3 packet structure.
 *
 * @remarks
 * Wire format: `[bodyLength:u16le] [messageCounter:u16le] [type:u8] [payload:u8[]]`
 * where `bodyLength = 2 (counter) + 1 (type) + payload.length`.
 */
export interface Ev3Packet {
	/** Sequence number for matching requests with replies (0–65535). */
	messageCounter: number;
	/** Command or reply type byte (see {@link EV3_COMMAND} and {@link EV3_REPLY}). */
	type: number;
	/** Variable-length payload following the type byte. */
	payload: Uint8Array;
}

/** Minimum valid EV3 packet size: 2 (length) + 2 (counter) + 1 (type). */
const MIN_PACKET_BYTES = 5;

/**
 * Encodes an EV3 packet into its wire format.
 *
 * @param messageCounter - Sequence number (will be masked to 16 bits)
 * @param type - Command type byte (e.g. {@link EV3_COMMAND.DIRECT_COMMAND_REPLY})
 * @param payload - Optional payload bytes
 * @returns Complete packet ready for transport
 */
export function encodeEv3Packet(messageCounter: number, type: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
	const normalizedCounter = messageCounter & 0xffff;
	const bodyLength = 2 + 1 + payload.length;
	const out = new Uint8Array(2 + bodyLength);
	const view = new DataView(out.buffer);

	view.setUint16(0, bodyLength, true);
	view.setUint16(2, normalizedCounter, true);
	out[4] = type & 0xff;
	if (payload.length > 0) {
		out.set(payload, 5);
	}
	return out;
}

/**
 * Decodes raw bytes into a structured {@link Ev3Packet}.
 *
 * @param packet - Raw packet bytes received from the transport layer
 * @returns Parsed packet with counter, type, and payload separated
 * @throws Error if packet is too short or declared length doesn't match actual length
 */
export function decodeEv3Packet(packet: Uint8Array): Ev3Packet {
	if (packet.length < MIN_PACKET_BYTES) {
		throw new Error(`Invalid EV3 packet: expected at least ${MIN_PACKET_BYTES} bytes, got ${packet.length}.`);
	}

	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	const declaredBodyLength = view.getUint16(0, true);
	const actualBodyLength = packet.length - 2;
	if (declaredBodyLength !== actualBodyLength) {
		throw new Error(
			`Invalid EV3 packet length: declared body ${declaredBodyLength}, actual body ${actualBodyLength}.`
		);
	}

	const messageCounter = view.getUint16(2, true);
	const type = packet[4];
	const payload = packet.subarray(5);
	return { messageCounter, type, payload };
}

/** EV3 command type bytes sent from host to brick. */
export const EV3_COMMAND = {
	DIRECT_COMMAND_REPLY: 0x00,
	DIRECT_COMMAND_NO_REPLY: 0x80,
	SYSTEM_COMMAND_REPLY: 0x01,
	SYSTEM_COMMAND_NO_REPLY: 0x81
} as const;

/** EV3 reply type bytes sent from brick to host. */
export const EV3_REPLY = {
	DIRECT_REPLY: 0x02,
	DIRECT_REPLY_ERROR: 0x04,
	SYSTEM_REPLY: 0x03,
	SYSTEM_REPLY_ERROR: 0x05
} as const;

