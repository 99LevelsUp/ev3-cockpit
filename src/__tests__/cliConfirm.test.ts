/**
 * Asking the person at the terminal: only a real terminal is asked, and only a typed yes counts.
 * Without one, what needs a person is refused and the daemon's questions are answered `keep`.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { ContractError } from '../client';
import { Confirmer } from '../cli/confirm';
import type { Question } from '../contract/models';
import { privateHome } from './clientDaemonHelpers';
import { CliWorld, cliWorld, ev3InTerminal } from './cliHelpers';
import { waitFor } from './waitFor';

const home = privateHome();

const question: Question = { questionId: 'q1', kind: 'forget', text: 'Forget CCC?', timeoutMs: 1000 };

function terminal(typed: string | undefined, isTTY: boolean): { input: PassThrough; output: PassThrough; isTTY: boolean } {
	const input = new PassThrough();
	if (typed !== undefined) { input.end(typed); }
	return { input, output: new PassThrough(), isTTY };
}

describe('asking a person', () => {
	it('answers keep without reading anything when there is no terminal, or the output is JSON', async () => {
		assert.equal(await new Confirmer(terminal(undefined, false), false).answer(question), 'keep');
		assert.equal(await new Confirmer(terminal(undefined, true), true).answer(question), 'keep');
	});

	it('refuses what needs a person when there is no terminal, with the message given', async () => {
		await assert.rejects(new Confirmer(terminal(undefined, false), false).confirm({ text: 'Sure?', refusal: 'Run it yourself.', command: 'ev3 x' }),
			(e: unknown) => e instanceof ContractError && e.code === 'needs_person' && e.message === 'Run it yourself.' && e.data.command === 'ev3 x');
	});

	it('counts only a typed yes', async () => {
		assert.equal(await new Confirmer(terminal('yes\n', true), false).answer(question), 'yes');
		assert.equal(await new Confirmer(terminal('y\n', true), false).answer(question), 'yes');
		assert.equal(await new Confirmer(terminal('\n', true), false).answer(question), 'no');
		assert.equal(await new Confirmer(terminal('', true), false).answer(question), 'no');
	});
});

describe('the ev3 command at a terminal', () => {
	let w: CliWorld;
	before(async () => { w = await cliWorld(home); });
	after(async () => { await w.done(); });

	it('switches access mode to full once the person types yes', async () => {
		const result = await ev3InTerminal(['config', 'set', 'access-mode', 'full'], 'yes\n', w.env);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.prompt, /full/);
		assert.equal(await w.observer.request('settings/accessMode', {}), 'full');
		// Back to safe needs nobody's confirmation.
		assert.equal((await ev3InTerminal(['config', 'set', 'access-mode', 'safe'], '', w.env, false)).code, 0);
		assert.equal(await w.observer.request('settings/accessMode', {}), 'safe');
	});

	it('shows the entries bt-clear would remove and keeps them when the person says no', async () => {
		const result = await ev3InTerminal(['bt-clear', 'CCC'], 'n\n', w.env);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.prompt, /HOSTA/);
		assert.match(result.prompt, /HOSTB/);
		const again = await ev3InTerminal(['bt-clear', 'CCC'], 'n\n', w.env);
		assert.match(again.prompt, /HOSTA[\s\S]*HOSTB/);
	});

	it('asks before forgetting a brick and forgets nothing on a no', async () => {
		const result = await ev3InTerminal(['forget', 'CCC'], 'no\n', w.env);
		assert.equal(result.code, 1, result.stderr);
		assert.match(result.prompt, /Forget CCC\?/);
		assert.ok((await w.observer.request('bricks/list', {})).some((b) => b.name === 'CCC'));
	});

	it('asks before a daemon restart, and on a yes the successor serves the same simulated bricks', async () => {
		const declined = await ev3InTerminal(['daemon', 'restart'], 'no\n', w.env);
		assert.equal(declined.code, 1);
		assert.match(declined.prompt, /Restart the cockpit daemon now\?/);
		const before = w.observer.daemon.pid;
		let reconnected = false;
		w.observer.onReconnected(() => { reconnected = true; });
		const accepted = await ev3InTerminal(['daemon', 'restart'], 'yes\n', w.env);
		assert.equal(accepted.code, 0, accepted.stderr);
		await waitFor(() => reconnected, 20_000);
		assert.notEqual(w.observer.daemon.pid, before);
		assert.ok((await w.observer.request('bricks/list', { waitForDiscovery: true })).some((b) => b.name === 'CCC'));
	});
});
