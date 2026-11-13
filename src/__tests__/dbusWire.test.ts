/**
 * The cockpit's own D-Bus wire format (step-7 plan, U3, owner decision D1), against messages GLib
 * built and serialised (`scripts/dbus-fixtures.py`): what a reference implementation puts on the
 * bus, this one must read; what this one writes, its body bytes must match.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Variant, marshal, unmarshal, splitSignature } from '../transports/dbus/wire';
import { MessageType, decodeMessage, encodeMessage, type DBusMessage } from '../transports/dbus/message';
import * as F from './fixtures/dbusFixtures';

const bytes = (hex: string): Buffer => Buffer.from(hex, 'hex');

function decoded(hex: string): DBusMessage {
	const result = decodeMessage(bytes(hex));
	assert.ok(result, 'a whole message decodes');
	assert.equal(result.length, hex.length / 2, 'and uses exactly its own bytes');
	return result.message;
}

/** The body as it sits on the wire: after the header, padded to 8. */
function bodyOf(hex: string): Buffer {
	const b = bytes(hex);
	const fieldsLength = b.readUInt32LE(12);
	const start = Math.ceil((16 + fieldsLength) / 8) * 8;
	return b.subarray(start, start + b.readUInt32LE(4));
}

describe('dbus wire — signatures', () => {
	it('splits a signature into complete types', () => {
		assert.deepEqual(splitSignature('a{oa{sa{sv}}}'), ['a{oa{sa{sv}}}']);
		assert.deepEqual(splitSignature('sa{sv}as'), ['s', 'a{sv}', 'as']);
		assert.deepEqual(splitSignature('(ss)u'), ['(ss)', 'u']);
		assert.deepEqual(splitSignature(''), []);
	});

	it('refuses a broken signature', () => {
		assert.throws(() => splitSignature('a{sv'), /signature/);
		assert.throws(() => splitSignature('(s'), /signature/);
		assert.throws(() => splitSignature('z'), /signature/);
	});
});

