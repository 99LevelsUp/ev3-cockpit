/** The daemon's settings: checked values, a person's confirmation for dangerous ones, `full` never stored. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ContractError } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import { SettingsStore, cliKey, keyFromCli } from '../daemon/settingsStore';

function fresh(): { store: SettingsStore; file: string; warnings: string[] } {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-set-')), 'settings.json');
	const warnings: string[] = [];
	const store = new SettingsStore(file, (m) => warnings.push(m));
	store.load();
	return { store, file, warnings };
}

const needsPerson = (error: unknown) => error instanceof ContractError && error.code === WireErrorCode.NeedsPerson;

describe('the settings store', () => {
	it('starts at the defaults', () => {
		const { store } = fresh();
		assert.equal(store.value('accessMode'), 'safe');
		assert.equal(store.value('telemetry.staleFactor'), 3);
		assert.equal(store.value('rememberBricks'), 'wait');
	});

	it('refuses a value out of range, naming the range', () => {
		const { store } = fresh();
		assert.throws(() => store.set('telemetry.staleFactor', 0, { kind: 'cli' }),
			(e: unknown) => e instanceof ContractError && /at least 1/.test(e.message));
		assert.throws(() => store.set('transfer.btPacketBytes', 70000, { kind: 'cli' }), /at most 65535/);
	});

	it('changes a valid value, fires one change and keeps it in the file', () => {
		const { store, file } = fresh();
		const changes: string[] = [];
		store.onChange((e) => changes.push(`${e.key}=${String(e.value)}`));
		store.set('telemetry.staleFactor', 5, { kind: 'mcp' });
		assert.deepEqual(changes, ['telemetry.staleFactor=5']);
		const again = new SettingsStore(file);
		again.load();
		assert.equal(again.value('telemetry.staleFactor'), 5);
	});

	it('refuses full without a person\'s confirmation, and applies it with one', () => {
		const { store } = fresh();
		assert.throws(() => store.set('accessMode', 'full', { kind: 'cli' }), needsPerson);
		assert.equal(store.value('accessMode'), 'safe');
		store.set('accessMode', 'full', { kind: 'cli', confirmedByPerson: true });
		assert.equal(store.value('accessMode'), 'full');
	});

	it('refuses full from MCP and add-ons even when they claim a confirmation, with the command to run', () => {
		const { store } = fresh();
		for (const kind of ['mcp', 'addon', 'peer'] as const) {
			assert.throws(() => store.set('accessMode', 'full', { kind, confirmedByPerson: true }),
				(e: unknown) => needsPerson(e) && (e as ContractError).data.command === 'ev3 config set access-mode full');
		}
		assert.equal(store.value('accessMode'), 'safe');
	});

	it('never writes full to the file, and ignores full written there by hand', () => {
		const { store, file } = fresh();
		store.set('accessMode', 'full', { kind: 'vscode', confirmedByPerson: true });
		store.set('telemetry.staleFactor', 4, { kind: 'cli' });
		assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /accessMode/);
		fs.writeFileSync(file, JSON.stringify({ accessMode: 'full' }));
		const reread = new SettingsStore(file);
		reread.load();
		assert.equal(reread.value('accessMode'), 'safe');
	});

	it('hands full over to a successor', () => {
		const { store } = fresh();
		store.set('accessMode', 'full', { kind: 'cli', confirmedByPerson: true });
		const { store: successor } = fresh();
		successor.restoreUnstored(store.unstored());
		assert.equal(successor.value('accessMode'), 'full');
	});

	it('drops an unusable value from the file with a warning', () => {
		const { file } = fresh();
		fs.writeFileSync(file, JSON.stringify({ 'telemetry.staleFactor': -1, nonsense: 1 }));
		const warnings: string[] = [];
		const store = new SettingsStore(file, (m) => warnings.push(m));
		store.load();
		assert.equal(store.value('telemetry.staleFactor'), 3);
		assert.equal(warnings.length, 2);
	});

	it('spells keys for the command line and back', () => {
		assert.equal(cliKey('accessMode'), 'access-mode');
		assert.equal(keyFromCli('access-mode'), 'accessMode');
		assert.equal(keyFromCli('telemetry.staleFactor'), 'telemetry.staleFactor');
	});
});
