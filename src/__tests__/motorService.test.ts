import assert from 'node:assert/strict';
import test from 'node:test';
import { MotorService } from '../device/motorService';
import { Ev3CommandRequest } from '../protocol/ev3CommandClient';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { EV3_COMMAND, EV3_REPLY, Ev3Packet } from '../protocol/ev3Packet';
import { CommandResult } from '../scheduler/types';

class FakeMotorCommandClient implements Ev3CommandSendLike {
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
			reply: { messageCounter: counter, type: this.replyType, payload: this.replyPayload },
			enqueuedAt: 0,
			startedAt: 0,
			finishedAt: 0,
			durationMs: 0
		};
	}
}

test('MotorService.setSpeedAndStart sends OUTPUT_SPEED + OUTPUT_START payload', async () => {
	const client = new FakeMotorCommandClient();
	const service = new MotorService({ commandClient: client });

	await service.setSpeedAndStart('A', 50);

	assert.equal(client.requests.length, 1);
	const req = client.requests[0];
	assert.equal(req.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
	assert.equal(req.lane, 'high');

	const payload = Array.from(req.payload ?? new Uint8Array());
	assert.deepEqual(payload, [
		0x00, 0x00,             // 0 global bytes
		0xa5, 0x00, 0x01,       // opOUTPUT_SPEED LAYER=0 NOS=A(0x01)
		0x81, 0x32,             // LC1 SPEED=50
		0xa6, 0x00, 0x01        // opOUTPUT_START LAYER=0 NOS=A(0x01)
	]);
});

test('MotorService.setSpeedAndStart clamps speed to -100..100', async () => {
	const client = new FakeMotorCommandClient();
	const service = new MotorService({ commandClient: client });

	await service.setSpeedAndStart('B', 200);
	const payload = Array.from(client.requests[0].payload ?? new Uint8Array());
	// Speed should be clamped to 100 = 0x64, encoded as LC1: 0x81, 0x64
	assert.deepEqual(payload, [
		0x00, 0x00,             // 0 global bytes
		0xa5, 0x00, 0x02,       // opOUTPUT_SPEED LAYER=0 NOS=B(0x02)
		0x81, 0x64,             // LC1 SPEED=100 (clamped from 200)
		0xa6, 0x00, 0x02        // opOUTPUT_START LAYER=0 NOS=B(0x02)
	]);
});

test('MotorService.stopMotor sends OUTPUT_STOP with brake flag', async () => {
	const client = new FakeMotorCommandClient();
	const service = new MotorService({ commandClient: client });

	await service.stopMotor('C', 'brake');

	const payload = Array.from(client.requests[0].payload ?? new Uint8Array());
	assert.deepEqual(payload, [
		0x00, 0x00,       // 0 global bytes
		0xa3, 0x00, 0x04, // opOUTPUT_STOP LAYER=0 NOS=C(0x04)
		0x01              // BRAKE=1
	]);
});

test('MotorService.stopMotor uses coast mode', async () => {
	const client = new FakeMotorCommandClient();
	const service = new MotorService({ commandClient: client });

	await service.stopMotor('D', 'coast');

	const payload = Array.from(client.requests[0].payload ?? new Uint8Array());
	assert.deepEqual(payload, [
		0x00, 0x00,       // 0 global bytes
		0xa3, 0x00, 0x08, // opOUTPUT_STOP LAYER=0 NOS=D(0x08)
		0x00              // COAST=0
	]);
});

test('MotorService.readTacho decodes int32 position', async () => {
	const buf = new ArrayBuffer(4);
	new DataView(buf).setInt32(0, -1234, true);
	const client = new FakeMotorCommandClient(EV3_REPLY.DIRECT_REPLY, new Uint8Array(buf));
	const service = new MotorService({ commandClient: client });

	const reading = await service.readTacho('B');

	assert.equal(reading.port, 'B');
	assert.equal(reading.position, -1234);
	assert.ok(reading.timestampMs > 0);

	const payload = Array.from(client.requests[0].payload ?? new Uint8Array());
	assert.deepEqual(payload, [
		0x04, 0x00,       // 4 global bytes
		0xb3, 0x00, 0x01, // opOUTPUT_GET_COUNT LAYER=0 PORT=1(B)
		0x60              // GV0(0)
	]);
});

test('MotorService.setSpeedAndStart throws on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeMotorCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new MotorService({ commandClient: client });

	await assert.rejects(
		service.setSpeedAndStart('A', 50),
		/DIRECT_REPLY_ERROR/i
	);
});

test('MotorService.readTacho throws on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeMotorCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new MotorService({ commandClient: client });

	await assert.rejects(
		service.readTacho('A'),
		/DIRECT_REPLY_ERROR/i
	);
});
