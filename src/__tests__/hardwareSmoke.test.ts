import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
	resolveEmergencyStopCheckFromEnv,
	resolveReconnectDriverDropCheckFromEnv,
	resolveReconnectGlitchCheckFromEnv,
	resolveReconnectCheckFromEnv,
	isLikelyUnavailableError,
	resolveHardwareTransportsFromEnv,
	resolveRunProgramSpecFromEnv
} from '../hw/hardwareSmoke';

test('hardware smoke classifies unavailable USB errors', () => {
	assert.equal(isLikelyUnavailableError('usb', new Error('No EV3 USB HID device found.')), true);
	assert.equal(isLikelyUnavailableError('usb', new Error('Request execution failed: could not read from HID device.')), true);
	assert.equal(isLikelyUnavailableError('usb', new Error('Probe reply command mismatch.')), false);
});

test('hardware smoke classifies unavailable TCP errors', () => {
	assert.equal(isLikelyUnavailableError('tcp', new Error('UDP discovery timeout after 1500ms.')), true);
	assert.equal(isLikelyUnavailableError('tcp', new Error('Unexpected capability reply type.')), false);
});

test('hardware smoke classifies unavailable Bluetooth errors', () => {
	assert.equal(isLikelyUnavailableError('bluetooth', new Error('Opening COM4: Unknown error code 121')), true);
	assert.equal(isLikelyUnavailableError('bluetooth', new Error('Probe reply returned status 0x2.')), false);
});

test('hardware smoke resolves remote run-program spec from ev3:// URI', () => {
	const resolution = resolveRunProgramSpecFromEnv({
		EV3_COCKPIT_HW_RUN_RBF_PATH: 'ev3://active/home/root/lms2012/prjs/Empty/Empty.rbf'
	});
	assert.equal(resolution.error, undefined);
	assert.ok(resolution.spec);
	assert.equal(resolution.spec.mode, 'remote');
	assert.equal(resolution.spec.remotePath, '/home/root/lms2012/prjs/Empty/Empty.rbf');
});

test('hardware smoke resolves fixture-upload run-program spec', () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-cockpit-hw-fixture-'));
	try {
		const fixturePath = path.join(tempDir, 'fixture.rbf');
		fs.writeFileSync(fixturePath, Buffer.from([0x01, 0x02, 0x03]));

		const resolution = resolveRunProgramSpecFromEnv({
			EV3_COCKPIT_HW_RUN_RBF_FIXTURE: fixturePath,
			EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH: '/home/root/lms2012/prjs/Temp/Fixture.rbf'
		});
		assert.equal(resolution.error, undefined);
		assert.ok(resolution.spec);
		assert.equal(resolution.spec.mode, 'fixture-upload');
		assert.equal(resolution.spec.localFixturePath, fixturePath);
		assert.equal(resolution.spec.remotePath, '/home/root/lms2012/prjs/Temp/Fixture.rbf');
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('hardware smoke resolves fixture-upload auto fixture', () => {
	const resolution = resolveRunProgramSpecFromEnv({
		EV3_COCKPIT_HW_RUN_RBF_FIXTURE: 'auto'
	});
	assert.equal(resolution.error, undefined);
	assert.ok(resolution.spec);
	assert.equal(resolution.spec.mode, 'fixture-upload');
	assert.equal(resolution.spec.localFixturePath, undefined);
	assert.ok(resolution.spec.fixtureBytes);
	assert.equal(resolution.spec.fixtureBytes?.length, 176);
	assert.match(resolution.spec.fixtureSource ?? '', /^embedded:/);
});

test('hardware smoke transport selection defaults to all in fixed order', () => {
	const selection = resolveHardwareTransportsFromEnv({});
	assert.deepEqual(selection.transports, ['usb', 'tcp', 'bluetooth']);
	assert.equal(selection.warning, undefined);
});

test('hardware smoke transport selection allows usb+tcp only', () => {
	const selection = resolveHardwareTransportsFromEnv({
		EV3_COCKPIT_HW_TRANSPORTS: 'tcp, usb'
	});
	assert.deepEqual(selection.transports, ['usb', 'tcp']);
	assert.equal(selection.warning, undefined);
});

test('hardware smoke transport selection ignores unknown entries with warning', () => {
	const selection = resolveHardwareTransportsFromEnv({
		EV3_COCKPIT_HW_TRANSPORTS: 'usb,foo'
	});
	assert.deepEqual(selection.transports, ['usb']);
	assert.match(selection.warning ?? '', /ignored unknown transports/i);
});

test('hardware smoke emergency stop check is enabled by default', () => {
	assert.equal(resolveEmergencyStopCheckFromEnv({}), true);
});

test('hardware smoke emergency stop check can be disabled by env', () => {
	assert.equal(resolveEmergencyStopCheckFromEnv({ EV3_COCKPIT_HW_EMERGENCY_STOP_CHECK: '0' }), false);
	assert.equal(resolveEmergencyStopCheckFromEnv({ EV3_COCKPIT_HW_EMERGENCY_STOP_CHECK: 'false' }), false);
});

test('hardware smoke reconnect check is disabled by default', () => {
	assert.equal(resolveReconnectCheckFromEnv({}), false);
});

test('hardware smoke reconnect check can be enabled by env', () => {
	assert.equal(resolveReconnectCheckFromEnv({ EV3_COCKPIT_HW_RECONNECT_CHECK: '1' }), true);
	assert.equal(resolveReconnectCheckFromEnv({ EV3_COCKPIT_HW_RECONNECT_CHECK: 'true' }), true);
});

test('hardware smoke reconnect glitch check is enabled by default', () => {
	assert.equal(resolveReconnectGlitchCheckFromEnv({}), true);
});

test('hardware smoke reconnect glitch check can be disabled by env', () => {
	assert.equal(resolveReconnectGlitchCheckFromEnv({ EV3_COCKPIT_HW_RECONNECT_GLITCH_CHECK: '0' }), false);
	assert.equal(resolveReconnectGlitchCheckFromEnv({ EV3_COCKPIT_HW_RECONNECT_GLITCH_CHECK: 'false' }), false);
});

test('hardware smoke reconnect driver-drop check is disabled by default', () => {
	assert.equal(resolveReconnectDriverDropCheckFromEnv({}), false);
});

test('hardware smoke reconnect driver-drop check can be enabled by env', () => {
	assert.equal(resolveReconnectDriverDropCheckFromEnv({ EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_CHECK: '1' }), true);
	assert.equal(resolveReconnectDriverDropCheckFromEnv({ EV3_COCKPIT_HW_RECONNECT_DRIVER_DROP_CHECK: 'true' }), true);
});
