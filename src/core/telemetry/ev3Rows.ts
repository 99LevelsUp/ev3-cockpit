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
	COM_HARDWARE,
	PROGRAM_INFO_SUB,
	PROGRAM_SLOT,
	PROGRAM_STATUS,
} from '../protocol/ev3Packet';
import {
	lc0,
	lc1,
	concatBytes,
	readFloat32le,
	readInt32le,
	readFixedCString,
} from '../protocol/ev3Bytecode';
import { globalRef } from './frameAssembler';
import { portStateOf } from './portState';
import { RowLifetime, RowSlot, RowValue, TelemetryRow } from './telemetryRow';

const LAYER_SELF = 0;

/**
 * The layers of the bricks a master can have below it in a USB daisy chain: three, for four
 * bricks in all (`DAISY_MAX_LAYER_DEPT`, `c_daisy.h`).
 */
export const CHAIN_LAYERS = [1, 2, 3] as const;

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
 * Where a port row is named. The master's own ports keep the ids and port names they always had
 * (`ports.sensor.1.value`, port `'1'`), so nothing a consumer subscribed to changes. A port of a
 * brick below it in the chain lives under `chain.<layer>`, and its port name carries the layer
 * (`'2:3'`), because the scheduler and the mode claims key on the port name alone.
 */
function portRow(kind: 'sensor' | 'motor', name: string, field: string, layer: number):
{ id: string; port: string; layer?: number } {
	const id = portRowId(kind, name, field, layer);
	if (layer === LAYER_SELF) { return { id, port: name }; }
	return { id, port: `${layer}:${name}`, layer };
}

/** The id of a port row: `ports.sensor.1.value` for the brick's own port, `chain.2.sensor.1.value` for layer 2's. */
export function portRowId(kind: 'sensor' | 'motor', name: string, field: string, layer = LAYER_SELF): string {
	return layer === LAYER_SELF ? `ports.${kind}.${name}.${field}` : `chain.${layer}.${kind}.${name}.${field}`;
}

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
export function sensorOccupancyRow(index: number, divider: number = DEFAULT_DIVIDERS.event, layer = LAYER_SELF): TelemetryRow {
	return occupancyRow(portRow('sensor', SENSOR_PORT_NAMES[index], 'occupancy', layer), SENSOR_PORTS[index], divider);
}

/**
 * Occupancy for one motor port. Same instruction, the other port numbering.
 *
 * On a member of a daisy chain this is all there is of a motor: its type crosses the chain, its
 * tacho does not (IMPLEMENTATION_PLAN 3.1.4f), so no tacho row exists for a member.
 */
export function motorOccupancyRow(index: number, divider: number = DEFAULT_DIVIDERS.event, layer = LAYER_SELF): TelemetryRow {
	return occupancyRow(portRow('motor', MOTOR_PORT_NAMES[index], 'occupancy', layer), MOTOR_INPUT_PORTS[index], divider);
}

function occupancyRow(
	{ id, port, layer }: { id: string; port: string; layer?: number },
	firmwarePort: number,
	divider: number,
): TelemetryRow {
	return {
		id,
		tier: 'event',
		lifetime: repeating(divider),
		result: { bytes: 2, alignment: 1 },
		port,
		...(layer !== undefined ? { layer } : {}),
		reportsOccupancy: true,
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]),
			lc0(layer ?? LAYER_SELF), lc0(firmwarePort),
			globalRef(slot), globalRef(slot + 1),
		),
		parse: (payload, slot, sampledAt) => ({ ...value(id, payload[slot], sampledAt), mode: payload[slot + 1] }),
	};
}

/**
 * One sensor reading in SI units.
 *
 * Only comes up while its port's last known occupancy was a real device type. `opINPUT_READSI`
 * never changes the dispatch status (`c_input.c` `cInputReadSi`): an empty, faulty or still
 * busy port answers NaN at once. The re-execution for up to `MAX_DEVICE_BUSY_TIME` belongs to
 * `opINPUT_DEVICE`'s `READY_*` subcodes, which no row uses (step 6, 11.11.2026; U10 measures it).
 */
