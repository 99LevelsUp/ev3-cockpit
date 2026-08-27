/**
 * The EV3 row catalogue: every value the cockpit can read, as a row.
 *
 * Encodings here are the ones the `ports`, `battery` and `buttons` commands already use, so
 * they inherit that verification rather than being written from the specification again.
 * Plan 3.1.4a is why that matters: `INPUT_READ_SI` once held 0x9A (`opINPUT_READ`, a one-byte
 * percent) instead of 0x9D (`opINPUT_READSI`, a float), and every sensor value was one real
 * byte followed by three of the previous command's leftovers.
 *
 * Note which rows declare alignment 4. It is per instruction, not per width: `opINPUT_READSI`
 * rejects an unaligned 32-bit result and answers `DIRECT_REPLY_ERROR` carrying the previous
 * payload, while `opINPUT_DEVICE`/`READY_SI` accepts the same offset. Both measured 3 of 3 on
 * a brick. We use the former, so these rows are strict.
 */

import {
	EV3_OPCODE,
	INPUT_DEVICE_SUB,
	UI_READ_SUB,
	UI_BUTTON_SUB,
	COM_GET_SUB,
} from '../protocol/ev3Packet';
import {
	lc0,
	concatBytes,
	readFloat32le,
	readInt32le,
	readFixedCString,
} from '../protocol/ev3Bytecode';
import { globalRef } from './frameAssembler';
import { RowLifetime, RowSlot, RowValue, TelemetryRow } from './telemetryRow';

const LAYER_SELF = 0;

/** Sensor ports 1-4 as the firmware numbers them. */
const SENSOR_PORTS = [0, 1, 2, 3];

/**
 * Motor ports as `opINPUT_DEVICE` numbers them: 16-19 for A-D.
 *
 * `opOUTPUT_GET_COUNT` uses 0-3 for the same ports. Two numbering schemes for one set of
 * sockets, which is worth stating where both appear.
 */
const MOTOR_INPUT_PORTS = [16, 17, 18, 19];

const SENSOR_PORT_NAMES = ['1', '2', '3', '4'];
const MOTOR_PORT_NAMES = ['A', 'B', 'C', 'D'];

/** Buttons in the order the existing `buttons` command reads them. */
const BUTTON_NAMES = ['up', 'enter', 'down', 'right', 'left', 'back'] as const;
const BUTTON_CODES = [1, 2, 3, 4, 5, 6];

/** Default cadence per tier, as tick dividers. Tick period comes from the transport. */
export const DEFAULT_DIVIDERS = {
	/** Every tick: sensor values, tacho, buttons. */
	sampled: 1,
	/** Every fifth tick, as LEGO's own Device Manager divides its slow tier. */
	event: 5,
} as const;

const repeating = (divider: number): RowLifetime => ({ kind: 'repeating', divider });
const oneShot: RowLifetime = { kind: 'oneShot' };

function value(rowId: string, v: RowValue['value'], sampledAt: number, unit?: string): RowValue {
	return { rowId, value: v, unit, sampledAt };
}

// ── Ports ────────────────────────────────────────────────────────────

/**
 * Occupancy for one sensor port: the type code and the mode, two bytes.
 *
 * A row with its own divider, not a header stapled to every frame. An earlier version of the
 * design required reading every port's type in every frame, which on the 64-byte HID path
 * cost ~48 of the 57 available bytes and left room for a single value — so truncation would
 * have starved every value row permanently. The trade accepted instead: a hot-plug is noticed
 * when this row next comes up, which is invisible beside the 1-2 seconds a device spends
 * reporting `TYPE_UNKNOWN` while it identifies.
 *
 * `GET_TYPEMODE` reads `DeviceType` and `DeviceMode` straight out of memory and never blocks,
 * so this row is safe at any divider. The value rows are the ones that can stall.
 */
