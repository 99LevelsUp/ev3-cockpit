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
	FsSizeResponse, FsFreeSpaceResponse, FsMakeDirectoryResponse, FsEntry,
	FsListContinueResponse,
	FsBeginWriteResponse, FsContinueWriteResponse, FsBeginReadResponse,
	FsContinueReadResponse, FsCloseHandleResponse,
	PortState,
} from '../contracts';
import { readFloat32le, readInt32le, readUint32le, readFixedCString } from './ev3Bytecode';
import {
	Ev3Packet, EV3_REPLY, EV3_SYSTEM_STATUS,
} from './ev3Packet';
import { INFO_LAYOUT } from './ev3Commands';
import { ProtocolError } from '../errors/CockpitError';

// ── Sensor/motor type names ─────────────────────────────────────────

/**
 * Device type codes as the brick reports them.
 *
 * Two of these were wrong, and the mistake was invisible: 16 was named `color` and 29
 * `color-v2`, so a touch sensor was reported as a colour sensor and the real colour sensor
 * as a second-generation one. A brick with a touch sensor plugged in read as having none.
 *
 * Sources, since guessing is what produced the error:
 * - 1 and 16 from the firmware's own `typedata.rcf` (`1 0 NXT-TOUCH`, `16 0 TOUCH`)
 * - 29, 30, 32, 33 are UART sensors, which supply their own type data, so they are absent
 *   from that file; the codes come from `lego-linux-drivers/sensors/ev3_uart_sensor.h`
 *   (`LEGO_EV3_COLOR_TYPE_ID 29`, `..._ULTRASONIC 30`, `..._GYRO 32`, `..._INFRARED 33`)
 */
const SENSOR_TYPE_NAMES: Record<number, string> = {
	1: 'nxt-touch',
	16: 'touch',
	29: 'color',
	30: 'ultrasonic',
	32: 'gyro',
	33: 'infrared',
	125: 'unknown',
	126: 'none',
	127: 'error',
};

/**
 * From `typedata.rcf`: `7 0 L-MOTOR-DEG`, `8 0 M-MOTOR-DEG`.
 *
 * The port-status codes belong here too: a motor plugged in while running passes through
 * `TYPE_UNKNOWN` exactly as a sensor does, and without these it would surface as
 * `motor-125` — the sensor table got the fix first and this one nearly missed it.
 */
const MOTOR_TYPE_NAMES: Record<number, string> = {
	7: 'large-motor',
	8: 'medium-motor',
	125: 'unknown',
	126: 'none',
	127: 'error',
};

/**
 * The three type codes that are a port status rather than a device.
 *
 * From `bytecodes.h`: 125 `TYPE_UNKNOWN` ("port not empty but type has not been
 * determined"), 126 `TYPE_NONE` ("port empty or not available"), 127 `TYPE_ERROR`.
 *
 * 125 is not a corner case: every sensor plugged in while running reports it for a second
 * or two before announcing itself, observed on all three bricks. None of the three carries
 * a usable reading, so the value is dropped rather than passed on — the buffer slot behind
 * it holds whatever the last command left there.
 */
const TYPE_UNKNOWN = 125;
const NO_DEVICE_TYPE = 126;
const TYPE_ERROR = 127;

function hasReading(typeCode: number): boolean {
	return typeCode !== TYPE_UNKNOWN && typeCode !== NO_DEVICE_TYPE && typeCode !== TYPE_ERROR;
}

/**
 * `DATA32_NAN` from `bytecodes.h` (0x80000000) — a tacho slot with nothing to report.
 *
 * Distinct from an empty port: the device is there and has no reading yet. Sensor readings
 * signal the same thing with `DATAF_NAN`, which the firmware defines as 0/0 and therefore
 * arrives as a real NaN.
 */
const DATA32_NAN = -2147483648;

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
	case 'telemetry:frame':
		// Handed back as bytes on purpose: only the frame that was sent knows the layout.
		return { kind: 'telemetry:frame', payload: reply.payload };
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
	case 'fs:beginWrite':
		return parseFsBeginWrite(reply.payload);
	case 'fs:continueWrite':
		return parseFsContinueWrite(reply.payload);
	case 'fs:beginRead':
		return parseFsBeginRead(reply.payload);
	case 'fs:continueRead':
		return parseFsContinueRead(reply.payload);
	case 'fs:closeHandle':
		return parseFsCloseHandle(reply.payload);
	case 'fs:listContinue':
		return parseFsListContinue(reply.payload);
	case 'fs:size':
		return parseFsSize(reply.payload);
	case 'fs:freeSpace':
		return parseFsFreeSpace(reply.payload);
	case 'fs:makeDirectory':
		return parseFsMakeDirectory(reply.payload);
	case 'fs:copy':
		return { kind: 'fs:copy' };
	case 'fs:removeTree':
		return { kind: 'fs:removeTree' };
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
	// The contract promises 0-100 and Phase 4 renders it as a percentage. Clamping
	// an out-of-range byte would report a false full battery and let the heartbeat
	// succeed, hiding exactly the layout change this error exists to surface — and
	// the layout was measured on one firmware. Refusing costs nothing now that a
	// ProtocolError no longer tears the session down.
	if (payload[8] > 100) {
		throw new ProtocolError(
			`Battery level out of range: ${payload[8]} is not a percentage. `
			+ 'The reply layout does not match this firmware.'
		);
	}
	return {
		kind: 'battery',
		level: payload[8],
		voltage: readFloat32le(payload, 0),
		currentAmps: readFloat32le(payload, 4),
	};
}

