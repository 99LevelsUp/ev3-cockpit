/**
 * Which Bluetooth the runtime builds on which host (step-7 plan, the U8 wiring note).
 *
 * Windows keeps its Winsock, bthprops and helper wiring, and must not load the Linux D-Bus client
 * or BlueZ at all (U8 review #7): an import that pulled them in would load code a Windows user never
 * runs. Linux builds BlueZ through `createBluezBluetooth`. Each case is checked in `require.cache`,
 * which this file's own process owns: node:test runs every test file in a process of its own.
 */

import assert from 'assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { createRuntime } from '../runtime/createRuntime';
import { programPresetSettingsFromPackage, telemetrySettingsFromPackage, throttleSettingsFromPackage } from '../telemetry/telemetrySettings';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as unknown;
const settings = {
	telemetrySettings: telemetrySettingsFromPackage(manifest),
	throttleSettings: throttleSettingsFromPackage(manifest),
	programPreset: programPresetSettingsFromPackage(manifest),
};

/** The Linux-only modules: the BlueZ pieces and the D-Bus client under them. */
const linuxOnly = (): string[] => Object.keys(require.cache)
	.filter((file) => /[\\/]transports[\\/](bluez\w*|linuxBluetoothSocket|dbus[\\/]\w+)\.js$/.test(file));

describe('The runtime\'s Bluetooth, per host (step-7 plan, U8 wiring note)', () => {
	it('loads no BlueZ or D-Bus module when the runtime is imported (U8 review #7)', () => {
		assert.deepEqual(linuxOnly(), []);
	});

	it('wires Windows without loading any of them either (U8 review #7)', () => {
		const lines: string[] = [];
		const runtime = createRuntime({
			extensionPath: '.', log: { ...quiet, info: (m: string) => { lines.push(m); } }, startPresence: false,
			platform: 'win32', ...settings,
		});
		try {
			assert.ok(lines.some((l) => /^BT transport registered \(Winsock RFCOMM/.test(l)), `got ${JSON.stringify(lines)}`);
			assert.deepEqual(linuxOnly(), [], 'a Windows wiring loads nothing of the Linux backend');
		} finally {
			runtime.dispose();
		}
	});
});
