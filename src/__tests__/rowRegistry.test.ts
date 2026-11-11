/**
 * The row registry and the EV3 row catalogue (step-6 plan, U2; IMPLEMENTATION_PLAN 3.1.6).
 *
 * Registration validates and refuses (DESIGN §9.3): a row that could never be placed fails at
 * `register`, not as a corrupt frame at runtime. The bound is the HID fallback, the tightest
 * link: 59 bytes of declared globals and 57 of bytecode. Row ids are the contract consumers name
 * rows by, in the owner's format `ports.sensor.1.value` (D1).
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { EV3_OPCODE, INPUT_DEVICE_SUB } from '../protocol/ev3Packet';
import { RowRegistry, createEv3RowRegistry } from '../telemetry/rowRegistry';
import { allEv3Rows, motorOccupancyRow, sensorOccupancyRow } from '../telemetry/ev3Rows';
import type { TelemetryRow } from '../telemetry/telemetryRow';

const HID = { maxPacketBytes: 64 };

function row(overrides: Partial<TelemetryRow> = {}): TelemetryRow {
	return {
		id: 'test.row',
		tier: 'sampled',
		lifetime: { kind: 'repeating', divider: 1 },
		result: { bytes: 4, alignment: 4 },
		emit: () => new Uint8Array([0x01]),
		parse: (_payload, _slot, sampledAt) => ({ rowId: 'test.row', value: 0, sampledAt }),
		...overrides,
	};
}

const codeOf = (error: unknown): string => (error as Error).message;

describe('Row registry (step-6 U2)', () => {
	it('registers the whole EV3 catalogue and lists it as plain data', () => {
		const registry = createEv3RowRegistry();

		const listed = registry.list();

		assert.equal(listed.length, allEv3Rows().length);
		assert.doesNotThrow(() => JSON.parse(JSON.stringify(listed)));
		const value = listed.find((r) => r.id === 'ports.sensor.1.value');
		assert.deepEqual(value, { id: 'ports.sensor.1.value', tier: 'sampled', port: '1' });
		assert.deepEqual(listed.find((r) => r.id === 'system.battery.voltage'),
			{ id: 'system.battery.voltage', tier: 'event', unit: 'V' });
	});

	it('finds a row by id', () => {
		const registry = createEv3RowRegistry();

		assert.equal(registry.get('ports.motor.A.tacho')?.id, 'ports.motor.A.tacho');
		assert.equal(registry.get('ports.motor.E.tacho'), undefined);
	});

	it('refuses a second row with the same id', () => {
		const registry = new RowRegistry();
		registry.register(row());

		assert.throws(() => registry.register(row()), (e) => /already registered/.test(codeOf(e)));
	});

	it('refuses an id that is not a namespaced path', () => {
		const registry = new RowRegistry();

		for (const id of ['value', 'ports..1', 'ports.1.', '.ports.1', 'ports 1.value', '']) {
			assert.throws(() => registry.register(row({ id })), (e) => /id/.test(codeOf(e)), `accepted '${id}'`);
		}
	});

	it('refuses a result that cannot come back on the HID fallback: 59 bytes of globals', () => {
		const registry = new RowRegistry();

		assert.doesNotThrow(() => registry.register(row({ id: 'test.fits', result: { bytes: 56, alignment: 4 } })));
		assert.throws(() => registry.register(row({ id: 'test.wide', result: { bytes: 60, alignment: 4 } })));
	});

	it('refuses bytecode that cannot go out on the HID fallback: 57 bytes, at its widest global reference', () => {
		const registry = new RowRegistry();
		// The widest a row's bytecode gets is with a two-byte global reference (slot 32 and on).
		const sized = (bytes: number) => (slot: number) => new Uint8Array(slot > 31 ? bytes + 1 : bytes);

		assert.doesNotThrow(() => registry.register(row({ id: 'test.short', emit: sized(56) })));
		assert.throws(() => registry.register(row({ id: 'test.long', emit: sized(57) })), (e) => /bytecode/.test(codeOf(e)));
	});

	it('refuses a repeating row whose divider is not a whole number of ticks', () => {
		const registry = new RowRegistry();

		for (const divider of [0, -1, 1.5, Number.NaN]) {
			assert.throws(() => registry.register(row({ id: `test.d${String(divider).replace(/\W/g, '')}`,
				lifetime: { kind: 'repeating', divider } })), (e) => /divider/.test(codeOf(e)), `accepted ${divider}`);
		}
	});

	it('leaves nothing registered when a row is refused', () => {
		const registry = new RowRegistry();

		assert.throws(() => registry.register(row({ id: 'test.wide', result: { bytes: 60, alignment: 4 } })));

		assert.equal(registry.get('test.wide'), undefined);
		assert.deepEqual(registry.list(), []);
	});
});

describe('EV3 row catalogue (step-6 U2)', () => {
	it('names every row in the namespaced format, once', () => {
		const ids = allEv3Rows().map((r) => r.id);

		assert.equal(new Set(ids).size, ids.length);
		for (const id of ids) { assert.match(id, /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/); }
		assert.ok(ids.includes('ports.sensor.4.value'));
		assert.ok(ids.includes('ports.motor.D.occupancy'));
	});

	it('reads a sensor value with opINPUT_READSI, not the one-byte opINPUT_READ (plan 3.1.4a)', () => {
		const sensor = allEv3Rows().find((r) => r.id === 'ports.sensor.2.value');

		assert.equal(sensor?.emit(0)[0], EV3_OPCODE.INPUT_READ_SI);
		assert.equal(EV3_OPCODE.INPUT_READ_SI, 0x9d);
	});

	it('numbers motor ports 16-19 for occupancy and 0-3 for tacho', () => {
		const occupancy = motorOccupancyRow(2).emit(0);
		const tacho = allEv3Rows().find((r) => r.id === 'ports.motor.C.tacho')?.emit(0);

		assert.deepEqual([occupancy[0], occupancy[1]], [EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE]);
		assert.equal(occupancy[3], 18);   // LC0(18): layer, then the port
		assert.equal(tacho?.[2], 2);
	});

	it('keeps the mode an occupancy row reads, beside the type code', () => {
		const occupancy = sensorOccupancyRow(0);
		const payload = new Uint8Array([0, 0, 30, 2]);   // slot 2: ultrasonic (30), mode 2

		const parsed = occupancy.parse(payload, 2, 1000);

		assert.equal(parsed.value, 30);
		assert.equal(parsed.mode, 2);
	});
});
