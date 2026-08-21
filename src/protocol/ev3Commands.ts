/**
 * Maps BrickCommand types to EV3 bytecode payloads.
 *
 * Each builder function returns `{ type, payload }` ready for packet framing.
 * Direct commands use a global variable allocation header (first 2 bytes)
 * to reserve space for reply data.
 */

import { BrickCommand } from '../contracts';
import { ProtocolError } from '../errors/CockpitError';
import { concatBytes, uint16le, uint32le, lc0, cString, gv0, gv1 } from './ev3Bytecode';
import {
	EV3_COMMAND, EV3_SYSTEM, EV3_OPCODE, UI_READ_SUB, UI_BUTTON_SUB, COM_GET_SUB,
	INPUT_DEVICE_SUB,
} from './ev3Packet';

// ── Constants ───────────────────────────────────────────────────────

const LAYER_SELF = 0;
/** Max bytes per system command chunk. */
const SYSTEM_LIST_CHUNK_SIZE = 1012;

/**
 * The firmware's own receive and transmit buffers, in bytes.
 *
 * `c_com.c` sets `RxBuf[n].BufSize = 1024` and `TxBuf[n].BufSize = 1024`
 * unconditionally, for every communication channel. So this is a firmware property,
 * not a transport one: USB, TCP and Bluetooth all hit the same ceiling, and USB's
 * 1025-byte HID report (one report id plus 1024) matches it exactly.
 */
export const FIRMWARE_BUFFER_BYTES = 1024;

/** Envelope before a system command's own payload: length, counter, type, command. */
export const SYSTEM_ENVELOPE_BYTES = 2 + 2 + 1 + 1;

/**
 * Largest chunk `CONTINUE_DOWNLOAD` can carry: the buffer less the envelope and the
 * one-byte handle.
 */
export const MAX_WRITE_CHUNK_BYTES = FIRMWARE_BUFFER_BYTES - SYSTEM_ENVELOPE_BYTES - 1;

/**
 * Largest first chunk `BEGIN_DOWNLOAD` can carry for a given path.
 *
 * BEGIN_DOWNLOAD carries payload directly after the zero-terminated path, so its
 * room shrinks as the path grows — unlike CONTINUE_DOWNLOAD, whose header is fixed.
 */
export function maxFirstChunkBytes(
	path: string,
	packetBytes: number = FIRMWARE_BUFFER_BYTES,
): number {
	const pathBytes = Buffer.byteLength(path, 'utf8') + 1;
	return packetBytes - SYSTEM_ENVELOPE_BYTES - 4 - pathBytes;
}

// ── Capability probe (info command) ─────────────────────────────────

const LEN_BRICK_NAME = 16;
const LEN_OS_VERS = 16;
const LEN_HW_VERS = 8;
const LEN_FW_VERS = 8;
const LEN_OS_BUILD = 12;
const LEN_FW_BUILD = 12;

const OFF_BRICK_NAME = 0;
const OFF_OS_VERS = OFF_BRICK_NAME + LEN_BRICK_NAME;
const OFF_HW_VERS = OFF_OS_VERS + LEN_OS_VERS;
const OFF_FW_VERS = OFF_HW_VERS + LEN_HW_VERS;
const OFF_OS_BUILD = OFF_FW_VERS + LEN_FW_VERS;
const OFF_FW_BUILD = OFF_OS_BUILD + LEN_OS_BUILD;
const TOTAL_INFO_BYTES = OFF_FW_BUILD + LEN_FW_BUILD;

/** Lengths and offsets for info reply parsing (exported for ev3Responses). */
export const INFO_LAYOUT = {
	LEN_BRICK_NAME, LEN_OS_VERS, LEN_HW_VERS, LEN_FW_VERS, LEN_OS_BUILD, LEN_FW_BUILD,
	OFF_BRICK_NAME, OFF_OS_VERS, OFF_HW_VERS, OFF_FW_VERS, OFF_OS_BUILD, OFF_FW_BUILD,
	TOTAL_INFO_BYTES,
} as const;

// ── Port layout ─────────────────────────────────────────────────────

