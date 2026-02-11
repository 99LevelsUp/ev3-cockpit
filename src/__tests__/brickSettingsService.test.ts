import assert from 'node:assert/strict';
import test from 'node:test';
import { BrickSettingsService } from '../device/brickSettingsService';
import { Ev3CommandRequest } from '../protocol/ev3CommandClient';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { EV3_COMMAND, EV3_REPLY, Ev3Packet } from '../protocol/ev3Packet';
import { CommandResult } from '../scheduler/types';

class FakeSettingsCommandClient implements Ev3CommandSendLike {
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

test('BrickSettingsService.getBrickName sends opINFO GET_BRICKNAME and decodes reply', async () => {
	const nameBytes = Buffer.from('EV3\0', 'utf8');
	const replyPayload = new Uint8Array(13);
	replyPayload.set(nameBytes);
	const client = new FakeSettingsCommandClient(EV3_REPLY.DIRECT_REPLY, replyPayload);
	const service = new BrickSettingsService({ commandClient: client });

	const name = await service.getBrickName();

	assert.equal(name, 'EV3');
	assert.equal(client.requests.length, 1);
	const req = client.requests[0];
	assert.equal(req.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);

	const payload = Array.from(req.payload ?? new Uint8Array());
	// Global bytes: 13 (0x0d, 0x00)
	assert.equal(payload[0], 0x0d);
	assert.equal(payload[1], 0x00);
	// opINFO=0x7c, GET_BRICKNAME=0x0d
	assert.equal(payload[2], 0x7c);
	assert.equal(payload[3], 0x0d);
});

test('BrickSettingsService.setBrickName sends opINFO SET_BRICKNAME with LCS string', async () => {
	const client = new FakeSettingsCommandClient();
	const service = new BrickSettingsService({ commandClient: client });

	await service.setBrickName('MyBrick');

	const payload = Array.from(client.requests[0].payload ?? new Uint8Array());
	// uint16le(0), opINFO(0x7c), SET_BRICKNAME(0x08), LCS('MyBrick')
	assert.deepEqual(payload.slice(0, 4), [0x00, 0x00, 0x7c, 0x08]);
	assert.equal(payload[4], 0x84); // LCS marker
});

test('BrickSettingsService.setBrickName truncates to 12 chars', async () => {
	const client = new FakeSettingsCommandClient();
	const service = new BrickSettingsService({ commandClient: client });

	await service.setBrickName('VeryLongBrickName123');

	const payload = client.requests[0].payload ?? new Uint8Array();
	// LCS at offset 4: 0x84 + string bytes + 0x00
	// String should be truncated to 12 chars = "VeryLongBric"
	const lcsStart = 5; // after 0x84
	const lcsEnd = Array.from(payload).indexOf(0, lcsStart);
	const nameStr = Buffer.from(payload.slice(lcsStart, lcsEnd)).toString('utf8');
	assert.equal(nameStr, 'VeryLongBric');
});

test('BrickSettingsService.getBatteryInfo decodes voltage and level', async () => {
	const buf = new Uint8Array(5);
	new DataView(buf.buffer).setFloat32(0, 7.85, true);
	buf[4] = 75;
	const client = new FakeSettingsCommandClient(EV3_REPLY.DIRECT_REPLY, buf);
	const service = new BrickSettingsService({ commandClient: client });

	const battery = await service.getBatteryInfo();

	assert.ok(Math.abs(battery.voltage - 7.85) < 0.01, `Voltage should be ~7.85, got ${battery.voltage}`);
	assert.equal(battery.level, 75);

	const payload = Array.from(client.requests[0].payload ?? new Uint8Array());
	// 5 global bytes
	assert.equal(payload[0], 0x05);
	assert.equal(payload[1], 0x00);
	// opUI_READ(0x81), GET_VBATT(0x01), GV0(0)
	assert.deepEqual(payload.slice(2, 5), [0x81, 0x01, 0x60]);
	// opUI_READ(0x81), GET_LBATT(0x12), GV0(4)
	assert.deepEqual(payload.slice(5, 8), [0x81, 0x12, 0x64]);
});

test('BrickSettingsService.getVolume decodes 1-byte reply', async () => {
	const client = new FakeSettingsCommandClient(EV3_REPLY.DIRECT_REPLY, new Uint8Array([80]));
	const service = new BrickSettingsService({ commandClient: client });

	const volume = await service.getVolume();

	assert.equal(volume, 80);
});

test('BrickSettingsService.setVolume sends opUI_WRITE SET_VOLUME', async () => {
	const client = new FakeSettingsCommandClient();
	const service = new BrickSettingsService({ commandClient: client });

	await service.setVolume(60);

	const payload = Array.from(client.requests[0].payload ?? new Uint8Array());
	// uint16le(0), opUI_WRITE(0x82), SET_VOLUME(0x06), LC2(60)
	assert.deepEqual(payload.slice(0, 4), [0x00, 0x00, 0x82, 0x06]);
	assert.deepEqual(payload.slice(4, 7), [0x82, 60, 0x00]); // LC2(60)
});

test('BrickSettingsService.getSleepTimer decodes 1-byte reply', async () => {
	const client = new FakeSettingsCommandClient(EV3_REPLY.DIRECT_REPLY, new Uint8Array([30]));
	const service = new BrickSettingsService({ commandClient: client });

	const minutes = await service.getSleepTimer();

	assert.equal(minutes, 30);
});

test('BrickSettingsService.setSleepTimer sends opUI_WRITE SET_SLEEP', async () => {
	const client = new FakeSettingsCommandClient();
	const service = new BrickSettingsService({ commandClient: client });

	await service.setSleepTimer(10);

	const payload = Array.from(client.requests[0].payload ?? new Uint8Array());
	assert.deepEqual(payload.slice(0, 4), [0x00, 0x00, 0x82, 0x07]);
	assert.deepEqual(payload.slice(4, 7), [0x82, 10, 0x00]); // LC2(10)
});

test('BrickSettingsService throws on DIRECT_REPLY_ERROR', async () => {
	const client = new FakeSettingsCommandClient(EV3_REPLY.DIRECT_REPLY_ERROR);
	const service = new BrickSettingsService({ commandClient: client });

	await assert.rejects(service.getBrickName(), /DIRECT_REPLY_ERROR/i);
	await assert.rejects(service.setBrickName('X'), /DIRECT_REPLY_ERROR/i);
	await assert.rejects(service.getBatteryInfo(), /DIRECT_REPLY_ERROR/i);
	await assert.rejects(service.getVolume(), /DIRECT_REPLY_ERROR/i);
	await assert.rejects(service.setVolume(50), /DIRECT_REPLY_ERROR/i);
	await assert.rejects(service.getSleepTimer(), /DIRECT_REPLY_ERROR/i);
	await assert.rejects(service.setSleepTimer(5), /DIRECT_REPLY_ERROR/i);
});
