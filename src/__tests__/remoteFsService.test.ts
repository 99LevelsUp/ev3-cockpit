import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityProfile } from '../compat/capabilityProfile';
import { FsConfigSnapshot } from '../config/featureConfig';
import { Logger } from '../diagnostics/logger';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { Ev3CommandClient, Ev3CommandRequest } from '../protocol/ev3CommandClient';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY, Ev3Packet } from '../protocol/ev3Packet';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { CommandResult } from '../scheduler/types';
import { MockTransportAdapter } from '../transport/mockTransportAdapter';
import { RemoteFsService } from '../fs/remoteFsService';

const CMD = {
	BEGIN_DOWNLOAD: 0x92,
	CONTINUE_DOWNLOAD: 0x93,
	BEGIN_UPLOAD: 0x94,
	CONTINUE_UPLOAD: 0x95,
	CLOSE_FILEHANDLE: 0x98,
	LIST_FILES: 0x99,
	CONTINUE_LIST_FILES: 0x9a,
	CREATE_DIR: 0x9b
} as const;

function makeProfile(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
	return {
		id: 'stock-default',
		firmwareFamily: 'stock',
		supportsContinueList: true,
		uploadChunkBytes: 1000,
		minPollingUsbMs: 100,
		minPollingBtTcpMs: 250,
		recommendedTimeoutMs: 2000,
		...overrides
	};
}

function makeFsConfig(overrides: Partial<FsConfigSnapshot> = {}): FsConfigSnapshot {
	return {
		mode: 'safe',
		defaultRoots: ['/home/root/lms2012/prjs/', '/media/card/'],
		fullModeConfirmationRequired: true,
		...overrides
	};
}

function u32le(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0, true);
	return out;
}

class SilentLogger implements Logger {
	public error(_message: string, _meta?: Record<string, unknown>): void {}
	public warn(_message: string, _meta?: Record<string, unknown>): void {}
	public info(_message: string, _meta?: Record<string, unknown>): void {}
	public debug(_message: string, _meta?: Record<string, unknown>): void {}
	public trace(_message: string, _meta?: Record<string, unknown>): void {}
}

class FakeCommandClient implements Ev3CommandSendLike {
	public readonly requests: Ev3CommandRequest[] = [];
	private messageCounter = 0;

	public constructor(private readonly responder: (request: Ev3CommandRequest) => Ev3Packet) {}

	public async send(request: Ev3CommandRequest): Promise<CommandResult<Ev3Packet>> {
		this.requests.push(request);
		const reply = this.responder(request);
		const counter = this.messageCounter++;
		return {
			requestId: request.id ?? `req-${counter}`,
			messageCounter: counter,
			reply,
			enqueuedAt: 0,
			startedAt: 0,
			finishedAt: 0,
			durationMs: 0
		};
	}
}

function systemReply(payload: Uint8Array): Ev3Packet {
	return {
		messageCounter: 0,
		type: EV3_REPLY.SYSTEM_REPLY,
		payload
	};
}

function directReply(payload: Uint8Array): Ev3Packet {
	return {
		messageCounter: 0,
		type: EV3_REPLY.DIRECT_REPLY,
		payload
	};
}

test('RemoteFsService createDirectory normalizes path and sends CREATE_DIR command', async () => {
	const client = new FakeCommandClient(() => systemReply(new Uint8Array([CMD.CREATE_DIR, 0x00])));
	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile(),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	await service.createDirectory('\\home\\root\\lms2012\\prjs\\demo');

	assert.equal(client.requests.length, 1);
	const payload = client.requests[0].payload ?? new Uint8Array();
	assert.equal(payload[0], CMD.CREATE_DIR);
	assert.equal(Buffer.from(payload.subarray(1)).toString('utf8'), '/home/root/lms2012/prjs/demo\u0000');
});

