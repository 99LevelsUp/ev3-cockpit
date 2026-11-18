/**
 * The core's event emitter delivers as VS Code's does.
 *
 * The expected observations below were recorded from VS Code's own `EventEmitter` in the extension
 * host (VS Code 1.146, 18.11.2026), by running the same scenarios (`src/test/emitterScenarios.ts`);
 * the host suite compares the two emitters live on every run.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
	{ scenario: 'a fire from inside a listener has delivered both events when it returns', seen: ['a1', 'nested-fire', 'b1', 'a2', 'b2', 'nested-returned'] },
	{ scenario: 'the emitter disposed by a listener right after a fire from inside it', seen: ['a1', 'b1', 'c1', 'a2', 'b2', 'c2'] },
	{ scenario: 'a listener added right after a fire from inside a listener', seen: ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'late3'] },
	{ scenario: 'the same listener subscribed twice', seen: ['x1', 'x1', 'x2'] },
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

	it('keeps delivering when the error handler itself throws, and the next fire still works', () => {
		const previous = setListenerErrorHandler(() => { throw new Error('handler failed'); });
		const quiet = console.error;
		console.error = () => { /* the handler's failure is reported here; not under test */ };
		try {
			const emitter = new EventEmitter<number>();
			const heard: string[] = [];
			emitter.event((n) => { heard.push(`a${n}`); if (n === 1) { emitter.fire(2); } throw new Error('listener failed'); });
			emitter.event((n) => heard.push(`b${n}`));
			assert.doesNotThrow(() => emitter.fire(1));
			emitter.fire(3);
			assert.deepEqual(heard, ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
		} finally {
			console.error = quiet;
			setListenerErrorHandler(previous);
		}
	});

	it('fails a unit test whose listener throws, under the suite\'s preload', () => {
		// The preload turns a listener's error into a failed test; without it an assertion inside a
		// listener would only reach the console. Run a one-test file under the same preload.
		const repo = path.resolve(__dirname, '..', '..');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-listener-'));
		const file = path.join(dir, 'listener.test.js');
		fs.writeFileSync(file, [
			`const { it } = require('node:test');`,
			`const assert = require('node:assert/strict');`,
			`const { EventEmitter } = require(${JSON.stringify(path.join(repo, 'out', 'events'))});`,
			`it('asserts inside a listener', () => {`,
			`  const emitter = new EventEmitter();`,
			`  emitter.event((n) => assert.equal(n, 2));`,
			`  emitter.fire(1);`,
			`});`,
		].join('\n'));
		try {
			// A fresh runner: without this test's own NODE_TEST_CONTEXT, which would make the preload
			// treat the runner as a test file and hold it open.
			const env = { ...process.env };
			delete env.NODE_TEST_CONTEXT;
			const run = spawnSync(process.execPath, ['--require', path.join(repo, 'scripts', 'test-setup.cjs'), '--test', file], { encoding: 'utf8', env, timeout: 60_000 });
			assert.notEqual(run.status, 0, `the test passed:\n${run.stdout}`);
			assert.match(run.stdout + run.stderr, /An event listener threw 1 time/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('restores the handler it replaced', () => {
		const mine = (): void => { /* collects nothing */ };
		const previous = setListenerErrorHandler(mine);
		assert.equal(setListenerErrorHandler(previous), mine);
	});
});
