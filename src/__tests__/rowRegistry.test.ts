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

import { COM_GET_SUB, COM_HARDWARE, EV3_OPCODE, INPUT_DEVICE_SUB } from '../protocol/ev3Packet';
import { RowRegistry, createEv3RowRegistry } from '../telemetry/rowRegistry';
import { allEv3Rows, chainDepthRow, motorOccupancyRow, sensorOccupancyRow } from '../telemetry/ev3Rows';
import { globalRef } from '../telemetry/frameAssembler';
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

	it('reads the radios and the pairing count with opCOM_GET on the right hardware (3.1.3, 3.1.4k)', () => {
		const rows = new Map(allEv3Rows().map((r) => [r.id, r]));
		const expect = (id: string, subcode: number, hardware: number): void => {
			const bytes = rows.get(id)?.emit(5);
			assert.ok(bytes, `${id} is missing`);
			assert.deepEqual([...bytes], [EV3_OPCODE.COM_GET, subcode, hardware, 0x65], id);   // GV0(5) = 0x60 | 5
		};

		expect('system.bluetooth.on', COM_GET_SUB.GET_ON_OFF, COM_HARDWARE.BT);
		expect('system.bluetooth.visible', COM_GET_SUB.GET_VISIBLE, COM_HARDWARE.BT);
		expect('system.bluetooth.peers', COM_GET_SUB.FAVOUR_ITEMS, COM_HARDWARE.BT);
		expect('system.wifi.on', COM_GET_SUB.GET_ON_OFF, COM_HARDWARE.WIFI);
		expect('system.wifi.present', COM_GET_SUB.GET_PRESENT, COM_HARDWARE.WIFI);
		assert.deepEqual([COM_GET_SUB.GET_ON_OFF, COM_GET_SUB.GET_VISIBLE, COM_GET_SUB.GET_PRESENT], [1, 2, 15], 'bytecodes.h 636, 637, 647');
	});

	it('parses a radio flag as a boolean and the pairing count as a number', () => {
		const rows = new Map(allEv3Rows().map((r) => [r.id, r]));
		const payload = new Uint8Array([1, 0, 3]);

		assert.equal(rows.get('system.bluetooth.on')?.parse(payload, 0, 1).value, true);
		assert.equal(rows.get('system.wifi.on')?.parse(payload, 1, 1).value, false);
		assert.equal(rows.get('system.bluetooth.peers')?.parse(payload, 2, 1).value, 3);
	});

	it('never asks GET_ON_OFF of the USB hardware: the firmware answers FAILBREAK and ends the whole frame', () => {
		// c_com.c 4296–4330: the HW_USB case leaves DspStat at FAILBREAK; lms2012.c 2496–2510 then
		// ends the direct command, so every row in that frame would be lost.
		const forbidden = [EV3_OPCODE.COM_GET, COM_GET_SUB.GET_ON_OFF, COM_HARDWARE.USB];
		for (const r of allEv3Rows()) {
			const bytes = [...r.emit(0)];
			const hit = bytes.some((_, i) => forbidden.every((b, k) => bytes[i + k] === b));
			assert.equal(hit, false, `${r.id} asks GET_ON_OFF of USB`);
		}
	});

	it('keeps the mode an occupancy row reads, beside the type code', () => {
		const occupancy = sensorOccupancyRow(0);
		const payload = new Uint8Array([0, 0, 30, 2]);   // slot 2: ultrasonic (30), mode 2

		const parsed = occupancy.parse(payload, 2, 1000);

		assert.equal(parsed.value, 30);
		assert.equal(parsed.mode, 2);
	});

	it("emits the master's own port rows exactly as before the chain rows existed", () => {
		const rows = new Map(allEv3Rows().map((r) => [r.id, r]));
		const bytes = (id: string): number[] => [...(rows.get(id)?.emit(4) ?? [])];

		// GV0(4) = 0x64, GV0(5) = 0x65; layer 0 is LC0(0).
		assert.deepEqual(bytes('ports.sensor.1.value'), [EV3_OPCODE.INPUT_READ_SI, 0, 0, 0, 0, 0x64]);
		assert.deepEqual(bytes('ports.sensor.3.occupancy'), [EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE, 0, 2, 0x64, 0x65]);
		assert.deepEqual(bytes('ports.motor.B.occupancy'), [EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE, 0, 17, 0x64, 0x65]);
		assert.deepEqual(bytes('ports.motor.B.tacho'), [EV3_OPCODE.OUTPUT_GET_COUNT, 0, 1, 0x64]);
	});
});

