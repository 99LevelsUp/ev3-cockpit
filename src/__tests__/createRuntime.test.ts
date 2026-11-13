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
import { telemetrySettingsFromPackage } from '../telemetry/telemetrySettings';
import { waitFor } from './waitFor';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
/** The declared defaults, as an installed extension gets them when nobody changed a setting. */
const telemetrySettings = telemetrySettingsFromPackage(
	JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as unknown);

describe('createRuntime', () => {
	it('wires discovery to the brick layer: a discovered mock brick signs in and answers', async () => {
		const runtime = createRuntime({
			extensionPath: '.',
			log: quiet,
			startPresence: false,
			telemetrySettings,
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

	it('runs telemetry in the shipped wiring: a signed-in mock brick fills the read model, and signing out clears it (U6)', async () => {
		const lines: string[] = [];
		const log = { ...quiet, info: (message: string) => { lines.push(message); } };
		const runtime = createRuntime({
			extensionPath: '.', log, startPresence: false, telemetrySettings,
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

	it('builds no Bluetooth pairing or presence when the providers are injected', () => {
		const runtime = createRuntime({ extensionPath: '.', log: quiet, startPresence: false, telemetrySettings, providers: [] });
		assert.equal(runtime.btDiscovery, undefined);
		assert.equal(runtime.btPresence, undefined);
		runtime.dispose();
	});

	it('gives the brick layer Windows\' side of a pairing, so the one-sided check can run (step-4 plan, U7)', () => {
		const runtime = createRuntime({ extensionPath: '.', log: quiet, startPresence: false, telemetrySettings, providers: [] });
		// Absent, the check is silently off: nothing else in the product would show it.
		assert.ok((runtime.bricks as unknown as { windowsPairing?: unknown }).windowsPairing, 'the check has no source');
		runtime.dispose();
	});
});
