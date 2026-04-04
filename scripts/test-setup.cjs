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
