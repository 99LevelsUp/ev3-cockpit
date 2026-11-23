/**
 * A development daemon and the user's daemon share the hardware (KTD17, R34): the development one
 * shows the user's bricks as blocked and borrows them with their holders' consent, the user's one
 * gets them back when the development daemon ends, and whichever starts second never opens what the
 * other holds.
 *
 * Both daemons run simulated bricks with the hardware lock forced on, each on its own channel.
 */

import { daemonRefusesThisProcess } from './elevation';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { CockpitClient, ContractError } from '../client';
import { isDevelopmentChannel } from '../client/channel';
import { clientPaths } from '../client/locate';
import { WireErrorCode } from '../contract/errors';
import type { ClientKind, LaunchSpec, Question, QuestionAnswer } from '../contract/models';
import { REPO, privateHome, sleep } from './clientDaemonHelpers';
import { waitFor } from './waitFor';

const home = privateHome();
const VERSION = '0.0.5';

function launch(): LaunchSpec {
	const installRoot = path.join(home, 'install');
	fs.mkdirSync(installRoot, { recursive: true });
	fs.writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'ev3-cockpit', version: VERSION }));
	return { runtime: process.execPath, entry: path.join(REPO, 'out', 'daemon', 'main.js'), installRoot, version: VERSION };
}

interface Pair { readonly user: string; readonly dev: string }
const channels = (): Pair => {
	const hex = randomBytes(3).toString('hex');
	return { user: `t-${hex}`, dev: `dev-${hex}` };
};

function argsFor(channel: string, pair: Pair): string[] {
	return ['--channel', channel, '--simulated', '--hardware-lock', '--grace-ms', '5000',
		...(channel === pair.dev ? ['--user-channel', pair.user] : [])];
}

const opened: CockpitClient[] = [];
const pids = new Set<number>();