test('RemoteFsService safe mode blocks disallowed system paths before sending command', async () => {
	const client = new FakeCommandClient(() => systemReply(new Uint8Array([CMD.CREATE_DIR, 0x00])));
	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile(),
		fsConfig: makeFsConfig({ mode: 'safe' }),
		logger: new SilentLogger()
	});

	await assert.rejects(service.createDirectory('/etc/unsafe'), /safe mode|outside safe roots/i);
	assert.equal(client.requests.length, 0);
});

test('RemoteFsService writeFile chunks data based on capability profile', async () => {
	const calls: number[] = [];
	const client = new FakeCommandClient((request) => {
		const payload = request.payload ?? new Uint8Array();
		const command = payload[0];
		calls.push(command);
		if (command === CMD.BEGIN_DOWNLOAD) {
			return systemReply(new Uint8Array([CMD.BEGIN_DOWNLOAD, 0x00, 0x2a]));
		}
		if (command === CMD.CONTINUE_DOWNLOAD) {
			const chunkLength = payload.length - 2; // command + handle
			const status = chunkLength <= 2 ? 0x08 : 0x00;
			return systemReply(new Uint8Array([CMD.CONTINUE_DOWNLOAD, status, 0x2a]));
		}
		throw new Error(`Unexpected command 0x${command.toString(16)}`);
	});

	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile({ uploadChunkBytes: 4 }),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	await service.writeFile('/home/root/lms2012/prjs/demo.bin', new Uint8Array([1, 2, 3, 4, 5, 6]));

	assert.deepEqual(calls, [CMD.BEGIN_DOWNLOAD, CMD.CONTINUE_DOWNLOAD, CMD.CONTINUE_DOWNLOAD]);
	assert.equal((client.requests[1].payload ?? new Uint8Array()).length - 2, 4);
	assert.equal((client.requests[2].payload ?? new Uint8Array()).length - 2, 2);
});

test('RemoteFsService readFile collects BEGIN_UPLOAD and CONTINUE_UPLOAD chunks and closes handle', async () => {
	let continueUploadCount = 0;
	const commands: number[] = [];
	const client = new FakeCommandClient((request) => {
		const payload = request.payload ?? new Uint8Array();
		const command = payload[0];
		commands.push(command);

		if (command === CMD.BEGIN_UPLOAD) {
			const header = new Uint8Array([CMD.BEGIN_UPLOAD, 0x00]);
			return systemReply(new Uint8Array([...header, ...u32le(5), 0x11, 0x61, 0x62, 0x63]));
		}
		if (command === CMD.CONTINUE_UPLOAD) {
			continueUploadCount += 1;
			assert.equal(payload[1], 0x11);
			return systemReply(new Uint8Array([CMD.CONTINUE_UPLOAD, 0x08, 0x11, 0x64, 0x65]));
		}
		if (command === CMD.CLOSE_FILEHANDLE) {
			return systemReply(new Uint8Array([CMD.CLOSE_FILEHANDLE, 0x00]));
		}
		throw new Error(`Unexpected command 0x${command.toString(16)}`);
	});

	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile(),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	const data = await service.readFile('/home/root/lms2012/prjs/readme.txt');
	assert.equal(Buffer.from(data).toString('utf8'), 'abcde');
	assert.equal(continueUploadCount, 1);
	assert.deepEqual(commands, [CMD.BEGIN_UPLOAD, CMD.CONTINUE_UPLOAD, CMD.CLOSE_FILEHANDLE]);
});

