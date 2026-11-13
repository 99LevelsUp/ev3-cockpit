/**
 * The cockpit's own D-Bus connection (step-7 plan, U3, part 2), against a bus in memory that
 * speaks the same protocol: the `EXTERNAL` handshake, `Hello`, method calls with replies and
 * errors, signals, and objects this side exports (BlueZ calls the pairing agent).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough, Duplex } from 'node:stream';

import { DBusConnection, DBusError } from '../transports/dbus/connection';
import { MessageType, decodeMessage, encodeMessage, type DBusMessage } from '../transports/dbus/message';
import { Variant } from '../transports/dbus/wire';

/** Two ends of a pipe: what one writes, the other reads. */
function duplexPair(): [Duplex, Duplex] {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	const end = (read: PassThrough, write: PassThrough): Duplex => new Duplex({
		read() { /* pushed below */ },
		write(chunk, _enc, done) { write.write(chunk); done(); },
		final(done) { write.end(); done(); },
		destroy(_err, done) { write.end(); done(null); },
	});
	const a = end(bToA, aToB);
	const b = end(aToB, bToA);
	bToA.on('data', (chunk) => a.push(chunk));
	aToB.on('data', (chunk) => b.push(chunk));
	bToA.on('end', () => a.push(null));
	aToB.on('end', () => b.push(null));
	return [a, b];
}

/** A bus: checks the handshake, answers Hello, and lets a test answer or send anything else. */
class FakeBus {
	readonly received: DBusMessage[] = [];
	auth = '';
	private buffer = Buffer.alloc(0);
	private authed = false;
	private serial = 1000;
	onCall?: (m: DBusMessage) => void;

	constructor(private readonly end: Duplex, private readonly opts: { reject?: boolean } = {}) {
		end.on('data', (chunk: Buffer) => this.feed(chunk));
	}

	private feed(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (!this.authed) {
			const text = this.buffer.toString('latin1');
			const begin = text.indexOf('BEGIN\r\n');
			if (!this.auth && text.includes('\r\n')) {
				this.auth = text.slice(0, text.indexOf('\r\n') + 2);
				this.end.write(this.opts.reject ? 'REJECTED EXTERNAL\r\n' : 'OK 0123456789abcdef0123456789abcdef\r\n');
			}
			if (begin < 0) { return; }
			this.authed = true;
			this.buffer = this.buffer.subarray(begin + 7);
		}
		for (;;) {
			const next = decodeMessage(this.buffer);
			if (!next) { return; }
			this.buffer = this.buffer.subarray(next.length);
			this.received.push(next.message);
			if (next.message.member === 'Hello') {
				this.reply(next.message, 's', [':1.77']);
			} else if (next.message.member === 'AddMatch') {
				this.reply(next.message);
			} else {
				this.onCall?.(next.message);
			}
		}
	}

	send(m: Omit<DBusMessage, 'serial'>): void {
		this.end.write(encodeMessage({ ...m, serial: (this.serial += 1) }));
	}

	reply(to: DBusMessage, signature?: string, body: DBusMessage['body'] = []): void {
		this.send({ type: MessageType.MethodReturn, flags: 0, replySerial: to.serial, destination: ':1.77', sender: 'org.freedesktop.DBus', ...(signature ? { signature } : {}), body });
	}

	error(to: DBusMessage, name: string, text: string): void {
		this.send({ type: MessageType.Error, flags: 0, replySerial: to.serial, errorName: name, destination: ':1.77', signature: 's', body: [text] });
	}

	close(): void { this.end.end(); }
}

