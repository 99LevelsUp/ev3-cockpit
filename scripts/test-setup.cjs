/**
 * Preload script for unit tests. Registers the vscode stub module
 * so that require('vscode') resolves without the real extension host.
 */
'use strict';

const Module = require('module');
const path = require('path');

const vscodeStub = require(path.join(__dirname, '..', 'src', 'test', 'vscodeStub.cjs'));

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === 'vscode') {
		return path.join(__dirname, '..', 'src', 'test', 'vscodeStub.cjs');
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
	const { after } = require('node:test');
	const keepAlive = setInterval(() => {}, 1 << 30);
	after(() => clearInterval(keepAlive));
}
