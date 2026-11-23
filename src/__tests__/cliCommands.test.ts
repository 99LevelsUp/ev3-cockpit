/**
 * The `ev3` command as its own process against the native daemon in matched replay of brick AAA
 * over USB: listing, holding and releasing a brick, the settings it accepts, the exit codes a
 * script reads, and the operations that refuse to change anything without a person at a terminal.
 *
 * Needs `daemon/target/debug/ev3-cockpitd(.exe)` and its manifest (`npm run daemon:build`); without
 * the binary the tests are skipped.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { CockpitClient } from '../client/nativeClient';
import { DaemonStartError, StartFailure, developmentDaemon } from '../client/nativeLaunch';
import { run } from '../cli/main';
import type { Installation } from '../cli/installation';
import { ExitCode, exitCodeFor } from '../cli/output';
import type { CliIo } from '../cli/output';
import { SETTING_SPECS } from '../contract/generated';
import type { ContractBrick, DaemonStatus, Question } from '../contract/generated';
import { NativeCliWorld, ev3, nativeCliWorld } from './cliHelpers';
import { NATIVE_DAEMON_VERSION, nativeBinaryMissing, nativeLaunch, nativeTestChannel, sleep } from './clientDaemonHelpers';

const temps: string[] = [];
/** A temporary folder the run removes at its end; each test home holds its own verified copy of the daemon. */
function temp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	return dir;
}
after(async () => {
	await sleep(200);
	for (const dir of temps) {
		for (let attempt = 0; attempt < 10; attempt++) {
			try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(200); }
		}
	}
});

const home = temp('ev3-cli-');

interface JsonError { error: { code: string; message: string; command?: string; holder?: string; failure?: string } }

describe('the ev3 command on the native daemon', { skip: nativeBinaryMissing }, () => {
	let w: NativeCliWorld;
	before(async () => { w = await nativeCliWorld(home); });
	after(async () => { await w.done(); });

	it('lists the bricks as JSON, holds AAA past ev3 connect, shows the hold in a second process and releases it', async () => {
		const list = await ev3(['list', '--json'], { env: w.env });
		assert.equal(list.code, 0, list.stderr);
		const bricks = JSON.parse(list.stdout) as ContractBrick[];
		assert.deepEqual(bricks.map((b) => b.name), ['AAA']);
		assert.ok(Array.isArray(bricks[0].channels) && Array.isArray(bricks[0].holders));

		const connect = await ev3(['connect', 'AAA'], { env: w.env });
		assert.equal(connect.code, 0, connect.stderr);
		const status = await ev3(['status', '--json'], { env: w.env });
		assert.equal(status.code, 0, status.stderr);
		const parsed = JSON.parse(status.stdout) as DaemonStatus;
		assert.equal(parsed.mode, 'replay');
		assert.deepEqual(parsed.bricks.find((b) => b.name === 'AAA')?.holders, [{ kind: 'hold' }]);
		const human = await ev3(['status'], { env: w.env });
		assert.match(human.stdout, /AAA.*held by ev3 connect/);

		const disconnect = await ev3(['disconnect', 'AAA'], { env: w.env });
		assert.equal(disconnect.code, 0, disconnect.stderr);
		const afterwards = JSON.parse((await ev3(['status', '--json'], { env: w.env })).stdout) as DaemonStatus;
		assert.equal(afterwards.bricks.some((b) => b.name === 'AAA'), false);
	});

	it('accepts exactly the setting keys the contract lists, by either spelling', async () => {
		for (const spec of SETTING_SPECS) {
			const set = await ev3(['config', 'set', spec.cliKey, String(spec.default), '--json'], { env: w.env });
			assert.equal(set.code, 0, `${spec.cliKey}: ${set.stdout}${set.stderr}`);
		}
		const camel = await ev3(['config', 'get', 'telemetry.staleFactor', '--json'], { env: w.env });
		assert.equal(camel.code, 0, camel.stderr);
		for (const unknown of ['access_mode', 'mock', 'nope', 'telemetry']) {
			const set = await ev3(['config', 'set', unknown, '1', '--json'], { env: w.env });
			assert.equal(set.code, ExitCode.Usage, `${unknown}: ${set.stdout}`);
			assert.equal((JSON.parse(set.stdout) as JsonError).error.code, 'usage');
		}
		const wrongType = await ev3(['config', 'set', 'telemetry.throttle.window-size', '2.5'], { env: w.env });
		assert.equal(wrongType.code, ExitCode.Usage, wrongType.stderr);
	});

	it('refuses to switch access mode to full without a terminal, names the command, and leaves it safe', async () => {
		const set = await ev3(['config', 'set', 'access-mode', 'full', '--json'], { env: w.env });
		assert.equal(set.code, ExitCode.NeedsPerson, set.stdout);
		const { error } = JSON.parse(set.stdout) as JsonError;
		assert.equal(error.code, 'needs_person');
		assert.equal(error.command, 'ev3 config set access-mode full');
		assert.equal((await w.observer.request('settings/accessMode', {})).mode, 'safe');
	});

	it('refuses daemon restart and forget without a terminal, and changes nothing', async () => {
		const pid = w.observer.daemon.pid;
		const restart = await ev3(['daemon', 'restart', '--json'], { env: w.env });
		assert.equal(restart.code, ExitCode.NeedsPerson, restart.stdout);
		assert.equal((JSON.parse(restart.stdout) as JsonError).error.command, 'ev3 daemon restart');
		assert.equal((await w.observer.request('daemon/status', {})).pid, pid);

		const forget = await ev3(['forget', 'AAA', '--json'], { env: w.env });
		assert.equal(forget.code, ExitCode.NeedsPerson, forget.stdout);
		assert.equal((JSON.parse(forget.stdout) as JsonError).error.command, 'ev3 forget AAA');
		assert.deepEqual((await w.observer.request('bricks/list', {})).bricks.map((b) => b.name), ['AAA']);
	});

	it('prints the daemon log\'s path without reaching a daemon', async () => {
		const log = await ev3(['daemon', 'log', '--json'], { env: w.env });
		assert.equal(log.code, 0, log.stderr);
		assert.equal((JSON.parse(log.stdout) as { logPath: string }).logPath, path.join(w.channel.files.dir, 'daemon.log'));
	});

	it('has no flags of the dropped features', async () => {
		for (const args of [['--channel', 'dev', 'list'], ['config', 'set', 'access-mode', 'full', '--confirmed-by-person'], ['list', '--mock']]) {
			const result = await ev3(args, { env: w.env });
			assert.equal(result.code, ExitCode.Usage, `${args.join(' ')}: ${result.stderr}`);
		}
	});
});

