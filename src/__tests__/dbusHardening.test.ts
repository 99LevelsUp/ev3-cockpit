/**
 * The D-Bus client against bytes it must refuse (review of 43b3e65): the peer is the system bus
 * daemon, but what it relays is still input — a malformed header, an array that overruns its
 * bounds, a string without its NUL, a flood of calls — and none of it may take the extension host
 * down or let memory grow.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough, Duplex } from 'node:stream';

import { Variant, marshal, unmarshal, splitSignature } from '../transports/dbus/wire';
import { MessageType, decodeMessage, encodeMessage } from '../transports/dbus/message';
import { DBusConnection } from '../transports/dbus/connection';

/** A raw message: the header written field by field, so a test can make it wrong. */
function rawMessage(type: number, serial: number, fields: [number, Variant][], body = Buffer.alloc(0)): Buffer {
	const header = marshal('yyyyuua(yv)', [0x6c, type, 0, 1, body.length, serial, fields]);
	const pad = Math.ceil(header.length / 8) * 8 - header.length;
	return Buffer.concat([header, Buffer.alloc(pad), body]);
}
const PATH = (p: string): [number, Variant] => [1, new Variant('o', p)];
const IFACE = (i: string): [number, Variant] => [2, new Variant('s', i)];
const MEMBER = (m: string): [number, Variant] => [3, new Variant('s', m)];
const REPLY = (n: number): [number, Variant] => [5, new Variant('u', n)];
const SIG = (g: string): [number, Variant] => [8, new Variant('g', g)];

describe('dbus hardening — headers (review #0, #5)', () => {
	it('refuses a known header field of the wrong type', () => {
		const bytes = rawMessage(MessageType.MethodCall, 3, [PATH('/x'), MEMBER('M'), [7, new Variant('u', 5)]]);
		assert.throws(() => decodeMessage(bytes), /sender/);
	});

	it('refuses a header field given twice', () => {
		const bytes = rawMessage(MessageType.MethodCall, 3, [PATH('/x'), MEMBER('M'), MEMBER('N')]);
		assert.throws(() => decodeMessage(bytes), /twice/);
	});

	it('refuses a message without the fields its type requires, or with serial 0', () => {
		assert.throws(() => decodeMessage(rawMessage(MessageType.MethodCall, 3, [PATH('/x')])), /member/);
		assert.throws(() => decodeMessage(rawMessage(MessageType.Signal, 3, [PATH('/x'), MEMBER('M')])), /interface/);
		assert.throws(() => decodeMessage(rawMessage(MessageType.MethodReturn, 3, [])), /reply serial/);
		assert.throws(() => decodeMessage(rawMessage(MessageType.Error, 3, [REPLY(1)])), /error name/);
		assert.throws(() => decodeMessage(rawMessage(MessageType.MethodCall, 0, [PATH('/x'), MEMBER('M')])), /serial 0/);
		assert.throws(() => decodeMessage(rawMessage(9, 3, [PATH('/x'), MEMBER('M')])), /type 9/);
	});

	it('skips a header field it does not know', () => {
		const m = decodeMessage(rawMessage(MessageType.Signal, 3, [PATH('/x'), IFACE('a.b'), MEMBER('M'), [42, new Variant('s', 'later')]]));
		assert.equal(m!.message.member, 'M');
	});

	it('refuses to write a body without a signature (review #9)', () => {
		assert.throws(() => encodeMessage({ type: MessageType.MethodReturn, flags: 0, serial: 1, replySerial: 1, body: ['lost'] }), /signature/);
	});
});

describe('dbus hardening — values (review #6, #7)', () => {
	it('refuses an array element that runs past the array', () => {
		// as: array length 8, holding a string that claims 5 bytes (4 + 5 + NUL > 8).
		const bytes = Buffer.from([8, 0, 0, 0, 5, 0, 0, 0, 0x61, 0x62, 0x63, 0x64, 0x65, 0, 0, 0]);
		assert.throws(() => unmarshal('as', bytes), /past the end of its array|past the end/);
	});

	it('refuses bytes left over after the body', () => {
		const body = Buffer.concat([marshal('u', [7]), Buffer.from([1, 2, 3, 4])]);
		assert.throws(() => unmarshal('u', body), /left over/);
		const m = rawMessage(MessageType.MethodReturn, 3, [REPLY(1), SIG('u')], body);
		assert.throws(() => decodeMessage(m), /left over/);
	});

	it('refuses a boolean that is not 0 or 1', () => {
		assert.throws(() => unmarshal('b', Buffer.from([2, 0, 0, 0])), /boolean/);
	});

	it('refuses a string without its NUL, with a NUL inside, or not UTF-8', () => {
		assert.throws(() => unmarshal('s', Buffer.from([2, 0, 0, 0, 0x61, 0x62, 0x63])), /NUL|past the end/);
		assert.throws(() => unmarshal('s', Buffer.from([2, 0, 0, 0, 0x61, 0x62, 0x58])), /NUL/);
		assert.throws(() => unmarshal('s', Buffer.from([3, 0, 0, 0, 0x61, 0x00, 0x62, 0x00])), /NUL/);
		assert.throws(() => unmarshal('s', Buffer.from([2, 0, 0, 0, 0xc3, 0x28, 0x00])), /UTF-8/);
	});

	it('refuses an object path or a signature that is not valid', () => {
		assert.throws(() => unmarshal('o', Buffer.from([3, 0, 0, 0, 0x61, 0x2f, 0x62, 0x00])), /object path/);
		assert.throws(() => unmarshal('g', Buffer.from([2, 0x7a, 0x7a, 0x00])), /signature/);
		assert.throws(() => unmarshal('v', Buffer.from([2, 0x73, 0x73, 0x00])), /one complete type|one type/);
	});
});

