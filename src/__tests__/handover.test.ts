/**
 * A newer daemon takes over (KTD7): only a newer client asks, the replacement waits until the
 * daemon is idle, a restart keeps held and connected bricks and `full`, a client in the gap waits
 * for the successor, and a write cut off by the handover ends with `outcome_unknown`.
 *
 * Two daemon "versions" are the same build started from install folders whose package.json says
 * different versions.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { CockpitClient, ContractError } from '../client';
import { spawnDaemon } from '../client/ensureDaemon';
import { WireErrorCode } from '../contract/errors';
import type { ClientKind, LaunchSpec, TelemetryUpdate } from '../contract/models';
import { writeHandoverState } from '../daemon/handover';
import { REPO, privateHome, sleep, testDaemon } from './clientDaemonHelpers';
import { waitFor } from './waitFor';

const home = privateHome();

function launchOf(version: string): LaunchSpec {
	const installRoot = path.join(home, `install-${version}`);
	fs.mkdirSync(installRoot, { recursive: true });
	fs.writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'ev3-cockpit', version }));
	return { runtime: process.execPath, entry: path.join(REPO, 'out', 'daemon', 'main.js'), installRoot, version };
}

function connector(graceMs = 5000) {
	const d = testDaemon(home, '0.0.1', graceMs);
	const connect = (name: string, kind: ClientKind, version: string): Promise<CockpitClient> =>
		CockpitClient.connect({ name, kind, version, paths: d.paths, launch: launchOf(version), launchArgs: d.launchArgs });
	return { d, connect };
}

const log = (d: ReturnType<typeof testDaemon>): string => {
	try { return fs.readFileSync(d.paths.logFile, 'utf8'); } catch { return ''; }
};

describe('handing the daemon over', () => {
	it('never lets an older client replace a newer daemon', async (t) => {
		const { d, connect } = connector();
		const newer = await connect('newer', 'cli', '0.0.2');
		t.after(() => newer.dispose());
		assert.equal(newer.daemon.version, '0.0.2');
		const older = await connect('older', 'cli', '0.0.1');
		t.after(() => older.dispose());
		assert.equal(older.daemon.pid, newer.daemon.pid);
		await sleep(1500);
		const status = await older.request('daemon/status', {});
		assert.equal(status.pid, newer.daemon.pid);
		assert.equal(status.version, '0.0.2');
		assert.doesNotMatch(log(d), /Replacement by/);
	});

	it('waits for the daemon to be idle before a newer client replaces it, and replaces it once', async (t) => {
		const { d, connect } = connector();
		const first = await connect('first', 'vscode', '0.0.1');
		t.after(() => first.dispose());
		const firstPid = first.daemon.pid;
		await first.request('bricks/list', { waitForDiscovery: true });
		await first.request('bricks/connect', { brick: 'R2D2' });
		const newer = await connect('newer', 'cli', '0.0.2');
		t.after(() => newer.dispose());
		await waitFor(() => /Replacement by 0\.0\.2 registered/.test(log(d)), 5000);
		await sleep(1500);
		assert.equal((await newer.request('daemon/status', {})).pid, firstPid, 'replaced while a brick was connected');

		let reconnected = false;
		first.onReconnected(() => { reconnected = true; });
		await first.request('bricks/disconnect', { brick: 'R2D2' });
		await waitFor(() => reconnected, 20_000);
		assert.notEqual(first.daemon.pid, firstPid);
		assert.equal(first.daemon.version, '0.0.2');
		const successor = first.daemon.pid;
		await sleep(2500);
		assert.equal((await first.request('daemon/status', {})).pid, successor, 'replaced more than once');
		assert.equal(log(d).match(/Handing over to/g)?.length, 1);
	});

	it('keeps a held brick and a VS Code brick across a restart, and VS Code\'s telemetry goes on', async (t) => {
		const { d, connect } = connector();
		const cli = await connect('ev3 cli', 'cli', '0.0.1');
		t.after(() => cli.dispose());
		const vscode = await connect('VS Code window', 'vscode', '0.0.1');
		t.after(() => vscode.dispose());
		await cli.request('bricks/list', { waitForDiscovery: true });
		await cli.request('bricks/connect', { brick: 'R2D2', hold: true });
		await vscode.request('bricks/connect', { brick: 'SkyNet' });
		const updates: TelemetryUpdate[] = [];
		await vscode.subscribeTelemetry('SkyNet', { rows: ['system.battery.level'], intervalMs: 500 }, (u) => updates.push(u));
		const before = vscode.daemon.pid;

		let reconnected = false;
		vscode.onReconnected(() => { reconnected = true; });
		const snapshotsBefore = updates.filter((u) => u.kind === 'snapshot').length;
		assert.deepEqual(await cli.request('daemon/restart', { confirmedByPerson: true }), { accepted: true });
		await waitFor(() => reconnected, 20_000);
		assert.notEqual(vscode.daemon.pid, before);
		assert.match(log(d), /Took over from 0\.0\.1: 2 held brick\(s\)/);

		await waitFor(() => {
			const r2 = vscode.brick('R2D2');
			const sky = vscode.brick('SkyNet');
			return r2?.connected === true && sky?.connected === true && !r2.reconnecting && !sky.reconnecting;
		}, 15_000);
		const status = await vscode.request('daemon/status', {});
		const held = (name: string) => status.bricks.find((b) => b.name === name)?.holders ?? [];
		assert.ok(held('R2D2').some((h) => h.kind === 'hold'), 'the ev3 connect hold was lost');
		assert.ok(held('SkyNet').some((h) => h.client === 'VS Code window'), 'VS Code\'s hold was lost');
		assert.equal(held('SkyNet').filter((h) => h.kind === 'client').length, 1, 'VS Code holds the brick twice: its old hold was not taken back');
		assert.ok(updates.filter((u) => u.kind === 'snapshot').length > snapshotsBefore, 'no fresh snapshot after the restart');
		await sleep(2000);
		assert.equal((await vscode.request('daemon/status', {})).pid, vscode.daemon.pid, 'the successor did not keep running');
		await cli.request('bricks/disconnect', { brick: 'R2D2', releaseHold: true });
	});

	it('serves at once after a handover whose held brick does not answer, and keeps it held', async (t) => {
		const { d, connect } = connector();
		writeHandoverState(d.paths, {
			at: Date.now(), from: '0.0.1', holders: { 'switched-off': [{ kind: 'hold' }] }, unstored: {}, btCloseTimes: {},
		});
		const started = Date.now();
		const client = await connect('after', 'cli', '0.0.1');
		t.after(() => { process.kill(client.daemon.pid); client.dispose(); });
		assert.ok(Date.now() - started < 15_000);
		const status = await client.request('daemon/status', {});
		const brick = status.bricks.find((b) => b.brickId === 'switched-off');
		assert.ok(brick, 'the held brick was dropped');
		assert.equal(brick.reconnecting, true);
		assert.deepEqual(brick.holders, [{ kind: 'hold' }]);
	});

	it('keeps full across a restart, and a fresh daemon starts safe', async (t) => {
		const { connect } = connector(1000);
		const cli = await connect('ev3 cli', 'cli', '0.0.1');
		t.after(() => cli.dispose());
		await cli.request('settings/set', { key: 'accessMode', value: 'full', confirmedByPerson: true });
		await waitFor(() => cli.accessMode() === 'full', 5000);
		let reconnects = 0;
		cli.onReconnected(() => { reconnects++; });
		await cli.request('daemon/restart', { confirmedByPerson: true });
		await waitFor(() => reconnects === 1, 20_000);
		assert.equal(cli.accessMode(), 'full');

		process.kill(cli.daemon.pid);
		await waitFor(() => reconnects === 2, 20_000);
		assert.equal(cli.accessMode(), 'safe');
	});

	it('has a client in the gap between two daemons wait for the successor instead of starting one', async (t) => {
		const d = testDaemon(home, '0.0.2', 3000);
		fs.mkdirSync(path.dirname(d.paths.handoverMarker), { recursive: true });
		fs.writeFileSync(d.paths.handoverMarker, JSON.stringify({ successorVersion: '0.0.2', at: Date.now() }));
		// Were it to start a daemon, this one would die at once and the connect would fail.
		const broken: LaunchSpec = { ...launchOf('0.0.1'), entry: path.join(home, `no-daemon-${randomBytes(3).toString('hex')}.js`) };
		const waiting = CockpitClient.connect({ name: 'older', kind: 'cli', version: '0.0.1', paths: d.paths, launch: broken, launchArgs: d.launchArgs, readinessMs: 12_000 });
		await sleep(1500);
		spawnDaemon(launchOf('0.0.2'), d.launchArgs);
		const client = await waiting;
		t.after(() => client.dispose());
		assert.equal(client.daemon.version, '0.0.2');
		await waitFor(() => !fs.existsSync(d.paths.handoverMarker), 5000);
	});

	it('ends a deploy cut off by a restart with outcome_unknown and does not retry it', async (t) => {
		const { d, connect } = connector();
		const writer = await connect('writer', 'cli', '0.0.1');
		t.after(() => writer.dispose());
		const restarter = await connect('restarter', 'cli', '0.0.1');
		t.after(() => restarter.dispose());
		await writer.request('bricks/list', { waitForDiscovery: true });
		await writer.request('bricks/connect', { brick: 'R2D2' });
		const big = path.join(home, 'big.rbf');
		fs.writeFileSync(big, randomBytes(3 * 1024 * 1024));
		const remote = '/home/root/lms2012/prjs/Big/big.rbf';
		const deploy = writer.request('programs/deployAndRun', { brick: 'R2D2', files: [{ localPath: big, remotePath: remote }], runPath: remote });
		const outcome = deploy.then(() => 'finished', (e: unknown) => e);
		for (const until = Date.now() + 10_000; !(await restarter.request('daemon/status', {})).bricks.some((b) => b.leaseHolder === 'writer');) {
			assert.ok(Date.now() < until, 'the deploy never took the lease');
			await sleep(20);
		}
		await restarter.request('daemon/restart', { confirmedByPerson: true });
		const result = await outcome;
		assert.ok(result instanceof ContractError, `the deploy ${String(result)}`);
		assert.equal(result.code, WireErrorCode.OutcomeUnknown);
		await sleep(1500);
		assert.equal(log(d).match(/Deployed /g), null, 'the deploy was retried or finished');
	});
});
