/**
 * EV3 packet framing: encode and decode the wire format used by all transports.
 *
 * Wire format: `[bodyLength:u16le] [messageCounter:u16le] [type:u8] [payload:u8[]]`
 * where `bodyLength = 2 (counter) + 1 (type) + payload.length`.
 */

// ── Packet structure ────────────────────────────────────────────────

export interface Ev3Packet {
	/** Sequence number for matching requests with replies (0–65535). */
	messageCounter: number;
	/** Command or reply type byte. */
	type: number;
	/** Variable-length payload following the type byte. */
	payload: Uint8Array;
}

/** Minimum valid EV3 packet size: 2 (length) + 2 (counter) + 1 (type). */
const MIN_PACKET_BYTES = 5;

// ── Command type bytes (host → brick) ──────────────────────────────

export const EV3_COMMAND = {
	DIRECT_COMMAND_REPLY: 0x00,
	DIRECT_COMMAND_NO_REPLY: 0x80,
	SYSTEM_COMMAND_REPLY: 0x01,
	SYSTEM_COMMAND_NO_REPLY: 0x81,
} as const;

// ── Reply type bytes (brick → host) ────────────────────────────────

export const EV3_REPLY = {
	DIRECT_REPLY: 0x02,
	DIRECT_REPLY_ERROR: 0x04,
	SYSTEM_REPLY: 0x03,
	SYSTEM_REPLY_ERROR: 0x05,
} as const;

// ── System command opcodes ──────────────────────────────────────────

export const EV3_SYSTEM = {
	BEGIN_DOWNLOAD: 0x92,
	CONTINUE_DOWNLOAD: 0x93,
	BEGIN_UPLOAD: 0x94,
	CONTINUE_UPLOAD: 0x95,
	CLOSE_FILEHANDLE: 0x98,
	LIST_FILES: 0x99,
	CONTINUE_LIST_FILES: 0x9a,
	CREATE_DIR: 0x9b,
	DELETE_FILE: 0x9c,
} as const;

// ── Direct command opcodes ──────────────────────────────────────────

export const EV3_OPCODE = {
	UI_READ: 0x81,
	INPUT_DEVICE: 0x99,
	INPUT_READ_SI: 0x9a,
	INPUT_DEVICE_LIST: 0x98,
	OUTPUT_SPEED: 0xa5,
	OUTPUT_START: 0xa6,
	OUTPUT_STOP: 0xa3,
	OUTPUT_RESET: 0xa2,
	OUTPUT_GET_COUNT: 0xb3,
	MEMORY_USAGE: 0xc5,
	PROGRAM_STOP: 0x02,
} as const;

/** Subcodes for opUI_READ. */
export const UI_READ_SUB = {
	GET_IBATT: 0x02,
	GET_OS_VERS: 0x03,
	GET_IMOTOR: 0x07,
	GET_HW_VERS: 0x09,
	GET_FW_VERS: 0x0a,
	GET_FW_BUILD: 0x0b,
	GET_OS_BUILD: 0x0c,
	GET_PRESS: 0x0d,
	GET_SDCARD: 0x1d,
} as const;

/** Subcodes for opINPUT_DEVICE. */
export const INPUT_DEVICE_SUB = {
	SET_TYPEMODE: 0x01,
	GET_TYPEMODE: 0x05,
} as const;

// ── System command status codes ─────────────────────────────────────

export const EV3_SYSTEM_STATUS = {
	OK: 0x00,
	UNKNOWN_HANDLE: 0x01,
	HANDLE_NOT_READY: 0x02,
	CORRUPT_FILE: 0x03,
	NO_HANDLES_AVAILABLE: 0x04,
	NO_PERMISSION: 0x05,
	ILLEGAL_PATH: 0x06,
	FILE_EXISTS: 0x07,
	END_OF_FILE: 0x08,
	SIZE_ERROR: 0x09,
	UNKNOWN_ERROR: 0x0a,
	ILLEGAL_FILENAME: 0x0b,
	ILLEGAL_CONNECTION: 0x0c,
} as const;

// ── Encode / Decode ─────────────────────────────────────────────────

/**
 * Encodes an EV3 packet into its wire format.
 *
 * @param messageCounter - Sequence number (masked to 16 bits)
 * @param type - Command type byte
 * @param payload - Optional payload bytes
 * @returns Complete packet ready for transport
 */
export function encodeEv3Packet(
	messageCounter: number,
	type: number,
	payload: Uint8Array = new Uint8Array(),
): Uint8Array {
	const bodyLength = 2 + 1 + payload.length;
	const out = new Uint8Array(2 + bodyLength);
	const view = new DataView(out.buffer);

	view.setUint16(0, bodyLength, true);
	view.setUint16(2, messageCounter & 0xffff, true);
	out[4] = type & 0xff;
	if (payload.length > 0) {
		out.set(payload, 5);
	}
	return out;
}

/**
 * Decodes raw bytes into a structured Ev3Packet.
 *
 * @throws Error if packet is too short or declared length doesn't match
 */
export function decodeEv3Packet(packet: Uint8Array): Ev3Packet {
	if (packet.length < MIN_PACKET_BYTES) {
		throw new Error(`Invalid EV3 packet: expected at least ${MIN_PACKET_BYTES} bytes, got ${packet.length}`);
	}

	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	const declaredBodyLength = view.getUint16(0, true);
	const actualBodyLength = packet.length - 2;
	if (declaredBodyLength !== actualBodyLength) {
		throw new Error(
			`Invalid EV3 packet length: declared body ${declaredBodyLength}, actual body ${actualBodyLength}`
		);
	}

	return {
		messageCounter: view.getUint16(2, true),
		type: packet[4],
		payload: packet.subarray(5),
	};
}

/**
 * Extracts the first length-prefixed packet from a receive buffer.
 * Returns `null` if the buffer doesn't contain a complete packet yet.
 */
export function extractLengthPrefixedPacket(buffer: Uint8Array): { packet: Uint8Array; remaining: Uint8Array } | null {
	if (buffer.length < 2) { return null; }
	const bodyLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint16(0, true);
	const totalLength = 2 + bodyLength;
	if (buffer.length < totalLength) { return null; }
	return {
		packet: buffer.subarray(0, totalLength),
		remaining: buffer.subarray(totalLength),
	};
}
