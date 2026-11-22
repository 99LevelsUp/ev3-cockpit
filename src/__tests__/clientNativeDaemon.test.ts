/**
 * The client library against the native daemon binary, on private test channels in matched replay
 * of the link recordings: starting a verified copy, several clients at once, every branch of the
 * launch rules that needs no second contract, a client's own bricks after a replacement, the
 * install record add-ons start from, and questions for a person.
 *
 * The development build reports itself as a release build with `--report-release`, so one binary
 * plays both. Needs `daemon/target/debug/ev3-cockpitd(.exe)`; without it the tests are skipped.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { ContractError } from '../client/connection';
import { NativeCockpitClient, NativeCockpitClientOptions } from '../client/nativeClient';
import { ensureNativeDaemon } from '../client/nativeDaemon';
import {
	DaemonStartError, LaunchHost, SpawnedDaemon, daemonBinaryName, installedNativeLaunch, systemLaunchHost,
} from '../client/nativeLaunch';
import type { DaemonStatus, Question } from '../contract/generated';
import { nativeCliWorld } from './cliHelpers';
import { NATIVE_DAEMON_VERSION, NativeTestChannel, nativeBinaryMissing, nativeLaunch, nativeTestChannel, sleep } from './clientDaemonHelpers';

const homes: string[] = [];
const channels: NativeTestChannel[] = [];
const clients: NativeCockpitClient[] = [];
after(async () => {
	for (const client of clients) { client.dispose(); }
	for (const channel of channels) { await channel.stop(); }
	await sleep(200);
	for (const home of homes) {
		for (let attempt = 0; attempt < 10; attempt++) {
			try { fs.rmSync(home, { recursive: true, force: true }); break; } catch { await sleep(200); }
		}
	}
});

function testChannel(): NativeTestChannel {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-native-client-'));
	homes.push(home);
	const channel = nativeTestChannel(home);
	channels.push(channel);
	return channel;
}

async function connect(options: NativeCockpitClientOptions, notices: string[] = []): Promise<NativeCockpitClient> {
	const client = await NativeCockpitClient.connect(options, (text) => notices.push(text));
	clients.push(client);
	return client;
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
		await sleep(50);
	}
}

/** The real host, recording every daemon it starts. */
function recordingHost(): LaunchHost & { readonly started: SpawnedDaemon[] } {
	const real = systemLaunchHost();
	const started: SpawnedDaemon[] = [];
	return {
		...real,
		started,
		spawn(file, args, cwd) {
			const daemon = real.spawn(file, args, cwd);
			started.push(daemon);
			return daemon;
		},
	};
}

