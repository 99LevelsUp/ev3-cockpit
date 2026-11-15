/**
 * A Bluetooth adapter that has stopped answering, noticed and restarted (HOSTD, 15.11.2026).
 *
 * Measured on HOSTD: a Broadcom BCM2070 on USB is reset on the bus near the end of about one
 * inquiry in six to twenty-six and then answers nothing; BlueZ refuses our StopDiscovery with
 * InProgress (or the next StartDiscovery), switching it off through BlueZ fails, and 0 then 1
 * written to the USB device's `authorized` file brings it back.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BluezRadioWatch, linuxBtRestartAdvice, LINUX_BT_RESTART_RULE_PATH, type RadioSysfs } from '../transports/bluezRadioWatch';
import type { BluezAdapter } from '../transports/bluezObjects';
import type { DBusValue, Variant } from '../transports/dbus/wire';
import { DBusError } from '../transports/dbus/connection';

const AUTH = '/sys/devices/pci0000:00/usb4/4-4/authorized';
const STUCK = { radio: 'stuck', detail: 'StopDiscovery: org.bluez.Error.InProgress: Operation already in progress' } as const;
const FINE = { radio: 'answered' } as const;
const UNCLEAR = { radio: 'unclear' } as const;

class World {
	adapterNow: BluezAdapter | undefined = { path: '/org/bluez/hci0', address: undefined, alias: 'HOSTD', powered: true, discovering: false };
	handlers = new Set<() => void>();
	/** Set Powered calls, as on/off. */
	powered: boolean[] = [];
	/** Switching off through BlueZ fails, as on a dead radio. */
	offFails = true;
	/** Switching off answers once this settles. */
	offGate?: Promise<void>;
	writes: string[] = [];
	file: string | undefined = AUTH;
	canWrite = true;
	warns: string[] = [];
	infos: string[] = [];
	clock = 1_000_000;

	readonly cache = {
		adapter: (): BluezAdapter | undefined => this.adapterNow,
		onChange: (h: () => void): (() => void) => { this.handlers.add(h); return () => this.handlers.delete(h); },
	};
	readonly bus = {
		call: async (o: { member: string; body?: DBusValue[] }): Promise<DBusValue[]> => {
			if (o.member === 'Set') {
				const on = (o.body![2] as Variant).value as boolean;
				this.powered.push(on);
				if (!on && this.offGate) { await this.offGate; }
				if (!on && this.offFails) { throw new DBusError('org.bluez.Error.Failed', 'Failed'); }
			}
			return [];
		},
	};
	readonly sysfs: RadioSysfs = {
		authorizedFile: (hci) => (hci === 'hci0' ? this.file : undefined),
		writable: () => this.canWrite,
		write: (file, value) => { this.writes.push(`${file}=${value}`); },
	};
	readonly log = { info: (m: string): void => { this.infos.push(m); }, warn: (m: string): void => { this.warns.push(m); } };

	watch(extra: Partial<ConstructorParameters<typeof BluezRadioWatch>[0]> = {}): BluezRadioWatch {
		return new BluezRadioWatch({
			bus: this.bus, cache: this.cache, log: this.log, sysfs: this.sysfs, replugPauseMs: 1,
			rulePath: '/home/user/.vscode/extensions/ev3-cockpit/native/linux/71-ev3-cockpit-bluetooth-restart.rules',
			now: () => this.clock, ...extra,
		});
	}
	changed(): void { for (const h of [...this.handlers]) { h(); } }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('BluezRadioWatch — an adapter that stopped answering (HOSTD, 15.11.2026)', () => {
	it('after two refused windows in a row, reads a USB adapter again through its authorized file: 0, then 1', async () => {
		const w = new World();
		const watch = w.watch();
		watch.noteWindow(STUCK);
		await settle();
		assert.deepEqual(w.writes, [], 'one refused window can be a race');
		watch.noteWindow(STUCK);
		await settle();
		assert.deepEqual(w.powered, [false], 'switching it off through BlueZ is tried first, and refused');
		assert.deepEqual(w.writes, [`${AUTH}=0`, `${AUTH}=1`]);
		assert.match(w.warns[0], /hci0 has stopped answering \(StopDiscovery: org\.bluez\.Error\.InProgress/);
		assert.match(w.infos.at(-1)!, /Restarted the Bluetooth adapter hci0: the system read it again/);
		assert.deepEqual([watch.inquiryHeld, watch.checksHeld], [false, false]);
		watch.dispose();
	});

	it('does nothing when a refused window is followed by one that went well', async () => {
		const w = new World();
		const watch = w.watch();
		watch.noteWindow(STUCK);
		watch.noteWindow(FINE);
		watch.noteWindow(STUCK);
		await settle();
		assert.deepEqual([w.powered, w.writes, w.warns], [[], [], []]);
		watch.dispose();
	});

	it('restarts by switching it off and on when BlueZ can, and reads it afresh if it stops again soon after', async () => {
		const w = new World();
		w.offFails = false;
		const watch = w.watch();
		watch.noteWindow(STUCK);
		watch.noteWindow(STUCK);
		await settle();
		assert.deepEqual(w.powered, [false, true]);
		assert.deepEqual(w.writes, []);
		assert.match(w.infos.at(-1)!, /by switching it off and on/);
		w.clock += 120_000;
		watch.noteWindow(STUCK);
		watch.noteWindow(STUCK);
		await settle();
		assert.deepEqual(w.powered, [false, true], 'switching did not help: not tried again');
		assert.deepEqual(w.writes, [`${AUTH}=0`, `${AUTH}=1`]);
		watch.dispose();
	});

	it('when this user may not restart it, says once what happened and how to allow it, and leaves the radio alone', async () => {
		const w = new World();
		w.canWrite = false;
		const watch = w.watch();
		watch.noteWindow(STUCK);
		watch.noteWindow(STUCK);
		await settle();
		assert.deepEqual(w.writes, []);
		const said = w.warns.filter((m) => /may not restart/.test(m));
		assert.equal(said.length, 1);
		assert.match(said[0], /\/home\/user\/\.vscode\/extensions\/ev3-cockpit\/native\/linux\/71-ev3-cockpit-bluetooth-restart\.rules/);
		assert.match(said[0], /plugdev/);
		assert.deepEqual([watch.inquiryHeld, watch.checksHeld], [true, true], 'no inquiry or check into a dead radio');
		// Ten minutes on, one inquiry may try again, and only the inquiry (codex review); still refused: nothing said again.
		w.clock += 600_000;
		assert.deepEqual([watch.inquiryHeld, watch.checksHeld], [false, true]);
		watch.noteWindow(STUCK);
		watch.noteWindow(STUCK);
		await settle();
		assert.equal(watch.inquiryHeld, true);
		assert.equal(w.warns.filter((m) => /may not restart/.test(m)).length, 1);
		watch.dispose();
	});

	it('looks again when the adapter goes and comes back (plugged in again, BlueZ restarted)', async () => {
		const w = new World();
		w.canWrite = false;
		const watch = w.watch();
		watch.noteWindow(STUCK);
		watch.noteWindow(STUCK);
		await settle();
		assert.equal(watch.inquiryHeld, true);
		w.adapterNow = undefined;
		w.changed();
		assert.equal(watch.inquiryHeld, true);
		w.adapterNow = { path: '/org/bluez/hci0', address: undefined, alias: 'HOSTD', powered: true, discovering: false };
		w.changed();
		assert.deepEqual([watch.inquiryHeld, watch.checksHeld], [false, false]);
		assert.match(w.infos.at(-1)!, /adapter is back \(the adapter came back\)/);
		watch.dispose();
	});

	it('looks again when a later inquiry finds the radio answering', async () => {
		const w = new World();
		w.file = undefined;
		const watch = w.watch();
		watch.noteWindow(STUCK);
		watch.noteWindow(STUCK);
		await settle();
		assert.match(w.warns.at(-1)!, /cannot restart the Bluetooth adapter hci0: it is not a USB adapter/);
		w.clock += 600_000;
		await watch.noteWindow(FINE);
		assert.deepEqual([watch.inquiryHeld, watch.checksHeld], [false, false]);
		assert.match(w.infos.at(-1)!, /it answered again/);
		watch.dispose();
	});

	it('leaves the radio alone while restarting it: no inquiry or check meanwhile', async () => {
		const w = new World();
		const watch = w.watch({ replugPauseMs: 60 });
		watch.noteWindow(STUCK);
		watch.noteWindow(STUCK);
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual([watch.inquiryHeld, watch.checksHeld], [true, true]);
		await new Promise((r) => setTimeout(r, 120));
		assert.deepEqual([watch.inquiryHeld, watch.checksHeld], [false, false]);
		watch.dispose();
	});

	it('restarts at most three times within 15 minutes, then leaves it alone and says so once', async () => {
		const w = new World();
		const watch = w.watch();
		for (let i = 0; i < 4; i += 1) {
			watch.noteWindow(STUCK);
			watch.noteWindow(STUCK);
			await settle();
			w.clock += 60_000;
		}
		assert.equal(w.writes.length, 6, 'three restarts');
		assert.match(w.warns.at(-1)!, /stopped answering again, 3 times within 15 minutes/);
		assert.equal(watch.inquiryHeld, true);
		watch.dispose();
	});

	it('keeps restarting an adapter that stops now and then, as HOSTD\'s did six to twenty-six minutes apart', async () => {
		const w = new World();
		const watch = w.watch();
		for (let i = 0; i < 5; i += 1) {
			watch.noteWindow(STUCK);
			watch.noteWindow(STUCK);
			await settle();
			w.clock += 6 * 60_000;
		}
		assert.equal(w.writes.length, 10, 'five restarts');
		assert.equal(watch.inquiryHeld, false);
		watch.dispose();
	});

	it('a restart is over when the window that started it is: the window still holds the Bluetooth queue (codex review)', async () => {
		const w = new World();
		const watch = w.watch({ replugPauseMs: 40 });
		await watch.noteWindow(STUCK);
		await watch.noteWindow(STUCK);
		assert.deepEqual(w.writes, [`${AUTH}=0`, `${AUTH}=1`], 'done before the window returns');
		watch.dispose();
	});

	it('starts nothing after dispose, and still reads again an adapter it had taken off (codex review)', async () => {
		const before = new World();
		const disposedFirst = before.watch();
		disposedFirst.dispose();
		await disposedFirst.noteWindow(STUCK);
		await disposedFirst.noteWindow(STUCK);
		assert.deepEqual([before.powered, before.writes], [[], []]);

		const w = new World();
		const watch = w.watch({ replugPauseMs: 60 });
		await watch.noteWindow(STUCK);
		const restarting = watch.noteWindow(STUCK);
		await new Promise((r) => setTimeout(r, 15));
		assert.deepEqual(w.writes, [`${AUTH}=0`]);
		watch.dispose();
		await restarting;
		assert.deepEqual(w.writes, [`${AUTH}=0`, `${AUTH}=1`], 'never left taken off');

		// Disposed while BlueZ is still asked to switch it off: the file is not touched after.
		const late = new World();
		let answer = (): void => undefined;
		late.offGate = new Promise<void>((r) => { answer = r; });
		const lateWatch = late.watch();
		await lateWatch.noteWindow(STUCK);
		const pending = lateWatch.noteWindow(STUCK);
		await new Promise((r) => setTimeout(r, 10));
		lateWatch.dispose();
		answer();
		await pending;
		assert.deepEqual(late.writes, []);
	});

	it('does not try switching off through BlueZ again within ten minutes of a try that failed (codex review)', async () => {
		const w = new World();
		const watch = w.watch();
		await watch.noteWindow(STUCK);
		await watch.noteWindow(STUCK);
		assert.deepEqual(w.powered, [false]);
		w.clock += 6 * 60_000;
		await watch.noteWindow(STUCK);
		await watch.noteWindow(STUCK);
		assert.deepEqual(w.powered, [false], 'not tried again');
		assert.equal(w.writes.length, 4, 'read again through the file both times');
		w.clock += 11 * 60_000;
		await watch.noteWindow(STUCK);
		await watch.noteWindow(STUCK);
		assert.deepEqual(w.powered, [false, false], 'tried again after ten minutes');
		watch.dispose();
	});

	it('an adapter plugged in again by hand starts afresh; its own replug keeps the budget (codex review)', async () => {
		const w = new World();
		const watch = w.watch();
		const goAndCome = (): void => {
			const adapter = w.adapterNow;
			w.adapterNow = undefined; w.changed();
			w.adapterNow = adapter; w.changed();
		};
		for (let i = 0; i < 3; i += 1) {
			await watch.noteWindow(STUCK);
			await watch.noteWindow(STUCK);
			goAndCome();   // our replug coming back
			w.clock += 60_000;
		}
		assert.equal(w.writes.length, 6);
		await watch.noteWindow(STUCK);
		await watch.noteWindow(STUCK);
		assert.equal(w.writes.length, 6, 'the budget stood across its own replugs');
		assert.match(w.warns.at(-1)!, /3 times within 15 minutes/);
		goAndCome();       // the user plugs it in again
		await watch.noteWindow(STUCK);
		await watch.noteWindow(STUCK);
		assert.equal(w.writes.length, 8, 'a fresh start after a replug by hand');
		watch.dispose();
	});

	it('a window that says nothing either way neither counts as stuck nor breaks a run (codex confirmation)', async () => {
		const w = new World();
		const watch = w.watch();
		await watch.noteWindow(UNCLEAR);
		await watch.noteWindow(UNCLEAR);
		assert.deepEqual([w.powered, w.writes], [[], []], 'switched off, no permission: not a dead radio');
		await watch.noteWindow(STUCK);
		await watch.noteWindow(UNCLEAR);
		await watch.noteWindow(STUCK);
		assert.equal(w.writes.length, 2);
		watch.dispose();
	});

	it('a probe that finds out nothing keeps the dead radio left alone (codex confirmation)', async () => {
		const w = new World();
		w.canWrite = false;
		const watch = w.watch();
		await watch.noteWindow(STUCK);
		await watch.noteWindow(STUCK);
		w.clock += 600_000;
		assert.equal(watch.inquiryHeld, false, 'the probe may run');
		await watch.noteWindow(UNCLEAR);
		assert.deepEqual([watch.inquiryHeld, watch.checksHeld], [true, true], 'still held, the probe interval renewed');
		assert.ok(!w.infos.some((m) => /is back/.test(m)));
		watch.dispose();
	});

	it('names the shipped rule in its advice', () => {
		assert.equal(LINUX_BT_RESTART_RULE_PATH, 'native/linux/71-ev3-cockpit-bluetooth-restart.rules');
		assert.match(linuxBtRestartAdvice(), /native\/linux\/71-ev3-cockpit-bluetooth-restart\.rules from the extension's folder/);
	});
});
