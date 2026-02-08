import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHardwareSmokeOutput, parseScenarioIds } from '../hw/hardwareMatrix';

test('hardware matrix parser extracts case rows and summary counts', () => {
	const output = `
[HW] Running hardware smoke tests in order: usb -> tcp -> bluetooth
[HW][USB] PASS Connect probe succeeded. {"path":"auto"}
[HW][TCP] SKIP TCP transport unavailable (UDP discovery timeout after 1500ms.)
[HW][BLUETOOTH] FAIL Opening COM4: Unknown error code 1256
[HW] Summary: PASS=1 SKIP=1 FAIL=1
`;
	const parsed = parseHardwareSmokeOutput(output);
	assert.equal(parsed.summary.pass, 1);
	assert.equal(parsed.summary.skip, 1);
	assert.equal(parsed.summary.fail, 1);
	assert.equal(parsed.results.length, 3);
	assert.equal(parsed.results[0].transport, 'usb');
	assert.equal(parsed.results[0].status, 'PASS');
	assert.equal(parsed.results[0].detail?.path, 'auto');
	assert.equal(parsed.results[1].transport, 'tcp');
	assert.equal(parsed.results[1].status, 'SKIP');
	assert.equal(parsed.results[2].transport, 'bluetooth');
	assert.equal(parsed.results[2].status, 'FAIL');
});

test('hardware matrix parser derives summary when summary line is missing', () => {
	const output = `
[HW][USB] PASS Connect probe succeeded.
[HW][TCP] SKIP TCP transport unavailable.
[HW][BLUETOOTH] SKIP Bluetooth transport unavailable.
`;
	const parsed = parseHardwareSmokeOutput(output);
	assert.equal(parsed.summary.pass, 1);
	assert.equal(parsed.summary.skip, 2);
	assert.equal(parsed.summary.fail, 0);
});

test('hardware matrix scenario parser keeps default order and ignores unknown values', () => {
	assert.deepEqual(parseScenarioIds(undefined), ['baseline', 'reconnect', 'reconnect-glitch']);
	assert.deepEqual(parseScenarioIds('reconnect,foo,baseline'), ['baseline', 'reconnect']);
	assert.deepEqual(parseScenarioIds('driver-drop,reconnect'), ['reconnect', 'driver-drop']);
	assert.deepEqual(parseScenarioIds('foo,bar'), ['baseline', 'reconnect', 'reconnect-glitch']);
});
