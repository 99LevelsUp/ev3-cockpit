import assert from 'node:assert/strict';
import test from 'node:test';
import { LedService, isValidLedPattern, LED_PATTERN_NAMES } from '../device/ledService';
import type { LedPattern } from '../device/ledService';
import { Ev3CommandRequest } from '../protocol/ev3CommandClient';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { EV3_COMMAND, EV3_REPLY, Ev3Packet } from '../protocol/ev3Packet';
import { CommandResult } from '../scheduler/types';

class FakeLedCommandClient implements Ev3CommandSendLike {
	public readonly requests: Ev3CommandRequest[] = [];
	private messageCounter = 0;
	private replyType: number;

	public constructor(replyType: number = EV3_REPLY.DIRECT_REPLY) {
		this.replyType = replyType;
	}

	public async send(request: Ev3CommandRequest): Promise<CommandResult<Ev3Packet>> {
		this.requests.push(request);
		const counter = this.messageCounter++;
		return {
			requestId: request.id ?? `request-${counter}`,
			messageCounter: counter,
			reply: { messageCounter: counter, type: this.replyType, payload: new Uint8Array() },
			enqueuedAt: 0,
			startedAt: 0,
			finishedAt: 0,
			durationMs: 0
		};
	}
}

test('isValidLedPattern accepts 0..9', () => {
	for (let i = 0; i <= 9; i++) {
		assert.ok(isValidLedPattern(i), `${i} should be valid`);
	}
	assert.ok(!isValidLedPattern(-1));
	assert.ok(!isValidLedPattern(10));
	assert.ok(!isValidLedPattern(1.5));
});

test('LED_PATTERN_NAMES covers all valid patterns', () => {
	for (let i = 0; i <= 9; i++) {
		assert.ok(LED_PATTERN_NAMES[i as LedPattern], `Pattern ${i} should have a name`);
	}
});

test('LedService.setLedPattern sends opUI_WRITE LED payload', async () => {
	const client = new FakeLedCommandClient();
	const service = new LedService({ commandClient: client });

	await service.setLedPattern(3); // Orange

	assert.equal(client.requests.length, 1);
	const req = client.requests[0];
	assert.equal(req.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
	assert.equal(req.lane, 'normal');

	const payload = Array.from(req.payload ?? new Uint8Array());
	assert.deepEqual(payload, [
		0x00, 0x00,       // 0 global bytes
		0x82, 0x1b,       // opUI_WRITE, LED subcode
		0x03              // LC0 pattern=3 (orange)
	]);
});

test('LedService.setLedPattern throws on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeLedCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new LedService({ commandClient: client });

	await assert.rejects(
		service.setLedPattern(1),
		/DIRECT_REPLY_ERROR/i
	);
});

test('LedService.setLedPattern rejects invalid pattern', async () => {
	const client = new FakeLedCommandClient();
	const service = new LedService({ commandClient: client });

	await assert.rejects(
		service.setLedPattern(15 as LedPattern),
		/Invalid LED pattern/i
	);
});
