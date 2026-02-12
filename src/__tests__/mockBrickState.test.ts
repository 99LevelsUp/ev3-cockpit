import assert from 'node:assert/strict';
import test from 'node:test';
import { MockBrickState } from '../mock/state/mockBrickState';
import type { MockBrickConfig } from '../mock/mockTypes';

const BASE_CONFIG: MockBrickConfig = {
	name: 'TestEV3',
	firmwareVersion: 'V1.10E',
	batteryVoltage: 8.0,
	batteryCurrent: 0.2,
	batteryDrainRate: 0,
	volume: 50,
	sleepMinutes: 30
};

test('constructor initializes from config', () => {
	const b = new MockBrickState(BASE_CONFIG);
	assert.equal(b.getName(), 'TestEV3');
	assert.equal(b.getFirmwareVersion(), 'V1.10E');
	assert.equal(b.getBatteryVoltage(), 8.0);
	assert.equal(b.getBatteryCurrent(), 0.2);
	assert.equal(b.getVolume(), 50);
	assert.equal(b.getSleepMinutes(), 30);
	assert.equal(b.getLedPattern(), 1); // default green
	assert.equal(b.getButtonPress(), 0);
});

test('setName truncates to 12 chars', () => {
	const b = new MockBrickState(BASE_CONFIG);
	b.setName('VeryLongBrickName');
	assert.equal(b.getName(), 'VeryLongBric');
});

test('setVolume clamps to 0..100', () => {
	const b = new MockBrickState(BASE_CONFIG);
	b.setVolume(120);
	assert.equal(b.getVolume(), 100);
	b.setVolume(-5);
	assert.equal(b.getVolume(), 0);
});

test('setSleepMinutes clamps to >= 0', () => {
	const b = new MockBrickState(BASE_CONFIG);
	b.setSleepMinutes(-10);
	assert.equal(b.getSleepMinutes(), 0);
	b.setSleepMinutes(60);
	assert.equal(b.getSleepMinutes(), 60);
});

test('setLedPattern changes LED', () => {
	const b = new MockBrickState(BASE_CONFIG);
	b.setLedPattern(5);
	assert.equal(b.getLedPattern(), 5);
});

test('tick drains battery when drainRate > 0', () => {
	const b = new MockBrickState({ ...BASE_CONFIG, batteryDrainRate: 1.0 });
	// 1.0 V/hour, tick 3600000ms = 1 hour → drain 1.0V
	b.tick(3_600_000);
	assert.ok(Math.abs(b.getBatteryVoltage() - 7.0) < 0.001, `expected ~7.0, got ${b.getBatteryVoltage()}`);
});

test('tick does not drain when drainRate is 0', () => {
	const b = new MockBrickState(BASE_CONFIG);
	b.tick(10_000_000);
	assert.equal(b.getBatteryVoltage(), 8.0);
});

test('battery voltage never goes below 0', () => {
	const b = new MockBrickState({ ...BASE_CONFIG, batteryVoltage: 0.1, batteryDrainRate: 10 });
	b.tick(3_600_000); // would drain 10V, but capped at 0
	assert.equal(b.getBatteryVoltage(), 0);
});

test('setButtonPress stores button value', () => {
	const b = new MockBrickState(BASE_CONFIG);
	b.setButtonPress(0x10);
	assert.equal(b.getButtonPress(), 0x10);
});
