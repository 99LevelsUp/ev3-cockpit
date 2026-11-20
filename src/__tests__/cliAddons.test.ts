/**
 * Add-ons: `ev3 foo` runs `ev3-foo` found in an absolute PATH folder, by its absolute path and
 * without a shell; never one in the current folder; never a name that could climb folders or carry
 * shell syntax. On Windows an npm `.cmd` shim runs its Node script with this Node, not `cmd.exe`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { findAddon } from '../cli/addons';
import { UsageError } from '../cli/output';
import { ev3 } from './cliHelpers';

const windows = process.platform === 'win32';

/** The script an add-on runs: it reports how it was started and exits 7. */
const SCRIPT = 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1) })); process.exit(7);\n';

/** Installs `ev3-foo` in `dir` the way npm would on this OS; returns the script that should run. */
function installAddon(dir: string): string {
	if (windows) {
		const pkg = path.join(dir, 'node_modules', 'ev3-foo', 'bin');
		fs.mkdirSync(pkg, { recursive: true });
		const script = path.join(pkg, 'foo.js');
		fs.writeFileSync(script, SCRIPT);
		// npm's shim; the echo shows whether cmd.exe ever ran it.
		fs.writeFileSync(path.join(dir, 'ev3-foo.cmd'), [
			'@ECHO off', 'echo SHELL-RAN', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
			'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
			'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\ev3-foo\\bin\\foo.js" %*', '',
		].join('\r\n'));
		return script;
	}
	const script = path.join(dir, 'ev3-foo');
	fs.writeFileSync(script, `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
	return script;
}

function envWithPath(value: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) { if (key.toUpperCase() === 'PATH') { delete env[key]; } }
	env.PATH = value;
	return env;
}

describe('ev3 add-ons', () => {
	it('does not run ev3-foo from the current folder', async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-addon-cwd-'));
		installAddon(cwd);
		const result = await ev3(['foo'], { env: envWithPath(['.', 'relative'].join(path.delimiter)), cwd });
		assert.equal(result.code, 2, result.stdout);
		assert.match(result.stderr, /no add-on ev3-foo on PATH/);
	});

	it('runs ev3-foo found on PATH by its absolute path, passes its arguments and exits with its code', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-addon-bin-'));
		const script = installAddon(dir);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-addon-elsewhere-'));
		const result = await ev3(['foo', 'a', 'b c', '--json'], { env: envWithPath(['.', dir].join(path.delimiter)), cwd });
		assert.equal(result.code, 7, result.stderr);
		assert.doesNotMatch(result.stdout, /SHELL-RAN/);
		const reported = JSON.parse(result.stdout) as { argv: string[] };
		assert.equal(fs.realpathSync(reported.argv[0]), fs.realpathSync(script));
		assert.deepEqual(reported.argv.slice(1), ['a', 'b c', '--json']);
	});

	it('runs an npm .cmd shim on Windows as its Node script with this Node, never through cmd.exe', { skip: !windows }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-addon-shim-'));
		const script = installAddon(dir);
		const found = findAddon('foo', { env: { PATH: dir }, platform: 'win32', execPath: 'C:\\node\\node.exe' });
		assert.deepEqual(found && { command: found.command, args: found.args }, { command: 'C:\\node\\node.exe', args: [script] });
	});

	it('refuses a name that could climb folders or carry shell syntax', async () => {
		for (const name of ['..', '../foo', 'foo&calc', 'foo;rm', 'Foo', 'foo bar', '-x']) {
			assert.throws(() => findAddon(name, { env: { PATH: os.tmpdir() } }), UsageError, name);
		}
		const result = await ev3(['foo&calc'], { env: process.env });
		assert.equal(result.code, 2);
	});
});