function parsePorts(payload: Uint8Array): PortsResponse {
	const sensorPorts: PortState[] = [];
	const motorPorts: PortState[] = [];

	// The firmware does not clear the global buffer, so a slot it did not write holds
	// whatever the previous command left there — verified on hardware, where the unwritten
	// bytes were legible ASCII. Presence therefore comes from the type code only, and a
	// value is trusted only for a port that reports a device.

	// Sensor type/mode: bytes 0..7 (2 per port)
	for (let i = 0; i < 4; i++) {
		const typeCode = payload.length > i * 2 ? payload[i * 2] : NO_DEVICE_TYPE;
		const present = typeCode !== NO_DEVICE_TYPE;
		const raw = hasReading(typeCode) && payload.length >= 16 + (i + 1) * 4
			? readFloat32le(payload, 16 + i * 4)
			: undefined;
		sensorPorts.push({
			port: SENSOR_PORT_LABELS[i],
			peripheralType: present
				? SENSOR_TYPE_NAMES[typeCode] ?? `sensor-${typeCode}`
				: undefined,
			// DATAF_NAN is a real NaN, so a device with no reading yet is reported as
			// having none rather than as holding a nonsense number.
			value: raw !== undefined && Number.isFinite(raw) ? raw : undefined,
			timestamp: Date.now(),
		});
	}

	// Motor type/mode: bytes 8..15 (2 per port)
	for (let i = 0; i < 4; i++) {
		const typeCode = payload.length > 8 + i * 2 ? payload[8 + i * 2] : NO_DEVICE_TYPE;
		const present = typeCode !== NO_DEVICE_TYPE;
		const raw = hasReading(typeCode) && payload.length >= 32 + (i + 1) * 4
			? readInt32le(payload, 32 + i * 4)
			: undefined;
		const tachoValue = raw === DATA32_NAN ? undefined : raw;
		motorPorts.push({
			port: MOTOR_PORT_LABELS[i],
			peripheralType: present
				? MOTOR_TYPE_NAMES[typeCode] ?? `motor-${typeCode}`
				: undefined,
			value: tachoValue,
			unit: tachoValue !== undefined ? 'deg' : undefined,
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
	const entries = listing
		.split('\n')
		.filter((line) => line.length > 0)
		.map(parseListingLine);
	return {
		kind: 'fs:list',
		entries,
		/** Whether the brick still has more of this listing to hand over. */
		complete: payload[1] === EV3_SYSTEM_STATUS.END_OF_FILE,
		handle: payload.length > 6 ? payload[6] : undefined,
	};
}

/**
 * A continuation reply, whose header is `[echo][status][handle]` - three bytes, where
 * the opening `LIST_FILES` reply carries a four-byte list size as well.
 */
function parseFsListContinue(payload: Uint8Array): FsListContinueResponse {
	if (payload.length < 3) {
		throw new ProtocolError(
			`Malformed fs:listContinue reply: expected at least 3 bytes, got ${payload.length}.`
		);
	}
	const listing = Buffer.from(payload.subarray(3)).toString('utf8');
	return {
		kind: 'fs:listContinue',
		entries: listing.split('\n').filter((l) => l.length > 0).map(parseListingLine),
		complete: payload[1] === EV3_SYSTEM_STATUS.END_OF_FILE,
		handle: payload[2],
	};
}

/**
 * Splits one listing line into its parts.
 *
 * `cComGetFileInfo` writes a directory as `name/` and a file as
 * `<32 hex md5> <8 hex size> name`. The `.` and `..` entries arrive like any other
 * directory and are dropped by the caller, not here — a parser should not decide policy.
 */
function parseListingLine(line: string): FsEntry {
	if (line.endsWith('/')) {
		return { name: line.slice(0, -1), kind: 'directory' };
	}

	// 32 hex, space, 8 hex, space, then the name.
	const match = /^([0-9A-Fa-f]{32}) ([0-9A-Fa-f]{8}) (.+)$/.exec(line);
	if (match) {
		return {
			name: match[3],
			kind: 'file',
			bytes: parseInt(match[2], 16),
			md5: match[1].toLowerCase(),
		};
	}

	// A line in neither shape: report it rather than guess, so an unexpected firmware
	// format shows up as an odd name instead of a silently dropped entry.
	return { name: line, kind: 'unknown' };
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

function parseFsExists(payload: Uint8Array): FsExistsResponse {
	// One output byte from `opFILENAME/EXIST`: non-zero when the path resolves.
	//
	// This used to infer existence from a LIST_FILES reply not erroring, and returned
	// true whatever came back — including for a file in a directory that had just been
	// created empty. The builder moved to the real primitive without the parser
	// following, so the right question was asked and the answer thrown away.
	if (payload.length < 1) {
		throw new ProtocolError('Malformed fs:exists reply: no result byte.');
	}
	return { kind: 'fs:exists', exists: payload[0] !== 0 };
}

/**
 * Reads the `[echo][status]` prefix every system reply opens with.
 *
 * `END_OF_FILE` is deliberately not an error: the firmware sets it as a status on an
 * ordinary SYSTEM_REPLY (its error paths set `CmdType` to SYSTEM_REPLY_ERROR instead),
 * and it is how a transfer learns it has reached the last chunk.
 */
function transferStatus(payload: Uint8Array, kind: string): number {
	if (payload.length < 2) {
		throw new ProtocolError(
			`Malformed ${kind} reply: expected at least 2 bytes, got ${payload.length}.`
		);
	}
	return payload[1];
}

function parseFsBeginWrite(payload: Uint8Array): FsBeginWriteResponse {
	const status = transferStatus(payload, 'fs:beginWrite');
	if (payload.length < 3) {
		throw new ProtocolError('BEGIN_DOWNLOAD reply carried no file handle.');
	}
	return {
		kind: 'fs:beginWrite',
		handle: payload[2],
		endOfFile: status === EV3_SYSTEM_STATUS.END_OF_FILE,
	};
}

function parseFsContinueWrite(payload: Uint8Array): FsContinueWriteResponse {
	const status = transferStatus(payload, 'fs:continueWrite');
	if (payload.length < 3) {
		throw new ProtocolError('CONTINUE_DOWNLOAD reply carried no file handle.');
	}
	return {
		kind: 'fs:continueWrite',
		handle: payload[2],
		endOfFile: status === EV3_SYSTEM_STATUS.END_OF_FILE,
	};
}

function parseFsBeginRead(payload: Uint8Array): FsBeginReadResponse {
	// [0] echo, [1] status, [2..5] total size, [6] handle, [7..] payload
	const status = transferStatus(payload, 'fs:beginRead');
	if (payload.length < 7) {
		throw new ProtocolError(
			`Malformed BEGIN_UPLOAD reply: expected at least 7 bytes, got ${payload.length}.`
		);
	}
	return {
		kind: 'fs:beginRead',
		totalBytes: readUint32le(payload, 2),
		handle: payload[6],
		endOfFile: status === EV3_SYSTEM_STATUS.END_OF_FILE,
		chunk: payload.subarray(7),
	};
}

function parseFsContinueRead(payload: Uint8Array): FsContinueReadResponse {
	// [0] echo, [1] status, [2] handle, [3..] payload — no size, unlike BEGIN_UPLOAD
	const status = transferStatus(payload, 'fs:continueRead');
	if (payload.length < 3) {
		throw new ProtocolError('CONTINUE_UPLOAD reply carried no file handle.');
	}
	return {
		kind: 'fs:continueRead',
		handle: payload[2],
		endOfFile: status === EV3_SYSTEM_STATUS.END_OF_FILE,
		chunk: payload.subarray(3),
	};
}

function parseFsCloseHandle(payload: Uint8Array): FsCloseHandleResponse {
	transferStatus(payload, 'fs:closeHandle');
	return { kind: 'fs:closeHandle' };
}

function parseFsSize(payload: Uint8Array): FsSizeResponse {
	if (payload.length < 8) {
		throw new ProtocolError(
			`Malformed fs:size reply: expected 8 bytes, got ${payload.length}.`
		);
	}
	// Firmware order: files first, then the kilobyte total.
	return {
		kind: 'fs:size',
		files: readUint32le(payload, 0),
		kilobytes: readUint32le(payload, 4),
	};
}

function parseFsFreeSpace(payload: Uint8Array): FsFreeSpaceResponse {
	if (payload.length < 8) {
		throw new ProtocolError(
			`Malformed fs:freeSpace reply: expected 8 bytes, got ${payload.length}.`
		);
	}
	return {
		kind: 'fs:freeSpace',
		totalKb: readUint32le(payload, 0),
		freeKb: readUint32le(payload, 4),
	};
}

function parseFsMakeDirectory(payload: Uint8Array): FsMakeDirectoryResponse {
	if (payload.length < 1) {
		throw new ProtocolError('Malformed fs:makeDirectory reply: no result byte.');
	}
	return { kind: 'fs:makeDirectory', exists: payload[0] !== 0 };
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