describe('dbus hardening — signatures (review #8)', () => {
	it('refuses a dict entry outside an array', () => {
		assert.throws(() => splitSignature('{sv}'), /dict entry/);
		assert.throws(() => splitSignature('({sv})'), /dict entry/);
		assert.deepEqual(splitSignature('a{sv}'), ['a{sv}']);
	});

	it('refuses nesting deeper than the specification allows, and a signature over 255 bytes', () => {
		assert.throws(() => splitSignature('a'.repeat(33) + 'y'), /deep/);
		assert.throws(() => splitSignature('('.repeat(33) + 'y' + ')'.repeat(33)), /deep/);
		assert.doesNotThrow(() => splitSignature('a'.repeat(32) + 'y'));
		assert.throws(() => splitSignature('y'.repeat(256)), /255/);
	});
});

describe('dbus hardening — writing stays linear (review #11)', () => {
	it('writes a large nested array without copying what it already wrote each time', () => {
		// 60 000 inner arrays: each one patches its length, which used to copy everything before it.
		const many = Array.from({ length: 60_000 }, (_, i) => [`k${i}`]);
		const started = Date.now();
		const bytes = marshal('aas', [many]);
		assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
		assert.equal((unmarshal('aas', bytes)[0] as unknown[]).length, 60_000);
	});
});

// ── The connection ─────────────────────────────────────────────────

function duplexPair(): [Duplex, Duplex] {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	const end = (write: PassThrough): Duplex => new Duplex({
		read() { /* pushed */ },
		write(chunk, _enc, done) { write.write(chunk); done(); },
		final(done) { write.end(); done(); },
		destroy(_err, done) { write.end(); done(null); },
	});
	const a = end(aToB);
	const b = end(bToA);
	bToA.on('data', (c) => a.push(c));
	aToB.on('data', (c) => b.push(c));
	bToA.on('end', () => a.push(null));
	aToB.on('end', () => b.push(null));
	return [a, b];
}

/** The bus side, raw: answers the handshake and Hello as told, records what arrives. */
function rawBus(theirs: Duplex, options: { hello?: (serial: number) => Buffer } = {}) {
	const received: ReturnType<typeof decodeMessage>[] = [];
	let buffer = Buffer.alloc(0);
	let okSent = false;
	let authed = false;
	theirs.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		if (!authed) {
			if (!okSent && buffer.includes('\r\n')) {
				okSent = true;
				theirs.write('OK 0123456789abcdef0123456789abcdef\r\n');
			}
			const begin = buffer.indexOf('BEGIN\r\n');
			if (begin < 0) { return; }
			authed = true;
			buffer = buffer.subarray(begin + 7);
		}
		for (;;) {
			const next = decodeMessage(buffer);
			if (!next) { return; }
			buffer = buffer.subarray(next.length);
			received.push(next);
			if (next.message.member === 'Hello') {
				theirs.write(options.hello ? options.hello(next.message.serial)
					: encodeMessage({ type: MessageType.MethodReturn, flags: 0, serial: 1, replySerial: next.message.serial, signature: 's', body: [':1.77'] }));
			}
		}
	});
	return { received };
}

describe('DBusConnection hardening — opening (review #1, #10)', () => {
	it('refuses a Hello reply that is not one unique name', async () => {
		for (const hello of [
			(s: number) => encodeMessage({ type: MessageType.MethodReturn, flags: 0, serial: 1, replySerial: s, signature: 'u', body: [7] }),
			(s: number) => encodeMessage({ type: MessageType.MethodReturn, flags: 0, serial: 1, replySerial: s, body: [] }),
			(s: number) => encodeMessage({ type: MessageType.MethodReturn, flags: 0, serial: 1, replySerial: s, signature: 's', body: ['org.bluez'] }),
		]) {
			const [ours, theirs] = duplexPair();
			rawBus(theirs, { hello });
			await assert.rejects(() => DBusConnection.open({ stream: ours, uid: 1000, callTimeoutMs: 500 }), /unique name/);
		}
	});

	it('gives up on a handshake line that never ends, without holding it all', async () => {
		const [ours, theirs] = duplexPair();
		theirs.on('data', () => { theirs.write(Buffer.alloc(4096, 0x41)); });
		await assert.rejects(() => DBusConnection.open({ stream: ours, uid: 1000, callTimeoutMs: 2000 }), /handshake/);
	});
});