/** Sensor port indices (1-4 mapped to 0-3 in EV3 protocol). */
const SENSOR_PORTS = [0, 1, 2, 3];
/** Motor port indices (A-D mapped to 16-19 in EV3 INPUT_DEVICE, 0-3 for OUTPUT). */
const MOTOR_INPUT_PORTS = [16, 17, 18, 19];

// ── Public interface ────────────────────────────────────────────────

export interface EncodedCommand {
	/** EV3 command type byte. */
	type: number;
	/** Bytecode payload (direct command) or system command payload. */
	payload: Uint8Array;
}

/**
 * Builds the EV3 wire payload for a BrickCommand.
 * Returns `{ type, payload }` ready for encodeEv3Packet().
 */
export function buildCommand(command: BrickCommand): EncodedCommand {
	switch (command.kind) {
	case 'battery':
		return buildBatteryCommand();
	case 'ports':
		return buildPortsCommand();
	case 'buttons':
		return buildButtonsCommand();
	case 'info':
		return buildInfoCommand();
	case 'fs:list':
		return buildFsListCommand(command.path);
	case 'fs:read':
		return buildFsReadCommand(command.path);
	case 'fs:write':
		return buildFsWriteCommand(command.path, command.content);
	case 'fs:exists':
		return buildFsExistsCommand(command.path);
	case 'fs:delete':
		return buildFsDeleteCommand(command.path);
	case 'fs:beginWrite':
		return buildFsBeginWriteCommand(command.path, command.totalBytes, command.chunk);
	case 'fs:continueWrite':
		return buildFsContinueWriteCommand(command.handle, command.chunk);
	case 'fs:beginRead':
		return buildFsBeginReadCommand(command.path, command.wantBytes);
	case 'fs:continueRead':
		return buildFsContinueReadCommand(command.handle, command.wantBytes);
	case 'fs:closeHandle':
		return buildFsCloseHandleCommand(command.handle);
	}
}

// ── Direct commands ─────────────────────────────────────────────────

/**
 * Battery: charge level, voltage and current in one round trip.
 *
 * Global layout: [0..3] volts float32, [4..7] amps float32, [8] level percent.
 *
 * This used to ask only for GET_IBATT and report `current * 200` as the level. On a
 * brick reading 100 % that produced 29 %, because current draw tracks motor load
 * rather than remaining charge. GET_LBATT answers the actual question.
 *
 * The floats sit at offsets 0 and 4 with the single byte last: putting the byte
 * first left both floats unaligned and the firmware rejected the whole command.
 */
function buildBatteryCommand(): EncodedCommand {
	const payload = concatBytes(
		uint16le(9),
		new Uint8Array([EV3_OPCODE.UI_READ, UI_READ_SUB.GET_VBATT]), gv0(0),
		new Uint8Array([EV3_OPCODE.UI_READ, UI_READ_SUB.GET_IBATT]), gv0(4),
		new Uint8Array([EV3_OPCODE.UI_READ, UI_READ_SUB.GET_LBATT]), gv0(8),
	);
	return { type: EV3_COMMAND.DIRECT_COMMAND_REPLY, payload };
}

/**
 * Ports: reads sensor type/mode for 4 sensor ports and 4 motor ports,
 * plus one float32 SI value per port.
 *
 * Global allocation layout:
 * - Bytes 0..7:   sensor type+mode (2 bytes × 4 ports)
 * - Bytes 8..15:  motor type+mode (2 bytes × 4 ports)
 * - Bytes 16..31: sensor SI values (4 bytes × 4 ports)
 * - Bytes 32..47: motor tacho (4 bytes × 4 ports)
 */
