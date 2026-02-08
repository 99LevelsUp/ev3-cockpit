import assert from 'node:assert/strict';
import test from 'node:test';
import { BrickControlService, Ev3CommandSendLike } from '../device/brickControlService';
import { Ev3CommandRequest } from '../protocol/ev3CommandClient';
import { EV3_COMMAND, EV3_REPLY, Ev3Packet } from '../protocol/ev3Packet';
import { CommandResult } from '../scheduler/types';

class FakeCommandClient implements Ev3CommandSendLike {
	public readonly requests: Ev3CommandRequest[] = [];
	private messageCounter = 0;

	public constructor(private readonly replyType: number = EV3_REPLY.DIRECT_REPLY) {}

	public async send(request: Ev3CommandRequest): Promise<CommandResult<Ev3Packet>> {
		this.requests.push(request);
		const counter = this.messageCounter++;
		return {
			requestId: request.id ?? `request-${counter}`,
			messageCounter: counter,
			reply: {
				messageCounter: counter,
				type: this.replyType,
				payload: new Uint8Array()
			},
			enqueuedAt: 0,
			startedAt: 0,
			finishedAt: 0,
			durationMs: 0
		};
	}
}

test('BrickControlService emergencyStopAll sends emergency direct command payload', async () => {
	const client = new FakeCommandClient(EV3_REPLY.DIRECT_REPLY);
	const service = new BrickControlService({
		commandClient: client
	});

	await service.emergencyStopAll();

	assert.equal(client.requests.length, 1);
	const request = client.requests[0];
	assert.equal(request.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
	assert.equal(request.lane, 'emergency');
	assert.equal(request.idempotent, true);
	assert.equal(request.timeoutMs, 2000);

	const payload = request.payload ?? new Uint8Array();
	assert.deepEqual(
		Array.from(payload),
		[
			0x00, 0x00, // globals/local alloc
			0x02, 0x01, // opPROGRAM_STOP USER_SLOT
			0xa3, 0x00, 0x0f, 0x01 // opOUTPUT_STOP LAYER=0 NOS=ALL BRAKE=1
		]
	);
});

test('BrickControlService emergencyStopAll fails on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new BrickControlService({
		commandClient: client
	});

	await assert.rejects(service.emergencyStopAll(), /DIRECT_REPLY_ERROR/i);
});

test('BrickControlService stopProgram sends high-lane program-stop payload', async () => {
	const client = new FakeCommandClient(EV3_REPLY.DIRECT_REPLY);
	const service = new BrickControlService({
		commandClient: client
	});

	await service.stopProgram();

	assert.equal(client.requests.length, 1);
	const request = client.requests[0];
	assert.equal(request.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
	assert.equal(request.lane, 'high');
	assert.equal(request.idempotent, true);

	const payload = request.payload ?? new Uint8Array();
	assert.deepEqual(
		Array.from(payload),
		[
			0x00, 0x00, // globals/local alloc
			0x02, 0x01 // opPROGRAM_STOP USER_SLOT
		]
	);
});

test('BrickControlService stopProgram fails on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new BrickControlService({
		commandClient: client
	});

	await assert.rejects(service.stopProgram(), /DIRECT_REPLY_ERROR/i);
});
