/**
 * Which cockpit daemon the `ev3` command and the MCP server carry, found from the folder their code
 * runs from.
 *
 * - Built from the repository (`out/cli/main.js`, `out/mcp/main.js`): the development build that
 *   `npm run daemon:build` wrote into `daemon/target/`. Only such a build honours
 *   `EV3_COCKPIT_CHANNEL`, which puts it on a test channel of its own.
 * - Packaged (`ev3-cockpit` from npm): the binary and its `ev3-cockpitd.manifest.json` in the
 *   platform package for this computer, `@ev3-cockpit/<platform>-<arch>`, which npm installs as an
 *   optional dependency on the platform its `os` and `cpu` name, and found as Node finds a
 *   package from the bundle's folder. Nothing in the environment changes which daemon a packaged
 *   command starts, or where it looks for one.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { nativeChannelFiles, nativeStateRoot } from '../client/locate';
import { DaemonStartError, developmentDaemon, packagedDaemon } from '../client/nativeLaunch';
import type { BuildKind, LaunchSpec } from '../contract/generated';

/** The npm package carrying the daemon for each platform the cockpit ships for, by `<platform>-<arch>`. */
export const DAEMON_PACKAGES: Readonly<Record<string, string>> = {
	'win32-x64': '@ev3-cockpit/win32-x64',
	'linux-x64': '@ev3-cockpit/linux-x64',
	'linux-arm64': '@ev3-cockpit/linux-arm64',
};

/**
 * The folder of the platform package that carries this computer's daemon, resolved from `here`
 * (the bundle's folder) as Node resolves a package. Throws a `missing_binary` start failure, with
 * what to do, on a platform the cockpit does not ship for or when the package is not installed.
 */
export function platformDaemonDir(here: string, platform: string = process.platform, arch: string = process.arch): string {
	const key = `${platform}-${arch}`;
	const name = DAEMON_PACKAGES[key];
	if (!name) {
		throw new DaemonStartError('missing_binary',
			`EVƎ Cockpit has no daemon for ${key}: it runs on Windows x64, Linux x64 and Linux arm64.`);
	}
	try {
		return path.dirname(createRequire(path.join(here, 'installation.js')).resolve(`${name}/package.json`));
	} catch {
		throw new DaemonStartError('missing_binary',
			`The cockpit daemon for this computer, the npm package ${name}, is not installed beside ev3-cockpit. npm installs it as an optional dependency: reinstall with npm install -g ev3-cockpit, without --omit=optional or --no-optional.`);
	}
}

export interface Installation {
	readonly buildKind: BuildKind;
	/** The installation's package version. */
	readonly version: string;
	/** The daemon it carries; throws a `DaemonStartError` when that daemon is not there. */
	daemon(): LaunchSpec;
	/** The test channel `EV3_COCKPIT_CHANNEL` names, for a build from the repository only. */
	channel(env: NodeJS.ProcessEnv): string | undefined;
}

function readVersion(dir: string): string {
	try {
		return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/** The installation whose code lies in `here`. */
export function installation(here: string): Installation {
	const repoRoot = path.resolve(here, '..', '..');
	if (fs.existsSync(path.join(repoRoot, 'daemon', 'Cargo.toml'))) {
		return {
			buildKind: 'development',
			version: readVersion(repoRoot),
			daemon: () => developmentDaemon(repoRoot),
			channel: (env) => env.EV3_COCKPIT_CHANNEL || undefined,
		};
	}
	return {
		buildKind: 'release',
		version: readVersion(path.resolve(here, '..')),
		daemon: () => packagedDaemon(platformDaemonDir(here)),
		channel: () => undefined,
	};
}

/** Where the daemon of a channel writes its log: the newest of its rotated files. */
export function daemonLogFile(env: NodeJS.ProcessEnv, channel: string | undefined): string {
	return path.join(nativeChannelFiles(nativeStateRoot({ env }), channel).dir, 'daemon.log');
}