test('RemoteFsService listDirectory parses folder/file listing and continues when profile allows', async () => {
	const listing = Buffer.from('mydir/\nABCD1234 00000004 test.rbf\n', 'utf8');
	const first = listing.subarray(0, 8);
	const rest = listing.subarray(8);
	const commands: number[] = [];

	const client = new FakeCommandClient((request) => {
		const payload = request.payload ?? new Uint8Array();
		const command = payload[0];
		commands.push(command);

		if (command === CMD.LIST_FILES) {
			return systemReply(new Uint8Array([CMD.LIST_FILES, 0x00, ...u32le(listing.length), 0x22, ...first]));
		}
		if (command === CMD.CONTINUE_LIST_FILES) {
			return systemReply(new Uint8Array([CMD.CONTINUE_LIST_FILES, 0x08, 0x22, ...rest]));
		}
		if (command === CMD.CLOSE_FILEHANDLE) {
			return systemReply(new Uint8Array([CMD.CLOSE_FILEHANDLE, 0x00]));
		}
		throw new Error(`Unexpected command 0x${command.toString(16)}`);
	});

	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile({ supportsContinueList: true }),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	const result = await service.listDirectory('/home/root/lms2012/prjs/demo');
	assert.equal(result.truncated, false);
	assert.deepEqual(result.folders, ['mydir']);
	assert.equal(result.files.length, 1);
	assert.equal(result.files[0].name, 'test.rbf');
	assert.equal(result.files[0].size, 4);
	assert.deepEqual(commands, [CMD.LIST_FILES, CMD.CONTINUE_LIST_FILES, CMD.CLOSE_FILEHANDLE]);
});

test('RemoteFsService listDirectory returns truncated result when continue-list is disabled', async () => {
	const listing = Buffer.from('sub/\nAAAA0000 00000010 longname.rbf\n', 'utf8');
	const first = listing.subarray(0, 6);
	const commands: number[] = [];

	const client = new FakeCommandClient((request) => {
		const payload = request.payload ?? new Uint8Array();
		const command = payload[0];
		commands.push(command);
		if (command === CMD.LIST_FILES) {
			return systemReply(new Uint8Array([CMD.LIST_FILES, 0x00, ...u32le(listing.length), 0x33, ...first]));
		}
		if (command === CMD.CLOSE_FILEHANDLE) {
			return systemReply(new Uint8Array([CMD.CLOSE_FILEHANDLE, 0x00]));
		}
		throw new Error(`Unexpected command 0x${command.toString(16)}`);
	});

	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile({ supportsContinueList: false }),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	const result = await service.listDirectory('/home/root/lms2012/prjs/demo');
	assert.equal(result.truncated, true);
	assert.deepEqual(commands, [CMD.LIST_FILES, CMD.CLOSE_FILEHANDLE]);
	assert.equal(client.requests[0].idempotent, true);
	assert.equal(client.requests[1].idempotent, true);
});

test('RemoteFsService listDirectory does not close invalid handle 0', async () => {
	const commands: number[] = [];
	const client = new FakeCommandClient((request) => {
		const payload = request.payload ?? new Uint8Array();
		const command = payload[0];
		commands.push(command);
		if (command === CMD.LIST_FILES) {
			return systemReply(new Uint8Array([CMD.LIST_FILES, 0x08, ...u32le(0), 0x00]));
		}
		throw new Error(`Unexpected command 0x${command.toString(16)}`);
	});

	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile(),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	const result = await service.listDirectory('/home/root/lms2012/prjs/');
	assert.equal(result.totalBytes, 0);
	assert.deepEqual(commands, [CMD.LIST_FILES]);
});

test('RemoteFsService listDirectory retries after stale messageCounter mismatch and succeeds', async () => {
	const scheduler = new CommandScheduler();
	let sendCalls = 0;
	const listing = Buffer.from('okdir/\n', 'utf8');

	const transport = new MockTransportAdapter((outgoing) => {
		sendCalls += 1;
		const decoded = decodeEv3Packet(outgoing);
		const command = decoded.payload[0];

		if (sendCalls === 1) {
			const stalePayload = new Uint8Array([CMD.LIST_FILES, 0x08, ...u32le(listing.length), 0x44, ...listing]);
			return encodeEv3Packet((decoded.messageCounter + 1) & 0xffff, EV3_REPLY.SYSTEM_REPLY, stalePayload);
		}

		if (command === CMD.LIST_FILES) {
			const payload = new Uint8Array([CMD.LIST_FILES, 0x08, ...u32le(listing.length), 0x44, ...listing]);
			return encodeEv3Packet(decoded.messageCounter, EV3_REPLY.SYSTEM_REPLY, payload);
		}

		if (command === CMD.CLOSE_FILEHANDLE) {
			const payload = new Uint8Array([CMD.CLOSE_FILEHANDLE, 0x00]);
			return encodeEv3Packet(decoded.messageCounter, EV3_REPLY.SYSTEM_REPLY, payload);
		}

		throw new Error(`Unexpected command 0x${command.toString(16)}`);
	});

	const client = new Ev3CommandClient({ scheduler, transport });
	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile(),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	await client.open();
	try {
		const result = await service.listDirectory('/home/root/lms2012/prjs/');
		assert.deepEqual(result.folders, ['okdir']);
		assert.equal(result.truncated, false);
		assert.equal(sendCalls, 3);
	} finally {
		await client.close();
		scheduler.dispose();
	}
});

