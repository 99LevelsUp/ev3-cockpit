/**
 * Maps BrickCommand types to EV3 bytecode payloads.
 *
 * Each builder function returns `{ type, payload }` ready for packet framing.
 * Direct commands use a global variable allocation header (first 2 bytes)
 * to reserve space for reply data.
 */

import { BrickCommand } from '../contracts';
import { concatBytes, uint16le, uint32le, lc0, cString, gv0, gv1 } from './ev3Bytecode';
import {
	EV3_COMMAND, EV3_SYSTEM, EV3_OPCODE, UI_READ_SUB,
	INPUT_DEVICE_SUB,
} from './ev3Packet';

// ── Constants ───────────────────────────────────────────────────────

const LAYER_SELF = 0;
/** Max bytes per system command chunk. */
const SYSTEM_LIST_CHUNK_SIZE = 1012;

// ── Capability probe (info command) ─────────────────────────────────

const LEN_OS_VERS = 16;
const LEN_HW_VERS = 8;
const LEN_FW_VERS = 8;
const LEN_OS_BUILD = 12;
const LEN_FW_BUILD = 12;

const OFF_OS_VERS = 0;
const OFF_HW_VERS = OFF_OS_VERS + LEN_OS_VERS;
const OFF_FW_VERS = OFF_HW_VERS + LEN_HW_VERS;
const OFF_OS_BUILD = OFF_FW_VERS + LEN_FW_VERS;
const OFF_FW_BUILD = OFF_OS_BUILD + LEN_OS_BUILD;
const TOTAL_INFO_BYTES = OFF_FW_BUILD + LEN_FW_BUILD;

/** Lengths and offsets for info reply parsing (exported for ev3Responses). */
export const INFO_LAYOUT = {
	LEN_OS_VERS, LEN_HW_VERS, LEN_FW_VERS, LEN_OS_BUILD, LEN_FW_BUILD,
	OFF_OS_VERS, OFF_HW_VERS, OFF_FW_VERS, OFF_OS_BUILD, OFF_FW_BUILD,
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
	}
}

// ── Direct commands ─────────────────────────────────────────────────

/** Battery level: reads battery current as float32. */
function buildBatteryCommand(): EncodedCommand {
	// 4 bytes global: float32 battery current
	const payload = concatBytes(
		uint16le(4),
		new Uint8Array([EV3_OPCODE.UI_READ, UI_READ_SUB.GET_IBATT]),
		gv0(0),
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

/** Buttons: reads which button is currently pressed. */
function buildButtonsCommand(): EncodedCommand {
	// 6 bytes global: one byte per button (up, enter, down, right, left, back)
	const ops: Uint8Array[] = [uint16le(6)];
	const buttonIds = [1, 2, 3, 4, 5, 6]; // UP, ENTER, DOWN, RIGHT, LEFT, BACK

	for (let i = 0; i < buttonIds.length; i++) {
		ops.push(new Uint8Array([EV3_OPCODE.UI_READ, UI_READ_SUB.GET_PRESS]));
		ops.push(lc0(buttonIds[i]));
		ops.push(gv0(i));
	}

	return { type: EV3_COMMAND.DIRECT_COMMAND_REPLY, payload: concatBytes(...ops) };
}

/** Info: reads firmware version, OS version, HW version, builds. */
function buildInfoCommand(): EncodedCommand {
	const ops: Uint8Array[] = [uint16le(TOTAL_INFO_BYTES)];

	const readString = (sub: number, len: number, off: number) => {
		ops.push(new Uint8Array([EV3_OPCODE.UI_READ, sub]));
		ops.push(lc0(len));
		if (off < 32) { ops.push(gv0(off)); } else { ops.push(gv1(off)); }
	};

	readString(UI_READ_SUB.GET_OS_VERS, LEN_OS_VERS, OFF_OS_VERS);
	readString(UI_READ_SUB.GET_HW_VERS, LEN_HW_VERS, OFF_HW_VERS);
	readString(UI_READ_SUB.GET_FW_VERS, LEN_FW_VERS, OFF_FW_VERS);
	readString(UI_READ_SUB.GET_OS_BUILD, LEN_OS_BUILD, OFF_OS_BUILD);
	readString(UI_READ_SUB.GET_FW_BUILD, LEN_FW_BUILD, OFF_FW_BUILD);

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

function buildFsDeleteCommand(path: string): EncodedCommand {
	const payload = concatBytes(
		new Uint8Array([EV3_SYSTEM.DELETE_FILE]),
		cString(path),
	);
	return { type: EV3_COMMAND.SYSTEM_COMMAND_REPLY, payload };
}
