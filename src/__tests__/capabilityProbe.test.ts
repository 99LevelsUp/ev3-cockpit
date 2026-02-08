import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildCapabilityProbeDirectPayload,
	CAPABILITY_PROBE_GLOBAL_BYTES,
	parseCapabilityProbeReply
} from '../protocol/capabilityProbe';

test('capability probe payload allocates expected global bytes and emits UI_READ ops', () => {
	const payload = buildCapabilityProbeDirectPayload();

	assert.equal(payload[0], CAPABILITY_PROBE_GLOBAL_BYTES);
	assert.equal(payload[1], 0x00);
	assert.equal(payload[2], 0x81);
	assert.equal(payload[3], 0x03);
	assert.ok(payload.length > 8);
});

test('capability probe parser extracts fixed-size C strings', () => {
	const reply = new Uint8Array(CAPABILITY_PROBE_GLOBAL_BYTES);
	reply.set(Buffer.from('V1.11H'), 0);
	reply.set(Buffer.from('1.00'), 16);
	reply.set(Buffer.from('1.10E'), 24);
	reply.set(Buffer.from('12345678'), 32);
	reply.set(Buffer.from('87654321'), 44);

	const parsed = parseCapabilityProbeReply(reply);
	assert.equal(parsed.osVersion, 'V1.11H');
	assert.equal(parsed.hwVersion, '1.00');
	assert.equal(parsed.fwVersion, '1.10E');
	assert.equal(parsed.osBuild, '12345678');
	assert.equal(parsed.fwBuild, '87654321');
});
