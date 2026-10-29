/**
 * EV3 packet framing: encode and decode the wire format used by all transports.
 *
 * Wire format: `[bodyLength:u16le] [messageCounter:u16le] [type:u8] [payload:u8[]]`
 * where `bodyLength = 2 (counter) + 1 (type) + payload.length`.
 */

import { ProtocolError } from '../errors/CockpitError';

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

/** `opFILE` subcodes. Only the ones this layer uses; there are 32. */
export const FILE_SUB = {
	MAKE_FOLDER: 10,
	/**
	 * Recursive delete by name.
	 *
	 * Distinct from `DEL_SUBFOLDER`, which takes an index, and from the `DELETE_FILE`
	 * system command, which removes a file or an *empty* directory only.
	 */
	REMOVE: 30,
	/**
	 * Copy, despite the name: the firmware runs `cp -r` and leaves the source in place.
	 *
	 * A rename is therefore this followed by a delete. The copy runs on the brick, so
	 * its cost does not scale with the link.
	 */
	MOVE: 31,
} as const;

/** `opFILENAME` subcodes. */
export const FILENAME_SUB = {
	EXIST: 16,
	TOTALSIZE: 17,
} as const;

// ── Direct command opcodes ──────────────────────────────────────────

export const EV3_OPCODE = {
	UI_READ: 0x81,
	UI_BUTTON: 0x83,
	COM_GET: 0xd3,
	COM_SET: 0xd4,
	INPUT_DEVICE: 0x99,
	/**
	 * `opINPUT_READSI` — one sensor reading in SI units.
	 *
	 * Signature from the firmware's own opcode table: `PAR8,PAR8,PAR8,PAR8,PARF` — layer,
	 * port, type hint, mode hint, and a **four-byte float** out.
	 *
	 * This constant held 0x9a until it was checked against that table. 0x9A is
	 * `opINPUT_READ`, whose last parameter is `PAR8`: it writes a single percent byte. The
	 * parser read four bytes as a float from a slot the firmware had filled one byte of, so
	 * every sensor value was three bytes of whatever the previous command had left in the
	 * global buffer.
	 */
	INPUT_READ_SI: 0x9d,
	INPUT_DEVICE_LIST: 0x98,
	OUTPUT_SPEED: 0xa5,
	OUTPUT_START: 0xa6,
	OUTPUT_STOP: 0xa3,
	OUTPUT_RESET: 0xa2,
	OUTPUT_GET_COUNT: 0xb3,
	MEMORY_USAGE: 0xc5,
	FILE: 0xc0,
	FILENAME: 0xc6,
	PROGRAM_STOP: 0x02,
} as const;

/** Subcodes for opUI_READ. Values marked (verified) were read off a real brick. */
export const UI_READ_SUB = {
	/** Battery voltage, float32 (verified). */
	GET_VBATT: 0x01,
	/** Battery current draw in amps, float32 (verified). */
	GET_IBATT: 0x02,
	/** Battery charge level in percent, one byte (verified). */
	GET_LBATT: 0x12,
	GET_OS_VERS: 0x03,
	GET_IMOTOR: 0x07,
	GET_HW_VERS: 0x09,
	GET_FW_VERS: 0x0a,
	GET_FW_BUILD: 0x0b,
	GET_OS_BUILD: 0x0c,
	/** 0x1e per the firmware enum. This table previously said 0x1d, which is GET_POWER. */
	GET_SDCARD: 0x1e,
} as const;

/**
 * Subcodes for opCOM_GET.
 *
 * Values from `lms2012/source/bytecodes.h` (`COM_GET_SUBCODE`). `GET_BRICKNAME` was
 * verified against three bricks, each returning its own name.
 */
export const COM_GET_SUB = {
	/** Bluetooth MAC of this brick. */
	GET_ID: 0x0c,
	/** The brick's user-visible name. */
	GET_BRICKNAME: 0x0d,
} as const;

/** Subcodes for opCOM_SET (`COM_SET_SUBCODE` in the firmware). */
export const COM_SET_SUB = {
	/**
	 * Switch a radio on or off. Reads **two** DATA8 parameters — the hardware selector
	 * ({@link COM_HARDWARE}) and then the flag (`c_com.c`, `case SET_ON_OFF`).
	 */
	SET_ON_OFF: 0x01,
	/** Make the brick discoverable. Same two-parameter shape as {@link COM_SET_SUB.SET_ON_OFF}. */
	SET_VISIBLE: 0x02,
	/** Rename the brick. Takes one string parameter. */
	SET_BRICKNAME: 0x08,
} as const;

/**
 * Which radio a `COM_SET`/`COM_GET` subcode is talking about (`HWTYPE` in the firmware).
 *
 * Easy to miss and impossible to guess: `SET_ON_OFF` and `SET_VISIBLE` both take this before
 * their actual argument, so a single-argument call silently addresses the wrong hardware.
 */
export const COM_HARDWARE = {
	USB: 1,
	BT: 2,
	WIFI: 3,
} as const;

/**
 * Longest brick name the firmware accepts.
 *
 * `vmBRICKNAMESIZE` is 120 including the terminator and the check is a strict `>`, so 118
 * characters is what actually fits.
 */
export const MAX_BRICK_NAME_LENGTH = 118;

/**
 * Characters the firmware accepts in a brick name: ASCII letters, digits, `_` and `-`.
 *
 * `ValidChars` in `lms2012.c` gives the name bit (`vmCHARSET_NAME`) to nothing else — not a
 * space, not a dot, nothing outside 0x00–0x7F — and one character without it fails the whole
 * rename. Being ASCII-only, a name that matches has as many bytes as characters, so
 * {@link MAX_BRICK_NAME_LENGTH} can be checked against `length`.
 */
export const BRICK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Subcodes for opUI_BUTTON.
 *
 * Button state is not an opUI_READ subcode. Asking opUI_READ for 0x0d (which is
 * GET_ADDRESS) made the firmware answer with an error — confirmed against a real
 * brick, where PRESSED under opUI_BUTTON answers correctly.
 */
export const UI_BUTTON_SUB = {
	/** Is the given button currently pressed: one byte, 0 or 1 (verified). */
	PRESSED: 0x09,
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
		throw new ProtocolError(`Invalid EV3 packet: expected at least ${MIN_PACKET_BYTES} bytes, got ${packet.length}`);
	}

	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	const declaredBodyLength = view.getUint16(0, true);
	const actualBodyLength = packet.length - 2;
	if (declaredBodyLength !== actualBodyLength) {
		throw new ProtocolError(
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
