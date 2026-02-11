import assert from 'node:assert/strict';
import test from 'node:test';
import { SensorService } from '../device/sensorService';
import { EV3_SENSOR_TYPE, type SensorPort } from '../device/sensorTypes';
import { Ev3CommandRequest } from '../protocol/ev3CommandClient';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { EV3_COMMAND, EV3_REPLY, Ev3Packet } from '../protocol/ev3Packet';
import { CommandResult } from '../scheduler/types';

class FakeSensorCommandClient implements Ev3CommandSendLike {
	public readonly requests: Ev3CommandRequest[] = [];
	private messageCounter = 0;
	private replyType: number;
	private replyPayload: Uint8Array;

	public constructor(replyType: number = EV3_REPLY.DIRECT_REPLY, replyPayload = new Uint8Array()) {
		this.replyType = replyType;
		this.replyPayload = replyPayload;
	}

	public setReply(type: number, payload: Uint8Array): void {
		this.replyType = type;
		this.replyPayload = payload;
	}

	public async send(request: Ev3CommandRequest): Promise<CommandResult<Ev3Packet>> {
		this.requests.push(request);
		const counter = this.messageCounter++;
		return {
			requestId: request.id ?? `request-${counter}`,
			messageCounter: counter,
			reply: {
				messageCounter: counter,
				type: this.replyType,
				payload: this.replyPayload
			},
			enqueuedAt: 0,
			startedAt: 0,
			finishedAt: 0,
			durationMs: 0
		};
	}
}

test('SensorService.probePort sends correct opINPUT_DEVICE GET_TYPEMODE payload', async () => {
	const client = new FakeSensorCommandClient(
		EV3_REPLY.DIRECT_REPLY,
		new Uint8Array([EV3_SENSOR_TYPE.EV3_TOUCH, 0x00])
	);
	const service = new SensorService({ commandClient: client });

	const info = await service.probePort(0 as SensorPort);

	assert.equal(client.requests.length, 1);
	const req = client.requests[0];
	assert.equal(req.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
	assert.equal(req.lane, 'normal');

	const payload = req.payload ?? new Uint8Array();
	assert.deepEqual(
		Array.from(payload),
		[
			0x02, 0x00, // 2 global bytes
			0x99, 0x05, // opINPUT_DEVICE, GET_TYPEMODE
			0x00,       // LAYER 0
			0x00,       // PORT 0
			0x60,       // GV0(0) = type
			0x61        // GV0(1) = mode
		]
	);

	assert.equal(info.port, 0);
	assert.equal(info.typeCode, EV3_SENSOR_TYPE.EV3_TOUCH);
	assert.equal(info.mode, 0);
	assert.equal(info.connected, true);
	assert.equal(info.typeName, 'EV3 TOUCH');
});

test('SensorService.probePort detects empty port', async () => {
	const client = new FakeSensorCommandClient(
		EV3_REPLY.DIRECT_REPLY,
		new Uint8Array([EV3_SENSOR_TYPE.EMPTY, 0x00])
	);
	const service = new SensorService({ commandClient: client });

	const info = await service.probePort(2 as SensorPort);
	assert.equal(info.connected, false);
	assert.equal(info.typeName, 'EMPTY');
});

test('SensorService.probePort handles DIRECT_REPLY_ERROR gracefully', async () => {
	const client = new FakeSensorCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new SensorService({ commandClient: client });

	const info = await service.probePort(1 as SensorPort);
	assert.equal(info.connected, false);
	assert.equal(info.typeCode, 0);
});

test('SensorService.probeAll probes all 4 ports', async () => {
	const client = new FakeSensorCommandClient(
		EV3_REPLY.DIRECT_REPLY,
		new Uint8Array([EV3_SENSOR_TYPE.NONE, 0x00])
	);
	const service = new SensorService({ commandClient: client });

	const results = await service.probeAll();
	assert.equal(results.length, 4);
	assert.equal(client.requests.length, 4);
	assert.deepEqual(results.map(r => r.port), [0, 1, 2, 3]);
});

test('SensorService.readSensor sends opINPUT_READ_SI and decodes float', async () => {
	// IEEE 754 float32 for 42.5 in little-endian
	const buf = new ArrayBuffer(4);
	new DataView(buf).setFloat32(0, 42.5, true);
	const floatBytes = new Uint8Array(buf);

	const client = new FakeSensorCommandClient(EV3_REPLY.DIRECT_REPLY, floatBytes);
	const service = new SensorService({ commandClient: client });

	const reading = await service.readSensor(0 as SensorPort, EV3_SENSOR_TYPE.EV3_TOUCH, 0);

	assert.equal(client.requests.length, 1);
	const req = client.requests[0];
	assert.equal(req.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);

	const payload = req.payload ?? new Uint8Array();
	assert.deepEqual(
		Array.from(payload),
		[
			0x04, 0x00, // 4 global bytes (float32)
			0x9a,       // opINPUT_READ_SI
			0x00,       // LAYER 0
			0x00,       // PORT 0
			0x10,       // TYPE = EV3_TOUCH (16)
			0x00,       // MODE 0
			0x60        // GV0(0)
		]
	);

	assert.equal(reading.port, 0);
	assert.equal(reading.value, 42.5);
	assert.equal(reading.typeCode, EV3_SENSOR_TYPE.EV3_TOUCH);
	assert.equal(reading.mode, 0);
	assert.ok(reading.timestampMs > 0);
});

test('SensorService.readSensor throws on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeSensorCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new SensorService({ commandClient: client });

	await assert.rejects(
		service.readSensor(0 as SensorPort, EV3_SENSOR_TYPE.EV3_TOUCH, 0),
		/DIRECT_REPLY_ERROR/i
	);
});
