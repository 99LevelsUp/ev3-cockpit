/**
 * The runtime on Linux builds Bluetooth through BlueZ (step-7 plan, the U8 wiring note), and hands
 * a refusal by the bus policy to the extension as an offer it can show (owner decision D4, U8
 * review #11). The system bus is a fake: a unit test talks to no daemon.
 */

import assert from 'assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { createRuntime } from '../runtime/createRuntime';
import type { BluetoothAccessFix } from '../transports/bluezAccess';
import type { BluezBus } from '../transports/bluezBluetooth';
import { programPresetSettingsFromPackage, telemetrySettingsFromPackage, throttleSettingsFromPackage } from '../telemetry/telemetrySettings';
import { waitFor } from './waitFor';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as unknown;
const settings = {
	telemetrySettings: telemetrySettingsFromPackage(manifest),
	throttleSettings: throttleSettingsFromPackage(manifest),
	programPreset: programPresetSettingsFromPackage(manifest),
};

/** A system bus whose policy refuses this user every call, as on a distribution limiting BlueZ to a group. */
function refusingBus(): BluezBus {
	// Required here, not imported: the D-Bus client is what this test is about to see loaded.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { DBusError } = require('../transports/dbus/connection') as typeof import('../transports/dbus/connection');
	const denied = (): Promise<never> => Promise.reject(new DBusError('org.freedesktop.DBus.Error.AccessDenied', 'Rejected send message'));
	return {
		call: denied,
		addMatch: denied,
		onSignal: () => () => { /* nothing to remove */ },
		onClose: () => () => { /* nothing to remove */ },
		exportObject: () => () => { /* nothing to withdraw */ },
		close: () => { /* nothing open */ },
	} as unknown as BluezBus;
}

describe('The runtime on Linux (step-7 plan, U8 wiring note)', () => {
	it('builds Bluetooth through BlueZ and offers the group fix when the bus refuses this user (D4)', async () => {
		const lines: string[] = [];
		const offers: BluetoothAccessFix[] = [];
		let opens = 0;
		const runtime = createRuntime({
			extensionPath: '.', log: { ...quiet, info: (m: string) => { lines.push(m); } }, startPresence: false,
			platform: 'linux', ...settings,
			bluezForTests: { openBus: () => { opens += 1; return Promise.resolve(refusingBus()); }, username: () => 'someone' },
			onBluetoothAccessDenied: (fix) => { offers.push(fix); },
		});
		try {
			assert.ok(lines.includes('BT transport registered (BlueZ RFCOMM; BlueZ discovery)'), `got ${JSON.stringify(lines)}`);
			await waitFor(() => offers.length > 0, 3000);
			assert.match(offers[0].command, /usermod -aG bluetooth someone/);

			// "Check again" after the user joined the group: Bluetooth starts over on a fresh bus.
			const before = opens;
			await offers[0].checkAgain();
			assert.equal(opens, before + 1);
		} finally {
			runtime.dispose();
		}
	});

	it('does not warn that BlueZ is not ready while it is still being read at start (HOSTC dev host, 14.11.2026)', async () => {
		const warnings: string[] = [];
		const infos: string[] = [];
		const runtime = createRuntime({
			extensionPath: '.', log: { ...quiet, warn: (m: string) => { warnings.push(m); }, info: (m: string) => { infos.push(m); } },
			startPresence: false, platform: 'linux', ...settings,
			// The bus never answers: BlueZ is still being read when the first scan asks for devices.
			bluezForTests: { openBus: () => new Promise<BluezBus>(() => { /* still opening */ }), username: () => 'someone' },
		});
		try {
			await waitFor(() => infos.some((l) => /BlueZ not read yet/.test(l)), 3000);
			assert.deepEqual(warnings.filter((w) => /BT devices unavailable/.test(w)), [], 'a start in progress is not a fault');
		} finally {
			runtime.dispose();
		}
	});

	it('starts Bluetooth presence on Linux too', () => {
		const lines: string[] = [];
		const runtime = createRuntime({
			extensionPath: '.', log: { ...quiet, info: (m: string) => { lines.push(m); } }, startPresence: true,
			platform: 'linux', ...settings,
			bluezForTests: { openBus: () => Promise.resolve(refusingBus()), username: () => 'someone' },
		});
		try {
			assert.ok(lines.some((l) => /^Bluetooth presence started/.test(l)), `got ${JSON.stringify(lines)}`);
		} finally {
			runtime.dispose();
		}
	});
});
