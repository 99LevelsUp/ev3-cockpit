import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { Transport, PresenceState, ConnectionState, ActivityMode, TelemetryCategory, makeBrickKey, brickKeyTransport, brickKeyId, brickIdOf } from '../contracts/index';
import {
	CockpitError, ErrorCode,
	TransportError, ConnectionError, TimeoutError,
	SessionError, HeartbeatError, ConsumerError, SubscriptionError,
	AlreadyConnectedError, NotConnectedError, NoProviderError,
	InvalidTransitionError, QueueUnavailableError,
} from '../errors/index';

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
		const cases: [CockpitError, string, ErrorCode][] = [
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

// ===================================================================
// brickKey -- round-tripping and malformed input
// ===================================================================

describe('brickKey', () => {
	it('round-trips a plain identifier', () => {
		const key = makeBrickKey(Transport.USB, '001653AABBCC');
		assert.equal(brickKeyTransport(key), Transport.USB);
		assert.equal(brickKeyId(key), '001653AABBCC');
	});

	it('round-trips a Bluetooth MAC, whose colons collide with the separator', () => {
		// Splitting on every colon instead of the first would truncate this to '00'.
		const key = makeBrickKey(Transport.BT, '00:16:53:AA:BB:CC');
		assert.equal(key, 'bt:00:16:53:AA:BB:CC');
		assert.equal(brickKeyTransport(key), Transport.BT);
		assert.equal(brickKeyId(key), '00:16:53:AA:BB:CC');
	});

	it('preserves case, because only the transport knows if its id is case-insensitive', () => {
		assert.equal(brickKeyId(makeBrickKey(Transport.Mock, 'brick-a')), 'brick-a');
	});

	it('trims surrounding whitespace', () => {
		assert.equal(brickKeyId(makeBrickKey(Transport.TCP, '  192.168.0.5  ')), '192.168.0.5');
	});

	it('rejects an empty or blank identifier', () => {
		assert.throws(() => makeBrickKey(Transport.USB, ''), /empty identifier/);
		assert.throws(() => makeBrickKey(Transport.USB, '   '), /empty identifier/);
	});

	it('reports undefined for malformed keys rather than guessing', () => {
		assert.equal(brickKeyTransport('nonsense'), undefined);
		assert.equal(brickKeyTransport(':abc'), undefined);
		assert.equal(brickKeyTransport('nosuchtransport:abc'), undefined);
		assert.equal(brickKeyId('nonsense'), undefined);
		assert.equal(brickKeyId('usb:'), undefined);
	});
});

describe('brickIdOf', () => {
	it('maps one brick to one id whichever channel names it', () => {
		// CCC on the bench: USB serial and BT address are the same twelve digits.
		const ccc = '00165342D9F2';
		assert.equal(brickIdOf(makeBrickKey(Transport.USB, '00165342D9F2')), ccc);
		assert.equal(brickIdOf(makeBrickKey(Transport.BT, '00:16:53:42:D9:F2')), ccc);
		assert.equal(brickIdOf(makeBrickKey(Transport.TCP, '00165342d9f2')), ccc);
	});

	it('keeps different bricks apart', () => {
		const ids = ['00:16:53:46:B6:3C', '00:16:53:51:87:39', '00:16:53:42:D9:F2']
			.map((mac) => brickIdOf(makeBrickKey(Transport.BT, mac)));
		assert.equal(new Set(ids).size, 3);
	});

	it('leaves a key with no hardware identity as itself', () => {
		assert.equal(brickIdOf(makeBrickKey(Transport.TCP, '192.168.1.20')), 'tcp:192.168.1.20');
		assert.equal(brickIdOf(makeBrickKey(Transport.Mock, 'brick-a')), 'mock:brick-a');
	});

	it('never truncates a malformed address into someone else\'s id', () => {
		assert.equal(brickIdOf(makeBrickKey(Transport.BT, '00:16:53')), 'bt:00:16:53');
		assert.equal(brickIdOf(makeBrickKey(Transport.USB, '00165342D9F2FF')), 'usb:00165342D9F2FF');
	});
});

// ===================================================================
// Typed errors -- callers must be able to branch
// ===================================================================

describe('typed errors', () => {
	it('carries the cause through the standard Error mechanism', () => {
		const root = new Error('socket closed');
		const err = new TransportError('send failed', root);
		// Passed to super(message, { cause }) rather than shadowed by an own property,
		// so debuggers and util.inspect follow the chain.
		assert.equal(err.cause, root);
	});

	it('gives each session failure mode its own distinguishable code', () => {
		const cases: Array<[CockpitError, string]> = [
			[new AlreadyConnectedError('x'), 'already_connected'],
			[new NotConnectedError('x'), 'not_connected'],
			[new NoProviderError('x'), 'no_provider'],
			[new InvalidTransitionError('x'), 'invalid_transition'],
			[new QueueUnavailableError('x'), 'queue_unavailable'],
		];
		for (const [err, code] of cases) {
			assert.equal(err.code, code);
			assert.ok(err instanceof SessionError, `${err.name} should be a SessionError`);
			assert.ok(err instanceof CockpitError);
		}
		// The codes must be distinct, or branching on them is pointless.
		assert.equal(new Set(cases.map(([, c]) => c)).size, cases.length);
	});
});
