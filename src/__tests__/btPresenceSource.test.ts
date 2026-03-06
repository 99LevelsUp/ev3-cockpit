import assert from 'node:assert/strict';
import test from 'node:test';
import { BtPresenceSource } from '../presence/btPresenceSource';
import { TransportMode } from '../types/enums';

function createNoopLogger() {
	const noop = () => {};
	return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

function safeId(v: string): string {
	return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

test('BtPresenceSource has BT transport', () => {
	const source = new BtPresenceSource(
		{ fastIntervalMs: 1000, inquiryIntervalMs: 30000, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	assert.equal(source.transport, TransportMode.BT);
});

test('BtPresenceSource starts with empty map', () => {
	const source = new BtPresenceSource(
		{ fastIntervalMs: 1000, inquiryIntervalMs: 30000, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	assert.equal(source.getPresent().size, 0);
});

test('BtPresenceSource stop is idempotent', () => {
	const source = new BtPresenceSource(
		{ fastIntervalMs: 1000, inquiryIntervalMs: 30000, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	source.stop();
	source.stop();
});

test('BtPresenceSource onChange registers callback', () => {
	const source = new BtPresenceSource(
		{ fastIntervalMs: 1000, inquiryIntervalMs: 30000, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	let called = false;
	source.onChange(() => { called = true; });
	assert.equal(called, false);
});
