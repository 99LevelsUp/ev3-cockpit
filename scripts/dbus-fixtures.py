#!/usr/bin/env python3
"""Byte fixtures for the cockpit's own D-Bus client (step-7 plan, U3, owner decision D1).

GLib's GDBus is an independent implementation of the D-Bus wire format; every message here is
built with it and serialised with `Gio.DBusMessage.to_blob`, so the client's tests compare its
bytes against a reference rather than against itself. The values are placeholders (bricks AAA,
BBB with the repo's placeholder MACs, the adapter `HOSTC`).

    python3 -I scripts/dbus-fixtures.py   prints a TypeScript module of hex strings

Needs `python3-gi` (Debian/Raspberry Pi OS ship it). Not run by the build: its output is checked
in at src/__tests__/fixtures/dbusFixtures.ts.
"""
from gi.repository import Gio, GLib

V = GLib.Variant
AAA = '/org/bluez/hci0/dev_00_16_53_F0_0A_0A'
BBB = '/org/bluez/hci0/dev_00_16_53_F0_0B_0B'
SPP = '00001101-0000-1000-8000-00805f9b34fb'


def device(name, mac, paired, rssi=None):
    props = {
        'Address': V('s', mac),
        'Name': V('s', name),
        'Alias': V('s', name),
        'Class': V('u', 2052),
        'Paired': V('b', paired),
        'Bonded': V('b', paired),
        'Trusted': V('b', False),
        'Connected': V('b', False),
        'UUIDs': V('as', [SPP]),
        'Adapter': V('o', '/org/bluez/hci0'),
    }
    if rssi is not None:
        props['RSSI'] = V('n', rssi)
    return props


def call(path, interface, member, signature=None, body=None, serial=1, destination='org.bluez'):
    m = Gio.DBusMessage.new_method_call(destination, path, interface, member)
    if body is not None:
        m.set_body(V(signature, body))
    m.set_serial(serial)
    return m


def reply_to(request_serial, signature, body, serial, sender=':1.2'):
    req = Gio.DBusMessage.new_method_call('org.bluez', '/', 'x.y', 'z')
    req.set_serial(request_serial)
    req.set_sender(sender)
    m = req.new_method_reply()
    if body is not None:
        m.set_body(V(signature, body))
    m.set_serial(serial)
    m.set_sender(sender)
    m.set_destination(':1.77')
    return m


def signal(path, interface, member, signature, body, serial):
    m = Gio.DBusMessage.new_signal(path, interface, member)
    m.set_body(V(signature, body))
    m.set_serial(serial)
    m.set_sender(':1.2')
    return m


fixtures = {}

# A call with two strings: Properties.Get(Adapter1, Alias).
fixtures['getAliasCall'] = call('/org/bluez/hci0', 'org.freedesktop.DBus.Properties', 'Get',
                                '(ss)', ('org.bluez.Adapter1', 'Alias'), serial=7)

# Its reply: a variant holding a string.
fixtures['getAliasReply'] = reply_to(7, '(v)', (V('s', 'HOSTC'),), serial=31)

# GetManagedObjects() with no body, and its reply a{oa{sa{sv}}}: the adapter and two bricks.
fixtures['getManagedObjectsCall'] = call('/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', serial=2)
fixtures['getManagedObjectsReply'] = reply_to(2, '(a{oa{sa{sv}}})', ({
    '/org/bluez/hci0': {
        'org.bluez.Adapter1': {
            'Address': V('s', '00:00:00:00:00:00'),
            'Alias': V('s', 'HOSTC'),
            'Powered': V('b', True),
            'Discovering': V('b', False),
        },
        'org.freedesktop.DBus.Properties': {},
    },
    AAA: {'org.bluez.Device1': device('AAA', '00:16:53:F0:0A:0A', True)},
    BBB: {'org.bluez.Device1': device('BBB', '00:16:53:F0:0B:0B', False, rssi=-62)},
},), serial=32)

# The signals discovery listens to.
fixtures['interfacesAdded'] = signal('/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded',
                                     '(oa{sa{sv}})', (BBB, {'org.bluez.Device1': device('BBB', '00:16:53:F0:0B:0B', False, rssi=-48)}), serial=40)
fixtures['interfacesRemoved'] = signal('/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved',
                                       '(oas)', (BBB, ['org.bluez.Device1']), serial=41)
fixtures['propertiesChanged'] = signal(AAA, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                                       '(sa{sv}as)', ('org.bluez.Device1', {'Paired': V('b', True), 'RSSI': V('n', -51)}, ['Name']), serial=42)

# The agent: BlueZ calls it, and it answers.
fixtures['registerAgentCall'] = call('/org/bluez', 'org.bluez.AgentManager1', 'RegisterAgent',
                                     '(os)', ('/ev3cockpit/agent', 'KeyboardDisplay'), serial=5)
pin = Gio.DBusMessage.new_method_call(':1.77', '/ev3cockpit/agent', 'org.bluez.Agent1', 'RequestPinCode')
pin.set_body(V('(o)', (AAA,)))
pin.set_serial(90)
pin.set_sender(':1.2')
fixtures['requestPinCodeCall'] = pin
fixtures['requestPinCodeReply'] = reply_to(90, '(s)', ('1234',), serial=8, sender=':1.77')
conf = Gio.DBusMessage.new_method_call(':1.77', '/ev3cockpit/agent', 'org.bluez.Agent1', 'RequestConfirmation')
conf.set_body(V('(ou)', (AAA, 123456)))
conf.set_serial(91)
conf.set_sender(':1.2')
fixtures['requestConfirmationCall'] = conf
empty = reply_to(91, None, None, serial=9, sender=':1.77')
fixtures['emptyReply'] = empty

# An error reply.
err_req = Gio.DBusMessage.new_method_call('org.bluez', AAA, 'org.bluez.Device1', 'Pair')
err_req.set_serial(12)
err_req.set_sender(':1.77')
err = err_req.new_method_error_literal('org.bluez.Error.AuthenticationRejected', 'Authentication Rejected')
err.set_serial(55)
err.set_sender(':1.2')
fixtures['pairRejected'] = err

# Integers of every width and a double, with alignment padding between them.
fixtures['numbers'] = call('/x', 'x.y', 'Numbers', '(ynqiuxtdb)',
                           (0xfe, -2, 0xfffe, -3, 0xfffffffd, -4, 0xfffffffffffffffb, 1.5, True), serial=3)

print('/**')
print(' * D-Bus messages built and serialised by GLib (`scripts/dbus-fixtures.py`), the reference the')
print(' * cockpit\'s own client is tested against (step-7 plan, U3). Generated; do not edit by hand.')
print(' */')
print()
for name, message in fixtures.items():
    blob = message.to_blob(Gio.DBusCapabilityFlags.NONE)
    print(f"export const {name} = '{blob.hex()}';")
