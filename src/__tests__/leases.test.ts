/** One writer per brick, for one request; a dead client's request ends before the next writer starts. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContractError } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import { Leases } from '../daemon/leases';

const terminal = { clientId: 't', name: 'ev3 c run (terminal)' };
const vscode = { clientId: 'v', name: 'VS Code' };

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

describe('write leases', () => {
	it('refuses a second writer with brick_busy naming the first, while other bricks stay free', async () => {
		const leases = new Leases();
		const upload = deferred();
		const first = leases.run('CCC', terminal, () => upload.promise);
		await assert.rejects(leases.run('CCC', vscode, () => Promise.resolve()), (error: unknown) =>
			error instanceof ContractError && error.code === WireErrorCode.BrickBusy && error.data.holder === 'ev3 c run (terminal)');
		await leases.run('BBB', vscode, () => Promise.resolve());
		assert.equal(leases.holder('CCC'), 'ev3 c run (terminal)');
		upload.resolve();
		await first;
	});

	it('ends with the request, so the next writer gets through right after it', async () => {
		const leases = new Leases();
		await leases.run('CCC', terminal, () => Promise.resolve('started'));
		assert.equal(leases.holder('CCC'), undefined);
		assert.equal(await leases.run('CCC', vscode, () => Promise.resolve('ok')), 'ok');
	});

	it('aborts a leaving client\'s request and frees the brick only once that request has settled', async () => {
		const leases = new Leases();
		const settled = deferred();
		let aborted = false;
		const upload = leases.run('CCC', terminal, async (signal) => {
			await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }));
			await settled.promise;
			throw new Error('aborted upload');
		});
		leases.clientLeft('t');
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(aborted, true);
		// Still held: the aborted upload is closing its slot.
		await assert.rejects(leases.run('CCC', vscode, () => Promise.resolve()), (e: unknown) => (e as ContractError).code === WireErrorCode.BrickBusy);
		settled.resolve();
		await assert.rejects(upload, /aborted upload/);
		await leases.run('CCC', vscode, () => Promise.resolve());
	});

	it('passes a caller\'s cancel on to the work', async () => {
		const leases = new Leases();
		const controller = new AbortController();
		const run = leases.run('CCC', vscode, (signal) => new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(new Error('cancelled')));
		}), controller.signal);
		controller.abort();
		await assert.rejects(run, /cancelled/);
		assert.equal(leases.busy(), false);
	});
});