describe('dbus wire — reading what GLib wrote', () => {
	it('reads a method call: header fields and two strings', () => {
		const m = decoded(F.getAliasCall);
		assert.equal(m.type, MessageType.MethodCall);
		assert.equal(m.serial, 7);
		assert.equal(m.path, '/org/bluez/hci0');
		assert.equal(m.interface, 'org.freedesktop.DBus.Properties');
		assert.equal(m.member, 'Get');
		assert.equal(m.destination, 'org.bluez');
		assert.equal(m.signature, 'ss');
		assert.deepEqual(m.body, ['org.bluez.Adapter1', 'Alias']);
	});

	it('reads a reply holding a variant', () => {
		const m = decoded(F.getAliasReply);
		assert.equal(m.type, MessageType.MethodReturn);
		assert.equal(m.replySerial, 7);
		assert.deepEqual(m.body, [new Variant('s', 'HOSTC')]);
	});

	it('reads GetManagedObjects: a{oa{sa{sv}}} with nested arrays and every value kind BlueZ sends', () => {
		const m = decoded(F.getManagedObjectsReply);
		assert.equal(m.signature, 'a{oa{sa{sv}}}');
		const objects = m.body[0] as Map<string, Map<string, Map<string, Variant>>>;
		assert.deepEqual([...objects.keys()].sort(), [
			'/org/bluez/hci0',
			'/org/bluez/hci0/dev_00_16_53_F0_0A_0A',
			'/org/bluez/hci0/dev_00_16_53_F0_0B_0B',
		]);
		const adapter = objects.get('/org/bluez/hci0')!.get('org.bluez.Adapter1')!;
		assert.deepEqual(adapter.get('Alias'), new Variant('s', 'HOSTC'));
		assert.equal(objects.get('/org/bluez/hci0')!.get('org.freedesktop.DBus.Properties')!.size, 0, 'an empty dict');
		const aaa = objects.get('/org/bluez/hci0/dev_00_16_53_F0_0A_0A')!.get('org.bluez.Device1')!;
		assert.deepEqual(aaa.get('Name'), new Variant('s', 'AAA'));
		assert.deepEqual(aaa.get('Class'), new Variant('u', 2052));
		assert.deepEqual(aaa.get('Paired'), new Variant('b', true));
		assert.deepEqual(aaa.get('UUIDs'), new Variant('as', ['00001101-0000-1000-8000-00805f9b34fb']));
		assert.deepEqual(aaa.get('Adapter'), new Variant('o', '/org/bluez/hci0'));
		const bbb = objects.get('/org/bluez/hci0/dev_00_16_53_F0_0B_0B')!.get('org.bluez.Device1')!;
		assert.deepEqual(bbb.get('RSSI'), new Variant('n', -62));
	});

	it('reads the signals: InterfacesAdded, InterfacesRemoved, PropertiesChanged', () => {
		const added = decoded(F.interfacesAdded);
		assert.equal(added.type, MessageType.Signal);
		assert.equal(added.member, 'InterfacesAdded');
		assert.equal(added.sender, ':1.2');
		assert.equal(added.body[0], '/org/bluez/hci0/dev_00_16_53_F0_0B_0B');
		const removed = decoded(F.interfacesRemoved);
		assert.deepEqual(removed.body, ['/org/bluez/hci0/dev_00_16_53_F0_0B_0B', ['org.bluez.Device1']]);
		const changed = decoded(F.propertiesChanged);
		assert.equal(changed.body[0], 'org.bluez.Device1');
		assert.deepEqual((changed.body[1] as Map<string, Variant>).get('RSSI'), new Variant('n', -51));
		assert.deepEqual(changed.body[2], ['Name']);
	});

	it('reads the agent calls BlueZ makes', () => {
		const pin = decoded(F.requestPinCodeCall);
		assert.equal(pin.member, 'RequestPinCode');
		assert.equal(pin.path, '/ev3cockpit/agent');
		assert.deepEqual(pin.body, ['/org/bluez/hci0/dev_00_16_53_F0_0A_0A']);
		const conf = decoded(F.requestConfirmationCall);
		assert.deepEqual(conf.body, ['/org/bluez/hci0/dev_00_16_53_F0_0A_0A', 123456]);
	});

	it('reads an error reply: its name and its message', () => {
		const m = decoded(F.pairRejected);
		assert.equal(m.type, MessageType.Error);
		assert.equal(m.errorName, 'org.bluez.Error.AuthenticationRejected');
		assert.equal(m.replySerial, 12);
		assert.deepEqual(m.body, ['Authentication Rejected']);
	});

	it('reads every integer width, a double and a boolean, with their padding', () => {
		const m = decoded(F.numbers);
		assert.deepEqual(m.body, [0xfe, -2, 0xfffe, -3, 0xfffffffd, -4n, 0xfffffffffffffffbn, 1.5, true]);
	});

	it('answers "not yet" for a message cut short, and reads one of two run together', () => {
		const whole = bytes(F.getAliasCall);
		assert.equal(decodeMessage(whole.subarray(0, 10)), undefined);
		assert.equal(decodeMessage(whole.subarray(0, whole.length - 1)), undefined);
		const two = Buffer.concat([whole, bytes(F.emptyReply)]);
		const first = decodeMessage(two)!;
		assert.equal(first.length, whole.length);
		assert.equal(decodeMessage(two.subarray(first.length))!.message.type, MessageType.MethodReturn);
	});

	it('refuses a big-endian message rather than misread it', () => {
		const big = Buffer.from(bytes(F.getAliasCall));
		big[0] = 0x42;
		assert.throws(() => decodeMessage(big), /big-endian/);
	});
});

describe('dbus wire — writing what GLib would', () => {
	for (const name of ['getAliasCall', 'getManagedObjectsReply', 'interfacesAdded', 'propertiesChanged',
		'registerAgentCall', 'requestPinCodeReply', 'requestConfirmationCall', 'numbers'] as const) {
		it(`writes the body of ${name} byte for byte`, () => {
			const m = decoded(F[name]);
			assert.deepEqual(marshal(m.signature ?? '', m.body), bodyOf(F[name]));
		});

		it(`writes ${name} as a message that reads back the same`, () => {
			const m = decoded(F[name]);
			const again = decodeMessage(encodeMessage(m))!;
			assert.deepEqual(again.message, m);
		});
	}

	it('writes a dict from a plain object as well as from a Map', () => {
		const fromMap = marshal('a{sv}', [new Map([['Transport', new Variant('s', 'bredr')]])]);
		const fromObject = marshal('a{sv}', [{ Transport: new Variant('s', 'bredr') }]);
		assert.deepEqual(fromObject, fromMap);
		assert.deepEqual(unmarshal('a{sv}', fromMap), [new Map([['Transport', new Variant('s', 'bredr')]])]);
	});

	it('refuses a value that does not fit its type', () => {
		assert.throws(() => marshal('y', [256]), /range/);
		assert.throws(() => marshal('u', [-1]), /range/);
		assert.throws(() => marshal('s', [42]), /string/);
		assert.throws(() => marshal('v', ['not a variant']), /Variant/);
		assert.throws(() => marshal('o', ['not/a/path']), /object path/);
	});

	it('refuses to read past the end of a body', () => {
		assert.throws(() => unmarshal('u', Buffer.alloc(2)), /past the end/);
		const s = marshal('s', ['hello']);
		assert.throws(() => unmarshal('s', s.subarray(0, s.length - 2)), /past the end/);
	});
});
