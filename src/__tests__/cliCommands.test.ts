/**
 * The `ev3` command as its own process against a private daemon on simulated bricks: listing,
 * holding and releasing a brick, the brick a command means when none is named, the exit codes a
 * script reads, and the operations that refuse to change anything without a person at a terminal.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ContractBrick, DaemonStatus, Question } from '../contract/models';
import { privateHome } from './clientDaemonHelpers';
import { CliWorld, cliWorld, ev3 } from './cliHelpers';

const home = privateHome();

describe('the ev3 command', () => {
	let w: CliWorld;
	before(async () => { w = await cliWorld(home); });
	after(async () => { await w.done(); });

	it('on a daemon that has just started, lists the bricks as JSON and connects one', async () => {
		// The daemon's first discovery round is still running: both commands wait for it.
		const [list, connect] = await Promise.all([ev3(['list', '--json'], { env: w.env }), ev3(['connect', 'CCC'], { env: w.env })]);
		assert.equal(list.code, 0, list.stderr);
		const bricks = JSON.parse(list.stdout) as ContractBrick[];
		const ccc = bricks.find((b) => b.name === 'CCC');
		assert.ok(ccc, list.stdout);
		assert.equal(typeof ccc.brickId, 'string');
		assert.ok(Array.isArray(ccc.channels) && Array.isArray(ccc.holders));
		assert.equal(connect.code, 0, connect.stderr);
		await ev3(['disconnect', 'CCC'], { env: w.env });
	});

	it('holds a brick past ev3 connect, shows the hold in a second process and releases it on ev3 disconnect', async () => {
		const connect = await ev3(['connect', 'CCC'], { env: w.env });
		assert.equal(connect.code, 0, connect.stderr);

		const status = await ev3(['status', '--json'], { env: w.env });
		assert.equal(status.code, 0, status.stderr);
		const parsed = JSON.parse(status.stdout) as DaemonStatus;
		assert.equal(parsed.channel, w.daemon.paths.channel);
		assert.deepEqual(parsed.bricks.find((b) => b.name === 'CCC')?.holders, [{ kind: 'hold' }]);
		const human = await ev3(['status'], { env: w.env });
		assert.match(human.stdout, /CCC.*held by ev3 connect/);

		const disconnect = await ev3(['disconnect', 'CCC'], { env: w.env });
		assert.equal(disconnect.code, 0, disconnect.stderr);
		const afterwards = JSON.parse((await ev3(['status', '--json'], { env: w.env })).stdout) as DaemonStatus;
		assert.equal(afterwards.bricks.some((b) => b.name === 'CCC'), false);
	});

	it('uses the one connected brick when none is named, and with two names the candidates', async () => {
		await ev3(['connect', 'CCC'], { env: w.env });
		const one = await ev3(['info', '--json'], { env: w.env });
		assert.equal(one.code, 0, one.stderr);
		assert.equal((JSON.parse(one.stdout) as { name: string }).name, 'CCC');

		await ev3(['connect', 'BBB'], { env: w.env });
		const two = await ev3(['info', '--json'], { env: w.env });
		assert.equal(two.code, 1);
		const error = (JSON.parse(two.stdout) as { error: { code: string; candidates: { name: string }[] } }).error;
		assert.equal(error.code, 'brick_ambiguous');
		assert.deepEqual(error.candidates.map((c) => c.name).sort(), ['BBB', 'CCC']);
		await ev3(['disconnect', 'CCC', '--all'], { env: w.env });
		await ev3(['disconnect', 'BBB', '--all'], { env: w.env });
	});

	it('exits 3 and names the holder when another client is writing to the brick', async () => {
		// Clearing a Bluetooth list holds the brick's write lease while it waits for the person's answer.
		assert.equal((await ev3(['connect', 'CCC'], { env: w.env })).code, 0);
		const holder = await (await import('../client')).CockpitClient.connect({
			name: 'lease holder', kind: 'vscode', version: '0.0.1', paths: w.daemon.paths,
		});
		let answer!: (a: 'no') => void;
		const asked = new Promise<Question>((resolveAsked) => {
			holder.onQuestion((q) => { resolveAsked(q); return new Promise((resolve) => { answer = resolve; }); });
		});
		const clearing = holder.request('bricks/clearBluetoothList', { brick: 'CCC' });
		await asked;
		const file = path.join(home, 'program.rbf');
		fs.writeFileSync(file, 'x');
		const put = await ev3(['put', file, '/home/root/lms2012/prjs/Demo/program.rbf', '--brick', 'CCC'], { env: w.env });
		answer('no');
		await clearing;
		holder.dispose();
		await ev3(['disconnect', 'CCC'], { env: w.env });
		assert.equal(put.code, 3, put.stderr);
		assert.match(put.stderr, /lease holder/);
	});

	it('refuses to switch access mode to full without a terminal, and leaves it safe', async () => {
		const set = await ev3(['config', 'set', 'access-mode', 'full'], { env: w.env });
		assert.equal(set.code, 5, set.stderr);
		assert.match(set.stderr, /EVƎ: Settings/);
		assert.equal(await w.observer.request('settings/accessMode', {}), 'safe');
	});

	it('refuses daemon restart, forget and bt-clear without a terminal, and changes nothing', async () => {
		const before = await w.observer.request('daemon/status', {});
		const restart = await ev3(['daemon', 'restart'], { env: w.env });
		assert.equal(restart.code, 5, restart.stderr);
		assert.match(restart.stderr, /terminal/);
		assert.equal((await w.observer.request('daemon/status', {})).pid, before.pid);

		const forget = await ev3(['forget', 'CCC'], { env: w.env });
		assert.equal(forget.code, 5, forget.stderr);
		const clear = await ev3(['bt-clear', 'CCC', '--json'], { env: w.env });
		assert.equal(clear.code, 5, clear.stdout);
		assert.equal((JSON.parse(clear.stdout) as { error: { code: string } }).error.code, 'needs_person');
		assert.ok((await w.observer.request('bricks/list', {})).some((b) => b.name === 'CCC'));
	});

	it('pairs without asking anything at the terminal and reports what the brick answered', async () => {
		const pair = await ev3(['pair', 'CCC'], { env: w.env });
		// A simulated brick has no Bluetooth channel, so the brick never confirms.
		assert.equal(pair.code, 1, pair.stderr);
		assert.match(pair.stdout, /Not paired: .*Bluetooth/);
		assert.doesNotMatch(pair.stderr, /\[y\/N\]/);
	});
});
