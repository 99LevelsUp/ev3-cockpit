import assert from 'node:assert/strict';
import test from 'node:test';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { SchedulerError } from '../scheduler/types';
import { MockTransportAdapter } from '../transport/mockTransportAdapter';
import { sleep } from './testHelpers';

test('Ev3CommandClient sends request packet and decodes matching reply', async () => {
	const scheduler = new CommandScheduler();
	const transport = new MockTransportAdapter((outgoing) => {
		const decoded = decodeEv3Packet(outgoing);
		return encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0xaa]));
	});
	const client = new Ev3CommandClient({ scheduler, transport });

	await client.open();
	try {
		const result = await client.send({
			id: 'probe-ok',
			lane: 'high',
			idempotent: true,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload: new Uint8Array([0x10])
		});

		assert.equal(result.requestId, 'probe-ok');
		assert.equal(result.reply.type, EV3_REPLY.DIRECT_REPLY);
		assert.deepEqual(Array.from(result.reply.payload), [0xaa]);
		assert.equal(transport.sentPackets.length, 1);
	} finally {
		await client.close();
		scheduler.dispose();
	}
});

test('Ev3CommandClient surfaces timeout and next request can still succeed', async () => {
	const scheduler = new CommandScheduler({ defaultTimeoutMs: 10 });
	let calls = 0;
	const transport = new MockTransportAdapter(async (outgoing) => {
		calls += 1;
		const decoded = decodeEv3Packet(outgoing);
		if (calls === 1) {
			await sleep(35);
			return encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x01]));
		}
		return encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x02]));
	});
	const client = new Ev3CommandClient({ scheduler, transport });

	await client.open();
	try {
		const timedOut = client.send({
			id: 'probe-timeout',
			idempotent: true,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY
		});
		await assert.rejects(timedOut, (error: unknown) => {
			assert.ok(error instanceof SchedulerError);
			assert.equal(error.code, 'TIMEOUT');
			assert.equal(error.requestId, 'probe-timeout');
			return true;
		});

		const recoveryResult = await client.send({
			id: 'probe-after-timeout',
			idempotent: true,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY
		});
		assert.deepEqual(Array.from(recoveryResult.reply.payload), [0x02]);
		assert.equal(calls, 2);
	} finally {
		await client.close();
		scheduler.dispose();
	}
});

test('Ev3CommandClient retries idempotent request after transport disconnect error', async () => {
	const scheduler = new CommandScheduler();
	let calls = 0;
	const transport = new MockTransportAdapter((outgoing) => {
		calls += 1;
		if (calls < 3) {
			throw new Error('disconnect');
		}

		const decoded = decodeEv3Packet(outgoing);
		return encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x55]));
	});
	const client = new Ev3CommandClient({ scheduler, transport });

	await client.open();
	try {
		const result = await client.send({
			id: 'probe-retry-disconnect',
			idempotent: true,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			retry: {
				maxRetries: 2,
				initialBackoffMs: 1,
				backoffFactor: 1,
				retryOn: ['EXECUTION_FAILED']
			}
		});
		assert.deepEqual(Array.from(result.reply.payload), [0x55]);
		assert.equal(calls, 3);
	} finally {
		await client.close();
		scheduler.dispose();
	}
});

test('Ev3CommandClient rejects stale out-of-order reply after timeout and accepts following valid reply', async () => {
	const scheduler = new CommandScheduler({ defaultTimeoutMs: 10 });
	let staleCounter = 0;
	let calls = 0;
	const transport = new MockTransportAdapter(async (outgoing) => {
		calls += 1;
		const decoded = decodeEv3Packet(outgoing);
		if (calls === 1) {
			staleCounter = decoded.messageCounter;
			await sleep(35);
			return encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x10]));
		}
		if (calls === 2) {
			return encodeEv3Packet(staleCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x20]));
		}
		return encodeEv3Packet(decoded.messageCounter, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x30]));
	});
	const client = new Ev3CommandClient({ scheduler, transport });

	await client.open();
	try {
		const first = client.send({
			id: 'probe-timeout-stale-1',
			idempotent: true,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY
		});
		await assert.rejects(first, (error: unknown) => {
			assert.ok(error instanceof SchedulerError);
			assert.equal(error.code, 'TIMEOUT');
			assert.equal(error.requestId, 'probe-timeout-stale-1');
			return true;
		});

		const stale = client.send({
			id: 'probe-stale-2',
			idempotent: true,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY
		});
		await assert.rejects(stale, (error: unknown) => {
			assert.ok(error instanceof SchedulerError);
			assert.equal(error.code, 'EXECUTION_FAILED');
			assert.equal(error.requestId, 'probe-stale-2');
			return true;
		});

		const valid = await client.send({
			id: 'probe-valid-3',
			idempotent: true,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY
		});
		assert.deepEqual(Array.from(valid.reply.payload), [0x30]);
		assert.equal(calls, 3);
	} finally {
		await client.close();
		scheduler.dispose();
	}
});

test('Ev3CommandClient rejects when reply messageCounter does not match request', async () => {
	const scheduler = new CommandScheduler();
	const transport = new MockTransportAdapter((outgoing) => {
		const decoded = decodeEv3Packet(outgoing);
		return encodeEv3Packet((decoded.messageCounter + 1) & 0xffff, EV3_REPLY.DIRECT_REPLY, new Uint8Array([0x00]));
	});
	const client = new Ev3CommandClient({ scheduler, transport });

	await client.open();
	try {
		const failing = client.send({
			id: 'probe-mismatch',
			lane: 'normal',
			idempotent: true,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY
		});

		await assert.rejects(failing, (error: unknown) => {
			assert.ok(error instanceof SchedulerError);
			assert.equal(error.code, 'EXECUTION_FAILED');
			assert.equal(error.requestId, 'probe-mismatch');
			return true;
		});
	} finally {
		await client.close();
		scheduler.dispose();
	}
});
