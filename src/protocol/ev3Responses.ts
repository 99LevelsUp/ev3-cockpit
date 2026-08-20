/**
 * Parses raw EV3 reply payloads into typed BrickResponse objects.
 *
 * Each parser function corresponds to a BrickCommand kind and extracts
 * the structured data from the global variable bytes returned by the brick.
 */

import {
	BrickCommand, BrickResponse,
	BatteryResponse, PortsResponse, ButtonsResponse, InfoResponse,
	FsListResponse, FsReadResponse, FsWriteResponse, FsExistsResponse, FsDeleteResponse,
	PortState,
} from '../contracts';
import { readFloat32le, readInt32le, readFixedCString } from './ev3Bytecode';
import {
	Ev3Packet, EV3_REPLY, EV3_SYSTEM_STATUS,
} from './ev3Packet';
import { INFO_LAYOUT } from './ev3Commands';
import { ProtocolError } from '../errors/CockpitError';

// ── Sensor/motor type names ─────────────────────────────────────────

const SENSOR_TYPE_NAMES: Record<number, string> = {
	1: 'touch',
	16: 'color',
	29: 'color-v2',
	30: 'ultrasonic',
	32: 'gyro',
	33: 'infrared',
	126: 'none',
};

const MOTOR_TYPE_NAMES: Record<number, string> = {
	7: 'large-motor',
	8: 'medium-motor',
	126: 'none',
};

const SENSOR_PORT_LABELS = ['1', '2', '3', '4'];
const MOTOR_PORT_LABELS = ['A', 'B', 'C', 'D'];

const BUTTON_NAMES = ['up', 'enter', 'down', 'right', 'left', 'back'];

/**
 * Bytes before the data in a system-command reply payload: the command echo, the
 * status byte, a uint32 size and a handle. Verified against a real brick.
 */
const SYSTEM_REPLY_HEADER_BYTES = 7;

// ── Public interface ────────────────────────────────────────────────

/**
 * Parses an EV3 reply packet into a typed BrickResponse.
 *
 * @param command - The original BrickCommand (to know what to parse)
 * @param reply - The decoded EV3 reply packet
 * @returns Typed BrickResponse matching the command kind
 * @throws Error if the reply indicates an error or is malformed
 */
export function parseResponse(command: BrickCommand, reply: Ev3Packet): BrickResponse {
	validateReply(reply, command.kind);

	switch (command.kind) {
	case 'battery':
		return parseBattery(reply.payload);
	case 'ports':
		return parsePorts(reply.payload);
	case 'buttons':
		return parseButtons(reply.payload);
	case 'info':
		return parseInfo(reply.payload);
	case 'fs:list':
		return parseFsList(reply.payload);
	case 'fs:read':
		return parseFsRead(reply.payload);
	case 'fs:write':
		return parseFsWrite(reply.payload);
	case 'fs:exists':
		return parseFsExists(reply.payload);
	case 'fs:delete':
		return parseFsDelete(reply.payload);
	}
}

// ── Direct command parsers ──────────────────────────────────────────

function parseBattery(payload: Uint8Array): BatteryResponse {
	// Global layout from buildBatteryCommand: [0..3] volts, [4..7] amps, [8] percent.
	if (payload.length < 9) {
		throw new ProtocolError(
			`Malformed battery reply: expected 9 bytes, got ${payload.length}.`
		);
	}
	return {
		kind: 'battery',
		// The contract says 0-100 and Phase 4 renders it as a percentage. The clamp
		// left with the old current-draw heuristic it belonged to; the layout was
		// measured on one firmware, so keep the range enforced at the boundary.
		level: Math.min(100, Math.max(0, payload[8])),
		voltage: readFloat32le(payload, 0),
		currentAmps: readFloat32le(payload, 4),
	};
}

function parsePorts(payload: Uint8Array): PortsResponse {
	const sensorPorts: PortState[] = [];
	const motorPorts: PortState[] = [];

	// Sensor type/mode: bytes 0..7 (2 per port)
	for (let i = 0; i < 4; i++) {
		const typeCode = payload.length > i * 2 ? payload[i * 2] : 126;
		const sensorValue = payload.length >= 16 + (i + 1) * 4
			? readFloat32le(payload, 16 + i * 4)
			: undefined;
		sensorPorts.push({
			port: SENSOR_PORT_LABELS[i],
			peripheralType: SENSOR_TYPE_NAMES[typeCode] ?? (typeCode === 126 ? undefined : `sensor-${typeCode}`),
			value: typeCode !== 126 ? sensorValue : undefined,
			timestamp: Date.now(),
		});
	}

	// Motor type/mode: bytes 8..15 (2 per port)
	for (let i = 0; i < 4; i++) {
		const typeCode = payload.length > 8 + i * 2 ? payload[8 + i * 2] : 126;
		const tachoValue = payload.length >= 32 + (i + 1) * 4
			? readInt32le(payload, 32 + i * 4)
			: undefined;
		motorPorts.push({
			port: MOTOR_PORT_LABELS[i],
			peripheralType: MOTOR_TYPE_NAMES[typeCode] ?? (typeCode === 126 ? undefined : `motor-${typeCode}`),
			value: typeCode !== 126 ? tachoValue : undefined,
			unit: typeCode !== 126 ? 'deg' : undefined,
			timestamp: Date.now(),
		});
	}

	return { kind: 'ports', motorPorts, sensorPorts };
}

