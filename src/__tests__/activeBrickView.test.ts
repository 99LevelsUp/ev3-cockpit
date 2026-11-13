/**
 * The view of the active brick, built from the read model (step-6 plan U6; IMPLEMENTATION_PLAN
 * 3.5.1–3.5.6, 3.7.5; DESIGN §5.3; owner decision D3).
 *
 * A pure function: what the panel will show (Phase 5) from the rows the loops read. A port shows a
 * value only when a known device is on it; the raw type code stays beside the name, so a device we
 * have never heard of stays recognisable; every port carries its daisy-chain layer, 0 for now.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BrickId } from '../contracts';
import { ConnectionState, Transport } from '../contracts/enums';
import { ActiveBrickInput, activeBrickView } from '../telemetry/activeBrickView';
import type { ReadValue } from '../telemetry/telemetryReadModel';

const fresh = (rowId: string, value: ReadValue['value'], extra: Partial<ReadValue> = {}): ReadValue =>
	({ rowId, value, sampledAt: 1000, effectiveIntervalMs: 100, stale: false, ...extra });

function input(values: readonly ReadValue[]): ActiveBrickInput {
	return {
		brickKey: 'AAA' as BrickId,
		displayName: 'AAA',
		transport: Transport.USB,
		connectionState: ConnectionState.Connected,
		availableTransports: [Transport.USB, Transport.BT],
		favorite: false,
		valueDisplayStyle: 'numeric',
		values,
	};
}

const sensor = (view: ReturnType<typeof activeBrickView>, port: string) =>
	view.sensorPorts.find((p) => p.port === port);

describe('Active brick view (step-6 U6)', () => {
	it('shows every port, layer 0, even before anything was read', () => {
		const view = activeBrickView(input([]));

		assert.deepEqual(view.sensorPorts.map((p) => [p.port, p.layer, p.occupancy]),
			[['1', 0, 'unreported'], ['2', 0, 'unreported'], ['3', 0, 'unreported'], ['4', 0, 'unreported']]);
		assert.deepEqual(view.motorPorts.map((p) => p.port), ['A', 'B', 'C', 'D']);
		assert.equal(view.sensorPorts[0].value, undefined);
	});

	it('names a known device, keeps its type code and mode, and shows its value', () => {
		const view = activeBrickView(input([
			fresh('ports.sensor.1.occupancy', 29, { mode: 2 }),   // EV3 colour sensor
			fresh('ports.sensor.1.value', 5, { sampledAt: 1100 }),
		]));

		assert.deepEqual(sensor(view, '1'), {
			port: '1', layer: 0, occupancy: 'known', peripheralType: 'color-sensor', typeCode: 29, mode: 2,
			value: 5, timestamp: 1100, stale: false,
		});
	});

	it('shows no value for an empty, identifying or faulty port, whatever the last read said', () => {
		const view = activeBrickView(input([
			fresh('ports.sensor.1.occupancy', 126), fresh('ports.sensor.1.value', Number.NaN),
			fresh('ports.sensor.2.occupancy', 125), fresh('ports.sensor.2.value', 3),
			fresh('ports.sensor.3.occupancy', 127), fresh('ports.sensor.3.value', 3),
		]));

		assert.deepEqual(view.sensorPorts.slice(0, 3).map((p) => [p.occupancy, p.peripheralType, p.value]),
			[['empty', undefined, undefined], ['identifying', undefined, undefined], ['error', undefined, undefined]]);
		assert.equal(sensor(view, '2')?.typeCode, 125, 'the code is shown even when no device is named');
	});

	it('keeps the code of a device it cannot name', () => {
		const view = activeBrickView(input([fresh('ports.sensor.4.occupancy', 77), fresh('ports.sensor.4.value', 1)]));

		assert.equal(sensor(view, '4')?.typeCode, 77);
		assert.equal(sensor(view, '4')?.peripheralType, 'third-party');
	});

	it('marks a port stale when its type or its value is', () => {
		const view = activeBrickView(input([
			fresh('ports.motor.A.occupancy', 7), fresh('ports.motor.A.tacho', 90, { unit: 'deg', stale: true }),
		]));

		const motor = view.motorPorts[0];
		assert.deepEqual([motor.value, motor.unit, motor.stale], [90, 'deg', true]);

		const typeStale = activeBrickView(input([
			fresh('ports.motor.B.occupancy', 7, { stale: true }), fresh('ports.motor.B.tacho', 10, { unit: 'deg' }),
		]));
		assert.equal(typeStale.motorPorts[1].stale, true, 'a fresh value on a port whose type went stale');
	});

	it('shows buttons, battery, firmware and Bluetooth visibility', () => {
		const view = activeBrickView(input([
			fresh('ui.button.enter', true), fresh('ui.button.back', false),
			fresh('system.battery.level', 80, { unit: '%' }), fresh('system.battery.voltage', 7.9, { unit: 'V' }),
			fresh('system.firmwareVersion', 'V1.10E', { effectiveIntervalMs: 'once' }),
			fresh('system.bluetooth.visible', true),
		]));

		assert.deepEqual(view.buttons, { enter: true, back: false });
		assert.deepEqual(view.battery, { level: 80, voltage: 7.9 });
		assert.equal(view.firmwareVersion, 'V1.10E');
		assert.equal(view.btVisible, true);
	});

	it('passes identity, route and the panel\'s preferences through', () => {
		const view = activeBrickView({ ...input([]), favorite: true, valueDisplayStyle: 'visual' });

		assert.deepEqual([view.brickKey, view.transport, view.availableTransports, view.favorite, view.valueDisplayStyle],
			['AAA', Transport.USB, [Transport.USB, Transport.BT], true, 'visual']);
		assert.equal(view.battery, undefined, 'no battery read yet is no battery, not a zero');
	});
});
