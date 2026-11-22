/**
 * Asking the person at the terminal: the daemon asks the terminal whose request it is, only a real
 * terminal answers, and only a typed yes counts. Without one, no question is answered and the
 * daemon refuses.
 *
 * The terminal tests run `ev3` in this process against the native daemon in matched replay of brick
 * AAA over USB; without `daemon/target/debug/ev3-cockpitd(.exe)` they are skipped.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { Confirmer } from '../cli/confirm';
import type { RunOptions } from '../cli/main';
import type { Question } from '../contract/generated';
import { NativeCliWorld, ev3InTerminal, nativeCliWorld } from './cliHelpers';
import { nativeBinaryMissing, sleep } from './clientDaemonHelpers';
import { waitFor } from './waitFor';

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

const home = temp('ev3-cli-confirm-');

const question: Question = {
	questionId: 'q1', kind: 'forget', brickId: 'AAA', text: 'Forget AAA?', timeoutMs: 1000,
	requester: { name: 'an agent', kind: 'mcp' },
};

function terminal(typed: string | undefined, isTTY: boolean): { input: PassThrough; output: PassThrough; isTTY: boolean } {
	const input = new PassThrough();
	if (typed !== undefined) { input.end(typed); }
	return { input, output: new PassThrough(), isTTY };
}

describe('asking a person', () => {
	it('can ask only at a terminal, and not when the output is JSON', () => {
		assert.equal(new Confirmer(terminal(undefined, false), false).canAsk, false);
		assert.equal(new Confirmer(terminal(undefined, true), true).canAsk, false);
		assert.equal(new Confirmer(terminal(undefined, true), false).canAsk, true);
	});

	it('counts only a typed yes', async () => {
		assert.equal(await new Confirmer(terminal('yes\n', true), false).answer(question), 'yes');
		assert.equal(await new Confirmer(terminal('y\n', true), false).answer(question), 'yes');
		assert.equal(await new Confirmer(terminal('\n', true), false).answer(question), 'no');
		assert.equal(await new Confirmer(terminal('', true), false).answer(question), 'no');
	});

	it('says which client asked when it was not this terminal', async () => {
		const io = terminal('n\n', true);
		let shown = '';
		io.output.on('data', (d: Buffer) => { shown += d.toString(); });
		await new Confirmer(io, false, 'ev3 forget (terminal)').answer(question);
		assert.match(shown, /an agent \(mcp\)/);
	});

	it('stops waiting and answers keep when the daemon withdraws the question', async () => {
		const controller = new AbortController();
		const io = terminal(undefined, true);
		const answer = new Confirmer(io, false).answer(question, { signal: controller.signal });
		controller.abort();
		assert.equal(await answer, 'keep');
	});
});

describe('the ev3 command at a terminal', { skip: nativeBinaryMissing }, () => {
	let w: NativeCliWorld;
	/** The in-process command starts a replay daemon of its own, never one on real hardware. */
	let replay: RunOptions;
	before(async () => {
		w = await nativeCliWorld(home);
		const { daemon, daemonArgs } = w.channel.client('cli', 'development');
		replay = { client: { ...(daemon ? { daemon } : {}), ...(daemonArgs ? { daemonArgs } : {}) } };
	});
	after(async () => { await w.done(); });

	it('switches access mode to full once the person types yes', async () => {
		const result = await ev3InTerminal(['config', 'set', 'access-mode', 'full'], 'yes\n', w.env, true, replay);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.prompt, /full/);
		assert.equal((await w.observer.request('settings/accessMode', {})).mode, 'full');
		// Back to safe needs nobody's confirmation.
		assert.equal((await ev3InTerminal(['config', 'set', 'access-mode', 'safe'], '', w.env, false, replay)).code, 0);
		assert.equal((await w.observer.request('settings/accessMode', {})).mode, 'safe');
	});

	it('asks before forgetting a brick and forgets nothing on a no', async () => {
		const result = await ev3InTerminal(['forget', 'AAA'], 'no\n', w.env, true, replay);
		assert.equal(result.code, 1, result.stderr);
		assert.match(result.prompt, /AAA[\s\S]*\[y\/N\]/);
		assert.deepEqual((await w.observer.request('bricks/list', {})).bricks.map((b) => b.name), ['AAA']);
	});

	it('asks before a daemon restart; on a no it keeps running, on a yes a new daemon serves', async () => {
		const before = w.observer.daemon.pid;
		const declined = await ev3InTerminal(['daemon', 'restart'], 'no\n', w.env, true, replay);
		assert.equal(declined.code, 1, declined.stderr);
		assert.match(declined.prompt, /Restart the EVƎ Cockpit daemon\?/);
		assert.equal((await w.observer.request('daemon/status', {})).pid, before);

		let reconnected = false;
		w.observer.onReconnected(() => { reconnected = true; });
		const json = await ev3InTerminal(['daemon', 'restart', '--json'], 'yes\n', w.env, true, replay);
		assert.equal(json.code, 5, `with --json nobody is asked: ${json.stdout}`);
		assert.equal((await w.observer.request('daemon/status', {})).pid, before);
		const accepted = await ev3InTerminal(['daemon', 'restart'], 'yes\n', w.env, true, replay);
		assert.equal(accepted.code, 0, accepted.stderr);
		await waitFor(() => reconnected, 20_000);
		assert.notEqual(w.observer.daemon.pid, before);
		assert.equal(w.observer.daemon.mode, 'replay');
	});
});
