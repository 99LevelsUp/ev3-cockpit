import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapWithFaultInjector } from '../mock/faultInjector';
import { encodeEv3Packet, decodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import type { MockFaultConfig } from '../mock/mockTypes';
import type { TransportRequestOptions } from '../transport/transportAdapter';

function makeOptions(timeoutMs = 2000): TransportRequestOptions {
	const controller = new AbortController();
	return { timeoutMs, signal: controller.signal };
}

function echoResponder(packet: Uint8Array): Uint8Array {
	const req = decodeEv3Packet(packet);
	const replyType = req.type === EV3_COMMAND.SYSTEM_COMMAND_REPLY
		? EV3_REPLY.SYSTEM_REPLY
		: EV3_REPLY.DIRECT_REPLY;
	return encodeEv3Packet(req.messageCounter, replyType, new Uint8Array([0x00]));
}

function noFaults(): MockFaultConfig {
	return { errorRate: 0, latencyMs: 0, jitterMs: 0, timeoutRate: 0 };
}

test('faultInjector: no faults = pass through', async () => {
	const wrapped = wrapWithFaultInjector(echoResponder, noFaults());
	const packet = encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x00, 0x00]));
	const reply = await wrapped(packet, makeOptions());
	const decoded = decodeEv3Packet(reply);
	assert.equal(decoded.type, EV3_REPLY.DIRECT_REPLY);
});

test('faultInjector: errorRate=1.0 always returns error reply', async () => {
	const cfg: MockFaultConfig = { errorRate: 1.0, latencyMs: 0, jitterMs: 0, timeoutRate: 0 };
	const wrapped = wrapWithFaultInjector(echoResponder, cfg);
	const packet = encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x00, 0x00]));
	const reply = await wrapped(packet, makeOptions());
	const decoded = decodeEv3Packet(reply);
	assert.equal(decoded.type, EV3_REPLY.DIRECT_REPLY_ERROR);
});

test('faultInjector: errorRate=1.0 flips system reply to error', async () => {
	const cfg: MockFaultConfig = { errorRate: 1.0, latencyMs: 0, jitterMs: 0, timeoutRate: 0 };
	const wrapped = wrapWithFaultInjector(echoResponder, cfg);
	const packet = encodeEv3Packet(1, EV3_COMMAND.SYSTEM_COMMAND_REPLY, new Uint8Array([0x99]));
	const reply = await wrapped(packet, makeOptions());
	const decoded = decodeEv3Packet(reply);
	assert.equal(decoded.type, EV3_REPLY.SYSTEM_REPLY_ERROR);
});

test('faultInjector: latency adds delay', async () => {
	const cfg: MockFaultConfig = { errorRate: 0, latencyMs: 50, jitterMs: 0, timeoutRate: 0 };
	const wrapped = wrapWithFaultInjector(echoResponder, cfg);
	const packet = encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x00, 0x00]));

	const start = Date.now();
	await wrapped(packet, makeOptions());
	const elapsed = Date.now() - start;
	assert.ok(elapsed >= 40, `expected >= 40ms, got ${elapsed}ms`);
});

test('faultInjector: timeoutRate=1.0 never resolves (aborts on signal)', async () => {
	const cfg: MockFaultConfig = { errorRate: 0, latencyMs: 0, jitterMs: 0, timeoutRate: 1.0 };
	const wrapped = wrapWithFaultInjector(echoResponder, cfg);
	const packet = encodeEv3Packet(1, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x00, 0x00]));

	const controller = new AbortController();
	const options: TransportRequestOptions = { timeoutMs: 100, signal: controller.signal };

	// Abort after 50ms
	setTimeout(() => controller.abort(), 50);

	await assert.rejects(
		async () => wrapped(packet, options),
		/aborted/i
	);
});
