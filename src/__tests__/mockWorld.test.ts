import assert from 'node:assert/strict';
import test from 'node:test';
import { MockWorld } from '../mock/mockWorld';
import { EV3_SENSOR_TYPE } from '../device/sensorTypes';
import { concatBytes, lc0, lc1, uint16le, gv0 } from '../protocol/ev3Bytecode';
import { encodeEv3Packet, decodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import type { MockWorldConfig } from '../mock/mockTypes';
import type { TransportRequestOptions } from '../transport/transportAdapter';

function makeOptions(): TransportRequestOptions {
	return { timeoutMs: 2000, signal: new AbortController().signal };
}

function sendDirect(world: MockWorld, payload: Uint8Array): ReturnType<typeof decodeEv3Packet> {
	const packet = encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY, payload);
	const result = world.getResponder()(packet, makeOptions());
	return decodeEv3Packet(result as Uint8Array);
}

test('MockWorld.create() with defaults works', () => {
	const world = MockWorld.create();
	assert.ok(world.sensors);
	assert.ok(world.motors);
	assert.ok(world.brick);
	assert.ok(world.fs);
	world.dispose();
});

test('MockWorld responder handles sensor probe', () => {
	const world = MockWorld.create();

	const payload = concatBytes(
		uint16le(2),
		new Uint8Array([0x99, 0x05]), // opINPUT_DEVICE GET_TYPEMODE
		lc0(0), lc0(0), gv0(0), gv0(1)
	);
	const reply = sendDirect(world, payload);
	assert.equal(reply.type, EV3_REPLY.DIRECT_REPLY);
	assert.equal(reply.payload[0], EV3_SENSOR_TYPE.EV3_TOUCH);

	world.dispose();
});

test('MockWorld tick advances sensor values', () => {
	const config: MockWorldConfig = {
		sensors: [
			{ port: 0, typeCode: EV3_SENSOR_TYPE.EV3_COLOR, mode: 0,
				generator: { kind: 'sine', min: 0, max: 100, periodMs: 1000 } }
		],
		motors: [],
		brick: {
			name: 'Test', firmwareVersion: 'V1.10E',
			batteryVoltage: 8.0, batteryCurrent: 0.2,
			batteryDrainRate: 0, volume: 50, sleepMinutes: 30
		},
		fsSeed: [],
		fault: { errorRate: 0, latencyMs: 0, jitterMs: 0, timeoutRate: 0 }
	};

	const world = MockWorld.create(config);
	const val0 = world.sensors.readValue(0);

	world.tick(250); // quarter period
	const val1 = world.sensors.readValue(0);
	assert.ok(val1 !== val0, `value should change after tick: ${val0} → ${val1}`);

	world.dispose();
});

test('MockWorld tick advances motor tacho', () => {
	const config: MockWorldConfig = {
		sensors: [],
		motors: [{ port: 'A', typeCode: 7, initialPosition: 0 }],
		brick: {
			name: 'Test', firmwareVersion: 'V1.10E',
			batteryVoltage: 8.0, batteryCurrent: 0.2,
			batteryDrainRate: 0, volume: 50, sleepMinutes: 30
		},
		fsSeed: [],
		fault: { errorRate: 0, latencyMs: 0, jitterMs: 0, timeoutRate: 0 }
	};

	const world = MockWorld.create(config);

	// Set speed + start via responder
	const payload = concatBytes(
		uint16le(0),
		new Uint8Array([0xa5]), lc0(0), lc0(0x01), lc1(50),
		new Uint8Array([0xa6]), lc0(0), lc0(0x01)
	);
	sendDirect(world, payload);

	world.tick(1000); // 50% → 500°/s → 500° in 1s
	assert.equal(world.motors.readTacho('A'), 500);

	world.dispose();
});

test('MockWorld reset restores initial state', () => {
	const world = MockWorld.create();

	// Modify state
	world.brick.setName('Changed');
	world.motors.setSpeed('A', 100);

	// Reset
	world.reset();
	assert.equal(world.brick.getName(), 'MockEV3');
	assert.equal(world.motors.getSpeed('A'), 0);

	world.dispose();
});

test('MockWorld with faults returns error replies', async () => {
	const config: MockWorldConfig = {
		sensors: [],
		motors: [],
		brick: {
			name: 'Test', firmwareVersion: 'V1.10E',
			batteryVoltage: 8.0, batteryCurrent: 0.2,
			batteryDrainRate: 0, volume: 50, sleepMinutes: 30
		},
		fsSeed: [],
		fault: { errorRate: 1.0, latencyMs: 0, jitterMs: 0, timeoutRate: 0 }
	};

	const world = MockWorld.create(config);
	const packet = encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY,
		concatBytes(uint16le(1), new Uint8Array([0x81, 0x1a]), gv0(0))
	);
	const result = await world.getResponder()(packet, makeOptions());
	const reply = decodeEv3Packet(result);
	assert.equal(reply.type, EV3_REPLY.DIRECT_REPLY_ERROR);

	world.dispose();
});

test('MockWorld startTicking/stopTicking', async () => {
	const world = MockWorld.create();
	world.startTicking(50);

	await new Promise<void>(resolve => setTimeout(resolve, 120));
	world.stopTicking();

	// After ticking, sensor values should have evolved (sine generator)
	// Just verify no crash
	world.dispose();
});

test('MockWorld FS operations via responder', () => {
	const world = MockWorld.create();
	assert.ok(world.fs.exists('/home/root/lms2012/prjs/MyProject/main.rbf'));
	world.dispose();
});
