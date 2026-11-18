/**
 * The mock brick serves telemetry frames (step-6 plan U3, owner decision D4; plan 3.1.7a).
 *
 * The mock decodes the bytecode the frame assembler composes and answers from its own ports,
 * battery and radios, so the encoding, the alignment and the reply layout are exercised
 * without hardware. A mock that skipped the bytecode would stay green exactly where telemetry
 * has broken before.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { MockTransportProvider } from '../core/mock/mockTransportProvider';
import { makeBrickKey, Transport } from '../core/contracts';
import { assembleFrame, buildTelemetryFrame, parseFrame } from '../core/telemetry/frameAssembler';
import { createEv3RowRegistry } from '../core/telemetry/rowRegistry';
import { createBrickTelemetry } from '../core/telemetry/brickTelemetry';
import { EV3_OPCODE, COM_GET_SUB, COM_HARDWARE } from '../core/protocol/ev3Packet';
import { concatBytes, gv0, gv1, lc0, lc1, uint16le } from '../core/protocol/ev3Bytecode';
import { chainDepthRow } from '../core/telemetry/ev3Rows';
import type { RowValue } from '../core/telemetry/telemetryRow';

const KEY = makeBrickKey(Transport.Mock, 'M1');
const LIBUSB = { maxPacketBytes: 1024 };
const HID = { maxPacketBytes: 64 };

async function brick() {
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'M1', displayName: 'Mocky', firmwareVersion: 'V1.09D',
			battery: { level: 81, voltage: 7.6 },
			bluetoothPeers: ['HOSTA', 'BBB'],
			sensorPorts: [
				{ port: '1', peripheralType: 'ultrasonic-sensor', unit: 'cm', dynamic: { kind: 'static', value: 42.5 } },
				{ port: '3', peripheralType: 'touch-sensor', dynamic: { kind: 'static', value: 1 } },
				{ port: '4', peripheralType: 'colour-thing', dynamic: { kind: 'static', value: 1 } },
			],
			motorPorts: [
				{ port: 'B', peripheralType: 'medium-motor', unit: 'deg', dynamic: { kind: 'static', value: -90 } },
			],
		}],
	} as never);
	await mock.connect(KEY);
	return mock;
}

async function readAll(limits = LIBUSB): Promise<Map<string, RowValue>> {
	const mock = await brick();
	const frame = assembleFrame(createEv3RowRegistry().all(), limits);
	const reply = await mock.executeCommand(KEY, { kind: 'telemetry:frame', payload: buildTelemetryFrame(frame) });
	assert.equal(reply.kind, 'telemetry:frame');
	const values = parseFrame(frame, (reply as { payload: Uint8Array }).payload, 1);
	mock.dispose();
	return new Map(values.map((v) => [v.rowId, v]));
}

const frameOf = (globals: number, ...bytecode: Uint8Array[]): Uint8Array => concatBytes(uint16le(globals), ...bytecode);

describe('Mock telemetry (step-6 U3)', () => {
	it('says it can run a telemetry frame', async () => {
		const mock = await brick();
		assert.equal(mock.capabilities.supportsTelemetryFrames, true);
		mock.dispose();
	});

	it('answers every EV3 row from its configuration, through the real assembler and parser', async () => {
		const v = await readAll();

		assert.equal(v.get('ports.sensor.1.occupancy')?.value, 30);
		assert.equal(v.get('ports.sensor.1.value')?.value, 42.5);
		assert.equal(v.get('ports.sensor.3.occupancy')?.value, 16);
		assert.equal(v.get('ports.sensor.2.occupancy')?.value, 126, 'an unconfigured port is empty');
		assert.ok(Number.isNaN(v.get('ports.sensor.2.value')?.value as number), 'an empty port reads NaN, as the firmware answers');
		assert.equal(v.get('ports.sensor.4.occupancy')?.value, 127, 'a name outside the vocabulary is a device of invalid type');
		assert.equal(v.get('ports.motor.B.occupancy')?.value, 8);
		assert.equal(v.get('ports.motor.B.tacho')?.value, -90);
		assert.equal(v.get('system.battery.level')?.value, 81);
		assert.ok(Math.abs((v.get('system.battery.voltage')?.value as number) - 7.6) < 1e-5);
		assert.equal(v.get('system.brickName')?.value, 'Mocky');
		assert.equal(v.get('system.firmwareVersion')?.value, 'V1.09D');
		assert.equal(v.get('ui.button.enter')?.value, false);
		assert.equal(v.get('system.bluetooth.on')?.value, true);
		assert.equal(v.get('system.bluetooth.peers')?.value, 2);
		assert.equal(v.get('system.wifi.present')?.value, false);
	});

	it('answers the same values over the HID budget, where the frame is truncated', async () => {
		const v = await readAll(HID);

		assert.ok(v.size > 0 && v.size < createEv3RowRegistry().all().length, 'the HID frame was not truncated');
		if (v.has('ports.sensor.1.value')) { assert.equal(v.get('ports.sensor.1.value')?.value, 42.5); }
		if (v.has('ports.motor.B.tacho')) { assert.equal(v.get('ports.motor.B.tacho')?.value, -90); }
	});

	it('refuses an opcode it does not interpret, rather than answer zeros', async () => {
		const mock = await brick();

		await assert.rejects(mock.executeCommand(KEY, { kind: 'telemetry:frame', payload: frameOf(1, new Uint8Array([0x01])) }),
			/opcode/i);
		mock.dispose();
	});

	it('refuses a frame that writes past the globals it declared', async () => {
		const mock = await brick();
		const battery = new Uint8Array([EV3_OPCODE.UI_READ, 0x12]);   // GET_LBATT into GV0(4)

		await assert.rejects(mock.executeCommand(KEY, { kind: 'telemetry:frame', payload: frameOf(2, battery, gv0(4)) }),
			/global/i);
		mock.dispose();
	});

	it('runs the real per-brick telemetry loop, occupancy gate included, against the mock', async () => {
		const mock = await brick();
		const seen = new Map<string, RowValue>();
		const errors: unknown[] = [];
		const telemetry = createBrickTelemetry({
			sender: { send: (key, command) => mock.executeCommand(KEY, command) },
			brickKey: KEY,
			onValues: (values) => { for (const v of values) { seen.set(v.rowId, v); } },
			onError: (error) => { errors.push(error); },
		});

		// Tick 0 carries occupancy (divider 5); the empty port's value row is gated from tick 1 on.
		for (let tick = 0; tick < 6; tick += 1) { await telemetry.runTick(); }

		assert.deepEqual(errors, []);
		assert.equal(seen.get('ports.sensor.1.value')?.value, 42.5);
		assert.equal(seen.get('ports.motor.B.tacho')?.value, -90);
		assert.equal(seen.get('system.firmwareVersion')?.value, 'V1.09D');
		// One command a tick, the event rows riding with the sampled ones (D8).
		assert.equal(telemetry.stats.framesSent, 6);
		telemetry.dispose();
		mock.dispose();
	});

	it('refuses opINPUT_READSI into an unaligned global, as the brick does', async () => {
		const mock = await brick();
		const read = concatBytes(new Uint8Array([EV3_OPCODE.INPUT_READ_SI]), lc0(0), lc0(0), lc0(0), lc0(0), gv0(2));

		await assert.rejects(mock.executeCommand(KEY, { kind: 'telemetry:frame', payload: frameOf(8, read) }), /unaligned/);
		mock.dispose();
	});

	it('answers no brick below it: the device list is empty past the master', async () => {
		const mock = await brick();
		const frame = assembleFrame([chainDepthRow()], LIBUSB);
		const reply = await mock.executeCommand(KEY, { kind: 'telemetry:frame', payload: buildTelemetryFrame(frame) });

		assert.equal(parseFrame(frame, (reply as { payload: Uint8Array }).payload, 1)[0].value, 0);
		mock.dispose();
	});

	it('fails the frame on GET_ON_OFF of USB, as the firmware does (FAILBREAK)', async () => {
		const mock = await brick();
		const usbOnOff = concatBytes(new Uint8Array([EV3_OPCODE.COM_GET, COM_GET_SUB.GET_ON_OFF]), lc0(COM_HARDWARE.USB), gv0(0));

		await assert.rejects(mock.executeCommand(KEY, { kind: 'telemetry:frame', payload: frameOf(1, usbOnOff) }),
			/FAILBREAK/);
		mock.dispose();
	});
});

describe('Mock daisy chain (step-8 U2)', () => {
	const MASTER = makeBrickKey(Transport.Mock, 'M');
	const port = (name: string, peripheralType: string, value: number) =>
		({ port: name, peripheralType, dynamic: { kind: 'static', value } });
	const brickOf = (id: string, extra: Record<string, unknown>) =>
		({ id, displayName: id, battery: { level: 50 }, sensorPorts: [], motorPorts: [], ...extra });

	/** M is the master; L1 hangs below it, L2 below L1. */
	async function chain(): Promise<MockTransportProvider> {
		const mock = new MockTransportProvider({
			transport: Transport.Mock,
			bricks: [
				brickOf('M', { sensorPorts: [port('1', 'touch-sensor', 1)] }),
				brickOf('L1', { parentId: 'M', sensorPorts: [port('1', 'ultrasonic-sensor', 33)], motorPorts: [port('A', 'large-motor', 45)] }),
				brickOf('L2', { parentId: 'L1', motorPorts: [port('B', 'medium-motor', 10)] }),
			],
		} as never);
		await mock.connect(MASTER);
		return mock;
	}

	async function run(mock: MockTransportProvider, payload: Uint8Array): Promise<Uint8Array> {
		const reply = await mock.executeCommand(MASTER, { kind: 'telemetry:frame', payload });
		return (reply as { payload: Uint8Array }).payload;
	}

	async function read(mock: MockTransportProvider, ids: string[]): Promise<Map<string, RowValue>> {
		const registry = createEv3RowRegistry();
		const frame = assembleFrame(ids.map((id) => registry.get(id) ?? chainDepthRow()), LIBUSB);
		const values = parseFrame(frame, await run(mock, buildTelemetryFrame(frame)), 1);
		return new Map(values.map((v) => [v.rowId, v]));
	}

	it('lists only the master: a brick below it is reached through it, as USB discovery sees only the master', async () => {
		const mock = await chain();

		assert.deepEqual((await mock.discover()).items.map((item) => item.displayName), ['M']);
		mock.dispose();
	});

	it("answers the master's device list with every member's ports at layer × 4 + port", async () => {
		const mock = await chain();
		const list = await run(mock, frameOf(33, new Uint8Array([EV3_OPCODE.INPUT_DEVICE_LIST]), lc1(32), gv0(0), gv1(32)));

		assert.equal(list[0], 16, "the master's own touch sensor");
		assert.equal(list[4], 30, "L1's ultrasonic sensor on port 1");
		assert.equal(list[20], 7, "L1's large motor on port A");
		assert.equal(list[25], 8, "L2's medium motor on port B");
		assert.deepEqual([...list.subarray(12, 16), ...list.subarray(28, 32)], new Array(8).fill(126), 'nothing on layer 3');
		assert.equal((await read(mock, ['chain.depth'])).get('chain.depth')?.value, 2);
		mock.dispose();
	});

	it("reads a member's ports through the master by their layer", async () => {
		const mock = await chain();
		const v = await read(mock, ['chain.1.sensor.1.occupancy', 'chain.1.sensor.1.value', 'chain.2.motor.B.occupancy', 'chain.3.sensor.1.occupancy']);

		assert.equal(v.get('chain.1.sensor.1.occupancy')?.value, 30);
		assert.equal(v.get('chain.1.sensor.1.value')?.value, 33);
		assert.equal(v.get('chain.2.motor.B.occupancy')?.value, 8);
		assert.equal(v.get('chain.3.sensor.1.occupancy')?.value, 126, 'no brick on layer 3');
		mock.dispose();
	});

	it("answers a member's tacho with a frozen number, as the firmware does, never its motor's position", async () => {
		const mock = await chain();
		const tacho = frameOf(4, new Uint8Array([EV3_OPCODE.OUTPUT_GET_COUNT]), lc0(1), lc0(0), gv0(0));

		const first = new DataView((await run(mock, tacho)).buffer).getInt32(0, true);
		const second = new DataView((await run(mock, tacho)).buffer).getInt32(0, true);

		assert.notEqual(first, 45, "L1's motor A is at 45 degrees, and that does not cross the chain");
		assert.equal(first, 111616, 'the frozen figure measured on a brick (IMPLEMENTATION_PLAN 3.1.4f)');
		assert.equal(second, first);
		mock.dispose();
	});
});
