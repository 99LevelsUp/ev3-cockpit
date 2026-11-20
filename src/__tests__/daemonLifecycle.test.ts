/**
 * The daemon lives while a client is connected or a brick is held, and exits a grace period after
 * neither is true — also when a client goes without a word.
 */

import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { createEndpoint } from '../client/connection';
import { performHello } from '../client/hello';
import type { DaemonStatus } from '../contract/models';
import { readKey } from '../daemon/key';
import { defaultInstallRoot } from '../daemon/main';
import { daemonPaths } from '../daemon/paths';
import { Lifecycle } from '../daemon/stateMachine';
import { currentUserSid } from '../daemon/systemTools';

const REPO = path.resolve(__dirname, '..', '..');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the daemon lifecycle', () => {
	it('exits a grace period after its last client leaves', async () => {
		let exited = 0;
		const life = new Lifecycle({ graceMs: 30, onExit: () => { exited++; } });
		life.serve();
		life.clientConnected('a');
		await sleep(60);
		assert.equal(exited, 0);
		life.clientLeft('a');
		await sleep(60);
		assert.equal(exited, 1);
		assert.equal(life.state, 'exiting');
		assert.equal(life.helloState(), 'exiting');
	});

	it('exits after the grace when no client ever comes', async () => {
		let exited = 0;
		const life = new Lifecycle({ graceMs: 30, onExit: () => { exited++; } });
		life.serve();
		await sleep(60);
		assert.equal(exited, 1);
	});

	it('keeps serving with no client while a brick is held', async () => {
		let exited = 0;
		const life = new Lifecycle({ graceMs: 30, onExit: () => { exited++; } });
		life.serve();
		life.setHolds(1);
		await sleep(60);
		assert.equal(exited, 0);
		life.setHolds(0);
		await sleep(60);
		assert.equal(exited, 1);
	});

	it('cancels the exit when a client comes back within the grace', async () => {
		let exited = 0;
		const life = new Lifecycle({ graceMs: 50, onExit: () => { exited++; } });
		life.serve();
		life.clientConnected('a');
		life.clientLeft('a');
		await sleep(20);
		life.clientConnected('b');
		await sleep(70);
		assert.equal(exited, 0);
		life.dispose();
	});

	it('is not replaceable while lent or busy', () => {
		const life = new Lifecycle({ graceMs: 1000, onExit: () => undefined });
		life.serve();
		assert.equal(life.replaceable(false), true);
		assert.equal(life.replaceable(true), false);
		life.setLentBricks(1);
		assert.equal(life.replaceable(false), false);
		life.setLentBricks(0);
		life.lend();
		assert.equal(life.replaceable(false), false);
		life.dispose();
	});
});

describe('the daemon process', () => {
	it('serves a client on simulated bricks and ends on its own after the client leaves', async (t) => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-daemon-'));
		const channel = `t-${randomBytes(3).toString('hex')}`;
		const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: home, XDG_STATE_HOME: home, XDG_RUNTIME_DIR: home, HOME: home, USERPROFILE: home };
		delete env.NODE_OPTIONS;
		delete env.NODE_TEST_CONTEXT;
		const paths = daemonPaths({
			platform: process.platform, env, homedir: home,
			...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
			...(process.platform === 'win32' ? { userSid: currentUserSid() } : {}),
			channel,
		});
		const daemon: ChildProcess = spawn(process.execPath, [
			path.join(REPO, 'out', 'daemon', 'main.js'), '--channel', channel, '--simulated', '--grace-ms', '300', '--install-root', REPO,
		], { env, stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		daemon.stderr?.on('data', (d) => { stderr += String(d); });
		const exited = new Promise<number | null>((resolve) => daemon.once('exit', (code) => resolve(code)));
		t.after(() => { if (daemon.exitCode === null) { daemon.kill(); } });

		// Wait for the channel.
		let socket: net.Socket | undefined;
		for (let i = 0; i < 100 && !socket; i++) {
			socket = await new Promise<net.Socket | undefined>((resolve) => {
				const s = net.connect(paths.channel);
				s.once('connect', () => resolve(s));
				s.once('error', () => resolve(undefined));
			});
			if (!socket) { await sleep(100); }
		}
		assert.ok(socket, `the daemon never listened: ${stderr}`);
		const endpoint = createEndpoint(socket);
		const hello = await performHello(endpoint, readKey(paths.keyFile), { name: 'test', kind: 'cli', version: '0.0.0' });
		assert.equal(hello.state, 'serving');
		assert.ok(hello.transports.includes('mock'));
		const status = await endpoint.request<DaemonStatus>('daemon/status');
		assert.equal(status.channel, paths.channel);
		assert.deepEqual(status.clients.map((c) => c.name), ['test']);
		assert.equal(status.logPath, paths.logFile);

		endpoint.close();
		const code = await Promise.race([exited, sleep(10_000).then(() => 'timeout')]);
		assert.equal(code, 0, `the daemon did not exit by itself: ${stderr}`);
		const log = fs.readFileSync(paths.logFile, 'utf8');
		assert.match(log, /INFO Client connected: test/);
		assert.match(log, /exiting/);
	});
});

describe('a client still in its handshake', () => {
	it('keeps the daemon from exiting under it when the grace runs out first', async (t) => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-daemon-'));
		const channel = `t-${randomBytes(3).toString('hex')}`;
		const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: home, XDG_STATE_HOME: home, XDG_RUNTIME_DIR: home, HOME: home, USERPROFILE: home };
		delete env.NODE_OPTIONS;
		delete env.NODE_TEST_CONTEXT;
		const paths = daemonPaths({
			platform: process.platform, env, homedir: home,
			...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
			...(process.platform === 'win32' ? { userSid: currentUserSid() } : {}),
			channel,
		});
		const daemon: ChildProcess = spawn(process.execPath, [
			path.join(REPO, 'out', 'daemon', 'main.js'), '--channel', channel, '--simulated', '--grace-ms', '300', '--install-root', REPO,
		], { env, stdio: 'ignore' });
		t.after(() => { if (daemon.exitCode === null) { daemon.kill(); } });
		let socket: net.Socket | undefined;
		for (let i = 0; i < 100 && !socket; i++) {
			socket = await new Promise<net.Socket | undefined>((resolve) => {
				const s = net.connect(paths.channel);
				s.once('connect', () => resolve(s));
				s.once('error', () => resolve(undefined));
			});
			if (!socket) { await sleep(100); }
		}
		assert.ok(socket, 'the daemon never listened');
		// Three graces long, connected but silent.
		await sleep(900);
		const endpoint = createEndpoint(socket);
		const hello = await performHello(endpoint, readKey(paths.keyFile), { name: 'slow', kind: 'cli', version: '0.0.0' });
		assert.equal(hello.state, 'serving');
		endpoint.close();
	});
});

describe('where the daemon is installed', () => {
	it('finds its install root from the bundle and from tsc\'s output alike', () => {
		const root = path.resolve('install');
		assert.equal(defaultInstallRoot(path.join(root, 'out')), root);
		assert.equal(defaultInstallRoot(path.join(root, 'out', 'daemon')), root);
	});
});