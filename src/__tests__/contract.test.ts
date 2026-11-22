/**
 * The contract add-ons import: plain data and constants that load anywhere, and errors that keep
 * every cockpit error distinguishable on the wire.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
	CONTRACT_VERSION, ERROR_KINDS, WireErrorCode, errorKindOf, wireErrorNumber,
} from '../contract';
import { ERROR_FAMILY, ERROR_FAMILY_NUMBER } from '../contract/generated';
import * as coreErrors from '../core/errors/CockpitError';

const REPO = path.resolve(__dirname, '..', '..');

describe('the contract', () => {
	it('loads in a fresh Node process with no vscode module and pulls in no native module', () => {
		const entry = path.join(REPO, 'out', 'contract', 'index');
		const script = `require(${JSON.stringify(entry)});`
			+ 'const loaded = Object.keys(require.cache).filter((f) => f.includes("node_modules"));'
			+ 'process.stdout.write(JSON.stringify(loaded));';
		const env = { ...process.env };
		delete env.NODE_OPTIONS;
		delete env.NODE_TEST_CONTEXT;
		const run = spawnSync(process.execPath, ['-e', script], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 });
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(JSON.parse(run.stdout), []);
	});

	it('has a version clients can compare', () => {
		assert.equal(typeof CONTRACT_VERSION, 'number');
		assert.ok(CONTRACT_VERSION >= 1);
	});

	it('keeps every error number outside the range JSON-RPC reserves', () => {
		for (const code of Object.values(WireErrorCode)) {
			const n = wireErrorNumber(code);
			assert.ok(n < -32768 || n > -32000, `${code} maps to ${n}`);
		}
	});

	it('names every code the contract defines, in the family the contract gives it', () => {
		const named = new Set<string>(Object.values(WireErrorCode));
		for (const [code, family] of Object.entries(ERROR_FAMILY)) {
			assert.ok(named.has(code), `${code} has no name in WireErrorCode`);
			assert.equal(wireErrorNumber(code as WireErrorCode), ERROR_FAMILY_NUMBER[family], code);
		}
	});

	it('carries every code the cockpit raises', () => {
		const wire = new Set<string>(Object.values(WireErrorCode));
		for (const code of Object.values(coreErrors.ErrorCode)) {
			assert.ok(wire.has(code), `${code} has no wire code`);
		}
	});

	it('names every cockpit error class as a kind of its own', () => {
		const classes = Object.entries(coreErrors)
			.filter(([, value]) => typeof value === 'function' && value.prototype instanceof Error)
			.map(([name]) => name);
		assert.ok(classes.length > 15, `only ${classes.length} error classes found`);
		for (const name of classes) {
			assert.equal(errorKindOf(name), name, `${name} reads as ${errorKindOf(name)}`);
		}
	});

	it('reads a class it does not know as Unknown without throwing', () => {
		assert.equal(errorKindOf('SomethingNewError'), 'Unknown');
		assert.equal(errorKindOf(undefined), 'Unknown');
		assert.ok(ERROR_KINDS.includes('Unknown'));
	});
});