function parseButtons(payload: Uint8Array): ButtonsResponse {
	const state: Record<string, boolean> = {};
	for (let i = 0; i < BUTTON_NAMES.length; i++) {
		state[BUTTON_NAMES[i]] = payload.length > i ? payload[i] !== 0 : false;
	}
	return { kind: 'buttons', state };
}

function parseInfo(payload: Uint8Array): InfoResponse {
	const brickName = readFixedCString(payload, INFO_LAYOUT.OFF_BRICK_NAME, INFO_LAYOUT.LEN_BRICK_NAME);
	const osVersion = readFixedCString(payload, INFO_LAYOUT.OFF_OS_VERS, INFO_LAYOUT.LEN_OS_VERS);
	const fwVersion = readFixedCString(payload, INFO_LAYOUT.OFF_FW_VERS, INFO_LAYOUT.LEN_FW_VERS);
	return {
		kind: 'info',
		// The brick's name, not the kernel version this used to report.
		displayName: brickName || 'EV3',
		firmwareVersion: fwVersion || undefined,
		osVersion: osVersion || undefined,
	};
}

// ── System command parsers ──────────────────────────────────────────

function parseFsList(payload: Uint8Array): FsListResponse {
	// Anything shorter than the header is a malformed reply, not an empty directory.
	// Returning an empty list for it made a corrupted exchange indistinguishable from
	// a directory that genuinely holds nothing.
	if (payload.length < SYSTEM_REPLY_HEADER_BYTES) {
		throw new ProtocolError(
			`Malformed fs:list reply: expected at least ${SYSTEM_REPLY_HEADER_BYTES} bytes, `
			+ `got ${payload.length}.`
		);
	}
	// Measured against a real brick: the reply payload is
	//   [0] system command echo (0x99 LIST_FILES)
	//   [1] status
	//   [2..5] list size, uint32
	//   [6] handle
	//   [7..] the listing
	// Skipping 4 left three stray bytes glued to the first entry, which is exactly
	// what a directory listing beginning "\0\0\0tetris 22/" looked like.
	const listing = Buffer.from(payload.subarray(SYSTEM_REPLY_HEADER_BYTES)).toString('utf8');
	const entries = listing.split('\n').filter(e => e.length > 0);
	return { kind: 'fs:list', entries };
}

function parseFsRead(payload: Uint8Array): FsReadResponse {
	// Same reasoning as fs:list: too short to hold the header means malformed, not empty.
	if (payload.length < SYSTEM_REPLY_HEADER_BYTES) {
		throw new ProtocolError(
			`Malformed fs:read reply: expected at least ${SYSTEM_REPLY_HEADER_BYTES} bytes, `
			+ `got ${payload.length}.`
		);
	}
	// Same 7-byte header as the listing reply, with the size field naming the file
	// rather than the listing.
	const content = Buffer.from(payload.subarray(SYSTEM_REPLY_HEADER_BYTES)).toString('utf8');
	return { kind: 'fs:read', content };
}

function parseFsWrite(_payload: Uint8Array): FsWriteResponse {
	return { kind: 'fs:write' };
}

function parseFsExists(_payload: Uint8Array): FsExistsResponse {
	// Existence is inferred from LIST_FILES not erroring, which cannot tell an empty
	// directory from a missing path — both come back without an error and with no
	// entries. The mock answers correctly because it queries its own tree, so the
	// gap is invisible in tests and only appears against real hardware. Phase 4
	// filesystem work needs a real existence probe, not this.
	return { kind: 'fs:exists', exists: true };
}

function parseFsDelete(_payload: Uint8Array): FsDeleteResponse {
	return { kind: 'fs:delete', deleted: true };
}

// ── Validation ──────────────────────────────────────────────────────

function validateReply(reply: Ev3Packet, commandKind: string): void {
	if (reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
		throw new ProtocolError(`EV3 direct command error for '${commandKind}'`);
	}
	if (reply.type === EV3_REPLY.SYSTEM_REPLY_ERROR) {
		// payload[0] is the echoed system command, payload[1] the status — the same
		// layout the parsers below skip with SYSTEM_REPLY_HEADER_BYTES. Reading [0]
		// here reported every failure as the command byte, so an ILLEGAL_PATH came out
		// as '0x99' and lost the one piece of information the error carried.
		const status = reply.payload.length > 1 ? reply.payload[1] : 0xff;
		const statusName = Object.entries(EV3_SYSTEM_STATUS)
			.find(([, v]) => v === status)?.[0] ?? `0x${status.toString(16)}`;
		throw new ProtocolError(`EV3 system command error for '${commandKind}': ${statusName}`);
	}
}