function buildPortsCommand(): EncodedCommand {
	const globalBytes = 8 + 8 + 16 + 16;  // 48
	const ops: Uint8Array[] = [uint16le(globalBytes)];

	// Sensor type/mode: 2 bytes each at offsets 0..7
	for (let i = 0; i < SENSOR_PORTS.length; i++) {
		ops.push(new Uint8Array([EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]));
		ops.push(lc0(LAYER_SELF));
		ops.push(lc0(SENSOR_PORTS[i]));
		ops.push(gv0(i * 2));       // type
		ops.push(gv0(i * 2 + 1));   // mode
	}

	// Motor type/mode: 2 bytes each at offsets 8..15
	for (let i = 0; i < MOTOR_INPUT_PORTS.length; i++) {
		ops.push(new Uint8Array([EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]));
		ops.push(lc0(LAYER_SELF));
		ops.push(lc0(MOTOR_INPUT_PORTS[i]));
		ops.push(gv0(8 + i * 2));       // type
		ops.push(gv0(8 + i * 2 + 1));   // mode
	}

	// Sensor SI values: 4 bytes each at offsets 16..31
	for (let i = 0; i < SENSOR_PORTS.length; i++) {
		ops.push(new Uint8Array([EV3_OPCODE.INPUT_READ_SI]));
		ops.push(lc0(LAYER_SELF));
		ops.push(lc0(SENSOR_PORTS[i]));
		ops.push(lc0(0));  // type hint (0 = auto)
		ops.push(lc0(0));  // mode hint (0 = default)
		ops.push(gv0(16 + i * 4));
	}

	// Motor tacho: 4 bytes each at offsets 32..47
	for (let i = 0; i < 4; i++) {
		ops.push(new Uint8Array([EV3_OPCODE.OUTPUT_GET_COUNT]));
		ops.push(lc0(LAYER_SELF));
		ops.push(lc0(i));  // motor port index 0-3
		ops.push(gv1(32 + i * 4));
	}

	return { type: EV3_COMMAND.DIRECT_COMMAND_REPLY, payload: concatBytes(...ops) };
}

/**
 * Buttons: one byte per button, in BUTTON_NAMES order.
 *
 * This asked opUI_READ for subcode 0x0d, which is GET_ADDRESS, not a button read —
 * a real brick answered the whole command with an error, so button telemetry never
 * worked outside the mock. opUI_BUTTON with PRESSED is the right opcode.
 */
function buildButtonsCommand(): EncodedCommand {
	const ops: Uint8Array[] = [uint16le(6)];
	const buttonIds = [1, 2, 3, 4, 5, 6]; // UP, ENTER, DOWN, RIGHT, LEFT, BACK

	for (let i = 0; i < buttonIds.length; i++) {
		ops.push(new Uint8Array([EV3_OPCODE.UI_BUTTON, UI_BUTTON_SUB.PRESSED]));
		ops.push(lc0(buttonIds[i]));
		ops.push(gv0(i));
	}

	return { type: EV3_COMMAND.DIRECT_COMMAND_REPLY, payload: concatBytes(...ops) };
}

/**
 * Info: the brick's own name, plus firmware, OS and hardware versions.
 *
 * The name comes from opCOM_GET / GET_BRICKNAME. It used to be absent entirely and
 * `displayName` carried the OS version instead, so a brick called AAA reported
 * itself as "Linux 2.6.33-rc".
 */
function buildInfoCommand(): EncodedCommand {
	const ops: Uint8Array[] = [uint16le(TOTAL_INFO_BYTES)];

	const readString = (opcode: number, sub: number, len: number, off: number) => {
		ops.push(new Uint8Array([opcode, sub]));
		ops.push(lc0(len));
		if (off < 32) { ops.push(gv0(off)); } else { ops.push(gv1(off)); }
	};

	readString(EV3_OPCODE.COM_GET, COM_GET_SUB.GET_BRICKNAME, LEN_BRICK_NAME, OFF_BRICK_NAME);
	readString(EV3_OPCODE.UI_READ, UI_READ_SUB.GET_OS_VERS, LEN_OS_VERS, OFF_OS_VERS);
	readString(EV3_OPCODE.UI_READ, UI_READ_SUB.GET_HW_VERS, LEN_HW_VERS, OFF_HW_VERS);
	readString(EV3_OPCODE.UI_READ, UI_READ_SUB.GET_FW_VERS, LEN_FW_VERS, OFF_FW_VERS);
	readString(EV3_OPCODE.UI_READ, UI_READ_SUB.GET_OS_BUILD, LEN_OS_BUILD, OFF_OS_BUILD);
	readString(EV3_OPCODE.UI_READ, UI_READ_SUB.GET_FW_BUILD, LEN_FW_BUILD, OFF_FW_BUILD);

	return { type: EV3_COMMAND.DIRECT_COMMAND_REPLY, payload: concatBytes(...ops) };
}

// ── System commands (filesystem) ────────────────────────────────────