async function connect(pair: Pair, side: 'user' | 'dev', name: string, kind: ClientKind = 'vscode',
	answer?: (q: Question) => QuestionAnswer | Promise<QuestionAnswer>): Promise<CockpitClient & { asked: Question[] }> {
	const channel = pair[side];
	const client = await CockpitClient.connect({
		name, kind, version: VERSION, reconnect: false,
		paths: clientPaths({ channel, homedir: home }), launch: launch(), launchArgs: argsFor(channel, pair),
	});
	const asked: Question[] = [];
	client.onQuestion((q) => { asked.push(q); return answer ? answer(q) : 'keep'; });
	opened.push(client);
	pids.add(client.daemon.pid);
	return Object.assign(client, { asked });
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Every client and daemon of a test ends, so the next one finds the hardware lock free. */
async function endAll(): Promise<void> {
	for (const client of opened.splice(0)) { client.dispose(); }
	for (const pid of pids) { try { process.kill(pid); } catch { /* gone */ } }
	await waitFor(() => [...pids].every((pid) => !alive(pid)), 10_000);
	pids.clear();
}

const brick = (client: CockpitClient, name: string) => client.bricks().find((b) => b.name === name);

describe('brick loans between daemons', { skip: daemonRefusesThisProcess }, () => {
	it('keeps a development channel apart from the user\'s daemon', () => {
		const env = { ...process.env };
		delete env.EV3_COCKPIT_CHANNEL;
		const user = clientPaths({ homedir: home, env });
		const dev = clientPaths({ homedir: home, env: { ...env, EV3_COCKPIT_CHANNEL: 'dev-x' } });
		assert.notEqual(dev.channel, user.channel);
		assert.equal(dev.channelName, 'dev-x');
		assert.equal(user.channelName, undefined);
		assert.ok(isDevelopmentChannel('dev') && isDevelopmentChannel('dev-x'));
		assert.ok(!isDevelopmentChannel(undefined) && !isDevelopmentChannel('t-abc') && !isDevelopmentChannel('developer'));
	});

	it('shows the user\'s bricks as blocked, lends one on yes, and gets it back when the development daemon ends', async (t) => {
		t.after(endAll);
		const pair = channels();
		const window = await connect(pair, 'user', 'VS Code window', 'vscode', () => 'yes');
		await window.request('bricks/list', { waitForDiscovery: true });
		for (const name of ['R2D2', 'SkyNet', 'Marvin']) { await window.request('bricks/connect', { brick: name }); }

		const dev = await connect(pair, 'dev', 'development window');
		await dev.request('bricks/list', { waitForDiscovery: true });
		await waitFor(() => ['R2D2', 'SkyNet', 'Marvin'].every((n) => brick(dev, n)?.blocked?.holder === 'VS Code window'), 10_000);

		await dev.request('bricks/connect', { brick: 'Marvin' });
		assert.equal(window.asked.filter((q) => q.kind === 'brickLoan').length, 1);
		await waitFor(() => brick(dev, 'Marvin')?.connected === true && !brick(dev, 'Marvin')?.blocked, 10_000);
		await waitFor(() => brick(window, 'Marvin')?.blocked?.by === 'lent to a development daemon', 5000);
		assert.equal(brick(window, 'Marvin')?.connected, false);
		assert.equal(brick(window, 'R2D2')?.connected, true);
		assert.equal(brick(window, 'SkyNet')?.connected, true);

		// A single loan leaves the radio with the user's daemon: no pairing here.
		const paired = await dev.request('bricks/pair', { brick: 'Marvin' });
		assert.equal(paired.paired, false);
		assert.match(paired.message ?? '', /radio is lent/);
		// Nor may the user's daemon be restarted while it has lent something.
		await assert.rejects(window.request('daemon/restart', { confirmedByPerson: true }), /lent to a development daemon/);

		process.kill(dev.daemon.pid);
		await waitFor(() => brick(window, 'Marvin')?.connected === true && !brick(window, 'Marvin')?.blocked, 15_000);
	});

	it('lends a brick held by two windows only when both say yes, and never one held through ev3 connect', async (t) => {
		t.after(endAll);
		const pair = channels();
		let second: QuestionAnswer = 'keep';
		const a = await connect(pair, 'user', 'window A', 'vscode', () => 'yes');
		const b = await connect(pair, 'user', 'window B', 'vscode', () => second);
		const terminal = await connect(pair, 'user', 'ev3 connect (terminal)', 'cli');
		await a.request('bricks/list', { waitForDiscovery: true });
		await a.request('bricks/connect', { brick: 'Marvin' });
		await b.request('bricks/connect', { brick: 'Marvin' });
		await terminal.request('bricks/connect', { brick: 'SkyNet', hold: true });

		const dev = await connect(pair, 'dev', 'development window');
		await dev.request('bricks/list', { waitForDiscovery: true });
		const refusedBy = (e: unknown): string | undefined => (e instanceof ContractError ? e.data.holder : undefined);

		await assert.rejects(dev.request('bricks/connect', { brick: 'Marvin' }),
			(e: unknown) => e instanceof ContractError && e.code === WireErrorCode.BrickBusy && refusedBy(e) === 'window B' && /could not be asked/.test(e.message));
		second = 'no';
		await assert.rejects(dev.request('bricks/connect', { brick: 'Marvin' }), (e: unknown) => refusedBy(e) === 'window B' && /said no/.test(String(e)));
		assert.equal(brick(a, 'Marvin')?.connected, true);
		second = 'yes';
		await dev.request('bricks/connect', { brick: 'Marvin' });
		assert.equal(a.asked.length, 3);
		assert.equal(b.asked.length, 3);

		await assert.rejects(dev.request('bricks/connect', { brick: 'SkyNet' }), /ev3 disconnect SkyNet/);
		assert.equal(terminal.asked.length, 0);
		await sleep(200);
		assert.equal(brick(dev, 'SkyNet')?.connected, false);
	});

	it('lends nothing when the development daemon goes away while the holder is still being asked', async (t) => {
		t.after(endAll);
		const pair = channels();
		let answer!: (a: QuestionAnswer) => void;
		const answered = new Promise<QuestionAnswer>((resolve) => { answer = resolve; });
		const window = await connect(pair, 'user', 'VS Code window', 'vscode', () => answered);
		await window.request('bricks/list', { waitForDiscovery: true });
		await window.request('bricks/connect', { brick: 'Marvin' });

		const dev = await connect(pair, 'dev', 'development window');
		await dev.request('bricks/list', { waitForDiscovery: true });
		const borrowing = dev.request('bricks/connect', { brick: 'Marvin' }).catch(() => undefined);
		await waitFor(() => window.asked.some((q) => q.kind === 'brickLoan'), 10_000);
		process.kill(dev.daemon.pid);
		await waitFor(() => !alive(dev.daemon.pid), 5000);
		await sleep(300);
		answer('yes');
		await borrowing;
		await sleep(500);

		assert.equal(brick(window, 'Marvin')?.connected, true);
		assert.equal(brick(window, 'Marvin')?.blocked, undefined);
		assert.equal((await window.request('daemon/status', {})).lent, undefined);
	});

	it('lends everything: the user\'s daemon enters Lent and leaves it when the development daemon ends', async (t) => {
		t.after(endAll);
		const pair = channels();
		const window = await connect(pair, 'user', 'VS Code window', 'vscode', () => 'yes');
		await window.request('bricks/list', { waitForDiscovery: true });
		await window.request('bricks/connect', { brick: 'R2D2' });

		const dev = await connect(pair, 'dev', 'development window');
		await dev.request('bricks/list', { waitForDiscovery: true });
		assert.deepEqual(await dev.request('bricks/borrowAll', {}), { lent: true });
		assert.equal((await window.request('daemon/status', {})).lent, true);
		await dev.request('bricks/connect', { brick: 'R2D2' });
		await dev.request('bricks/connect', { brick: 'SkyNet' });
		await assert.rejects(window.request('bricks/connect', { brick: 'Marvin' }), /lent/);

		process.kill(dev.daemon.pid);
		await waitFor(() => brick(window, 'R2D2')?.connected === true, 15_000);
		assert.equal((await window.request('daemon/status', {})).lent, undefined);
	});

	it('lets a development daemon with no user\'s daemon own the hardware, and a user\'s daemon starting then waits in Lent', async (t) => {
		t.after(endAll);
		const pair = channels();
		const dev = await connect(pair, 'dev', 'development window');
		await dev.request('bricks/list', { waitForDiscovery: true });
		await dev.request('bricks/connect', { brick: 'R2D2' });

		const window = await connect(pair, 'user', 'VS Code window', 'vscode', () => 'yes');
		assert.equal((await window.request('daemon/status', {})).lent, true);
		await window.request('bricks/list', { waitForDiscovery: true });
		await assert.rejects(window.request('bricks/connect', { brick: 'SkyNet' }));

		process.kill(dev.daemon.pid);
		await waitFor(() => !alive(dev.daemon.pid), 5000);
		for (const until = Date.now() + 10_000; (await window.request('daemon/status', {})).lent;) {
			assert.ok(Date.now() < until, 'the user\'s daemon never took the hardware');
			await sleep(200);
		}
		await window.request('bricks/connect', { brick: 'SkyNet' });
		assert.equal(brick(window, 'SkyNet')?.connected ?? (await window.request('bricks/list', {})).find((b) => b.name === 'SkyNet')?.connected, true);
	});
});