export function sensorOccupancyRow(index: number, divider = DEFAULT_DIVIDERS.event): TelemetryRow {
	const port = SENSOR_PORT_NAMES[index];
	const id = `ports.sensor.${port}.occupancy`;
	return {
		id,
		tier: 'event',
		lifetime: repeating(divider),
		result: { bytes: 2, alignment: 1 },
		port,
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]),
			lc0(LAYER_SELF), lc0(SENSOR_PORTS[index]),
			globalRef(slot), globalRef(slot + 1),
		),
		parse: (payload, slot, sampledAt) => value(id, payload[slot], sampledAt),
	};
}

/** Occupancy for one motor port. Same instruction, the other port numbering. */
export function motorOccupancyRow(index: number, divider = DEFAULT_DIVIDERS.event): TelemetryRow {
	const port = MOTOR_PORT_NAMES[index];
	const id = `ports.motor.${port}.occupancy`;
	return {
		id,
		tier: 'event',
		lifetime: repeating(divider),
		result: { bytes: 2, alignment: 1 },
		port,
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]),
			lc0(LAYER_SELF), lc0(MOTOR_INPUT_PORTS[index]),
			globalRef(slot), globalRef(slot + 1),
		),
		parse: (payload, slot, sampledAt) => value(id, payload[slot], sampledAt),
	};
}

/**
 * One sensor reading in SI units.
 *
 * Only comes up while its port's last known occupancy was a real device type. Reading an
 * *identifying* port is what the scheduler must avoid: the port is not absent, so the read
 * takes the device-present path, and a still-settling device makes the firmware re-execute
 * the instruction — `SetObjectIp(TmpIp - 1); SetDispatchStatus(BUSYBREAK)` — for up to
 * `MAX_DEVICE_BUSY_TIME`, 1200 ms, holding the whole frame and everything behind it.
 */
export function sensorValueRow(
	index: number,
	mode = 0,
	divider = DEFAULT_DIVIDERS.sampled,
): TelemetryRow {
	const port = SENSOR_PORT_NAMES[index];
	const id = `ports.sensor.${port}.value`;
	return {
		id,
		tier: 'sampled',
		lifetime: repeating(divider),
		result: { bytes: 4, alignment: 4 },
		port,
		mode,
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.INPUT_READ_SI]),
			lc0(LAYER_SELF), lc0(SENSOR_PORTS[index]),
			lc0(0),      // type hint: 0 lets the firmware use what it detected
			lc0(mode),
			globalRef(slot),
		),
		parse: (payload, slot, sampledAt) => value(id, readFloat32le(payload, slot), sampledAt),
	};
}

/** One motor's tacho count, in degrees. */
export function motorTachoRow(index: number, divider = DEFAULT_DIVIDERS.sampled): TelemetryRow {
	const port = MOTOR_PORT_NAMES[index];
	const id = `ports.motor.${port}.tacho`;
	return {
		id,
		tier: 'sampled',
		lifetime: repeating(divider),
		result: { bytes: 4, alignment: 4 },
		port,
		unit: 'deg',
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.OUTPUT_GET_COUNT]),
			lc0(LAYER_SELF),
			lc0(index),   // opOUTPUT_GET_COUNT numbers motor ports 0-3
			globalRef(slot),
		),
		parse: (payload, slot, sampledAt) =>
			value(id, readInt32le(payload, slot), sampledAt, 'deg'),
	};
}

// ── System ───────────────────────────────────────────────────────────

/**
 * Battery charge in percent.
 *
 * Event tier deliberately: it is dynamic, but nothing needs its instantaneous value. If
 * brownout detection ever becomes a requirement this moves to sampled — the divider is the
 * only thing that changes.
 */
export function batteryLevelRow(divider = DEFAULT_DIVIDERS.event): TelemetryRow {
	const id = 'system.battery.level';
	return {
		id,
		tier: 'event',
		lifetime: repeating(divider),
		result: { bytes: 1, alignment: 1 },
		unit: '%',
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.UI_READ, UI_READ_SUB.GET_LBATT]),
			globalRef(slot),
		),
		parse: (payload, slot, sampledAt) => value(id, payload[slot], sampledAt, '%'),
	};
}

