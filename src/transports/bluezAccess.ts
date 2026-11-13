/**
 * Owner decision D4 (step-7 plan, 13.11.2026): a distribution whose D-Bus policy limits BlueZ to
 * the `bluetooth` group. The cockpit offers to add the user to it and, when they confirm, runs it
 * itself — through `pkexec`, so polkit shows its own system dialog and no password passes through
 * the cockpit. The user comes from `os.userInfo()`, never from input; the argv is fixed and there
 * is no shell. Where `pkexec` or a polkit agent is missing (headless, SSH, VS Code Remote) the
 * cockpit hands back the command to copy. Nothing runs without a yes.
 *
 * Debian 13 / Raspberry Pi OS need none of this: their policy lets a desktop user talk to BlueZ
 * (HOSTC, 13.11.2026).
 */

import * as childProcess from 'child_process';
import * as os from 'os';

import { DBusError } from './dbus/connection';

export const BLUETOOTH_GROUP = 'bluetooth';

/** A plain account name: what `useradd` accepts by default. Anything else is never run. */
const ACCOUNT_NAME = /^[a-z_][a-z0-9_.-]{0,30}\$?$/i;

/** The bus refused this user a message to BlueZ. */
export function isBluezAccessDenied(error: unknown): boolean {
	return error instanceof DBusError && error.dbusName === 'org.freedesktop.DBus.Error.AccessDenied';
}

/** What the user can run themselves. */
export function manualGroupCommand(user: string): string {
	return `sudo usermod -aG ${BLUETOOTH_GROUP} ${user}`;
}

export type GroupFixResult =
	/** The user said no; nothing ran. */
	| { kind: 'declined' }
	/** Added; it applies to new logins. */
	| { kind: 'added'; message: string }
	/** The polkit dialog was dismissed or refused. */
	| { kind: 'cancelled' }
	/** It could not run here; the command to copy, and why. */
	| { kind: 'manual'; command: string; reason: string };

type SpawnLike = (file: string, args: readonly string[], options: childProcess.SpawnOptions) => {
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
};

export interface GroupFixOptions {
	/** Asks the user, showing the exact command. Only a resolved `true` runs it. */
	confirm: (prompt: { message: string; command: string }) => Promise<boolean>;
	/** For tests; default `child_process.spawn`. */
	spawn?: SpawnLike;
	/** For tests; default `os.userInfo().username`. */
	username?: () => string;
}

/**
 * Offers to add this user to the `bluetooth` group, and runs it on a yes.
 *
 * `pkexec` exits 126 when the dialog is dismissed or authorisation refused, and 127 when it cannot
 * ask at all (no polkit agent); both, and a missing `pkexec`, are told apart from a real failure.
 */
export async function offerBluetoothGroup(options: GroupFixOptions): Promise<GroupFixResult> {
	const user = (options.username ?? (() => os.userInfo().username))();
	if (!ACCOUNT_NAME.test(user)) {
		return { kind: 'manual', command: manualGroupCommand('<your user name>'), reason: 'the account name is not one the cockpit will pass on' };
	}
	const argv = ['usermod', '-aG', BLUETOOTH_GROUP, user] as const;
	const command = `pkexec ${argv.join(' ')}`;
	const confirmed = await options.confirm({
		message: `This system lets only members of the "${BLUETOOTH_GROUP}" group use Bluetooth. `
			+ `Add ${user} to it? Your system will ask for your password.`,
		command,
	});
	if (confirmed !== true) { return { kind: 'declined' }; }

	const spawn: SpawnLike = options.spawn ?? (childProcess.spawn as unknown as SpawnLike);
	const outcome = await new Promise<{ code: number | null } | { error: NodeJS.ErrnoException }>((resolve) => {
		try {
			const child = spawn('pkexec', argv, { shell: false, stdio: 'ignore' });
			child.on('error', (error) => resolve({ error }));
			child.on('exit', (code) => resolve({ code }));
		} catch (error) {
			resolve({ error: error as NodeJS.ErrnoException });
		}
	});

	const manual = (reason: string): GroupFixResult => ({ kind: 'manual', command: manualGroupCommand(user), reason });
	if ('error' in outcome) {
		return manual(outcome.error.code === 'ENOENT' ? 'pkexec is not installed' : `pkexec could not start (${outcome.error.message})`);
	}
	switch (outcome.code) {
	case 0:
		return {
			kind: 'added',
			message: `${user} is now in the "${BLUETOOTH_GROUP}" group. It applies to new logins: log out and in `
				+ '(or run "newgrp bluetooth" in a terminal), then check Bluetooth again.',
		};
	case 126:
		return { kind: 'cancelled' };
	case 127:
		return manual('no polkit agent could ask for the password (headless, SSH or a remote session)');
	default:
		return manual(`pkexec ended with exit ${outcome.code}`);
	}
}
