/**
 * A Bluetooth adapter that has stopped answering, noticed and restarted (HOSTD, 15.11.2026).
 *
 * Measured on HOSTD (a Broadcom BCM2070 on USB): about one inquiry in six to twenty-six ends with
 * the adapter reset on the USB bus, after which it answers no command. The kernel logs "command
 * 0x0402 tx timeout" every minute; BlueZ refuses to start a discovery or to stop ours
 * (InProgress); every connect and presence check runs into the dead radio. Switching the adapter
 * off through BlueZ fails the same way. What brings it back is the kernel reading it again, as if
 * it had been plugged in: 0 and then 1 written to the USB device's `authorized` file.
 *
 * The owner's rule (15.11.2026): an administrative step is taken only with the user's consent,
 * given once or each time. On Linux the consent is the udev rule that ships with the extension
 * (`LINUX_BT_RESTART_RULE_PATH`), installed once by the user, which lets the group plugdev write
 * that file. Without it the cockpit says once what happened and how to allow the restart.
 *
 * In order: two windows in a row in which the radio refused (one can be a race with another
 * client); then switching it off and on through BlueZ, which costs nothing when it works; then the
 * `authorized` file. While the adapter is known dead and cannot be restarted the radio is left
 * alone, an inquiry tried again every ten minutes, until the adapter goes and comes back.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { CallOptions } from './dbus/connection';
import { Variant, type DBusValue } from './dbus/wire';
import { BLUEZ, type BluezAdapter } from './bluezObjects';
import type { InquiryOutcome } from './bluezPresence';

/** The rule that lets the cockpit restart a USB Bluetooth adapter, in the extension's folder. */
export const LINUX_BT_RESTART_RULE_PATH = 'native/linux/71-ev3-cockpit-bluetooth-restart.rules';

/** How the user allows the restart. */
export function linuxBtRestartAdvice(rulePath?: string): string {
	return 'To let the cockpit restart it, install the udev rule that ships with the extension: copy '
		+ `${rulePath ?? `${LINUX_BT_RESTART_RULE_PATH} from the extension's folder`} to /etc/udev/rules.d/, `
		+ 'run "sudo udevadm control --reload", then plug the adapter in again. The user must be in the group plugdev.';
}

/** The adapter's USB device in sysfs; a seam for tests. */
export interface RadioSysfs {
	/** The `authorized` file of the USB device under `hciN`, or undefined when it is not on USB. */
	authorizedFile(hci: string): string | undefined;
	writable(file: string): boolean;
	write(file: string, value: '0' | '1'): void;
}

export const linuxRadioSysfs: RadioSysfs = {
	authorizedFile(hci) {
		if (!/^hci\d+$/.test(hci)) { return undefined; }
		try {
			// hciN/device is the USB interface the driver bound; its parent is the USB device.
			const device = path.dirname(fs.realpathSync(`/sys/class/bluetooth/${hci}/device`));
			if (!fs.existsSync(path.join(device, 'idVendor'))) { return undefined; }
			const file = path.join(device, 'authorized');
			return fs.existsSync(file) ? file : undefined;
		} catch {
			return undefined;
		}
	},
	writable(file) {
		try { fs.accessSync(file, fs.constants.W_OK); return true; } catch { return false; }
	},
	write(file, value) { fs.writeFileSync(file, value); },
};

export interface BluezRadioWatchOptions {
	bus: { call(options: CallOptions): Promise<DBusValue[]> };
	cache: { adapter(): BluezAdapter | undefined; onChange(handler: () => void): () => void };
	log: { info(message: string): void; warn(message: string): void };
	/** The shipped rule's absolute path, for the advice. */
	rulePath?: string;
	/** For tests; default this host's sysfs. */
	sysfs?: RadioSysfs;
	/** Windows in a row the radio must refuse before it counts as stopped (default 2). */
	windowsBeforeRestart?: number;
	/** Between writing 0 and 1 (default 3 s, as measured on HOSTD). */
	replugPauseMs?: number;
	/**
	 * Restarts allowed within `RESTART_SPAN_MS`; past them the adapter is left alone (default 3).
	 * An adapter that stops again right after each restart is broken, not flaky: HOSTD's stopped
	 * six to twenty-six minutes apart, a broken one would every two (two refused windows).
	 */
	restartsPerSpan?: number;
	/** While left alone, how often an inquiry is tried again (default 10 min). */
	probeEveryMs?: number;
	/** For tests. */
	now?: () => number;
}