/** Battery voltage, float32. */
export function batteryVoltageRow(divider = DEFAULT_DIVIDERS.event): TelemetryRow {
	const id = 'system.battery.voltage';
	return {
		id,
		tier: 'event',
		lifetime: repeating(divider),
		result: { bytes: 4, alignment: 4 },
		unit: 'V',
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.UI_READ, UI_READ_SUB.GET_VBATT]),
			globalRef(slot),
		),
		parse: (payload, slot, sampledAt) =>
			value(id, readFloat32le(payload, slot), sampledAt, 'V'),
	};
}

/** One button's pressed state. */
export function buttonRow(index: number, divider = DEFAULT_DIVIDERS.sampled): TelemetryRow {
	const name = BUTTON_NAMES[index];
	const id = `ui.button.${name}`;
	return {
		id,
		tier: 'sampled',
		lifetime: repeating(divider),
		result: { bytes: 1, alignment: 1 },
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.UI_BUTTON, UI_BUTTON_SUB.PRESSED]),
			lc0(BUTTON_CODES[index]),
			globalRef(slot),
		),
		parse: (payload, slot, sampledAt) => value(id, payload[slot] === 1, sampledAt),
	};
}

/**
 * The brick's own name, which is mutable — renaming is a feature.
 *
 * Event tier, unlike the firmware version it used to share a command with. `info` returning
 * both is exactly why cadence cannot be a property of a command.
 */
export function brickNameRow(divider = DEFAULT_DIVIDERS.event): TelemetryRow {
	const id = 'system.brickName';
	const NAME_BYTES = 16;
	return {
		id,
		tier: 'event',
		lifetime: repeating(divider),
		result: { bytes: NAME_BYTES, alignment: 1 },
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.COM_GET, COM_GET_SUB.GET_BRICKNAME]),
			lc0(NAME_BYTES),
			globalRef(slot),
		),
		parse: (payload, slot, sampledAt) =>
			value(id, readFixedCString(payload, slot, NAME_BYTES), sampledAt),
	};
}

/**
 * Firmware version: read once, then retired.
 *
 * One-shot rather than divider 0, which can only say never. LEGO's own Device Manager
 * re-reads this every fifth tick on a product that can flash firmware in-session; if that
 * ever becomes ours to support, this row becomes repeating and nothing else changes.
 */
export function firmwareVersionRow(): TelemetryRow {
	const id = 'system.firmwareVersion';
	const VERSION_BYTES = 16;
	return {
		id,
		tier: 'static',
		lifetime: oneShot,
		result: { bytes: VERSION_BYTES, alignment: 1 },
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.UI_READ, UI_READ_SUB.GET_FW_VERS]),
			lc0(VERSION_BYTES),
			globalRef(slot),
		),
		parse: (payload, slot, sampledAt) =>
			value(id, readFixedCString(payload, slot, VERSION_BYTES), sampledAt),
	};
}

/**
 * Every row a brick offers, in truncation priority order.
 *
 * The order is the answer to "what survives a tight tick", so it puts what a user watches
 * first: sensor values and tacho, then buttons, then the slower system rows, then occupancy.
 * Occupancy last looks wrong until you remember it has a slow divider anyway — on the ticks
 * where it does come up, losing it costs one divider period, while losing a sensor value
 * costs a visibly frozen reading.
 */
export function allEv3Rows(): TelemetryRow[] {
	return [
		...SENSOR_PORTS.map((_, i) => sensorValueRow(i)),
		...MOTOR_PORT_NAMES.map((_, i) => motorTachoRow(i)),
		...BUTTON_NAMES.map((_, i) => buttonRow(i)),
		batteryVoltageRow(),
		batteryLevelRow(),
		brickNameRow(),
		firmwareVersionRow(),
		...SENSOR_PORTS.map((_, i) => sensorOccupancyRow(i)),
		...MOTOR_PORT_NAMES.map((_, i) => motorOccupancyRow(i)),
	];
}

export { SENSOR_PORT_NAMES, MOTOR_PORT_NAMES, BUTTON_NAMES };