describe('Daisy-chain rows (step-8 U1)', () => {
	const TYPE_NONE = 126;
	const TYPE_UNKNOWN = 125;
	const COLOR = 29;
	const LARGE_MOTOR = 7;
	const rows = (): Map<string, TelemetryRow> => new Map(allEv3Rows().map((r) => [r.id, r]));
	/** The 32 types `opINPUT_DEVICE_LIST` answers, all empty but the given indexes, then CHANGED. */
	const deviceList = (devices: Record<number, number> = {}): Uint8Array => {
		const list = new Uint8Array(33).fill(TYPE_NONE);
		for (const [index, type] of Object.entries(devices)) { list[Number(index)] = type; }
		list[32] = 1;
		return list;
	};
	const depthOf = (devices: Record<number, number>): unknown =>
		chainDepthRow().parse(deviceList(devices), 0, 1).value;

	it('reads the whole chain with one opINPUT_DEVICE_LIST of 32 entries', () => {
		const row = chainDepthRow();

		assert.equal(row.id, 'chain.depth');
		assert.equal(row.tier, 'event');
		assert.deepEqual(row.result, { bytes: 33, alignment: 1 });
		// LENGTH 32 does not fit a short constant (6 bits, signed): LC1 is 0x81 then the byte.
		assert.deepEqual([...row.emit(0)], [EV3_OPCODE.INPUT_DEVICE_LIST, 0x81, 32, ...globalRef(0), ...globalRef(32)]);
	});

	it('takes the depth from the deepest layer with a device, sensor or motor', () => {
		assert.equal(depthOf({}), 0, 'nothing anywhere');
		assert.equal(depthOf({ 0: COLOR, 16: LARGE_MOTOR }), 0, "the master's own ports are not a member");
		assert.equal(depthOf({ 4: COLOR }), 1, 'a sensor on layer 1, port 1');
		assert.equal(depthOf({ 10: COLOR }), 2, 'a sensor on layer 2, port 3, with layer 1 empty');
		assert.equal(depthOf({ 25: LARGE_MOTOR }), 2, 'a motor alone on layer 2, port B');
		assert.equal(depthOf({ 31: LARGE_MOTOR }), 3, 'a motor on layer 3, port D');
		assert.equal(depthOf({ 4: TYPE_UNKNOWN }), 1, 'a device still identifying itself is there');
	});

	it("reads a member's sensor port by layer and port, with the port named by both", () => {
		const occupancy = rows().get('chain.2.sensor.3.occupancy');
		const value = rows().get('chain.2.sensor.3.value');

		assert.ok(occupancy && value);
		assert.equal(occupancy.port, '2:3');
		assert.equal(occupancy.layer, 2);
		assert.equal(occupancy.reportsOccupancy, true);
		assert.deepEqual([...occupancy.emit(4)], [EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE, 2, 2, 0x64, 0x65]);
		assert.equal(value.port, '2:3');
		assert.equal(value.layer, 2);
		assert.deepEqual([...value.emit(4)], [EV3_OPCODE.INPUT_READ_SI, 2, 2, 0, 0, 0x64]);
	});

	it("reads a member's motor type, and never its tacho, which does not cross the chain", () => {
		const all = rows();
		const occupancy = all.get('chain.1.motor.A.occupancy');

		assert.ok(occupancy);
		assert.equal(occupancy.port, '1:A');
		assert.deepEqual([...occupancy.emit(4)], [EV3_OPCODE.INPUT_DEVICE, INPUT_DEVICE_SUB.GET_TYPEMODE, 1, 16, 0x64, 0x65]);
		assert.deepEqual([...all.keys()].filter((id) => /^chain\.\d\.motor\..*\.(?!occupancy)/.test(id)), []);
	});

	it('offers every member layer 1-3, ports 1-4 and A-D, and puts the depth row last', () => {
		const ids = allEv3Rows().map((r) => r.id);

		for (const layer of [1, 2, 3]) {
			for (const port of ['1', '2', '3', '4']) {
				assert.ok(ids.includes(`chain.${layer}.sensor.${port}.occupancy`));
				assert.ok(ids.includes(`chain.${layer}.sensor.${port}.value`));
			}
			for (const port of ['A', 'B', 'C', 'D']) { assert.ok(ids.includes(`chain.${layer}.motor.${port}.occupancy`)); }
		}
		assert.equal(ids[ids.length - 1], 'chain.depth');
		assert.ok(ids.indexOf('chain.1.sensor.1.value') < ids.indexOf('ports.motor.A.tacho'),
			"a member's sensor value comes right after the master's");
	});

	it("lists a member's rows with their layer, and reads a member's sensor in the mode asked for", () => {
		const registry = createEv3RowRegistry();

		assert.deepEqual(registry.list().find((r) => r.id === 'chain.1.sensor.1.value'),
			{ id: 'chain.1.sensor.1.value', tier: 'sampled', port: '1:1', layer: 1 });
		assert.ok(registry.modePorts().has('1:1'));
		const inMode = registry.inMode('chain.1.sensor.1.value', 2);
		assert.deepEqual([...(inMode?.emit(4) ?? [])], [EV3_OPCODE.INPUT_READ_SI, 1, 0, 0, 2, 0x64]);
	});
});
