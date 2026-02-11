import assert from 'node:assert/strict';
import test from 'node:test';
import { SoundService } from '../device/soundService';
import { Ev3CommandRequest } from '../protocol/ev3CommandClient';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { EV3_COMMAND, EV3_REPLY, Ev3Packet } from '../protocol/ev3Packet';
import { CommandResult } from '../scheduler/types';

class FakeSoundCommandClient implements Ev3CommandSendLike {
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

test('SoundService.playTone sends opSOUND TONE payload', async () => {
	const client = new FakeSoundCommandClient();
	const service = new SoundService({ commandClient: client });

	await service.playTone(50, 440, 500);

	assert.equal(client.requests.length, 1);
	const req = client.requests[0];
	assert.equal(req.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
	assert.equal(req.lane, 'normal');

	const payload = Array.from(req.payload ?? new Uint8Array());
	// LC2 encoding: 0x82 + int16le
	const volLc2 = [0x82, 50, 0x00];       // LC2(50)
	const freqLc2 = [0x82, 0xb8, 0x01];    // LC2(440)
	const durLc2 = [0x82, 0xf4, 0x01];     // LC2(500)
	assert.deepEqual(payload, [
		0x00, 0x00,       // 0 global bytes
		0x94, 0x01,       // opSOUND, TONE subcode
		...volLc2,
		...freqLc2,
		...durLc2
	]);
});

test('SoundService.playTone clamps volume to 0..100', async () => {
	const client = new FakeSoundCommandClient();
	const service = new SoundService({ commandClient: client });

	await service.playTone(200, 1000, 100);

	const payload = Array.from(client.requests[0].payload ?? new Uint8Array());
	// Volume should be clamped to 100 = LC2(100)
	assert.deepEqual(payload.slice(4, 7), [0x82, 100, 0x00]); // LC2(100)
});

test('SoundService.playTone throws on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeSoundCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new SoundService({ commandClient: client });

	await assert.rejects(
		service.playTone(50, 440, 500),
		/DIRECT_REPLY_ERROR/i
	);
});

test('SoundService.playSoundFile sends opSOUND PLAY payload', async () => {
	const client = new FakeSoundCommandClient();
	const service = new SoundService({ commandClient: client });

	await service.playSoundFile(75, '../apps/Brick Program/Woah');

	assert.equal(client.requests.length, 1);
	const req = client.requests[0];
	assert.equal(req.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);

	const payload = Array.from(req.payload ?? new Uint8Array());
	// First 4 bytes: uint16le(0), opSOUND(0x94), PLAY(0x02)
	assert.deepEqual(payload.slice(0, 4), [0x00, 0x00, 0x94, 0x02]);
	// Volume LC2(75)
	assert.deepEqual(payload.slice(4, 7), [0x82, 75, 0x00]);
	// Filename LCS: 0x84 + string bytes + 0x00
	assert.equal(payload[7], 0x84); // LCS marker
});

test('SoundService.playSoundFile throws on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeSoundCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new SoundService({ commandClient: client });

	await assert.rejects(
		service.playSoundFile(50, 'test'),
		/DIRECT_REPLY_ERROR/i
	);
});