const RESTART_SPAN_MS = 900_000;
/** A switch off and on tried within this long is not tried again: it did not help, or it failed. */
const SWITCH_HELPED_MS = 600_000;
/** The adapter coming back within this long of our own replug is ours coming back, not a new one. */
const OWN_REPLUG_MS = 60_000;

export class BluezRadioWatch {
	private stuckWindows = 0;
	private restarting = false;
	private disposed = false;
	/** Why the radio is being left alone, when it is. */
	private leftAlone: string | undefined;
	private leftAloneAt = 0;
	private restarts: number[] = [];
	private switchTriedAt: number | undefined;
	private ownReplugAt: number | undefined;
	private adapterPresent: boolean;
	private readonly detach: () => void;
	private readonly sysfs: RadioSysfs;
	private readonly now: () => number;

	constructor(private readonly options: BluezRadioWatchOptions) {
		this.sysfs = options.sysfs ?? linuxRadioSysfs;
		this.now = options.now ?? Date.now;
		this.adapterPresent = Boolean(options.cache.adapter());
		this.detach = options.cache.onChange(() => this.adapterSeen());
	}

	/** Presence checks wait: while the adapter is restarted, and while it is known dead. */
	get checksHeld(): boolean {
		return this.disposed || this.restarting || this.leftAlone !== undefined;
	}

	/**
	 * Inquiries wait too, except one every `probeEveryMs` while the adapter is known dead, which
	 * may find it answering again (codex review: a probe for the inquiry alone, not the checks).
	 */
	get inquiryHeld(): boolean {
		if (this.disposed || this.restarting) { return true; }
		if (this.leftAlone === undefined) { return false; }
		return this.now() - this.leftAloneAt < (this.options.probeEveryMs ?? 600_000);
	}

	/**
	 * What one inquiry window said about the radio. Settles once a restart it started is over: the
	 * inquiry awaits it, so the restart runs while the inquiry still holds the Bluetooth queue and
	 * no pairing or connect can start meanwhile (codex review).
	 */
	async noteWindow(outcome: InquiryOutcome): Promise<void> {
		if (this.disposed || this.restarting) { return; }
		if (outcome.radio === 'answered') {
			this.stuckWindows = 0;
			if (this.leftAlone !== undefined) { this.back('it answered again'); }
			return;
		}
		if (this.leftAlone !== undefined) {
			// A probe that found it still dead, or found out nothing: wait another while.
			this.leftAloneAt = this.now();
			return;
		}
		// A window that says nothing either way neither counts nor breaks a run of stuck ones.
		if (outcome.radio === 'unclear') { return; }
		this.stuckWindows += 1;
		if (this.stuckWindows < (this.options.windowsBeforeRestart ?? 2)) { return; }
		this.stuckWindows = 0;
		await this.restart(outcome.detail ?? 'it refused a discovery');
	}

	/** Nothing new is started after this; an adapter already taken off is still read again. */
	dispose(): void {
		this.disposed = true;
		this.detach();
	}

