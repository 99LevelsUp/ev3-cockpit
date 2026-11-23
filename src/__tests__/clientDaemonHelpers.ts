/**
 * A private home and channel for tests that start real daemon processes. This file's own process
 * gets the home as its profile, so the daemons it starts keep their state there too.
 */

import { daemonRefusesThisProcess } from './elevation';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LaunchSpec } from '../contract/models';
import type { BuildKind, ClientKind, LaunchSpec as GeneratedLaunchSpec } from '../contract/generated';
import { readChannelRecord } from '../client/channel';
import { NativeChannelFiles, clientPaths, nativeChannelFiles, nativeStateRoot } from '../client/locate';
import type { NativeCockpitClientOptions } from '../client/nativeClient';
import { daemonBinaryName } from '../client/nativeLaunch';
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

// The native daemon. Tests run the development build on test channels of their own, in matched
// replay of the link recordings under daemon/fixtures/link, never on real hardware.

/** The development build of the native daemon. */
export const NATIVE_BINARY = path.join(REPO, 'daemon', 'target', 'debug', daemonBinaryName());
/** Why native-daemon tests are skipped: the daemon would refuse this process, or its build is missing; false otherwise. */
export const nativeBinaryMissing: string | false = daemonRefusesThisProcess || (fs.existsSync(NATIVE_BINARY)
	? false
	: `the daemon binary ${NATIVE_BINARY} is missing; run npm run daemon:build (or cargo build -p ev3-cockpitd in daemon/) to run these tests`);
/**
 * A recorded scenario of a real brick, with the brick names and inputs its script published: a link
 * recording by its name, a service recording as `service/<name>`.
 */
export const linkFixture = (scenario: string): string => scenario.startsWith('service/')
	? path.join(REPO, 'daemon', 'fixtures', ...scenario.split('/'))
	: path.join(REPO, 'daemon', 'fixtures', 'link', scenario);
/**
 * The version the development build reports: package.json's when it was compiled. The pre-commit
 * hook bumps package.json, so a build from before a commit reports the version its manifest
 * recorded (`npm run daemon:build` writes both); without a manifest that matches it, package.json's.
 */
export const NATIVE_DAEMON_VERSION = ((): string => {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(NATIVE_BINARY), 'ev3-cockpitd.manifest.json'), 'utf8')) as { sha256?: string; version?: string };
		if (manifest.version && manifest.sha256 === createHash('sha256').update(fs.readFileSync(NATIVE_BINARY)).digest('hex')) { return manifest.version; }
	} catch { /* no build or no manifest */ }
	return (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
})();

let snapshot: { binary: string; sha256: string } | undefined;

/**
 * The binary the test clients carry: one copy of the development build per test process, so a
 * rebuild meanwhile cannot change it under a running test.
 */
export function nativeSnapshot(): { binary: string; sha256: string } {
	if (!snapshot) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-native-pkg-'));
		const binary = path.join(dir, daemonBinaryName());
		fs.copyFileSync(NATIVE_BINARY, binary);
		snapshot = { binary, sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex') };
		process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
	}
	return snapshot;
}

/** The snapshot as a client carries it, claiming the given build kind and version. */
export function nativeLaunch(buildKind: BuildKind, version = NATIVE_DAEMON_VERSION): GeneratedLaunchSpec {
	const { binary, sha256 } = nativeSnapshot();
	return { binary, sha256, version, buildKind };
}

export interface NativeTestChannel {
	readonly channel: string;
	readonly stateRoot: string;
	readonly files: NativeChannelFiles;
	/** Options for a client on this channel whose daemon replays `scenario`; a release one reports itself as release. */
	client(kind: ClientKind, buildKind: BuildKind, extra?: Partial<NativeCockpitClientOptions> & { scenario?: string; version?: string }): NativeCockpitClientOptions;
	/** Kills every daemon still serving this channel; the end of a test. */
	stop(): Promise<void>;
}

/**
 * A test channel in the private home's native state root (`privateHome` first), where the clients
 * of a test start the snapshot in matched replay.
 */
export function nativeTestChannel(home: string): NativeTestChannel {
	const channel = `t-${randomBytes(3).toString('hex')}`;
	const stateRoot = nativeStateRoot({ env: { LOCALAPPDATA: home, XDG_STATE_HOME: home }, homedir: home });
	const files = nativeChannelFiles(stateRoot, channel);
	return {
		channel, stateRoot, files,
		client: (kind, buildKind, extra = {}) => {
			const { scenario = 'usb-connect-commands-aaa', version = NATIVE_DAEMON_VERSION, ...rest } = extra;
			return {
				name: `${kind} ${buildKind} test`, kind, version, channel, stateRoot,
				daemon: nativeLaunch(buildKind, version),
				daemonArgs: ['--mode', 'replay', '--fixtures', linkFixture(scenario), ...(buildKind === 'release' ? ['--report-release'] : [])],
				...rest,
			};
		},
		stop: async () => {
			for (let attempt = 0; attempt < 20; attempt++) {
				let pid: number | undefined;
				try { pid = readChannelRecord(fs.readFileSync(files.channelFile, 'utf8'))?.pid; } catch { /* none */ }
				if (pid === undefined) { return; }
				try { process.kill(pid); } catch { /* gone */ }
				try { fs.rmSync(files.channelFile, { force: true }); } catch { /* the daemon may still hold it */ }
				await sleep(100);
			}
		},
	};
}
