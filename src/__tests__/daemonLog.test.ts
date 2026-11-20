/** The daemon's log: time, level and client on each line; rotation keeps three files. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { DaemonLog } from '../daemon/log';

describe('the daemon log', () => {
	it('writes the time, the level and the client that caused a line', () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-log-')), 'logs', 'daemon.log');
		const log = new DaemonLog(file);
		log.info('Daemon serving');
		log.forClient('VS Code (window 1)').warn('Brick CCC is busy');
		const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
		assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO Daemon serving$/);
		assert.match(lines[1], /^\S+ WARN \[VS Code \(window 1\)\] Brick CCC is busy$/);
	});

	it('leaves debug lines out unless asked', () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-log-')), 'daemon.log');
		new DaemonLog(file).debug('noise');
		assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', '');
		new DaemonLog(file, { debug: true }).debug('wanted');
		assert.match(fs.readFileSync(file, 'utf8'), /DEBUG wanted/);
	});

	it('rotates at its size limit and keeps three files', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-log-'));
		const file = path.join(dir, 'daemon.log');
		const log = new DaemonLog(file, { maxBytes: 200 });
		for (let i = 0; i < 40; i++) { log.info(`line ${i} ${'x'.repeat(40)}`); }
		const files = fs.readdirSync(dir).sort();
		assert.deepEqual(files, ['daemon.log', 'daemon.log.1', 'daemon.log.2']);
		for (const name of files) { assert.ok(fs.statSync(path.join(dir, name)).size <= 200); }
		assert.match(fs.readFileSync(file, 'utf8'), /line 39/);
	});
});
