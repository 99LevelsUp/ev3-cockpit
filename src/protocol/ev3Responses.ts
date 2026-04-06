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
	if (payload.length < 4) {
		return { kind: 'battery', level: 0 };
	}
	const current = readFloat32le(payload, 0);
	// Convert battery current to approximate percentage (EV3 range ~0.0 to ~0.5A)
	const level = Math.round(Math.min(100, Math.max(0, current * 200)));
	return { kind: 'battery', level, voltage: current };
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
	const osVersion = readFixedCString(payload, INFO_LAYOUT.OFF_OS_VERS, INFO_LAYOUT.LEN_OS_VERS);
	const fwVersion = readFixedCString(payload, INFO_LAYOUT.OFF_FW_VERS, INFO_LAYOUT.LEN_FW_VERS);
	// Use OS version as displayName if available
	return {
		kind: 'info',
		displayName: osVersion || 'EV3',
		firmwareVersion: fwVersion || undefined,
	};
}

// ── System command parsers ──────────────────────────────────────────

function parseFsList(payload: Uint8Array): FsListResponse {
	if (payload.length < 1) {
		return { kind: 'fs:list', entries: [] };
	}
	// System reply payload: [status:1][handle:1][listing...]
	const listing = Buffer.from(payload.subarray(4)).toString('utf8');
	const entries = listing.split('\n').filter(e => e.length > 0);
	return { kind: 'fs:list', entries };
}

function parseFsRead(payload: Uint8Array): FsReadResponse {
	if (payload.length < 1) {
		return { kind: 'fs:read', content: '' };
	}
	// System reply: [status:1][fileSize:4][handle:1][data...]
	const content = Buffer.from(payload.subarray(6)).toString('utf8');
	return { kind: 'fs:read', content };
}

function parseFsWrite(_payload: Uint8Array): FsWriteResponse {
	return { kind: 'fs:write' };
}

function parseFsExists(_payload: Uint8Array): FsExistsResponse {
	// If LIST_FILES succeeded (no error thrown), path exists
	return { kind: 'fs:exists', exists: true };
}

function parseFsDelete(_payload: Uint8Array): FsDeleteResponse {
	return { kind: 'fs:delete', deleted: true };
}

// ── Validation ──────────────────────────────────────────────────────

function validateReply(reply: Ev3Packet, commandKind: string): void {
	if (reply.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
		throw new Error(`EV3 direct command error for '${commandKind}'`);
	}
	if (reply.type === EV3_REPLY.SYSTEM_REPLY_ERROR) {
		const status = reply.payload.length > 0 ? reply.payload[0] : 0xff;
		const statusName = Object.entries(EV3_SYSTEM_STATUS)
			.find(([, v]) => v === status)?.[0] ?? `0x${status.toString(16)}`;
		throw new Error(`EV3 system command error for '${commandKind}': ${statusName}`);
	}
}
