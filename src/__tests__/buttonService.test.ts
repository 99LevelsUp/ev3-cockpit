import assert from 'node:assert/strict';
import test from 'node:test';
import { ButtonService, EV3_BUTTON, BUTTON_NAMES } from '../device/buttonService';
import { Ev3CommandRequest } from '../protocol/ev3CommandClient';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { EV3_COMMAND, EV3_REPLY, Ev3Packet } from '../protocol/ev3Packet';
import { CommandResult } from '../scheduler/types';

class FakeButtonCommandClient implements Ev3CommandSendLike {
	public readonly requests: Ev3CommandRequest[] = [];
	private messageCounter = 0;
	private replyType: number;
	private replyPayload: Uint8Array;

	public constructor(replyType: number = EV3_REPLY.DIRECT_REPLY, replyPayload = new Uint8Array([0])) {
		this.replyType = replyType;
		this.replyPayload = replyPayload;
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

test('ButtonService.readButton sends opUI_READ GET_PRESS payload', async () => {
	const client = new FakeButtonCommandClient(EV3_REPLY.DIRECT_REPLY, new Uint8Array([EV3_BUTTON.ENTER]));
	const service = new ButtonService({ commandClient: client });

	const state = await service.readButton();

	assert.equal(client.requests.length, 1);
	const req = client.requests[0];
	assert.equal(req.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);

	const payload = Array.from(req.payload ?? new Uint8Array());
	assert.deepEqual(payload, [
		0x01, 0x00,       // 1 global byte
		0x81, 0x0d,       // opUI_READ, GET_PRESS subcode
		0x00,             // LC0(0) button query
		0x60              // GV0(0) result
	]);

	assert.equal(state.pressedButton, EV3_BUTTON.ENTER);
	assert.equal(state.buttonName, 'Enter');
	assert.ok(state.timestampMs > 0);
});

test('ButtonService.readButton returns NONE when no button pressed', async () => {
	const client = new FakeButtonCommandClient(EV3_REPLY.DIRECT_REPLY, new Uint8Array([0]));
	const service = new ButtonService({ commandClient: client });

	const state = await service.readButton();

	assert.equal(state.pressedButton, EV3_BUTTON.NONE);
	assert.equal(state.buttonName, 'None');
});

test('ButtonService.readButton throws on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeButtonCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new ButtonService({ commandClient: client });

	await assert.rejects(
		service.readButton(),
		/DIRECT_REPLY_ERROR/i
	);
});

test('BUTTON_NAMES covers all defined buttons', () => {
	for (const [key, value] of Object.entries(EV3_BUTTON)) {
		assert.ok(BUTTON_NAMES[value], `Button ${key}(${value}) should have a name`);
	}
});
