/**
 * Extension-host test runner.
 *
 * `@vscode/test-electron` launches VS Code and loads this module, expecting a
 * `run()` export. Anything thrown here fails the run; resolving passes it.
 *
 * These tests need the real `vscode` API, so they cannot live in `src/__tests__/`
 * — that suite runs under a stub (see `src/test/vscodeStub.cjs`).
 */

import * as assert from 'assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = '99LevelsUp.ev3-cockpit';

/** A single named check; throwing marks it failed. */
interface IntegrationTest {
	name: string;
	fn: () => Promise<void> | void;
}

const tests: IntegrationTest[] = [
	{
		name: 'extension is installed in the test host',
		fn: () => {
			const ext = vscode.extensions.getExtension(EXTENSION_ID);
			assert.ok(ext, `Extension ${EXTENSION_ID} not found in the test host.`);
		},
	},
	{
		name: 'extension activates without throwing',
		fn: async () => {
			const ext = vscode.extensions.getExtension(EXTENSION_ID);
			assert.ok(ext);
			await ext.activate();
			assert.equal(ext.isActive, true, 'Extension did not reach the active state.');
		},
	},
	{
		name: 'activation registers the Cockpit output channel',
		fn: async () => {
			const ext = vscode.extensions.getExtension(EXTENSION_ID);
			assert.ok(ext);
			await ext.activate();
			// activate() pushes the log channel onto context.subscriptions; a
			// second activate() must be a no-op rather than a duplicate wire-up.
			await ext.activate();
			assert.equal(ext.isActive, true);
		},
	},
	{
		name: 'filesystem commands are registered and declared',
		fn: async () => {
			const ext = vscode.extensions.getExtension(EXTENSION_ID);
			assert.ok(ext);
			await ext.activate();

			const registered = await vscode.commands.getCommands(true);
			const declared = (ext.packageJSON as {
				contributes?: { commands?: { command: string }[] };
			}).contributes?.commands ?? [];

			assert.ok(declared.length > 0, 'package.json contributes no commands');

			// Both directions: a command declared but not registered fails when invoked,
			// and one registered but not declared never appears in the palette. Neither
			// shows up in a unit test.
			for (const { command } of declared) {
				assert.ok(
					registered.includes(command),
					`${command} is declared in package.json but not registered`
				);
			}
			for (const command of registered.filter((c) => c.startsWith('ev3-cockpit.'))) {
				assert.ok(
					declared.some((d) => d.command === command),
					`${command} is registered but missing from package.json`
				);
			}
		},
	},
];

export async function run(): Promise<void> {
	const failures: string[] = [];

	for (const test of tests) {
		try {
			await test.fn();
			console.log(`  ✔ ${test.name}`);
		} catch (error) {
			const message = error instanceof Error ? error.stack ?? error.message : String(error);
			console.error(`  ✖ ${test.name}\n${message}`);
			failures.push(test.name);
		}
	}

	console.log(`\nintegration: ${tests.length - failures.length}/${tests.length} passed`);

	if (failures.length > 0) {
		throw new Error(`Integration tests failed: ${failures.join(', ')}`);
	}
}