describe('the ev3 command and a brick another client writes to', { skip: nativeBinaryMissing }, () => {
	let w: NativeCliWorld;
	before(async () => { w = await nativeCliWorld(temp('ev3-cli-busy-')); });
	after(async () => { await w.done(); });

	it('exits 3 and names the holder when another client is writing to the brick', async () => {
		// A forget holds the brick's write lease while it waits for the person's answer.
		const holder = await CockpitClient.connect(w.channel.client('vscode', 'development', { name: 'lease holder', reconnect: false }));
		let answer: ((a: 'no') => void) | undefined;
		const asked = new Promise<Question>((resolveAsked) => {
			holder.onQuestion((q) => { resolveAsked(q); return new Promise((resolve) => { answer = resolve; }); });
		});
		// The holder connects AAA first: the recording holds one connect, so the command's own connect finds it connected.
		await holder.request('bricks/connect', { brick: 'AAA' });
		const forgetting = holder.request('bricks/forget', { brick: 'AAA' }).catch((error: unknown) => error);
		try {
			await asked;
			const mkdir = await ev3(['mkdir', '/home/root/lms2012/prjs/new', '--brick', 'AAA', '--json'], { env: w.env });
			assert.equal(mkdir.code, ExitCode.BrickBusy, mkdir.stdout);
			const { error } = JSON.parse(mkdir.stdout) as JsonError;
			assert.equal(error.code, 'brick_busy');
			assert.equal(error.holder, 'lease holder');
		} finally {
			answer?.('no');
			await forgetting;
			holder.dispose();
		}
	});
});

/** Runs `ev3` in this process with an installation of the test's own; no terminal. */
async function runWith(args: readonly string[], install: Installation, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdin = new PassThrough();
	stdin.end();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let out = '';
	let err = '';
	stdout.on('data', (d: Buffer) => { out += d.toString(); });
	stderr.on('data', (d: Buffer) => { err += d.toString(); });
	const io: CliIo = { stdin, stdout, stderr, isTTY: false, env, cwd: os.tmpdir() };
	const code = await run(args, io, { installation: install });
	return { code, stdout: out, stderr: err };
}