	private async restart(detail: string): Promise<void> {
		const adapter = this.options.cache.adapter();
		if (!adapter) { return; }
		const hci = adapter.path.split('/').pop() ?? adapter.path;
		const now = this.now();
		this.restarts = this.restarts.filter((at) => now - at < RESTART_SPAN_MS);
		if (this.restarts.length >= (this.options.restartsPerSpan ?? 3)) {
			this.leaveAlone(`The Bluetooth adapter ${hci} has stopped answering again, ${this.restarts.length} times within 15 minutes; `
				+ 'the cockpit leaves it alone and does not look for Bluetooth bricks until it answers again.');
			return;
		}
		this.restarting = true;
		try {
			this.options.log.warn(`The Bluetooth adapter ${hci} has stopped answering (${detail}); restarting it.`);
			// Tried not long ago: it either failed or did not help. Read the adapter afresh instead.
			const switchedLately = this.switchTriedAt !== undefined && now - this.switchTriedAt < SWITCH_HELPED_MS;
			if (!switchedLately) {
				this.switchTriedAt = now;
				if (await this.switchOffAndOn(adapter.path)) {
					this.restarts.push(this.now());
					this.options.log.info(`Restarted the Bluetooth adapter ${hci} by switching it off and on.`);
					return;
				}
			}
			if (this.disposed) { return; }
			const file = this.sysfs.authorizedFile(hci);
			if (!file) {
				this.leaveAlone(`The cockpit cannot restart the Bluetooth adapter ${hci}: it is not a USB adapter. `
					+ 'Switching Bluetooth off and on may bring it back; until then Bluetooth bricks are not looked for.');
				return;
			}
			if (!this.sysfs.writable(file)) {
				this.leaveAlone(`The cockpit may not restart the Bluetooth adapter ${hci}. ${linuxBtRestartAdvice(this.options.rulePath)} `
					+ 'Until then, plug the adapter out and in again; Bluetooth bricks are not looked for meanwhile.');
				return;
			}
			this.ownReplugAt = this.now();
			// Taken off and read again whatever happens meanwhile, dispose included: never left off.
			this.sysfs.write(file, '0');
			await new Promise((resolve) => setTimeout(resolve, this.options.replugPauseMs ?? 3_000));
			this.sysfs.write(file, '1');
			this.restarts.push(this.now());
			this.options.log.info(`Restarted the Bluetooth adapter ${hci}: the system read it again, as if it had been plugged in again.`);
		} catch (error) {
			this.leaveAlone(`Restarting the Bluetooth adapter ${hci} failed (${error instanceof Error ? error.message : String(error)}); `
				+ 'plug it out and in again. Until then Bluetooth bricks are not looked for.');
		} finally {
			this.restarting = false;
		}
	}

	/** Through BlueZ; true when it went off and came back on. A dead radio refuses the first. */
	private async switchOffAndOn(adapterPath: string): Promise<boolean> {
		const set = (on: boolean): Promise<DBusValue[]> => this.options.bus.call({
			destination: BLUEZ, path: adapterPath, interface: 'org.freedesktop.DBus.Properties', member: 'Set',
			signature: 'ssv', body: ['org.bluez.Adapter1', 'Powered', new Variant('b', on)],
		});
		try {
			await set(false);
		} catch {
			return false;
		}
		try {
			await set(true);
			return true;
		} catch {
			// Off but not on again: the next step reads it afresh, and BlueZ switches it on then.
			return false;
		}
	}

	/** Said once: while left alone no restart is tried, so nothing comes here again until it is back. */
	private leaveAlone(message: string): void {
		this.leftAlone = message;
		this.leftAloneAt = this.now();
		this.options.log.warn(message);
	}

	private back(how: string): void {
		this.leftAlone = undefined;
		this.stuckWindows = 0;
		this.options.log.info(`The Bluetooth adapter is back (${how}); Bluetooth bricks are looked for again.`);
	}

	/**
	 * The adapter went and came back. After our own replug it is ours coming back, and the restart
	 * budget stands; otherwise (plugged in again by hand, another adapter, BlueZ restarted) it is a
	 * fresh start (codex review).
	 */
	private adapterSeen(): void {
		const present = Boolean(this.options.cache.adapter());
		if (present && !this.adapterPresent) {
			this.stuckWindows = 0;
			const own = this.ownReplugAt !== undefined && this.now() - this.ownReplugAt < OWN_REPLUG_MS;
			this.ownReplugAt = undefined;
			if (!own) {
				this.restarts = [];
				this.switchTriedAt = undefined;
			}
			if (this.leftAlone !== undefined) { this.back('the adapter came back'); }
		}
		this.adapterPresent = present;
	}
}
