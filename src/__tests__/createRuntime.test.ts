/**
 * The runtime the extension and the hardware harness both build (step-2 plan, U9, KTD9).
 */

import assert from 'assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { Transport, makeBrickKey, brickIdOf } from '../contracts';
import { MockTransportProvider, DEFAULT_MOCK_CONFIG } from '../mock';
import { createRuntime } from '../runtime/createRuntime';
import { createBrickFilesystem } from '../fs/brickFilesystem';
import { ActivityMode } from '../contracts/enums';
import { programPresetSettingsFromPackage, telemetrySettingsFromPackage, throttleSettingsFromPackage } from '../telemetry/telemetrySettings';
import { waitFor } from './waitFor';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
/** The declared defaults, as an installed extension gets them when nobody changed a setting. */
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as unknown;
const telemetrySettings = telemetrySettingsFromPackage(manifest);
const throttleSettings = throttleSettingsFromPackage(manifest);
const programPreset = programPresetSettingsFromPackage(manifest);

describe('createRuntime', () => {
	it('wires discovery to the brick layer: a discovered mock brick signs in and answers', async () => {
		const runtime = createRuntime({
			extensionPath: '.',
			log: quiet,
			startPresence: false,
			telemetrySettings, throttleSettings, programPreset,
			providers: [new MockTransportProvider(DEFAULT_MOCK_CONFIG)],
		});
		try {
			const marvin = brickIdOf(makeBrickKey(Transport.Mock, 'marvin'));
			await waitFor(() => runtime.aggregator.getBrick(marvin) !== undefined, 2000);

			await runtime.bricks.signIn(marvin);
			assert.equal(runtime.bricks.getActiveBrickId(), marvin);

			const usage = await createBrickFilesystem(runtime.bricks, marvin).files.storage();
			assert.deepEqual(usage, { totalKb: 6000, freeKb: 4000 });
		} finally {
			runtime.dispose();
		}
	});

	it('logs each failed reconnect attempt with its reason and the next try (U10, 13.11.2026)', async () => {
		const warnings: string[] = [];
		const log = { ...quiet, warn: (message: string) => { warnings.push(message); } };
		const mock = new MockTransportProvider(DEFAULT_MOCK_CONFIG);
		const runtime = createRuntime({
			extensionPath: '.', log, startPresence: false, telemetrySettings, throttleSettings, programPreset,
			providers: [mock],
		});
		try {
			const marvin = brickIdOf(makeBrickKey(Transport.Mock, 'marvin'));
			await waitFor(() => runtime.aggregator.getBrick(marvin) !== undefined, 2000);
			await runtime.bricks.signIn(marvin);

			// As the real transports: no `recover`, and the brick does not come back.
			(mock as { recover?: unknown }).recover = undefined;
			mock.disconnect = () => Promise.resolve();
			mock.connect = () => Promise.reject(new Error('BT connect failed (WSA error 10060).'));
			runtime.sessionManager['handleHeartbeatFailure'](makeBrickKey(Transport.Mock, 'marvin'), new Error('link went away'));

			await waitFor(() => warnings.some((w) => /reconnect attempt 1 failed/.test(w)), 5000);
			const line = warnings.find((w) => /reconnect attempt 1 failed/.test(w)) ?? '';
			assert.match(line, /^Session: .*marvin.* reconnect attempt 1 failed: BT connect failed \(WSA error 10060\)\.; next try in \d/i);
		} finally {
			runtime.dispose();
		}
	});

	it('runs telemetry in the shipped wiring: a signed-in mock brick fills the read model, and signing out clears it (U6)', async () => {
		const lines: string[] = [];
		const log = { ...quiet, info: (message: string) => { lines.push(message); } };
		const runtime = createRuntime({
			extensionPath: '.', log, startPresence: false, telemetrySettings, throttleSettings, programPreset,
			providers: [new MockTransportProvider(DEFAULT_MOCK_CONFIG)],
		});
		try {
			const marvin = brickIdOf(makeBrickKey(Transport.Mock, 'marvin'));
			await waitFor(() => runtime.aggregator.getBrick(marvin) !== undefined, 2000);

			await runtime.bricks.signIn(marvin);

			assert.equal(runtime.telemetry.modeOf(marvin), ActivityMode.Foreground);
			// Read from the mock's interpreted frames (U3): the whole path, frame to read model.
			await waitFor(() => typeof runtime.telemetryView.valueOf(marvin, 'system.firmwareVersion')?.value === 'string', 3000);
			await waitFor(() => runtime.telemetryView.valueOf(marvin, 'ports.motor.A.tacho') !== undefined, 3000);
			assert.ok(lines.some((line) => /^Telemetry: .* (foreground|read)/.test(line)), `no telemetry line in ${JSON.stringify(lines)}`);

			await runtime.bricks.signOut(marvin);
			assert.deepEqual(runtime.telemetryView.snapshot(marvin), []);
			assert.equal(runtime.telemetry.modeOf(marvin), ActivityMode.None);
		} finally {
			runtime.dispose();
		}
	});

	it('slows a brick\'s telemetry while its program runs, through the shipped wiring (U9, D11)', async () => {
		const prg = '/home/root/lms2012/prjs/Demo/Demo.rbf';
		const mock = new MockTransportProvider({
			transport: Transport.Mock,
			bricks: [{
				id: 'demo', displayName: 'Demo', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
				filesystem: [{ path: prg, content: 'LEGO-rbf-image' }],
			}],
		} as never);
		const runtime = createRuntime({
			extensionPath: '.', log: quiet, startPresence: false, telemetrySettings, throttleSettings, programPreset,
			providers: [mock],
		});
		try {
			const demo = brickIdOf(makeBrickKey(Transport.Mock, 'demo'));
			await waitFor(() => runtime.aggregator.getBrick(demo) !== undefined, 2000);
			await runtime.bricks.signIn(demo);
			assert.equal(runtime.telemetry.loopFor(demo)?.tickPeriodMs, 100);

			await runtime.bricks.send(demo, { kind: 'program:run', path: prg });
			await waitFor(() => runtime.telemetry.loopFor(demo)?.tickPeriodMs === programPreset.programRunningTickMs, 3000);

			await runtime.bricks.send(demo, { kind: 'program:stop' });
			await waitFor(() => runtime.telemetry.loopFor(demo)?.tickPeriodMs === 100, 3000);
		} finally {
			runtime.dispose();
		}
	});

	it('builds no Bluetooth pairing or presence when the providers are injected', () => {
		const runtime = createRuntime({ extensionPath: '.', log: quiet, startPresence: false, telemetrySettings, throttleSettings, programPreset, providers: [] });
		assert.equal(runtime.btDiscovery, undefined);
		assert.equal(runtime.btPresence, undefined);
		runtime.dispose();
	});

	it('gives the brick layer Windows\' side of a pairing, so the one-sided check can run (step-4 plan, U7)', () => {
		const runtime = createRuntime({ extensionPath: '.', log: quiet, startPresence: false, telemetrySettings, throttleSettings, programPreset, providers: [] });
		// Absent, the check is silently off: nothing else in the product would show it.
		assert.ok((runtime.bricks as unknown as { windowsPairing?: unknown }).windowsPairing, 'the check has no source');
		runtime.dispose();
	});
});