describe('the ev3 command when the daemon cannot start', { skip: nativeBinaryMissing }, () => {
	it('exits 8 with a --json error object naming the failure when the daemon does not match its SHA-256', async () => {
		const channelHome = temp('ev3-cli-start-');
		const channel = nativeTestChannel(channelHome);
		const install: Installation = {
			buildKind: 'development', version: NATIVE_DAEMON_VERSION,
			daemon: () => ({ ...nativeLaunch('development'), sha256: '0'.repeat(64) }),
			channel: () => channel.channel,
		};
		const result = await runWith(['list', '--json'], install, { ...process.env, LOCALAPPDATA: channelHome, XDG_STATE_HOME: channelHome });
		assert.equal(result.code, ExitCode.DaemonNotStartable, result.stdout);
		const { error } = JSON.parse(result.stdout) as JsonError;
		assert.equal(error.code, 'daemon_unavailable');
		assert.equal(error.failure, 'sha_mismatch');
		assert.equal(fs.existsSync(channel.files.channelFile), false, 'no daemon was started');
	});

	it('exits 8 and says how to build it when there is no daemon to start', async () => {
		const empty = temp('ev3-cli-nodaemon-');
		const install: Installation = {
			buildKind: 'development', version: NATIVE_DAEMON_VERSION,
			daemon: () => developmentDaemon(empty),
			channel: () => undefined,
		};
		const result = await runWith(['list'], install, process.env);
		assert.equal(result.code, ExitCode.DaemonNotStartable, result.stderr);
		assert.match(result.stderr, /npm run daemon:build/);
		const json = await runWith(['list', '--json'], install, process.env);
		assert.equal((JSON.parse(json.stdout) as JsonError).error.failure, 'missing_binary');
	});
});

describe('the exit code of each start failure', () => {
	const expected: Record<StartFailure, number> = {
		missing_binary: ExitCode.DaemonNotStartable,
		sha_mismatch: ExitCode.DaemonNotStartable,
		not_private: ExitCode.DaemonNotStartable,
		smart_app_control: ExitCode.SmartAppControl,
		name_held: ExitCode.DaemonUnavailable,
		lock_held: ExitCode.DaemonUnavailable,
		contract_mismatch: ExitCode.ContractMismatch,
		failed: ExitCode.DaemonUnavailable,
	};
	for (const [failure, code] of Object.entries(expected) as [StartFailure, number][]) {
		it(`maps ${failure} to ${code}`, () => {
			assert.equal(exitCodeFor(new DaemonStartError(failure, 'it did not start')), code);
		});
	}
});

describe('ev3 telemetry on the native daemon', { skip: nativeBinaryMissing }, () => {
	// The recorded minute of CCC over USB: the rows its script read, at the interval it used.
	const rows = ['program.user.running', 'system.battery.voltage', 'system.battery.level'];
	let w: NativeCliWorld;
	before(async () => { w = await nativeCliWorld(temp('ev3-cli-telemetry-'), 'service/usb-telemetry-minute-ccc'); });
	after(async () => { await w.done(); });

	it('lists the rows without connecting a brick', async () => {
		const listed = await ev3(['telemetry', '--list', '--json'], { env: w.env });
		assert.equal(listed.code, 0, listed.stderr);
		const ids = (JSON.parse(listed.stdout) as { id: string }[]).map((r) => r.id);
		for (const row of rows) { assert.ok(ids.includes(row), `${row} is listed`); }
	});

	it('reads the named rows of CCC once, on a subscription of its own', async () => {
		const read = await ev3(['telemetry', ...rows, '--brick', 'CCC', '--json'], { env: w.env });
		assert.equal(read.code, 0, read.stderr);
		const reading = JSON.parse(read.stdout) as { values: { rowId: string }[]; missing: string[] };
		assert.deepEqual(reading.values.map((v) => v.rowId), rows);
		assert.deepEqual(reading.missing, []);
		// The recording connects CCC once, so this world serves one reading.
	});

	it('refuses --list with anything else', async () => {
		const wrong = await ev3(['telemetry', '--list', 'system.battery.voltage'], { env: w.env });
		assert.equal(wrong.code, ExitCode.Usage);
	});
});