export function sensorValueRow(
	index: number,
	mode = 0,
	divider: number = DEFAULT_DIVIDERS.sampled,
	layer = LAYER_SELF,
): TelemetryRow {
	const { id, port, layer: memberLayer } = portRow('sensor', SENSOR_PORT_NAMES[index], 'value', layer);
	return {
		id,
		tier: 'sampled',
		lifetime: repeating(divider),
		result: { bytes: 4, alignment: 4 },
		port,
		...(memberLayer !== undefined ? { layer: memberLayer } : {}),
		mode,
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.INPUT_READ_SI]),
			lc0(layer), lc0(SENSOR_PORTS[index]),
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
 * One `opCOM_GET` byte about a radio: on, visible, present, or how many peers it remembers
 * (3.1.3, 3.1.4k).
 *
 * The radio is typed as Bluetooth or Wi-Fi on purpose. `GET_ON_OFF` asked of USB leaves the
 * firmware's dispatch status at FAILBREAK (`c_com.c` 4296–4330), and that ends the whole direct
 * command (`lms2012.c` 2496–2510): every row in the frame would be lost, not just this one. The
 * subcodes used here all answer NOBREAK for the radios they are asked about.
 */
function radioRow(
	id: string,
	subcode: number,
	hardware: typeof COM_HARDWARE.BT | typeof COM_HARDWARE.WIFI,
	asNumber: boolean,
	divider: number,
): TelemetryRow {
	return {
		id,
		tier: 'event',
		lifetime: repeating(divider),
		result: { bytes: 1, alignment: 1 },
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.COM_GET, subcode]),
			lc0(hardware),
			globalRef(slot),
		),
		parse: (payload, slot, sampledAt) =>
			value(id, asNumber ? payload[slot] : payload[slot] !== 0, sampledAt),
	};
}

/** Bluetooth switched on in the brick's settings. */
export const bluetoothOnRow = (divider: number = DEFAULT_DIVIDERS.event): TelemetryRow =>
	radioRow('system.bluetooth.on', COM_GET_SUB.GET_ON_OFF, COM_HARDWARE.BT, false, divider);

/** Bluetooth visible to a search. */
export const bluetoothVisibleRow = (divider: number = DEFAULT_DIVIDERS.event): TelemetryRow =>
	radioRow('system.bluetooth.visible', COM_GET_SUB.GET_VISIBLE, COM_HARDWARE.BT, false, divider);

/**
 * How many peers the brick remembers on Bluetooth (`FAVOUR_ITEMS`, 3.1.4k).
 *
 * The count only. The entries themselves stay a command (`bluetooth:peer`): the list has a
 * variable length, and the firmware does not bounds-check the index (`c_bt.c` 3561–3567), so
 * each entry may be asked only after this count is known.
 */
export const bluetoothPeersRow = (divider: number = DEFAULT_DIVIDERS.event): TelemetryRow =>
	radioRow('system.bluetooth.peers', COM_GET_SUB.FAVOUR_ITEMS, COM_HARDWARE.BT, true, divider);

/** Wi-Fi switched on. */
export const wifiOnRow = (divider: number = DEFAULT_DIVIDERS.event): TelemetryRow =>
	radioRow('system.wifi.on', COM_GET_SUB.GET_ON_OFF, COM_HARDWARE.WIFI, false, divider);

/** A Wi-Fi dongle the firmware knows is plugged in. */
export const wifiPresentRow = (divider: number = DEFAULT_DIVIDERS.event): TelemetryRow =>
	radioRow('system.wifi.present', COM_GET_SUB.GET_PRESENT, COM_HARDWARE.WIFI, false, divider);

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
 * Whether a program runs in the user slot (step-6 plan U9).
 *
 * The `program:status` command's encoding, as a row: it rides in the frame a read brick sends
 * anyway (D8) instead of a command of its own, and the telemetry service slows the loop while it
 * says running (D11). Event tier: a program starting or ending is an event, and the foreground
 * reads it every fifth tick. Only `RUNNING` is a running program; a halted or unknown slot is not.
 */
export const PROGRAM_RUNNING_ROW = 'program.user.running';

export function programRunningRow(divider = DEFAULT_DIVIDERS.event): TelemetryRow {
	const id = PROGRAM_RUNNING_ROW;
	return {
		id,
		tier: 'event',
		lifetime: repeating(divider),
		result: { bytes: 1, alignment: 1 },
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.PROGRAM_INFO]),
			lc0(PROGRAM_INFO_SUB.GET_STATUS),
			lc0(PROGRAM_SLOT.USER),
			globalRef(slot),
		),
		parse: (payload, slot, sampledAt) => value(id, payload[slot] === PROGRAM_STATUS.RUNNING, sampledAt),
	};
}

// ── Daisy chain ──────────────────────────────────────────────────────

/** The row that says how deep the chain below a brick is. */
export const CHAIN_DEPTH_ROW = 'chain.depth';

/** Entries in the master's device list: four sensor and four motor ports for each of four bricks. */
const DEVICE_LIST_LENGTH = 32;