async function connected(opts?: { reject?: boolean }): Promise<{ conn: DBusConnection; bus: FakeBus }> {
	const [ours, theirs] = duplexPair();
	const bus = new FakeBus(theirs, opts);
	const conn = await DBusConnection.open({ stream: ours, uid: 1000, callTimeoutMs: 500 });
	return { conn, bus };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('DBusConnection — opening', () => {
	it('authenticates EXTERNAL with the uid in hex, sends Hello, and learns its unique name', async () => {
		const { conn, bus } = await connected();
		assert.equal(bus.auth, '\0AUTH EXTERNAL 31303030\r\n', 'one NUL byte, then "1000" as hex digits of its ASCII');
		assert.equal(bus.received[0].member, 'Hello');
		assert.equal(bus.received[0].destination, 'org.freedesktop.DBus');
		assert.equal(conn.uniqueName, ':1.77');
		conn.close();
	});

	it('fails the open when the bus rejects the handshake', async () => {
		const [ours, theirs] = duplexPair();
		new FakeBus(theirs, { reject: true });
		await assert.rejects(() => DBusConnection.open({ stream: ours, uid: 1000, callTimeoutMs: 500 }), /rejected/i);
	});
});

describe('DBusConnection — calls', () => {
	it('sends a call and resolves with the reply body', async () => {
		const { conn, bus } = await connected();
		bus.onCall = (m) => bus.reply(m, 'v', [new Variant('s', 'HOSTC')]);
		const body = await conn.call({
			destination: 'org.bluez', path: '/org/bluez/hci0', interface: 'org.freedesktop.DBus.Properties',
			member: 'Get', signature: 'ss', body: ['org.bluez.Adapter1', 'Alias'],
		});
		assert.deepEqual(body, [new Variant('s', 'HOSTC')]);
		const sent = bus.received.at(-1)!;
		assert.deepEqual(sent.body, ['org.bluez.Adapter1', 'Alias']);
		assert.equal(sent.signature, 'ss');
		conn.close();
	});

	it('matches replies to calls by serial, whatever order they come in', async () => {
		const { conn, bus } = await connected();
		const held: DBusMessage[] = [];
		bus.onCall = (m) => { held.push(m); if (held.length === 2) { bus.reply(held[1], 's', ['second']); bus.reply(held[0], 's', ['first']); } };
		const call = (member: string) => conn.call({ destination: 'x.y', path: '/x', interface: 'x.y', member });
		const [a, b] = await Promise.all([call('A'), call('B')]);
		assert.deepEqual([a, b], [['first'], ['second']]);
		conn.close();
	});

	it('rejects with a DBusError carrying the error name and message', async () => {
		const { conn, bus } = await connected();
		bus.onCall = (m) => bus.error(m, 'org.bluez.Error.AuthenticationRejected', 'Authentication Rejected');
		const error = await conn.call({ destination: 'org.bluez', path: '/x', interface: 'org.bluez.Device1', member: 'Pair' })
			.then(() => undefined, (e: unknown) => e);
		assert.ok(error instanceof DBusError);
		assert.equal((error as DBusError).dbusName, 'org.bluez.Error.AuthenticationRejected');
		assert.match((error as Error).message, /Authentication Rejected/);
		conn.close();
	});

	it('gives up on a call nobody answers, at its timeout, and forgets it', async () => {
		const { conn } = await connected();
		const started = Date.now();
		await assert.rejects(() => conn.call({ destination: 'x.y', path: '/x', interface: 'x.y', member: 'Silent', timeoutMs: 80 }), /timed out/);
		assert.ok(Date.now() - started < 400);
		conn.close();
	});

	it('fails the calls in flight when the bus goes away, and refuses new ones', async () => {
		const { conn, bus } = await connected();
		const pending = conn.call({ destination: 'x.y', path: '/x', interface: 'x.y', member: 'Hang', timeoutMs: 5000 });
		bus.close();
		await assert.rejects(() => pending, /closed/);
		await assert.rejects(() => conn.call({ destination: 'x.y', path: '/x', interface: 'x.y', member: 'Late' }), /closed/);
	});

	it('fails the calls in flight on close()', async () => {
		const { conn } = await connected();
		const pending = conn.call({ destination: 'x.y', path: '/x', interface: 'x.y', member: 'Hang', timeoutMs: 5000 });
		conn.close();
		await assert.rejects(() => pending, /closed/);
	});
});

describe('DBusConnection — signals', () => {
	it('adds a match rule on the bus, and hands matching signals to the handler', async () => {
		const { conn, bus } = await connected();
		const seen: DBusMessage[] = [];
		await conn.addMatch("type='signal',sender='org.bluez',interface='org.freedesktop.DBus.ObjectManager'");
		const off = conn.onSignal((m) => seen.push(m));
		assert.deepEqual(bus.received.at(-1)!.body, ["type='signal',sender='org.bluez',interface='org.freedesktop.DBus.ObjectManager'"]);
		bus.send({ type: MessageType.Signal, flags: 0, path: '/', interface: 'org.freedesktop.DBus.ObjectManager', member: 'InterfacesRemoved', sender: ':1.2', signature: 'oas', body: ['/org/bluez/hci0/dev_00_16_53_F0_0A_0A', ['org.bluez.Device1']] });
		await settle();
		assert.equal(seen.length, 1);
		assert.equal(seen[0].member, 'InterfacesRemoved');
		off();
		bus.send({ type: MessageType.Signal, flags: 0, path: '/', interface: 'x.y', member: 'After', sender: ':1.2', body: [] });
		await settle();
		assert.equal(seen.length, 1, 'no signal after the handler is removed');
		conn.close();
	});

	it('survives a handler that throws', async () => {
		const { conn, bus } = await connected();
		const seen: string[] = [];
		conn.onSignal(() => { throw new Error('handler bug'); });
		conn.onSignal((m) => seen.push(m.member!));
		bus.send({ type: MessageType.Signal, flags: 0, path: '/', interface: 'x.y', member: 'One', sender: ':1.2', body: [] });
		await settle();
		assert.deepEqual(seen, ['One']);
		conn.close();
	});
});

describe('DBusConnection — exported objects (the agent BlueZ calls)', () => {
	it('answers a call to an exported method with its return value', async () => {
		const { conn, bus } = await connected();
		conn.exportObject('/ev3cockpit/agent', 'org.bluez.Agent1', {
			RequestPinCode: { returns: 's', handler: () => ['1234'] },
		});
		const replies: DBusMessage[] = [];
		bus.onCall = (m) => replies.push(m);
		bus.send({ type: MessageType.MethodCall, flags: 0, path: '/ev3cockpit/agent', interface: 'org.bluez.Agent1', member: 'RequestPinCode', destination: ':1.77', sender: ':1.2', signature: 'o', body: ['/org/bluez/hci0/dev_00_16_53_F0_0A_0A'] });
		await settle();
		const reply = bus.received.at(-1)!;
		assert.equal(reply.type, MessageType.MethodReturn);
		assert.equal(reply.signature, 's');
		assert.deepEqual(reply.body, ['1234']);
		assert.equal(reply.destination, ':1.2', 'back to the caller');
		conn.close();
	});

	it('passes the arguments in, and answers an async handler when it resolves', async () => {
		const { conn, bus } = await connected();
		const args: unknown[] = [];
		conn.exportObject('/ev3cockpit/agent', 'org.bluez.Agent1', {
			RequestConfirmation: { returns: '', handler: async (a) => { args.push(...a); await settle(); return []; } },
		});
		bus.send({ type: MessageType.MethodCall, flags: 0, path: '/ev3cockpit/agent', interface: 'org.bluez.Agent1', member: 'RequestConfirmation', destination: ':1.77', sender: ':1.2', signature: 'ou', body: ['/org/bluez/hci0/dev_00_16_53_F0_0A_0A', 123456] });
		await settle(); await settle();
		assert.deepEqual(args, ['/org/bluez/hci0/dev_00_16_53_F0_0A_0A', 123456]);
		const reply = bus.received.at(-1)!;
		assert.equal(reply.type, MessageType.MethodReturn);
		assert.equal(reply.signature, undefined, 'an empty reply has no signature');
		conn.close();
	});

	it('answers a handler that throws a DBusError with that error', async () => {
		const { conn, bus } = await connected();
		conn.exportObject('/ev3cockpit/agent', 'org.bluez.Agent1', {
			RequestConfirmation: { returns: '', handler: () => { throw new DBusError('org.bluez.Error.Rejected', 'not this brick'); } },
		});
		bus.send({ type: MessageType.MethodCall, flags: 0, path: '/ev3cockpit/agent', interface: 'org.bluez.Agent1', member: 'RequestConfirmation', destination: ':1.77', sender: ':1.2', signature: 'ou', body: ['/org/bluez/hci0/dev_00_16_53_F0_0B_0B', 1] });
		await settle();
		const reply = bus.received.at(-1)!;
		assert.equal(reply.type, MessageType.Error);
		assert.equal(reply.errorName, 'org.bluez.Error.Rejected');
		assert.deepEqual(reply.body, ['not this brick']);
		conn.close();
	});

	it('answers an unknown method or object with UnknownMethod / UnknownObject, and says nothing to a no-reply call', async () => {
		const { conn, bus } = await connected();
		conn.exportObject('/ev3cockpit/agent', 'org.bluez.Agent1', { Release: { returns: '', handler: () => [] } });
		const before = bus.received.length;
		bus.send({ type: MessageType.MethodCall, flags: 0, path: '/ev3cockpit/agent', interface: 'org.bluez.Agent1', member: 'Nope', destination: ':1.77', sender: ':1.2', body: [] });
		bus.send({ type: MessageType.MethodCall, flags: 0, path: '/elsewhere', interface: 'org.bluez.Agent1', member: 'Release', destination: ':1.77', sender: ':1.2', body: [] });
		bus.send({ type: MessageType.MethodCall, flags: 1, path: '/ev3cockpit/agent', interface: 'org.bluez.Agent1', member: 'Release', destination: ':1.77', sender: ':1.2', body: [] });
		await settle();
		const answers = bus.received.slice(before);
		assert.deepEqual(answers.map((m) => m.errorName), ['org.freedesktop.DBus.Error.UnknownMethod', 'org.freedesktop.DBus.Error.UnknownObject']);
		conn.close();
	});

	it('answers a call on another interface of the same object with UnknownMethod', async () => {
		const { conn, bus } = await connected();
		let ran = false;
		conn.exportObject('/ev3cockpit/agent', 'org.bluez.Agent1', { Release: { returns: '', handler: () => { ran = true; return []; } } });
		bus.send({ type: MessageType.MethodCall, flags: 0, path: '/ev3cockpit/agent', interface: 'org.bluez.Other', member: 'Release', destination: ':1.77', sender: ':1.2', body: [] });
		await settle();
		assert.equal(ran, false);
		assert.equal(bus.received.at(-1)!.errorName, 'org.freedesktop.DBus.Error.UnknownMethod');
		conn.close();
	});

	it('stops answering once the export is withdrawn', async () => {
		const { conn, bus } = await connected();
		const withdraw = conn.exportObject('/ev3cockpit/agent', 'org.bluez.Agent1', { Release: { returns: '', handler: () => [] } });
		withdraw();
		bus.send({ type: MessageType.MethodCall, flags: 0, path: '/ev3cockpit/agent', interface: 'org.bluez.Agent1', member: 'Release', destination: ':1.77', sender: ':1.2', body: [] });
		await settle();
		assert.equal(bus.received.at(-1)!.errorName, 'org.freedesktop.DBus.Error.UnknownObject');
		conn.close();
	});
});
