/** A client outlives its daemon: it connects to the next one and renews its subscriptions by itself. */

import { daemonRefusesThisProcess } from './elevation';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CockpitClient } from '../client';
import type { ProgramState, TelemetryUpdate } from '../contract/models';
import { privateHome, sleep, testDaemon } from './clientDaemonHelpers';
import { waitFor } from './waitFor';

const home = privateHome();

describe('a client across daemons', { skip: daemonRefusesThisProcess }, () => {
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

	it('renews a subscription whose brick was not back after a reconnect, once the brick is back', async (t) => {
		const d = testDaemon(home, '0.0.1', 5000);
		const options = { kind: 'cli' as const, version: '0.0.1', paths: d.paths, launch: d.launch, launchArgs: d.launchArgs };
		const watcher = await CockpitClient.connect({ ...options, name: 'watcher' });
		t.after(() => watcher.dispose());
		// The client that connected the brick does not come back, so nobody connects it again.
		const holder = await CockpitClient.connect({ ...options, name: 'holder', reconnect: false });
		t.after(() => holder.dispose());
		const name = (await holder.request('bricks/list', { waitForDiscovery: true }))[0].name;
		await holder.request('bricks/connect', { brick: name });
		const updates: TelemetryUpdate[] = [];
		await watcher.subscribeTelemetry(name, { rows: ['system.battery.level'], intervalMs: 300 }, (u) => updates.push(u));
		// Renewals fail until the brick is back, as they do while the new daemon does not know it yet.
		const renewables = (watcher as unknown as { renewables: Map<string, { renew: () => Promise<string> }> }).renewables;
		const [renewable] = renewables.values();
		const renew = renewable.renew;
		let brickBack = false;
		let refusals = 0;
		renewable.renew = () => {
			if (brickBack) { return renew(); }
			refusals++;
			return Promise.reject(new Error('the brick is not back yet'));
		};

		let back = false;
		watcher.onReconnected(() => { back = true; });
		process.kill(watcher.daemon.pid);
		await waitFor(() => back, 20_000);
		await sleep(300);
		assert.ok(refusals >= 1);
		const before = updates.length;

		// The brick coming back is announced to every client: the watcher renews then.
		const later = await CockpitClient.connect({ ...options, name: 'later' });
		t.after(() => later.dispose());
		await later.request('bricks/list', { waitForDiscovery: true });
		brickBack = true;
		await later.request('bricks/connect', { brick: name });
		await waitFor(() => updates.slice(before).some((u) => u.kind === 'snapshot'), 10_000);
		later.dispose();
		holder.dispose();
		watcher.dispose();
		await sleep(100);
	});

	it('reaches a third daemon when the second one goes away while the client is getting back to it', async (t) => {
		const d = testDaemon(home, '0.0.1', 5000);
		const client = await CockpitClient.connect({ name: 'bounced', kind: 'cli', version: '0.0.1', paths: d.paths, launch: d.launch, launchArgs: d.launchArgs });
		t.after(() => client.dispose());
		const name = (await client.request('bricks/list', { waitForDiscovery: true }))[0].name;
		await client.request('bricks/connect', { brick: name });
		await client.subscribePrograms(name, () => undefined);
		const renewables = (client as unknown as { renewables: Map<string, { renew: () => Promise<string> }> }).renewables;
		const [renewable] = renewables.values();
		const renew = renewable.renew;
		const pids = [client.daemon.pid];
		// The second daemon dies while the client renews its subscription there.
		let killedSecond = false;
		renewable.renew = async () => {
			if (!killedSecond) {
				killedSecond = true;
				pids.push(client.daemon.pid);
				process.kill(client.daemon.pid);
				await sleep(300);
			}
			return renew();
		};
		let reconnects = 0;
		client.onReconnected(() => { reconnects++; });
		let lost: Error | undefined;
		client.onLost((e) => { lost = e; });
		process.kill(pids[0]);
		await waitFor(() => (reconnects > 0 && !pids.includes(client.daemon.pid)) || lost !== undefined, 30_000);
		assert.equal(lost, undefined, String(lost));
		assert.equal((await client.request('daemon/status', {})).pid, client.daemon.pid);
		client.dispose();
		await sleep(100);
	});

	it('leaves no connection behind when it is disposed while it connects to the next daemon', async (t) => {
		const d = testDaemon(home, '0.0.1', 5000);
		const options = { kind: 'cli' as const, version: '0.0.1', paths: d.paths, launch: d.launch, launchArgs: d.launchArgs };
		const leaving = await CockpitClient.connect({ ...options, name: 'leaving' });
		t.after(() => leaving.dispose());
		const staying = await CockpitClient.connect({ ...options, name: 'staying' });
		t.after(() => staying.dispose());
		let back = false;
		staying.onReconnected(() => { back = true; });
		process.kill(staying.daemon.pid);
		// The next daemon is starting now; the leaving client goes in the middle of reaching it.
		await sleep(300);
		leaving.dispose();
		await waitFor(() => back, 20_000);
		await sleep(2000);
		const status = await staying.request('daemon/status', {});
		assert.deepEqual(status.clients.map((c) => c.name), ['staying']);
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
		assert.equal(client.brick(name.toUpperCase())?.name, name, 'the cache does not match a name as the daemon does');
		assert.equal(client.accessMode(), 'safe');
		client.dispose();
	});

	it('keeps a subscription whose listener throws on its first snapshot, and sends that snapshot once', async (t) => {
		const d = testDaemon(home, '0.0.1', 5000);
		const client = await CockpitClient.connect({ name: 'thrower', kind: 'cli', version: '0.0.1', paths: d.paths, launch: d.launch, launchArgs: d.launchArgs });
		t.after(() => client.dispose());
		const name = (await client.request('bricks/list', { waitForDiscovery: true }))[0].name;
		await client.request('bricks/connect', { brick: name });
		const raw: TelemetryUpdate[] = [];
		client.on('telemetry/update', (u) => raw.push(u));
		let calls = 0;
		const sub = await client.subscribeTelemetry(name, { rows: ['system.battery.level'], intervalMs: 500 }, () => { calls++; if (calls === 1) { throw new Error('listener failed'); } });
		await waitFor(() => calls >= 2, 10_000);
		assert.equal(raw.filter((u) => u.kind === 'snapshot').length, 0, 'the daemon sent the snapshot as a notification too');
		sub.dispose();
	});
});
