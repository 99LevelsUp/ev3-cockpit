import assert from 'node:assert/strict';
import test from 'node:test';
import { UsbPresenceSource } from '../presence/usbPresenceSource';
import { TransportMode } from '../types/enums';

function createNoopLogger() {
	const noop = () => {};
	return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

function safeId(v: string): string {
	return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

test('UsbPresenceSource has USB transport', () => {
	const source = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	assert.equal(source.transport, TransportMode.USB);
});

test('UsbPresenceSource starts with empty map', () => {
	const source = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	assert.equal(source.getPresent().size, 0);
});

test('UsbPresenceSource stop is idempotent', () => {
	const source = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	source.stop();
	source.stop();
});

test('UsbPresenceSource onChange registers callback', () => {
	const source = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: safeId },
		createNoopLogger()
	);
	let called = false;
	source.onChange(() => { called = true; });
	assert.equal(called, false);
});
