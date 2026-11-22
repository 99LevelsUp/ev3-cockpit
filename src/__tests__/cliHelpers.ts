/**
 * For tests of the `ev3` command: a private daemon on simulated bricks CCC and BBB, which remember
 * Bluetooth peers so that clearing a list has something to ask about, and a way to run the command
 * as its own process.
 *
 * The test starts the daemon itself and keeps a client connected, so the command under test always
 * finds it running on simulated bricks and never starts one of its own on real hardware.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { CockpitClient } from '../client';
import { NativeCockpitClient } from '../client/nativeClient';
import { RunOptions, run } from '../cli/main';
import type { CliIo } from '../cli/output';
import { NativeTestChannel, REPO, TestDaemon, nativeTestChannel, testDaemon } from './clientDaemonHelpers';

export const CLI = path.join(REPO, 'out', 'cli', 'main.js');

function mockBrick(id: string, peers: string[]): Record<string, unknown> {
	return {
		id, displayName: id, firmwareVersion: 'V1.10E', battery: { level: 80, voltage: 7.5 },
		motorPorts: [], sensorPorts: [], bluetoothPeers: peers,
		filesystem: [{ path: '/home/root/lms2012/prjs/Demo/Demo.rbf', content: '' }],
	};
}

export interface CliWorld {
	readonly daemon: TestDaemon;
	/** A client of the test's own that keeps the daemon running. */
	readonly observer: CockpitClient;
	readonly env: NodeJS.ProcessEnv;
	done(): Promise<void>;
}

export async function cliWorld(home: string): Promise<CliWorld> {
	const workspace = fs.mkdtempSync(path.join(home, 'ws-'));
	fs.mkdirSync(path.join(workspace, '.vscode'));
	fs.writeFileSync(path.join(workspace, '.vscode', 'ev3-cockpit-mock.json'), JSON.stringify({
		transport: 'mock',
		bricks: [mockBrick('CCC', ['HOSTA', 'HOSTB']), mockBrick('BBB', ['HOSTA'])],
	}));
	const base = testDaemon(home, '0.0.1', 1000);
	const daemon = { ...base, launchArgs: [...base.launchArgs, '--mock-workspace', workspace] };
	const observer = await CockpitClient.connect({
		name: 'test observer', kind: 'vscode', version: '0.0.1', paths: daemon.paths, launch: daemon.launch, launchArgs: daemon.launchArgs,
	});
	const env = { ...process.env, EV3_COCKPIT_CHANNEL: daemon.channel };
	return {
		daemon, observer, env,
		done: async () => {
			for (const brick of await observer.request('bricks/list', {})) {
				if (brick.connected) { await observer.request('bricks/disconnect', { brick: brick.brickId, forEveryone: true }).catch(() => undefined); }
			}
			observer.dispose();
		},
	};
}

export interface NativeCliWorld {
	readonly channel: NativeTestChannel;
	/** A VS Code-kind client of the test's own that keeps the native daemon running. */
	readonly observer: NativeCockpitClient;
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
	const observer = await NativeCockpitClient.connect(channel.client('vscode', 'development', { name: 'test observer', scenario }));
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
