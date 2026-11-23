/**
 * `ev3` as the npm package `ev3-cockpit` installs it: it starts the native `ev3` from the platform
 * package npm installed beside it (`@ev3-cockpit/<platform>-<arch>`, chosen by its `os` and `cpu`),
 * with this process's arguments, standard streams and exit code. The native `ev3` finds the daemon
 * beside itself in that package; `ev3 mcp` is the MCP server.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/** The platforms a release ships `ev3` for; `scripts/packaging.mts` (`TARGETS`) builds the same. */
export const PLATFORMS: readonly string[] = ['win32-x64', 'linux-x64', 'linux-arm64'];

/** The exit code `ev3` gives when it cannot start the cockpit daemon (here: no `ev3` to start). */
const NOT_STARTABLE = 8;

/** The platform package for this computer, or `undefined` when no release ships for it. */
export function platformPackage(platform: string, arch: string): string | undefined {
	const target = `${platform}-${arch}`;
	return PLATFORMS.includes(target) ? `@ev3-cockpit/${target}` : undefined;
}

/** The native `ev3` of that package, or why there is none. */
export function nativeEv3(platform: string, arch: string, resolve: (id: string) => string): { readonly binary: string } | { readonly problem: string } {
	const name = platformPackage(platform, arch);
	if (!name) {
		return { problem: `EVƎ Cockpit has no ev3 for ${platform}-${arch}; it ships for ${PLATFORMS.join(', ')}.` };
	}
	let dir: string;
	try {
		dir = path.dirname(resolve(`${name}/package.json`));
	} catch {
		return { problem: `${name} is not installed: install ev3-cockpit again, without --no-optional or --omit=optional.` };
	}
	return { binary: path.join(dir, platform === 'win32' ? 'ev3.exe' : 'ev3') };
}

function main(): number {
	const found = nativeEv3(process.platform, process.arch, require.resolve);
	if ('problem' in found) {
		console.error(`ev3: ${found.problem}`);
		return NOT_STARTABLE;
	}
	// The terminal's Ctrl+C reaches the native ev3 too, which ends as it decides (a second one ends a
	// watch); this process waits for it instead of ending first under it.
	process.on('SIGINT', () => undefined);
	const run = spawnSync(found.binary, process.argv.slice(2), { stdio: 'inherit' });
	if (run.error) {
		console.error(`ev3: ${found.binary} could not start (${run.error.message}).`);
		return NOT_STARTABLE;
	}
	if (run.signal) {
		process.removeAllListeners('SIGINT');
		process.kill(process.pid, run.signal);
	}
	return run.status ?? 1;
}

if (require.main === module) {
	process.exitCode = main();
}
