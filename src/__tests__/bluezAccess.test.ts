/**
 * Owner decision D4 (step-7 plan, U4): where the D-Bus policy keeps the user from BlueZ, the cockpit
 * offers to add them to the `bluetooth` group and, on their confirmation, runs it — through
 * `pkexec`, so polkit asks for the password and none passes through the cockpit. Fixed argv, no
 * shell, the user from `os.userInfo()`; and nothing at all without a yes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';

import { offerBluetoothGroup, isBluezAccessDenied, manualGroupCommand } from '../transports/bluezAccess';
import { DBusError } from '../transports/dbus/connection';

interface Spawned { file: string; args: readonly string[]; options: Record<string, unknown> }

function fakeSpawn(outcome: { exit?: number; error?: NodeJS.ErrnoException }): { spawn: never; runs: Spawned[] } {
	const runs: Spawned[] = [];
	const spawn = (file: string, args: readonly string[], options: Record<string, unknown>) => {
		runs.push({ file, args, options });
		const child = new EventEmitter();
		setImmediate(() => {
			if (outcome.error) { child.emit('error', outcome.error); } else { child.emit('exit', outcome.exit ?? 0, null); }
		});
		return child;
	};
	return { spawn: spawn as never, runs };
}

const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

describe('BlueZ access — telling the refusal apart', () => {
	it('recognises the bus refusing this user', () => {
		assert.equal(isBluezAccessDenied(new DBusError('org.freedesktop.DBus.Error.AccessDenied', 'Rejected send message')), true);
		assert.equal(isBluezAccessDenied(new DBusError('org.bluez.Error.Failed', 'x')), false);
		assert.equal(isBluezAccessDenied(new Error('AccessDenied')), false);
	});
});

describe('BlueZ access — the bluetooth group, offered and run (D4)', () => {
	it('runs nothing when the user does not confirm', async () => {
		const { spawn, runs } = fakeSpawn({ exit: 0 });
		const result = await offerBluetoothGroup({ confirm: no, spawn, username: () => 'alice' });
		assert.deepEqual(result, { kind: 'declined' });
		assert.deepEqual(runs, []);
	});

	it('shows the exact command it would run, before running it', async () => {
		const { spawn } = fakeSpawn({ exit: 0 });
		let shown = '';
		await offerBluetoothGroup({ confirm: async (prompt) => { shown = prompt.command; return false; }, spawn, username: () => 'alice' });
		assert.equal(shown, 'pkexec usermod -aG bluetooth alice');
	});

	it('runs exactly pkexec usermod -aG bluetooth <user>, with no shell', async () => {
		const { spawn, runs } = fakeSpawn({ exit: 0 });
		await offerBluetoothGroup({ confirm: yes, spawn, username: () => 'alice' });
		assert.equal(runs.length, 1);
		assert.equal(runs[0].file, 'pkexec');
		assert.deepEqual(runs[0].args, ['usermod', '-aG', 'bluetooth', 'alice']);
		assert.notEqual(runs[0].options.shell, true);
	});

	it('says the change applies after logging out and in, and offers to check again', async () => {
		const { spawn } = fakeSpawn({ exit: 0 });
		const result = await offerBluetoothGroup({ confirm: yes, spawn, username: () => 'alice' });
		assert.equal(result.kind, 'added');
		assert.match((result as { message: string }).message, /log out and in|newgrp/);
	});

	it('hands back the command to copy when pkexec is not installed', async () => {
		const enoent = Object.assign(new Error('spawn pkexec ENOENT'), { code: 'ENOENT' });
		const { spawn } = fakeSpawn({ error: enoent });
		const result = await offerBluetoothGroup({ confirm: yes, spawn, username: () => 'alice' });
		assert.deepEqual(result, { kind: 'manual', command: 'sudo usermod -aG bluetooth alice', reason: 'pkexec is not installed' });
	});

	it('hands back the command to copy when no polkit agent can ask (exit 127: headless, SSH, Remote)', async () => {
		const { spawn } = fakeSpawn({ exit: 127 });
		const result = await offerBluetoothGroup({ confirm: yes, spawn, username: () => 'alice' });
		assert.equal(result.kind, 'manual');
		assert.match((result as { reason: string }).reason, /polkit/);
	});

	it('reports a password dialog the user dismissed as cancelled (exit 126)', async () => {
		const { spawn } = fakeSpawn({ exit: 126 });
		assert.deepEqual(await offerBluetoothGroup({ confirm: yes, spawn, username: () => 'alice' }), { kind: 'cancelled' });
	});

	it('hands back the command for any other failure', async () => {
		const { spawn } = fakeSpawn({ exit: 1 });
		const result = await offerBluetoothGroup({ confirm: yes, spawn, username: () => 'alice' });
		assert.equal(result.kind, 'manual');
		assert.match((result as { reason: string }).reason, /exit 1/);
	});

	it('never runs anything for a user name that is not a plain account name', async () => {
		for (const name of ['x; rm -rf ~', '-oops', '', 'a b', 'a'.repeat(40)]) {
			const { spawn, runs } = fakeSpawn({ exit: 0 });
			let asked = false;
			const result = await offerBluetoothGroup({ confirm: async () => { asked = true; return true; }, spawn, username: () => name });
			assert.equal(result.kind, 'manual', name);
			assert.deepEqual(runs, [], name);
			assert.equal(asked, false, `no offer to run for ${JSON.stringify(name)}`);
		}
	});

	it('writes the command to copy with sudo', () => {
		assert.equal(manualGroupCommand('alice'), 'sudo usermod -aG bluetooth alice');
	});
});
