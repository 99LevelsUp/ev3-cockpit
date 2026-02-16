import assert from 'node:assert/strict';
import test from 'node:test';
import { BrickTelemetryStore } from '../device/brickTelemetryStore';
import type { SensorInfo } from '../device/sensorTypes';
import type { MotorState } from '../device/motorTypes';
import type { ButtonState } from '../device/buttonService';
import type { LedPattern } from '../device/ledService';

test('getSnapshot returns undefined for unknown brick', () => {
	const store = new BrickTelemetryStore();
	assert.equal(store.getSnapshot('unknown'), undefined);
});

test('update first time returns true and stores data', () => {
	const store = new BrickTelemetryStore();
	const changed = store.update('brick-1', { sensors: [] });
	assert.equal(changed, true);
	const snap = store.getSnapshot('brick-1');
	assert.ok(snap);
	assert.equal(snap.brickId, 'brick-1');
});

test('update with same data returns false', () => {
	const store = new BrickTelemetryStore();
	const sensor: SensorInfo = { port: 0, typeCode: 16, mode: 0, connected: true, typeName: 'EV3-Touch' };
	const motor: MotorState = { port: 'A', speed: 0, running: false };
	const button: ButtonState = { pressedButton: 0, buttonName: 'NONE', timestampMs: 100 };
	const led: LedPattern = 1;

	store.update('brick-1', { sensors: [sensor], motors: [motor], button, led });
	const second = store.update('brick-1', { sensors: [sensor], motors: [motor], button, led });
	assert.equal(second, false);
});

test('update with changed sensor data returns true', () => {
	const store = new BrickTelemetryStore();
	const s1: SensorInfo = { port: 0, typeCode: 16, mode: 0, connected: true, typeName: 'EV3-Touch' };
	store.update('brick-1', { sensors: [s1] });

	const s2: SensorInfo = { port: 0, typeCode: 16, mode: 1, connected: true, typeName: 'EV3-Touch' };
	const changed = store.update('brick-1', { sensors: [s2] });
	assert.equal(changed, true);
});

test('update with changed led pattern returns true', () => {
	const store = new BrickTelemetryStore();
	store.update('brick-1', { led: 1 });
	const changed = store.update('brick-1', { led: 2 });
	assert.equal(changed, true);
});

test('getSensorInfo returns sensors from snapshot', () => {
	const store = new BrickTelemetryStore();
	const sensor: SensorInfo = { port: 1, typeCode: 29, mode: 0, connected: true, typeName: 'EV3-Color' };
	store.update('brick-1', { sensors: [sensor] });
	const sensors = store.getSensorInfo('brick-1');
	assert.ok(sensors);
	assert.equal(sensors.length, 1);
	assert.equal(sensors[0].typeName, 'EV3-Color');
});

test('getMotorInfo returns motors from snapshot', () => {
	const store = new BrickTelemetryStore();
	const motor: MotorState = { port: 'B', speed: 50, running: true };
	store.update('brick-1', { motors: [motor] });
	const motors = store.getMotorInfo('brick-1');
	assert.ok(motors);
	assert.equal(motors.length, 1);
	assert.equal(motors[0].port, 'B');
});

test('getButtonState returns button from snapshot', () => {
	const store = new BrickTelemetryStore();
	const button: ButtonState = { pressedButton: 2, buttonName: 'ENTER', timestampMs: 500 };
	store.update('brick-1', { button });
	const result = store.getButtonState('brick-1');
	assert.ok(result);
	assert.equal(result.pressedButton, 2);
});

test('getLedPattern returns led from snapshot', () => {
	const store = new BrickTelemetryStore();
	store.update('brick-1', { led: 3 });
	assert.equal(store.getLedPattern('brick-1'), 3);
});

test('pruneMissing removes stale entries', () => {
	const store = new BrickTelemetryStore();
	store.update('brick-1', { led: 1 });
	store.update('brick-2', { led: 2 });
	store.pruneMissing(new Set(['brick-1']));
	assert.ok(store.getSnapshot('brick-1'));
	assert.equal(store.getSnapshot('brick-2'), undefined);
});

test('pruneMissing keeps valid entries', () => {
	const store = new BrickTelemetryStore();
	store.update('a', { led: 0 });
	store.update('b', { led: 1 });
	store.pruneMissing(new Set(['a', 'b']));
	assert.ok(store.getSnapshot('a'));
	assert.ok(store.getSnapshot('b'));
});
