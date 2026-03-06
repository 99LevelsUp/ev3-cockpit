import assert from 'node:assert/strict';
import test from 'node:test';
import { TcpPresenceSource } from '../presence/tcpPresenceSource';
import { TransportMode } from '../types/enums';

function createNoopLogger() {
	const noop = () => {};
	return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

test('TcpPresenceSource has TCP transport', () => {
	const source = new TcpPresenceSource(
		{ discoveryPort: 3015, toSafeIdentifier: (v) => v.replace(/[^a-z0-9]+/gi, '-').toLowerCase() },
		createNoopLogger()
	);
	assert.equal(source.transport, TransportMode.TCP);
});

test('TcpPresenceSource starts with empty map', () => {
	const source = new TcpPresenceSource(
		{ discoveryPort: 3015, toSafeIdentifier: (v) => v.replace(/[^a-z0-9]+/gi, '-').toLowerCase() },
		createNoopLogger()
	);
	assert.equal(source.getPresent().size, 0);
});

test('TcpPresenceSource onChange registers callback', () => {
	const source = new TcpPresenceSource(
		{ discoveryPort: 3015, toSafeIdentifier: (v) => v.replace(/[^a-z0-9]+/gi, '-').toLowerCase() },
		createNoopLogger()
	);
	let called = false;
	source.onChange(() => { called = true; });
	// Callback should be registered but not yet called
	assert.equal(called, false);
});

test('TcpPresenceSource stop is idempotent', () => {
	const source = new TcpPresenceSource(
		{ discoveryPort: 3015, toSafeIdentifier: (v) => v.replace(/[^a-z0-9]+/gi, '-').toLowerCase() },
		createNoopLogger()
	);
	// Should not throw
	source.stop();
	source.stop();
});