test('RemoteFsService readFile retries full transfer when CONTINUE_UPLOAD returns UNKNOWN_HANDLE', async () => {
	let beginCalls = 0;
	let continueCalls = 0;
	const commands: number[] = [];

	const client = new FakeCommandClient((request) => {
		const payload = request.payload ?? new Uint8Array();
		const command = payload[0];
		commands.push(command);

		if (command === CMD.BEGIN_UPLOAD) {
			beginCalls += 1;
			const header = new Uint8Array([CMD.BEGIN_UPLOAD, 0x00]);
			return systemReply(new Uint8Array([...header, ...u32le(5), 0x11, 0x61, 0x62, 0x63]));
		}
		if (command === CMD.CONTINUE_UPLOAD) {
			continueCalls += 1;
			if (continueCalls === 1) {
				return systemReply(new Uint8Array([CMD.CONTINUE_UPLOAD, 0x01, 0x11]));
			}
			return systemReply(new Uint8Array([CMD.CONTINUE_UPLOAD, 0x08, 0x11, 0x64, 0x65]));
		}
		if (command === CMD.CLOSE_FILEHANDLE) {
			return systemReply(new Uint8Array([CMD.CLOSE_FILEHANDLE, 0x00]));
		}
		throw new Error(`Unexpected command 0x${command.toString(16)}`);
	});

	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile(),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	const data = await service.readFile('/home/root/lms2012/prjs/retry.txt');
	assert.equal(Buffer.from(data).toString('utf8'), 'abcde');
	assert.equal(beginCalls, 2);
	assert.equal(continueCalls, 2);
	assert.ok(commands.filter((cmd) => cmd === CMD.BEGIN_UPLOAD).length >= 2);
});

test('RemoteFsService runBytecodeProgram composes compound direct command for provided path', async () => {
	const client = new FakeCommandClient((request) => {
		assert.equal(request.type, EV3_COMMAND.DIRECT_COMMAND_REPLY);
		assert.equal(request.lane, 'high');
		return directReply(new Uint8Array(8));
	});

	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile(),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	await service.runBytecodeProgram('/home/root/lms2012/prjs/demo/program.rbf');

	assert.equal(client.requests.length, 1);
	const payload = client.requests[0].payload ?? new Uint8Array();
	assert.equal(payload[0], 0x08);
	assert.equal(payload[1], 0x00);
	assert.equal(payload[2], 0xc0);
	assert.equal(payload[3], 0x08);
	assert.equal(payload[4], 0x82);
	assert.equal(payload[5], 0x01);
	assert.equal(payload[6], 0x00);

	const encodedPath = Buffer.from(payload);
	assert.notEqual(encodedPath.indexOf(Buffer.from('/home/root/lms2012/prjs/demo/program.rbf\u0000', 'utf8')), -1);
});

test('RemoteFsService runBytecodeProgram allows non-rbf extension and delegates validation to launcher', async () => {
	const client = new FakeCommandClient(() => directReply(new Uint8Array(8)));
	const service = new RemoteFsService({
		commandClient: client,
		capabilityProfile: makeProfile(),
		fsConfig: makeFsConfig(),
		logger: new SilentLogger()
	});

	await service.runBytecodeProgram('/home/root/lms2012/prjs/demo/readme.txt');
	assert.equal(client.requests.length, 1);
});
