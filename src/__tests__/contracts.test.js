const assert = require('assert/strict');
const { describe, it } = require('node:test');

const { Transport, PresenceState, ConnectionState, ActivityMode, TelemetryCategory, makeBrickKey } = require('../contracts/index');
const { CockpitError, ErrorCode, TransportError, ConnectionError, TimeoutError, SessionError, HeartbeatError, ConsumerError, SubscriptionError } = require('../errors/index');

describe('Transport enum', () => {
	it('has all four values', () => {
		assert.equal(Transport.Mock, 'mock');
		assert.equal(Transport.USB, 'usb');
		assert.equal(Transport.TCP, 'tcp');
		assert.equal(Transport.BT, 'bt');
	});
});

describe('PresenceState enum', () => {
	it('has all four states', () => {
		assert.equal(PresenceState.Remembered, 'remembered');
		assert.equal(PresenceState.Available, 'available');
		assert.equal(PresenceState.Unavailable, 'unavailable');
		assert.equal(PresenceState.Removed, 'removed');
	});
});

describe('ConnectionState enum', () => {
	it('has all four states', () => {
		assert.equal(ConnectionState.Connecting, 'connecting');
		assert.equal(ConnectionState.Connected, 'connected');
		assert.equal(ConnectionState.Reconnecting, 'reconnecting');
		assert.equal(ConnectionState.Disconnected, 'disconnected');
	});
});

describe('ActivityMode enum', () => {
	it('has all four modes', () => {
		assert.equal(ActivityMode.Foreground, 'foreground');
		assert.equal(ActivityMode.Subscribed, 'subscribed');
		assert.equal(ActivityMode.Minimal, 'minimal');
		assert.equal(ActivityMode.None, 'none');
	});
});

describe('TelemetryCategory enum', () => {
	it('has all three categories', () => {
		assert.equal(TelemetryCategory.Ports, 'ports');
		assert.equal(TelemetryCategory.Filesystem, 'filesystem');
		assert.equal(TelemetryCategory.System, 'system');
	});
});

describe('makeBrickKey', () => {
	it('formats key as transport:id', () => {
		assert.equal(makeBrickKey(Transport.Mock, 'alpha'), 'mock:alpha');
		assert.equal(makeBrickKey(Transport.USB, 'EV30001'), 'usb:EV30001');
		assert.equal(makeBrickKey(Transport.BT, 'AA:BB:CC:DD:EE:FF'), 'bt:AA:BB:CC:DD:EE:FF');
	});
});

describe('CockpitError', () => {
	it('sets name and code', () => {
		const err = new CockpitError(ErrorCode.TransportFailed, 'test');
		assert.equal(err.name, 'CockpitError');
		assert.equal(err.code, 'transport_failed');
		assert.equal(err.message, 'test');
	});

	it('each subclass has the right name and code', () => {
		const cases = [
			[new TransportError('t'), 'TransportError', ErrorCode.TransportFailed],
			[new ConnectionError('c'), 'ConnectionError', ErrorCode.ConnectionFailed],
			[new TimeoutError('to'), 'TimeoutError', ErrorCode.Timeout],
			[new SessionError('s'), 'SessionError', ErrorCode.SessionFailed],
			[new HeartbeatError('h'), 'HeartbeatError', ErrorCode.HeartbeatFailed],
			[new ConsumerError('co'), 'ConsumerError', ErrorCode.ConsumerFailed],
			[new SubscriptionError('su'), 'SubscriptionError', ErrorCode.SubscriptionFailed],
		];
		for (const [err, name, code] of cases) {
			assert.equal(err.name, name);
			assert.equal(err.code, code);
			assert.ok(err instanceof CockpitError);
		}
	});

	it('stores cause', () => {
		const cause = new Error('root');
		const err = new TransportError('wrap', cause);
		assert.equal(err.cause, cause);
	});
});
