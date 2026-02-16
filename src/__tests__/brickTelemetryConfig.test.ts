import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readBrickTelemetryConfig, type BrickTelemetryConfigSnapshot } from '../config/brickTelemetryConfig';

const DEFAULTS: BrickTelemetryConfigSnapshot = {
	enabled: true,
	fastDeviceIntervalMs: 500,
	fastValuesIntervalMs: 500,
	mediumIntervalMs: 2_000,
	slowIntervalMs: 15_000,
	extraSlowIntervalMs: 60_000,
	staticIntervalMs: 0,
	fsDepth: 1,
	fsMaxEntries: 250,
	fsBatchSize: 25,
	queueLimitSlow: 10,
	queueLimitMedium: 20,
	queueLimitInactiveFast: 35
};

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-telemetry-test-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: string): void {
	const configDir = path.join(tmpDir, 'config');
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, 'brick-telemetry.json'), content, 'utf8');
}

test('returns defaults when config file is missing', () => {
	const result = readBrickTelemetryConfig(tmpDir);
	assert.deepStrictEqual(result, DEFAULTS);
});

test('returns defaults when config file is invalid JSON', () => {
	writeConfig('not valid json {{{');
	const result = readBrickTelemetryConfig(tmpDir);
	assert.deepStrictEqual(result, DEFAULTS);
});

test('returns defaults when config file is a JSON array', () => {
	writeConfig('[1, 2, 3]');
	const result = readBrickTelemetryConfig(tmpDir);
	assert.deepStrictEqual(result, DEFAULTS);
});

test('parses valid config with all fields', () => {
	const config = {
		enabled: false,
		fastDeviceIntervalMs: 300,
		fastValuesIntervalMs: 400,
		mediumIntervalMs: 1_000,
		slowIntervalMs: 5_000,
		extraSlowIntervalMs: 10_000,
		staticIntervalMs: 100,
		fsDepth: 3,
		fsMaxEntries: 500,
		fsBatchSize: 50,
		queueLimitSlow: 5,
		queueLimitMedium: 15,
		queueLimitInactiveFast: 25
	};
	writeConfig(JSON.stringify(config));
	const result = readBrickTelemetryConfig(tmpDir);
	assert.deepStrictEqual(result, {
		enabled: false,
		fastDeviceIntervalMs: 300,
		fastValuesIntervalMs: 400,
		mediumIntervalMs: 1_000,
		slowIntervalMs: 5_000,
		extraSlowIntervalMs: 10_000,
		staticIntervalMs: 100,
		fsDepth: 3,
		fsMaxEntries: 500,
		fsBatchSize: 50,
		queueLimitSlow: 5,
		queueLimitMedium: 15,
		queueLimitInactiveFast: 25
	});
});

test('clamps below-minimum values to minimums', () => {
	const config = {
		enabled: true,
		fastDeviceIntervalMs: 1,
		fastValuesIntervalMs: 1,
		mediumIntervalMs: 1,
		slowIntervalMs: 1,
		extraSlowIntervalMs: 1,
		staticIntervalMs: -10,
		fsDepth: -1,
		fsMaxEntries: -1,
		fsBatchSize: 0,
		queueLimitSlow: -5,
		queueLimitMedium: -5,
		queueLimitInactiveFast: -5
	};
	writeConfig(JSON.stringify(config));
	const result = readBrickTelemetryConfig(tmpDir);
	assert.equal(result.enabled, true);
	assert.equal(result.fastDeviceIntervalMs, 150);
	assert.equal(result.fastValuesIntervalMs, 150);
	assert.equal(result.mediumIntervalMs, 500);
	assert.equal(result.slowIntervalMs, 2_000);
	assert.equal(result.extraSlowIntervalMs, 5_000);
	assert.equal(result.staticIntervalMs, 0);
	assert.equal(result.fsDepth, 0);
	assert.equal(result.fsMaxEntries, 0);
	assert.equal(result.fsBatchSize, 1);
	assert.equal(result.queueLimitSlow, 0);
	assert.equal(result.queueLimitMedium, 0);
	assert.equal(result.queueLimitInactiveFast, 0);
});

test('handles partial config – missing fields get defaults', () => {
	const config = { enabled: false, fsDepth: 5 };
	writeConfig(JSON.stringify(config));
	const result = readBrickTelemetryConfig(tmpDir);
	assert.equal(result.enabled, false);
	assert.equal(result.fsDepth, 5);
	assert.equal(result.fastDeviceIntervalMs, DEFAULTS.fastDeviceIntervalMs);
	assert.equal(result.slowIntervalMs, DEFAULTS.slowIntervalMs);
	assert.equal(result.fsBatchSize, DEFAULTS.fsBatchSize);
	assert.equal(result.queueLimitInactiveFast, DEFAULTS.queueLimitInactiveFast);
});
