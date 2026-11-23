/**
 * Preload script for unit tests. Registers the vscode stub module
 * so that require('vscode') resolves without the real extension host.
 *
 * Loaded with `node --require`, so it stays synchronous: no top-level await anywhere it reaches.
 */

import Module, { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const stubPath = path.join(import.meta.dirname, '..', 'src', 'test', 'vscodeStub.mts');

/** The part of Node's CommonJS loader this preload reaches into; Node does not type it. */
type Resolve = (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
const loader = Module as unknown as { _resolveFilename: Resolve };

require(stubPath);

const originalResolve = loader._resolveFilename;
loader._resolveFilename = function (this: unknown, request, parent, isMain, options) {
	if (request === 'vscode') {
		return stubPath;
	}
	return originalResolve.call(this, request, parent, isMain, options);
};

// Keep each test file's process alive until its tests end. Transport code unrefs its timers so they
// never hold the extension host open, and a test awaiting only such a timer has nothing else keeping
// the event loop busy: on Linux node:test then cancels it as "Promise resolution is still pending but
// the event loop has already resolved" (found on HOSTC, 11.11.2026; on Windows the loop stayed busy).
// The root `after` hook releases it, so a file still exits once its tests are done. Only in a test
// file's own process: the preload runs in the runner that spawns them too, which it would hold open.
if (process.env.NODE_TEST_CONTEXT) {
	const { after, afterEach } = require('node:test') as typeof import('node:test');
	const keepAlive = setInterval(() => {}, 1 << 30);
	after(() => clearInterval(keepAlive));

	// The extension's events, like VS Code's, never let a listener's error reach the code that fired:
	// in production it goes to the console. Here it fails the running test instead, so an assertion
	// inside a listener still guards its test. A test that expects a listener to throw installs its
	// own handler for the duration.
	const listenerErrors: unknown[] = [];
	const { setListenerErrorHandler } = require(path.join(import.meta.dirname, '..', 'out', 'vscode', 'events')) as typeof import('../src/vscode/events.ts');
	setListenerErrorHandler((error) => listenerErrors.push(error));
	afterEach(() => {
		const errors = listenerErrors.splice(0);
		if (errors.length > 0) {
			const first = errors[0];
			throw new Error(`An event listener threw ${errors.length} time(s) during this test: ${first instanceof Error ? first.stack ?? first.message : String(first)}`);
		}
	});
}
