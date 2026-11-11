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

import { MockTransportProvider } from '../mock/mockTransportProvider';
import { makeBrickKey, Transport } from '../contracts';
import { assembleFrame, buildTelemetryFrame, parseFrame } from '../telemetry/frameAssembler';
import { createEv3RowRegistry } from '../telemetry/rowRegistry';
import { createBrickTelemetry } from '../telemetry/brickTelemetry';
import { EV3_OPCODE, COM_GET_SUB, COM_HARDWARE } from '../protocol/ev3Packet';
import { concatBytes, gv0, lc0, uint16le } from '../protocol/ev3Bytecode';
import type { RowValue } from '../telemetry/telemetryRow';

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

	it('fails the frame on GET_ON_OFF of USB, as the firmware does (FAILBREAK)', async () => {
		const mock = await brick();
		const usbOnOff = concatBytes(new Uint8Array([EV3_OPCODE.COM_GET, COM_GET_SUB.GET_ON_OFF]), lc0(COM_HARDWARE.USB), gv0(0));

		await assert.rejects(mock.executeCommand(KEY, { kind: 'telemetry:frame', payload: frameOf(1, usbOnOff) }),
			/FAILBREAK/);
		mock.dispose();
	});
});
