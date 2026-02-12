import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MOCK_CONFIG } from '../mock/defaultSeed';
import type {
	MockWorldConfig,
	MockSensorConfig,
	MockMotorConfig,
	MockFaultConfig,
	MockFsSeedDir,
	ValueGenerator
} from '../mock/mockTypes';

// ---------------------------------------------------------------------------
// Type structure validation
// ---------------------------------------------------------------------------

test('DEFAULT_MOCK_CONFIG has all required top-level keys', () => {
	const cfg: MockWorldConfig = DEFAULT_MOCK_CONFIG;
	assert.ok(Array.isArray(cfg.sensors), 'sensors should be an array');
	assert.ok(Array.isArray(cfg.motors), 'motors should be an array');
	assert.ok(typeof cfg.brick === 'object', 'brick should be an object');
	assert.ok(Array.isArray(cfg.fsSeed), 'fsSeed should be an array');
	assert.ok(typeof cfg.fault === 'object', 'fault should be an object');
});

test('default sensors are valid MockSensorConfig', () => {
	for (const s of DEFAULT_MOCK_CONFIG.sensors) {
		const sensor: MockSensorConfig = s;
		assert.ok(sensor.port >= 0 && sensor.port <= 3, `port ${sensor.port} in range`);
		assert.ok(typeof sensor.typeCode === 'number');
		assert.ok(typeof sensor.mode === 'number');
		assert.ok(typeof sensor.generator === 'object');
		assert.ok(
			['constant', 'sine', 'randomWalk', 'step'].includes(sensor.generator.kind),
			`generator kind "${sensor.generator.kind}" is valid`
		);
	}
});

test('default motors are valid MockMotorConfig', () => {
	for (const m of DEFAULT_MOCK_CONFIG.motors) {
		const motor: MockMotorConfig = m;
		assert.ok(['A', 'B', 'C', 'D'].includes(motor.port), `port ${motor.port} is valid`);
		assert.ok(typeof motor.typeCode === 'number');
		assert.ok(typeof motor.initialPosition === 'number');
	}
});

test('default brick config has expected fields', () => {
	const b = DEFAULT_MOCK_CONFIG.brick;
	assert.ok(b.name.length > 0 && b.name.length <= 12, 'brick name length');
	assert.ok(b.batteryVoltage > 0, 'battery voltage positive');
	assert.ok(b.volume >= 0 && b.volume <= 100, 'volume in range');
	assert.ok(b.sleepMinutes >= 0, 'sleep >= 0');
});

test('default fault config has all rates at zero', () => {
	const f: MockFaultConfig = DEFAULT_MOCK_CONFIG.fault;
	assert.equal(f.errorRate, 0);
	assert.equal(f.latencyMs, 0);
	assert.equal(f.jitterMs, 0);
	assert.equal(f.timeoutRate, 0);
});

test('default fsSeed builds a valid directory tree', () => {
	assert.ok(DEFAULT_MOCK_CONFIG.fsSeed.length > 0, 'fsSeed not empty');
	const root = DEFAULT_MOCK_CONFIG.fsSeed[0] as MockFsSeedDir;
	assert.equal(root.type, 'dir');
	assert.equal(root.name, 'home');
	assert.ok(Array.isArray(root.children));
});

// ---------------------------------------------------------------------------
// ValueGenerator type narrowing
// ---------------------------------------------------------------------------

test('ValueGenerator constant type narrows correctly', () => {
	const g: ValueGenerator = { kind: 'constant', value: 42 };
	if (g.kind === 'constant') {
		assert.equal(g.value, 42);
	} else {
		assert.fail('should be constant');
	}
});

test('ValueGenerator sine type narrows correctly', () => {
	const g: ValueGenerator = { kind: 'sine', min: 0, max: 100, periodMs: 1000 };
	if (g.kind === 'sine') {
		assert.equal(g.min, 0);
		assert.equal(g.max, 100);
		assert.equal(g.periodMs, 1000);
	} else {
		assert.fail('should be sine');
	}
});

test('ValueGenerator randomWalk type narrows correctly', () => {
	const g: ValueGenerator = { kind: 'randomWalk', min: -10, max: 10, stepSize: 0.5 };
	if (g.kind === 'randomWalk') {
		assert.equal(g.stepSize, 0.5);
	} else {
		assert.fail('should be randomWalk');
	}
});

test('ValueGenerator step type narrows correctly', () => {
	const g: ValueGenerator = { kind: 'step', values: [0, 1, 2], intervalMs: 500 };
	if (g.kind === 'step') {
		assert.deepEqual(g.values, [0, 1, 2]);
		assert.equal(g.intervalMs, 500);
	} else {
		assert.fail('should be step');
	}
});