describe('DBusConnection hardening — receiving (review #0, #2)', () => {
	async function opened(): Promise<{ conn: DBusConnection; theirs: Duplex; bus: ReturnType<typeof rawBus> }> {
		const [ours, theirs] = duplexPair();
		const bus = rawBus(theirs);
		const conn = await DBusConnection.open({ stream: ours, uid: 1000, callTimeoutMs: 500, exportedCallTimeoutMs: 80 });
		return { conn, theirs, bus };
	}
	const settle = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

	it('reads a message that arrives one byte at a time', async () => {
		const { conn, theirs } = await opened();
		const seen: string[] = [];
		conn.onSignal((m) => seen.push(m.member!));
		const bytes = encodeMessage({ type: MessageType.Signal, flags: 0, serial: 9, path: '/x', interface: 'a.b', member: 'Trickle', body: [] });
		for (const byte of bytes) { theirs.write(Buffer.from([byte])); }
		await settle();
		assert.deepEqual(seen, ['Trickle']);
		conn.close();
	});

	it('closes the connection on a malformed message rather than misread what follows', async () => {
		const { conn, theirs } = await opened();
		theirs.write(rawMessage(MessageType.MethodCall, 3, [PATH('/x'), MEMBER('M'), MEMBER('N')]));
		await settle();
		assert.equal(conn.isOpen, false);
	});

	it('closes, rather than leave a rejection unhandled, when a reply cannot be written', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
		process.on('unhandledRejection', onUnhandled);
		try {
			const { conn, theirs } = await opened();
			// The handler answers with a value that does not fit the declared reply signature.
			conn.exportObject('/a', 'x.y', { Bad: { returns: 'u', handler: () => ['not a number'] } });
			theirs.write(encodeMessage({ type: MessageType.MethodCall, flags: 0, serial: 11, path: '/a', interface: 'x.y', member: 'Bad', sender: ':1.2', body: [] }));
			await settle(30);
			assert.deepEqual(unhandled, []);
			assert.equal(conn.isOpen, false);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('answers an invalid error name from a handler as a plain failure', async () => {
		const { conn, theirs, bus } = await opened();
		const { DBusError } = await import('../transports/dbus/connection');
		conn.exportObject('/a', 'x.y', { Odd: { returns: '', handler: () => { throw new DBusError('not a valid name', 'x'); } } });
		theirs.write(encodeMessage({ type: MessageType.MethodCall, flags: 0, serial: 12, path: '/a', interface: 'x.y', member: 'Odd', sender: ':1.2', body: [] }));
		await settle();
		assert.equal(bus.received.at(-1)!.message.errorName, 'org.freedesktop.DBus.Error.Failed');
		assert.equal(conn.isOpen, true);
		conn.close();
	});
});

describe('DBusConnection hardening — exported calls (review #4)', () => {
	it('answers at most four calls at once, refusing the rest, and gives up on a handler past its deadline', async () => {
		const [ours, theirs] = duplexPair();
		const bus = rawBus(theirs);
		const conn = await DBusConnection.open({ stream: ours, uid: 1000, callTimeoutMs: 500, exportedCallTimeoutMs: 80 });
		conn.exportObject('/agent', 'org.bluez.Agent1', {
			RequestPinCode: { returns: 's', handler: () => new Promise(() => { /* the user never answers */ }) },
		});
		for (let serial = 20; serial < 25; serial += 1) {
			theirs.write(encodeMessage({ type: MessageType.MethodCall, flags: 0, serial, path: '/agent', interface: 'org.bluez.Agent1', member: 'RequestPinCode', sender: ':1.2', signature: 'o', body: ['/org/bluez/hci0/dev_00_16_53_F0_0A_0A'] }));
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		const early = bus.received.slice(1).map((m) => m!.message.errorName);
		assert.deepEqual(early, ['org.freedesktop.DBus.Error.LimitsExceeded'], 'the fifth is refused at once');
		await new Promise((resolve) => setTimeout(resolve, 120));
		const late = bus.received.slice(2).map((m) => m!.message.errorName);
		assert.deepEqual(late, Array(4).fill('org.freedesktop.DBus.Error.Timeout'), 'the four in flight time out');
		conn.close();
	});
});
