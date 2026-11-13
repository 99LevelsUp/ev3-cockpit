/**
 * One lifetime for everything a provider starts (review of 2b3a311 / bd8f5bb, round 4): an
 * operation runs inside the scope, gets its signal, and a dispose aborts it and waits for it to
 * finish cleaning up. Nothing runs outside the scope, so nothing outlives a dispose.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LifetimeScope, abortableDelay } from '../transports/lifetimeScope';

describe('LifetimeScope', () => {
	it('runs an operation and hands back its result', async () => {
		const scope = new LifetimeScope('test');
		assert.equal(await scope.run(async () => 42), 42);
	});

	it('aborts the signal of every running operation on dispose, and waits for each to settle', async () => {
		const scope = new LifetimeScope('test');
		const events: string[] = [];
		const op = scope.run(async (signal) => {
			await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
			events.push('saw abort');
			await new Promise((resolve) => setTimeout(resolve, 20));
			events.push('cleaned up');
		});
		const disposed = scope.dispose().then(() => events.push('dispose resolved'));
		await Promise.all([op, disposed]);
		assert.deepEqual(events, ['saw abort', 'cleaned up', 'dispose resolved']);
	});

	it('refuses a new operation once disposed, without running it', async () => {
		const scope = new LifetimeScope('test provider');
		await scope.dispose();
		let ran = false;
		await assert.rejects(() => scope.run(async () => { ran = true; }), /test provider has been disposed/);
		assert.equal(ran, false);
		assert.equal(scope.disposed, true);
	});

	it('waits for an operation that fails, and does not reject the dispose', async () => {
		const scope = new LifetimeScope('test');
		const op = scope.run(async (signal) => {
			await abortableDelay(10_000, signal);
		});
		await scope.dispose();
		await assert.rejects(() => op, /disposed/);
	});

	it('resolves a second dispose with the first', async () => {
		const scope = new LifetimeScope('test');
		let release!: () => void;
		void scope.run(() => new Promise<void>((resolve) => { release = resolve; }));
		const first = scope.dispose();
		const second = scope.dispose();
		let secondDone = false;
		void second.then(() => { secondDone = true; });
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(secondDone, false, 'the second waits for the same operations');
		release();
		await Promise.all([first, second]);
		assert.equal(secondDone, true);
	});
});

describe('abortableDelay', () => {
	it('waits its time', async () => {
		const started = Date.now();
		await abortableDelay(30, new AbortController().signal);
		assert.ok(Date.now() - started >= 25);
	});

	it('ends at once with the abort reason when aborted', async () => {
		const controller = new AbortController();
		const started = Date.now();
		const waiting = abortableDelay(10_000, controller.signal);
		controller.abort(new Error('stop now'));
		await assert.rejects(() => waiting, /stop now/);
		assert.ok(Date.now() - started < 1000);
	});

	it('refuses at once on a signal already aborted', async () => {
		const controller = new AbortController();
		controller.abort(new Error('already'));
		await assert.rejects(() => abortableDelay(10_000, controller.signal), /already/);
	});
});