/**
 * How many bricks hang below this one in a USB daisy chain: 0 for none, up to 3.
 *
 * The master keeps the type of every port of the whole chain in one array and refreshes it on its
 * own (`c_input.c` `cInputDcmUpdate`); `opINPUT_DEVICE_LIST` copies it in one instruction that
 * never blocks (`c_input.c` 3750–3776). Sensors sit at layer × 4 + port, motors at 16 + layer × 4
 * + port. Measured on three chained bricks 17.11.2026: the list agrees with `GET_TYPEMODE` on
 * every port, and no motor shows on a port with nothing in it.
 *
 * The depth is the deepest layer with a device on any port. A brick with nothing plugged in reads
 * exactly like no brick, so an empty last member is not counted; one above a member with a device
 * is, because a chain has no gaps. The list's `CHANGED` byte is not used: reading it resets it for
 * the asking program slot, so a second reader would steal it.
 */
export function chainDepthRow(divider: number = DEFAULT_DIVIDERS.event): TelemetryRow {
	const id = CHAIN_DEPTH_ROW;
	return {
		id,
		tier: 'event',
		lifetime: repeating(divider),
		result: { bytes: DEVICE_LIST_LENGTH + 1, alignment: 1 },
		reportsChainDepth: true,
		emit: (slot: RowSlot) => concatBytes(
			new Uint8Array([EV3_OPCODE.INPUT_DEVICE_LIST]),
			lc1(DEVICE_LIST_LENGTH),   // 32 does not fit a short constant
			globalRef(slot),
			globalRef(slot + DEVICE_LIST_LENGTH),
		),
		parse: (payload, slot, sampledAt) => value(id, chainDepthOf(payload.subarray(slot, slot + DEVICE_LIST_LENGTH)), sampledAt),
	};
}

function chainDepthOf(types: Uint8Array): number {
	let depth = 0;
	for (const layer of CHAIN_LAYERS) {
		const indexes = [0, 1, 2, 3].flatMap((port) => [layer * 4 + port, 16 + layer * 4 + port]);
		// Empty is `TYPE_NONE`, what every port of a missing brick reads too.
		if (indexes.some((index) => portStateOf(types[index]) !== 'empty')) { depth = layer; }
	}
	return depth;
}

/**
 * Every row a brick offers, in truncation priority order.
 *
 * The order is the answer to "what survives a tight tick", so it puts what a user watches
 * first: sensor values and tacho, then buttons, then the slower system rows, then occupancy.
 * Occupancy last looks wrong until you remember it has a slow divider anyway — on the ticks
 * where it does come up, losing it costs one divider period, while losing a sensor value
 * costs a visibly frozen reading.
 *
 * The rows of bricks below this one in a daisy chain follow the master's rows of the same kind,
 * and the chain's depth comes last. The scheduler orders by urgency each tick, so the order here
 * breaks ties only; what keeps a brick with no chain from paying for member rows is the
 * scheduler's layer gate.
 */
export function allEv3Rows(): TelemetryRow[] {
	return [
		...SENSOR_PORTS.map((_, i) => sensorValueRow(i)),
		...CHAIN_LAYERS.flatMap((layer) => SENSOR_PORTS.map((_, i) => sensorValueRow(i, 0, DEFAULT_DIVIDERS.sampled, layer))),
		...MOTOR_PORT_NAMES.map((_, i) => motorTachoRow(i)),
		...BUTTON_NAMES.map((_, i) => buttonRow(i)),
		// Before the system rows: it decides how fast the whole loop may run (D11).
		programRunningRow(),
		batteryVoltageRow(),
		batteryLevelRow(),
		brickNameRow(),
		bluetoothOnRow(),
		bluetoothVisibleRow(),
		bluetoothPeersRow(),
		wifiOnRow(),
		wifiPresentRow(),
		firmwareVersionRow(),
		...SENSOR_PORTS.map((_, i) => sensorOccupancyRow(i)),
		...MOTOR_PORT_NAMES.map((_, i) => motorOccupancyRow(i)),
		...CHAIN_LAYERS.flatMap((layer) => SENSOR_PORTS.map((_, i) => sensorOccupancyRow(i, DEFAULT_DIVIDERS.event, layer))),
		...CHAIN_LAYERS.flatMap((layer) => MOTOR_PORT_NAMES.map((_, i) => motorOccupancyRow(i, DEFAULT_DIVIDERS.event, layer))),
		chainDepthRow(),
	];
}

export { SENSOR_PORT_NAMES, MOTOR_PORT_NAMES, BUTTON_NAMES };
