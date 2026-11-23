/**
 * For tests of the `ev3` command: a private daemon on simulated bricks CCC and BBB, which remember
 * Bluetooth peers so that clearing a list has something to ask about, and a way to run the command
 * as its own process.
 *
 * The test starts the daemon itself and keeps a client connected, so the command under test always
 * finds it running on simulated bricks and never starts one of its own on real hardware.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { CockpitClient } from '../client/nativeClient';
import { RunOptions, run } from '../cli/main';
import type { CliIo } from '../cli/output';
import { NativeTestChannel, REPO, nativeTestChannel } from './clientDaemonHelpers';

export const CLI = path.join(REPO, 'out', 'cli', 'main.js');

export interface NativeCliWorld {
	readonly channel: NativeTestChannel;
	/** A VS Code-kind client of the test's own that keeps the native daemon running. */
	readonly observer: CockpitClient;
	/** The environment for `ev3` as its own process: the test channel and the home whose state root holds it. */
	readonly env: NodeJS.ProcessEnv;
	done(): Promise<void>;
}

/**
 * The native daemon on a test channel in matched replay of `scenario`, started by an observer the
 * test keeps connected, so the command under test finds it running and never starts one on real
 * hardware. Only the inputs the scenario's script published (brick AAA and its files) work.
 */
export async function nativeCliWorld(home: string, scenario = 'usb-connect-commands-aaa'): Promise<NativeCliWorld> {
	const channel = nativeTestChannel(home);
	const observer = await CockpitClient.connect(channel.client('vscode', 'development', { name: 'test observer', scenario }));
	observer.onQuestion(() => 'keep');
	return {
		channel, observer,
		env: { ...process.env, LOCALAPPDATA: home, XDG_STATE_HOME: home, EV3_COCKPIT_CHANNEL: channel.channel },
		done: async () => {
			observer.dispose();
			await channel.stop();
		},
	};
}

export interface CliRun {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs `ev3` as its own process; stdin is a pipe, never a terminal. */
export function ev3(args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd?: string }): Promise<CliRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, ...args], { env: options.env, cwd: options.cwd ?? os.tmpdir(), windowsHide: true });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
		child.once('error', reject);
		child.once('close', (code) => resolve({ code, stdout, stderr }));
		child.stdin.end();
	});
}

/** Runs `ev3` in this process with a terminal that answers `typed`; `options` may give it a replay daemon of its own. */
export async function ev3InTerminal(args: readonly string[], typed: string, env: NodeJS.ProcessEnv, isTTY = true, options: RunOptions = {}): Promise<CliRun & { readonly prompt: string }> {
	const stdin = new PassThrough();
	stdin.end(typed);
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let out = '';
	let err = '';
	stdout.on('data', (d: Buffer) => { out += d.toString(); });
	stderr.on('data', (d: Buffer) => { err += d.toString(); });
	const io: CliIo = { stdin, stdout, stderr, isTTY, env, cwd: os.tmpdir() };
	const code = await run(args, io, options);
	return { code, stdout: out, stderr: err, prompt: err };
}
