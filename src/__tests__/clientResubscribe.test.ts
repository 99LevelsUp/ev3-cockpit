/** A client outlives its daemon: it connects to the next one and renews its subscriptions by itself. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CockpitClient } from '../client';
import type { ProgramState, TelemetryUpdate } from '../contract/models';
import { privateHome, sleep, testDaemon } from './clientDaemonHelpers';
import { waitFor } from './waitFor';

const home = privateHome();

describe('a client across daemons', () => {
	it('connects to a new daemon after the old one is killed and renews its subscriptions with a snapshot', async (t) => {
		const d = testDaemon(home, '0.0.1', 5000);
		const client = await CockpitClient.connect({ name: 'test', kind: 'cli', version: '0.0.1', paths: d.paths, launch: d.launch, launchArgs: d.launchArgs });
		t.after(() => client.dispose());
		const bricks = await client.request('bricks/list', { waitForDiscovery: true });
		const brick = bricks[0].name;
		await client.request('bricks/connect', { brick });
		const updates: TelemetryUpdate[] = [];
		const states: ProgramState[] = [];
		await client.subscribeTelemetry(brick, { rows: ['system.battery.level'], intervalMs: 500 }, (u) => updates.push(u));
		await client.subscribePrograms(brick, (s) => states.push(s));
		const firstPid = client.daemon.pid;
		const snapshotsBefore = updates.filter((u) => u.kind === 'snapshot').length;

		let reconnected = false;
		client.onReconnected(() => { reconnected = true; });
		let lost: Error | undefined;
		client.onLost((e) => { lost = e; });
		process.kill(firstPid);
		// The client starts the next daemon itself; the brick must be connected again for the renewals.
		await waitFor(() => reconnected || lost !== undefined, 20_000);
		assert.equal(lost, undefined, String(lost?.stack ?? lost));
		assert.notEqual(client.daemon.pid, firstPid);
		assert.ok(updates.filter((u) => u.kind === 'snapshot').length > snapshotsBefore, 'no fresh snapshot after the reconnect');
		assert.ok(states.length >= 1, 'the program subscription was not renewed');
		assert.ok(updates.every((u) => u.subscriptionId === updates[0].subscriptionId), 'the caller saw the subscription id change');
		client.dispose();
		await sleep(100);
	});

	it('keeps the bricks it shows current from the daemon\'s notifications', async (t) => {
		const d = testDaemon(home, '0.0.1', 5000);
		const client = await CockpitClient.connect({ name: 'cache', kind: 'vscode', version: '0.0.1', paths: d.paths, launch: d.launch, launchArgs: d.launchArgs });
		t.after(() => client.dispose());
		await client.request('bricks/list', { waitForDiscovery: true });
		await waitFor(() => client.bricks().length > 0, 5000);
		const name = client.bricks()[0].name;
		await client.request('bricks/connect', { brick: name });
		await waitFor(() => client.brick(name)?.connected === true, 5000);
		assert.equal(client.accessMode(), 'safe');
		client.dispose();
	});
});
