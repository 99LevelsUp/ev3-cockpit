/**
 * A private home and channel for tests that start real daemon processes. This file's own process
 * gets the home as its profile, so the daemons it starts keep their state there too.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LaunchSpec } from '../contract/models';
import { clientPaths } from '../client/locate';
import type { DaemonPaths } from '../daemon/paths';

export const REPO = path.resolve(__dirname, '..', '..');

export function privateHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-client-'));
	process.env.LOCALAPPDATA = home;
	process.env.XDG_STATE_HOME = home;
	process.env.XDG_RUNTIME_DIR = home;
	process.env.HOME = home;
	delete process.env.NODE_OPTIONS;
	return home;
}

export interface TestDaemon {
	readonly channel: string;
	readonly paths: DaemonPaths;
	readonly launch: LaunchSpec;
	readonly launchArgs: readonly string[];
}

export function testDaemon(home: string, version = '0.0.1', graceMs = 3000): TestDaemon {
	const channel = `t-${randomBytes(3).toString('hex')}`;
	return {
		channel,
		paths: clientPaths({ channel, homedir: home }),
		launch: { runtime: process.execPath, entry: path.join(REPO, 'out', 'daemon', 'main.js'), installRoot: REPO, version },
		launchArgs: ['--channel', channel, '--simulated', '--grace-ms', String(graceMs)],
	};
}

/** The pid of the daemon serving a channel, from its status. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
