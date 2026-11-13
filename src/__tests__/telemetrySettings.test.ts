/**
 * The stale settings (owner decision D9): user settings whose only defaults live in package.json.
 * The code holds no value of its own; a value out of range falls back to the declared default.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { readTelemetrySettings, telemetrySettingsFromPackage } from '../telemetry/telemetrySettings';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as unknown;

/** A settings section as VS Code's `getConfiguration('ev3-cockpit')` presents it. */
function section(values: Record<string, unknown>, defaults: Record<string, unknown>) {
	return {
		get: <T>(key: string): T | undefined => (key in values ? values[key] : defaults[key]) as T | undefined,
		inspect: <T>(key: string) => ({ defaultValue: defaults[key] as T | undefined }),
	};
}
const DECLARED = { 'telemetry.staleFactor': 3, 'telemetry.staleTimeoutMs': 10000 };

describe('telemetry settings (D9)', () => {
	it('declares its defaults in package.json, and nowhere else', () => {
		assert.deepEqual(telemetrySettingsFromPackage(pkg), { staleFactor: 3, staleTimeoutMs: 10000 });
	});

	it('reads what the user set', () => {
		const warnings: string[] = [];
		const settings = readTelemetrySettings(
			section({ 'telemetry.staleFactor': 5, 'telemetry.staleTimeoutMs': 0 }, DECLARED), (m) => warnings.push(m));

		assert.deepEqual(settings, { staleFactor: 5, staleTimeoutMs: 0 });
		assert.deepEqual(warnings, []);
	});

	it('falls back to the declared default for a value out of range, and says which', () => {
		const warnings: string[] = [];
		const settings = readTelemetrySettings(
			section({ 'telemetry.staleFactor': 0.5, 'telemetry.staleTimeoutMs': 'soon' }, DECLARED), (m) => warnings.push(m));

		assert.deepEqual(settings, { staleFactor: 3, staleTimeoutMs: 10000 });
		assert.equal(warnings.length, 2);
		assert.match(warnings[0], /staleFactor/);
		assert.match(warnings[1], /staleTimeoutMs/);
	});

	it('refuses to run on a package.json that declares no usable default', () => {
		assert.throws(() => readTelemetrySettings(section({}, {}), () => undefined), /staleFactor/);
		assert.throws(() => telemetrySettingsFromPackage({}), /staleFactor/);
	});
});
