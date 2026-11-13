/**
 * The view of the active brick, from what the loops read (step-6 plan U6; IMPLEMENTATION_PLAN
 * 3.5.1–3.5.6; DESIGN §5.3; owner decisions D3, D9).
 *
 * A pure function from the read model's rows of one brick, and what the caller knows about it
 * (identity, route, channels, the panel's preferences), to `ActiveBrickViewModel`. The panel
 * (Phase 5) draws it; nothing here talks to a loop or keeps state.
 *
 * - Every port is listed, read or not, and carries its daisy-chain layer, 0 until chains are
 *   supported (D3).
 * - What is on a port comes from its occupancy row's type code. A value is shown only for a known
 *   device: an empty, identifying or faulty port answers NaN or a stale number, and showing that
 *   would claim a reading there is not.
 * - The raw type code stays beside the name, so a device the vocabulary does not name is still
 *   recognisable (3.2.3).
 * - A port is stale when its type or its value is (D9).
 * - Nothing read is nothing shown: no battery read yet is no battery, not a zero.
 */

import { ConnectionState, Transport } from '../contracts/enums';
import type { BrickRef } from '../contracts/brickKey';
import type { ActiveBrickViewModel, BatteryState, PortState, ValueDisplayStyle } from '../contracts/models';
import { peripheralTypeOf } from '../protocol/peripheralTypes';
import { MOTOR_PORT_NAMES, SENSOR_PORT_NAMES } from './ev3Rows';
import { portStateOf } from './portState';
import type { ReadValue } from './telemetryReadModel';

/** What the view is built from. */
export interface ActiveBrickInput {
	readonly brickKey: BrickRef;
	readonly displayName: string;
	/** The transport the brick's traffic goes over now. */
	readonly transport: Transport;
	readonly connectionState: ConnectionState;
	readonly availableTransports: readonly Transport[];
	/** The panel's preferences; they have their own store (Phase 5/6). */
	readonly favorite: boolean;
	readonly valueDisplayStyle: ValueDisplayStyle;
	/** The read model's values of this brick. */
	readonly values: readonly ReadValue[];
}

/** Daisy-chain layer of every port until chains are supported (D3). */
const LAYER = 0;
const BUTTON_PREFIX = 'ui.button.';

export function activeBrickView(input: ActiveBrickInput): ActiveBrickViewModel {
	const byId = new Map(input.values.map((value) => [value.rowId, value] as const));
	const port = (kind: 'sensor' | 'motor', name: string, valueRow: string): PortState =>
		portView(name, byId.get(`ports.${kind}.${name}.occupancy`), byId.get(`ports.${kind}.${name}.${valueRow}`));

	const buttons: Record<string, boolean> = {};
	for (const value of input.values) {
		if (value.rowId.startsWith(BUTTON_PREFIX) && typeof value.value === 'boolean') {
			buttons[value.rowId.slice(BUTTON_PREFIX.length)] = value.value;
		}
	}

	const battery = batteryView(byId.get('system.battery.level'), byId.get('system.battery.voltage'));
	const firmware = byId.get('system.firmwareVersion')?.value;
	const visible = byId.get('system.bluetooth.visible')?.value;

	return {
		brickKey: input.brickKey,
		displayName: input.displayName,
		transport: input.transport,
		connectionState: input.connectionState,
		...(battery ? { battery } : {}),
		availableTransports: [...input.availableTransports],
		...(typeof visible === 'boolean' ? { btVisible: visible } : {}),
		motorPorts: MOTOR_PORT_NAMES.map((name) => port('motor', name, 'tacho')),
		sensorPorts: SENSOR_PORT_NAMES.map((name) => port('sensor', name, 'value')),
		buttons,
		...(typeof firmware === 'string' ? { firmwareVersion: firmware } : {}),
		favorite: input.favorite,
		valueDisplayStyle: input.valueDisplayStyle,
	};
}

function portView(name: string, occupancy: ReadValue | undefined, reading: ReadValue | undefined): PortState {
	const code = typeof occupancy?.value === 'number' ? occupancy.value : undefined;
	const state = portStateOf(code);
	const known = state === 'known';
	const showsValue = known && reading !== undefined;
	return {
		port: name,
		layer: LAYER,
		occupancy: state,
		...(known && code !== undefined ? { peripheralType: peripheralTypeOf(code) } : {}),
		...(code !== undefined ? { typeCode: code } : {}),
		...(occupancy?.mode !== undefined ? { mode: occupancy.mode } : {}),
		...(showsValue && reading.value !== undefined && typeof reading.value !== 'boolean' ? { value: reading.value } : {}),
		...(showsValue && reading.unit !== undefined ? { unit: reading.unit } : {}),
		...(showsValue ? { timestamp: reading.sampledAt } : {}),
		...(occupancy || reading ? { stale: occupancy?.stale === true || reading?.stale === true } : {}),
	};
}

function batteryView(level: ReadValue | undefined, voltage: ReadValue | undefined): BatteryState | undefined {
	if (typeof level?.value !== 'number') { return undefined; }
	return {
		level: level.value,
		...(typeof voltage?.value === 'number' ? { voltage: voltage.value } : {}),
	};
}