describe('the client library and the native daemon', { skip: nativeBinaryMissing }, () => {
	it('starts its verified copy when no daemon runs, from the state root, in replay', async () => {
		const channel = testChannel();
		const client = await connect(channel.client('vscode', 'development'));
		const launch = nativeLaunch('development');
		assert.equal(client.daemon.mode, 'replay');
		assert.equal(client.daemon.buildKind, 'development');
		assert.equal(client.daemon.buildId, launch.sha256, 'the daemon runs the copy whose hash the client checked');
		assert.deepEqual(fs.readdirSync(path.join(channel.stateRoot, 'bin', launch.sha256)), [daemonBinaryName()]);
		const listed = await client.request('bricks/list', { waitForDiscovery: true });
		assert.deepEqual(listed.bricks.map((b) => b.name), ['AAA'], 'the scenario\'s brick');
		await until('the brick list to reach the client', () => client.bricks().some((b) => b.name === 'AAA'));
		assert.equal(installedNativeLaunch(channel.files), undefined, 'a development client records no install');
	});

	it('three clients launching at once produce no false mismatch and one daemon', async () => {
		const channel = testChannel();
		const host = recordingHost();
		const options = channel.client('cli', 'development');
		const connections = await Promise.all([1, 2, 3].map((n) => ensureNativeDaemon({ ...options, name: `client ${n}`, host })));
		try {
			assert.equal(new Set(connections.map((c) => c.daemon.pid)).size, 1, 'all three reached the same daemon');
			assert.ok(host.started.length >= 1);
			await until('the losing daemons to exit', () => host.started.filter((d) => d.outcome() === undefined).length === 1);
			for (const loser of host.started.filter((d) => d.outcome() !== undefined)) {
				assert.deepEqual(loser.outcome(), { kind: 'exit', code: 2, signal: null }, 'a daemon that lost the lock exits with code 2');
			}
		} finally {
			for (const c of connections) { c.endpoint.close(); }
		}
	});

	it('a release client uses a release daemon of its own version, and records the install for add-ons', async () => {
		const channel = testChannel();
		const first = await connect(channel.client('vscode', 'release', { reconnect: false }));
		const second = await connect(channel.client('cli', 'release', { reconnect: false }));
		assert.equal(first.daemon.buildKind, 'release');
		assert.equal(second.daemon.pid, first.daemon.pid);
		assert.deepEqual(installedNativeLaunch(channel.files), nativeLaunch('release'));
	});

	it('an add-on starts the installed cockpit\'s daemon from the install record', async () => {
		const channel = testChannel();
		const installer = await connect(channel.client('vscode', 'release', { reconnect: false }));
		const pid = installer.daemon.pid;
		installer.dispose();
		await channel.stop();
		await until('the daemon to go', () => !alive(pid));
		const addon = await connect({
			name: 'EVƎ C (test)', kind: 'addon', version: '7.0.0', channel: channel.channel, stateRoot: channel.stateRoot,
			daemonArgs: ['--mode', 'replay'], reconnect: false,
		});
		assert.notEqual(addon.daemon.pid, pid);
		assert.equal(addon.daemon.buildId, nativeLaunch('release').sha256);
	});

	it('a development client asks a release daemon to exit and starts its own', async () => {
		const channel = testChannel();
		const release = await connect(channel.client('vscode', 'release', { reconnect: false }));
		const old = release.daemon.pid;
		const dev = await connect(channel.client('vscode', 'development'));
		assert.equal(dev.daemon.buildKind, 'development');
		assert.notEqual(dev.daemon.pid, old);
		await until('the release daemon to end', () => !alive(old));
	});

	it('a development client uses a development daemon', async () => {
		const channel = testChannel();
		const first = await connect(channel.client('vscode', 'development'));
		const second = await connect(channel.client('cli', 'development', { version: '0.0.0-other' }));
		assert.equal(second.daemon.pid, first.daemon.pid);
	});

	it('a release client uses a development daemon and tells the user one runs', async () => {
		const channel = testChannel();
		const dev = await connect(channel.client('vscode', 'development'));
		const notices: string[] = [];
		const release = await connect(channel.client('cli', 'release', { version: '99.0.0' }), notices);
		assert.equal(release.daemon.pid, dev.daemon.pid);
		assert.match(notices.join('\n'), /development build of the EVƎ Cockpit daemon/);
	});

	it('a release client newer than a release daemon asks it to exit, then starts its own', async () => {
		const channel = testChannel();
		const older = await connect(channel.client('cli', 'release', { reconnect: false }));
		const old = older.daemon.pid;
		const newer = await connect(channel.client('vscode', 'release', { version: '99.0.0', reconnect: false }));
		assert.notEqual(newer.daemon.pid, old);
		assert.equal(newer.daemon.buildKind, 'release');
		await until('the older daemon to end', () => !alive(old));
	});

	it('a client connects its own bricks again after a replacement; nothing is handed over', async () => {
		const channel = testChannel();
		const release = await connect(channel.client('vscode', 'release', { name: 'release window' }));
		const brick = await release.request('bricks/connect', { brick: 'AAA' });
		assert.equal(brick.connected, true);
		const old = release.daemon.pid;
		const reconnected = new Promise<void>((resolve) => { release.onReconnected(() => resolve()); });
		const lost: Error[] = [];
		release.onLost((error) => lost.push(error));
		const notices: string[] = [];
		release.onNotice((text) => notices.push(text));

		const dev = await connect(channel.client('vscode', 'development', { name: 'development window' }));
		await reconnected;
		assert.deepEqual(lost, []);
		assert.notEqual(dev.daemon.pid, old);
		assert.equal(release.daemon.pid, dev.daemon.pid, 'the release client found the successor instead of starting a daemon of its own');
		assert.match(notices.join('\n'), /development build/);
		const status: DaemonStatus = await dev.request('daemon/status', {});
		const aaa = status.bricks.find((b) => b.name === 'AAA');
		assert.ok(aaa, 'AAA is connected on the new daemon');
		assert.deepEqual(aaa.holders, [{ kind: 'client', client: 'release window' }]);
	});

	it('renews a program subscription on the successor after a replacement', async () => {
		// The service recording of program runs on CCC (daemon/fixtures/service/usb-programs-ccc):
		// it holds the program-state reads a subscription makes.
		const programs = (buildKind: 'release' | 'development'): string[] => [
			'--mode', 'replay', '--fixtures', path.join(__dirname, '..', '..', 'daemon', 'fixtures', 'service', 'usb-programs-ccc'),
			...(buildKind === 'release' ? ['--report-release'] : []),
		];
		const channel = testChannel();
		const release = await connect(channel.client('vscode', 'release', { name: 'release window', daemonArgs: programs('release') }));
		await release.request('bricks/connect', { brick: 'CCC' });
		const states: unknown[] = [];
		const subscription = await release.subscribePrograms('CCC', (state) => states.push(state));
		const reconnected = new Promise<void>((resolve) => { release.onReconnected(() => resolve()); });
		await connect(channel.client('vscode', 'development', { daemonArgs: programs('development') }));
		await reconnected;
		await until('the renewed subscription to report the state', () => states.length >= 1);
		subscription.dispose();
	});

	it('puts a question to the handler with who asked, and without a handler leaves it unanswered', async () => {
		const channel = testChannel();
		const window = await connect(channel.client('vscode', 'development', { name: 'VS Code (test)' }));
		const asked: Question[] = [];
		window.onQuestion((question) => {
			asked.push(question);
			return { answer: 'yes' };
		});
		const agent = await connect({ ...channel.client('mcp', 'development', { name: 'an agent' }), reconnect: false });
		const changed = await agent.request('settings/set', { key: 'access-mode', value: 'full' });
		assert.equal(changed.value, 'full');
		assert.equal(asked.length, 1);
		assert.ok('requester' in asked[0]);
		assert.deepEqual(asked[0].requester, { name: 'an agent', kind: 'mcp' });
		await until('the access mode to reach the window', () => window.accessMode() === 'full');

		await agent.request('settings/set', { key: 'access-mode', value: 'safe' });
		window.onQuestion(undefined);
		await assert.rejects(agent.request('settings/set', { key: 'access-mode', value: 'full' }),
			(error: unknown) => error instanceof ContractError && error.code === 'needs_person');
	});

	it('a start failure is a DaemonStartError every client reads the same way', async () => {
		const channel = testChannel();
		await assert.rejects(connect(channel.client('vscode', 'development', { daemon: { ...nativeLaunch('development'), sha256: '0'.repeat(64) } })),
			(error: unknown) => error instanceof DaemonStartError && error.failure === 'sha_mismatch' && error.code === 'daemon_unavailable');
	});

	it('the command tests\' world: an observer keeps a replay daemon on a test channel the environment names', async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-native-cli-'));
		homes.push(home);
		const world = await nativeCliWorld(home);
		try {
			assert.equal(world.observer.daemon.mode, 'replay');
			assert.equal(world.env.EV3_COCKPIT_CHANNEL, world.channel.channel);
			assert.equal(fs.existsSync(world.channel.files.channelFile), true);
		} finally {
			await world.done();
		}
		assert.equal(fs.existsSync(world.channel.files.channelFile), false, 'done stops the daemon');
	});

	it('reports the version the daemon build carries', () => {
		assert.match(NATIVE_DAEMON_VERSION, /^\d+\.\d+\.\d+/);
	});
});
