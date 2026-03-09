import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelemetryTaskDefinitions } from '../device/telemetryTaskRuntime.js';

const config = {
	fastDeviceIntervalMs: 100,
	fastValuesIntervalMs: 200,
	mediumIntervalMs: 300,
	slowIntervalMs: 400,
	extraSlowIntervalMs: 500,
	staticIntervalMs: 600,
	queueLimitSlow: 9,
	queueLimitMedium: 7,
	queueLimitInactiveFast: 5
};

function findTask(key: string) {
	const task = createTelemetryTaskDefinitions(config).find((candidate) => candidate.key === key);
	assert.ok(task, `Missing telemetry task definition for ${key}`);
	return task;
}

test('createTelemetryTaskDefinitions preserves task intervals and order', () => {
	const tasks = createTelemetryTaskDefinitions(config);

	assert.deepEqual(
		tasks.map((task) => task.key),
		['static', 'fastDevices', 'fastValues', 'medium', 'slow', 'extraSlow']
	);
	assert.equal(tasks[0]?.intervalMs, 600);
	assert.equal(tasks[1]?.intervalMs, 100);
	assert.equal(tasks[2]?.intervalMs, 200);
	assert.equal(tasks[3]?.intervalMs, 300);
	assert.equal(tasks[4]?.intervalMs, 400);
	assert.equal(tasks[5]?.intervalMs, 500);
	assert.ok(tasks.every((task) => task.errorHandling === 'isolate'));
});

test('fast telemetry tasks elevate active bricks and throttle inactive ones', () => {
	const fastDevices = findTask('fastDevices');
	const fastValues = findTask('fastValues');

	assert.equal(fastDevices.resolveLane(true), 'high');
	assert.equal(fastDevices.resolveLane(false), 'normal');
	assert.equal(fastValues.resolveLane(true), 'high');
	assert.equal(fastValues.resolveLane(false), 'normal');
	assert.equal(fastDevices.shouldSkip(false, 5), true);
	assert.equal(fastDevices.shouldSkip(false, 4), false);
	assert.equal(fastDevices.shouldSkip(true, 999), false);
	assert.equal(fastValues.shouldSkip(false, 5), true);
});

test('medium and slow telemetry tasks respect queue thresholds', () => {
	const medium = findTask('medium');
	const slow = findTask('slow');
	const extraSlow = findTask('extraSlow');
	const staticTask = findTask('static');

	assert.equal(medium.resolveLane(true), 'normal');
	assert.equal(medium.resolveLane(false), 'low');
	assert.equal(medium.shouldSkip(true, 7), true);
	assert.equal(medium.shouldSkip(true, 6), false);
	assert.equal(slow.resolveLane(true), 'low');
	assert.equal(slow.shouldSkip(true, 9), true);
	assert.equal(slow.shouldSkip(false, 8), false);
	assert.equal(extraSlow.shouldSkip(true, 9), true);
	assert.equal(staticTask.resolveLane(true), 'low');
	assert.equal(staticTask.shouldSkip(true, Number.MAX_SAFE_INTEGER), false);
});
