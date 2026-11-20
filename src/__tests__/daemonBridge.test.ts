/**
 * The extension's commands over the daemon (U11): the bridge gives them the list and the brick
 * layer they had in VS Code, and answers the daemon's question for a forget or a clearing the
 * person already confirmed in VS Code rather than asking twice.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CockpitClient } from '../client';
import type { Question } from '../contract/models';
import type { BrickId } from '../core/contracts';
import type { ForgetReport } from '../core/runtime/forgetReport';
import { DaemonBridge } from '../vscode/daemonBridge';
import { brickPickRows } from '../vscode/ui/brickPickRows';
import { privateHome } from './clientDaemonHelpers';
import { CliWorld, cliWorld } from './cliHelpers';
import { waitFor } from './waitFor';

const home = privateHome();

describe('the extension\'s commands over the daemon', () => {
	let w: CliWorld;
	let client: CockpitClient;
	let bridge: DaemonBridge;
	const askedPerson: Question[] = [];
	/** A brick's id, as the commands take it from the list. */
	const idOf = (name: string): BrickId => bridge.aggregator.getDiscoveryList().find((b) => b.name.value === name)!.brickId;

	before(async () => {
		w = await cliWorld(home);
		client = await CockpitClient.connect({
			name: 'VS Code (test window)', kind: 'vscode', version: '0.0.1', paths: w.daemon.paths, launch: w.daemon.launch, launchArgs: w.daemon.launchArgs,
		});
		bridge = new DaemonBridge(client, { askPerson: (q) => { askedPerson.push(q); return 'no'; } });
		await client.request('bricks/list', { waitForDiscovery: true });
		await waitFor(() => bridge.aggregator.getDiscoveryList().length >= 2, 5000);
	});
	after(async () => {
		bridge.dispose();
		client.dispose();
		await w.done();
	});

	it('lists the bricks as the picker reads them, and connects one as the active brick', async () => {
		const rows = brickPickRows(bridge.aggregator.getDiscoveryList(), (id) => bridge.bricks.isSignedIn(id));
		assert.deepEqual(rows.map((r) => r.label).sort(), ['BBB', 'CCC']);
		const changed = new Promise<void>((resolve) => { const l = bridge.aggregator.onListChanged(() => { l.dispose(); resolve(); }); });
		await bridge.bricks.signIn(idOf('CCC'));
		await changed;
		await waitFor(() => bridge.bricks.isSignedIn(idOf('CCC')), 5000);
		assert.equal(client.activeBrick(), idOf('CCC'));
		assert.ok(bridge.bricks.routeOf(idOf('CCC')));
	});

	it('hands a clearing\'s question to the command\'s own confirmation, with the entries', async () => {
		const seen: { names: readonly string[]; includes: boolean }[] = [];
		await bridge.bricks.clearBluetoothList(idOf('CCC'), (names, includes) => { seen.push({ names, includes }); return Promise.resolve(false); });
		assert.deepEqual(seen.map((s) => [...s.names].sort()), [['HOSTA', 'HOSTB']]);
		assert.equal(askedPerson.length, 0);
	});

	it('forgets a brick the person confirmed in VS Code without asking again, and returns the full report', async () => {
		const report: ForgetReport = await bridge.bricks.forget(idOf('BBB'));
		assert.equal(askedPerson.length, 0);
		assert.ok(report && typeof report === 'object' && 'memory' in report, 'no full report came back');
	});

	it('passes every other question to the person', async () => {
		// A forget nobody confirmed in VS Code: the daemon's question goes to the person, who says no.
		await assert.rejects(client.request('bricks/forget', { brick: 'CCC' }));
		assert.equal(askedPerson.length, 1);
		assert.equal(askedPerson[0].kind, 'forget');
	});
});