function buildFsListCommand(path: string): EncodedCommand {
	const payload = concatBytes(
		new Uint8Array([EV3_SYSTEM.LIST_FILES]),
		uint16le(SYSTEM_LIST_CHUNK_SIZE),
		cString(path),
	);
	return { type: EV3_COMMAND.SYSTEM_COMMAND_REPLY, payload };
}

function buildFsReadCommand(path: string): EncodedCommand {
	const payload = concatBytes(
		new Uint8Array([EV3_SYSTEM.BEGIN_UPLOAD]),
		uint16le(SYSTEM_LIST_CHUNK_SIZE),
		cString(path),
	);
	return { type: EV3_COMMAND.SYSTEM_COMMAND_REPLY, payload };
}

function buildFsWriteCommand(path: string, content: string): EncodedCommand {
	const contentBytes = Buffer.from(content, 'utf8');
	const payload = concatBytes(
		new Uint8Array([EV3_SYSTEM.BEGIN_DOWNLOAD]),
		uint32le(contentBytes.length),
		cString(path),
		contentBytes,
	);
	return { type: EV3_COMMAND.SYSTEM_COMMAND_REPLY, payload };
}

function buildFsExistsCommand(path: string): EncodedCommand {
	// Use LIST_FILES on the path — if it succeeds, the path exists
	return buildFsListCommand(path);
}

function buildFsBeginWriteCommand(
	path: string,
	totalBytes: number,
	chunk: Uint8Array,
): EncodedCommand {
	// Sized against the firmware buffer; a tighter host transport is the service's
	// business, and its own guard catches that before this one.
	const room = maxFirstChunkBytes(path);
	if (chunk.length > room) {
		throw new ProtocolError(
			`BEGIN_DOWNLOAD first chunk of ${chunk.length} bytes exceeds the ${room} bytes `
			+ `left after a ${path.length}-character path.`
		);
	}
	// The brick refuses a chunk larger than the size it was told to expect (SIZE_ERROR),
	// so catch the caller's arithmetic here rather than reading it back off the wire.
	if (chunk.length > totalBytes) {
		throw new ProtocolError(
			`First chunk of ${chunk.length} bytes exceeds the declared total of ${totalBytes}.`
		);
	}
	return {
		type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
		payload: concatBytes(
			new Uint8Array([EV3_SYSTEM.BEGIN_DOWNLOAD]),
			uint32le(totalBytes),
			cString(path),
			chunk,
		),
	};
}

function buildFsContinueWriteCommand(handle: number, chunk: Uint8Array): EncodedCommand {
	if (chunk.length > MAX_WRITE_CHUNK_BYTES) {
		throw new ProtocolError(
			`CONTINUE_DOWNLOAD chunk of ${chunk.length} bytes exceeds the firmware's `
			+ `${MAX_WRITE_CHUNK_BYTES}-byte limit.`
		);
	}
	return {
		type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
		payload: concatBytes(
			new Uint8Array([EV3_SYSTEM.CONTINUE_DOWNLOAD, handle & 0xff]),
			chunk,
		),
	};
}

function buildFsBeginReadCommand(path: string, wantBytes: number): EncodedCommand {
	return {
		type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
		payload: concatBytes(
			new Uint8Array([EV3_SYSTEM.BEGIN_UPLOAD]),
			uint16le(wantBytes),
			cString(path),
		),
	};
}

function buildFsContinueReadCommand(handle: number, wantBytes: number): EncodedCommand {
	return {
		type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
		payload: concatBytes(
			new Uint8Array([EV3_SYSTEM.CONTINUE_UPLOAD, handle & 0xff]),
			uint16le(wantBytes),
		),
	};
}

function buildFsCloseHandleCommand(handle: number): EncodedCommand {
	return {
		type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
		payload: new Uint8Array([EV3_SYSTEM.CLOSE_FILEHANDLE, handle & 0xff]),
	};
}

function buildFsDeleteCommand(path: string): EncodedCommand {
	const payload = concatBytes(
		new Uint8Array([EV3_SYSTEM.DELETE_FILE]),
		cString(path),
	);
	return { type: EV3_COMMAND.SYSTEM_COMMAND_REPLY, payload };
}
