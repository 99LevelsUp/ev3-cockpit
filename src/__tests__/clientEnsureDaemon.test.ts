/** A client finds or starts this user's daemon; two at once share one; a dead start is reported. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { CockpitClient, ContractError } from '../client';
import { WireErrorCode } from '../contract/errors';
import { recordInstall } from '../client/locate';
import { compareVersions, versionNotice } from '../client/versions';
import { privateHome, testDaemon } from './clientDaemonHelpers';

const home = privateHome();

describe('reaching the daemon', () => {
	it('starts a daemon when none runs, and connects to it', async () => {
		const d = testDaemon(home);
		const client = await CockpitClient.connect({ name: 'test', kind: 'cli', version: '0.0.1', paths: d.paths, launch: d.launch, launchArgs: d.launchArgs });
		assert.equal(client.daemon.state, 'serving');
		const status = await client.request('daemon/status', {});
		assert.equal(status.channel, d.paths.channel);
		client.dispose();
	});

	it('gives two clients starting at once the same daemon', async () => {
		const d = testDaemon(home);
		const options = { kind: 'cli' as const, version: '0.0.1', paths: d.paths, launch: d.launch, launchArgs: d.launchArgs };
		const [a, b] = await Promise.all([
			CockpitClient.connect({ ...options, name: 'a' }),
			CockpitClient.connect({ ...options, name: 'b' }),
		]);
		assert.equal(a.daemon.instanceId, b.daemon.instanceId);
		a.dispose();
		b.dispose();
	});

	it('reports a daemon that dies at start with its log path', async () => {
		const d = testDaemon(home);
		const broken = { ...d.launch, entry: path.join(home, 'no-such-daemon.js') };
		await assert.rejects(CockpitClient.connect({ name: 'x', kind: 'cli', version: '0.0.1', paths: d.paths, launch: broken, readinessMs: 5000 }),
			(e: unknown) => e instanceof ContractError && e.code === WireErrorCode.DaemonUnavailable && e.message.includes(d.paths.logFile));
	});

	it('refuses to start anything when it has no launch', async () => {
		const d = testDaemon(home);
		await assert.rejects(CockpitClient.connect({ name: 'x', kind: 'addon', version: '0.0.1', paths: d.paths, readinessMs: 500 }),
			(e: unknown) => e instanceof ContractError && e.code === WireErrorCode.DaemonUnavailable);
		assert.equal(fs.existsSync(d.paths.handoverMarker), false);
	});

	it('starts the installed cockpit\'s daemon for an add-on given no launch', async () => {
		const d = testDaemon(home);
		recordInstall(d.paths, d.launch);
		const addon = await CockpitClient.connect({ name: 'add-on', kind: 'addon', version: '0.0.1', paths: d.paths, launchArgs: d.launchArgs });
		assert.equal(addon.daemon.state, 'serving');
		addon.dispose();
	});

	it('compares versions and says which side is newer', () => {
		assert.ok(compareVersions('0.2.10', '0.2.9') > 0);
		assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
		assert.equal(versionNotice('0.2.5', '0.2.5'), undefined);
		assert.equal(versionNotice('0.2.6', '0.2.5')?.newerIs, 'client');
		assert.equal(versionNotice('0.2.4', '0.2.5')?.newerIs, 'daemon');
	});
});
