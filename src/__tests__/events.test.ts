/**
 * The core's event emitter delivers as VS Code's does.
 *
 * The expected observations below were recorded from VS Code's own `EventEmitter` in the extension
 * host (VS Code 1.146, 18.11.2026), by running the same scenarios (`src/test/emitterScenarios.ts`);
 * the host suite compares the two emitters live on every run.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EventEmitter, setListenerErrorHandler } from '../events';
import { observeEmitter } from '../test/emitterScenarios';

const RECORDED_FROM_VSCODE = [
	{ scenario: 'listeners are called in subscription order with the fired value', seen: ['a1', 'b1', 'c1', 'a2', 'b2', 'c2'] },
	{ scenario: 'a disposed subscription is not called, the others are', seen: ['a', 'c', 'a', 'c'] },
	{ scenario: 'a listener that throws does not stop the others, and fire does not throw', seen: { calls: ['a', 'b', 'c'], threw: false } },
	{ scenario: 'a listener added during a fire', seen: ['a1', 'b1', 'a2', 'b2', 'late2'] },
	{ scenario: 'a listener removed during a fire before its turn', seen: ['a1', 'b1', 'a2', 'b2'] },
	{ scenario: 'a listener that removes itself during a fire', seen: ['a1', 'b1', 'b2'] },
	{ scenario: 'a fire from inside a listener of the same emitter', seen: ['a1', 'b1', 'c1', 'a2', 'b2', 'c2'] },
	{ scenario: 'the emitter disposed during a fire', seen: ['a1'] },
	{ scenario: 'after the emitter is disposed, fire does nothing and subscribing returns a disposable', seen: { calls: [], disposeThrew: false, fireThrew: false } },
	{ scenario: 'the disposables collection receives the subscription', seen: { calls: ['a'], collected: 1 } },
	{ scenario: 'this binds the listener', seen: ['owner1'] },
];

/** Runs `body` with listener errors collected instead of printed. */
function collectingListenerErrors(body: (errors: unknown[]) => void): void {
	const errors: unknown[] = [];
	const previous = setListenerErrorHandler((error) => errors.push(error));
	try { body(errors); } finally { setListenerErrorHandler(previous); }
}

describe('EventEmitter delivers as VS Code\'s does', () => {
	for (const expected of RECORDED_FROM_VSCODE) {
		it(expected.scenario, () => {
			collectingListenerErrors(() => {
				const seen = observeEmitter(() => new EventEmitter()).find((o) => o.scenario === expected.scenario);
				assert.ok(seen, `no such scenario: ${expected.scenario}`);
				assert.deepEqual(seen.seen, expected.seen);
			});
		});
	}

	it('runs every scenario that was recorded, and no other', () => {
		collectingListenerErrors(() => {
			const names = observeEmitter(() => new EventEmitter()).map((o) => o.scenario);
			assert.deepEqual(names, RECORDED_FROM_VSCODE.map((o) => o.scenario));
		});
	});
});

describe('EventEmitter listener errors', () => {
	it('hands an error a listener throws to the error handler exactly once, and fire does not throw', () => {
		collectingListenerErrors((errors) => {
			const emitter = new EventEmitter<number>();
			const failure = new Error('listener failed');
			const heard: number[] = [];
			emitter.event(() => { throw failure; });
			emitter.event((n) => heard.push(n));
			emitter.fire(7);
			assert.deepEqual(errors, [failure]);
			assert.deepEqual(heard, [7]);
		});
	});

	it('restores the handler it replaced', () => {
		const mine = (): void => { /* collects nothing */ };
		const previous = setListenerErrorHandler(mine);
		assert.equal(setListenerErrorHandler(previous), mine);
	});
});
