/**
 * Where this user's daemon is, from a client's side, and which daemon an add-on should start.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LaunchSpec } from '../contract/models';
import { DaemonPaths, daemonPaths } from '../daemon/paths';
import { currentUserSid } from '../daemon/systemTools';

export interface LocateOptions {
	/** A development or test channel; by default the one `EV3_COCKPIT_CHANNEL` names, else the user's own. */
	readonly channel?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly homedir?: string;
}

export function clientPaths(options: LocateOptions = {}): DaemonPaths {
	const env = options.env ?? process.env;
	const channel = options.channel ?? (env.EV3_COCKPIT_CHANNEL || undefined);
	return daemonPaths({
		platform: process.platform, env, homedir: options.homedir ?? os.homedir(),
		...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
		...(process.platform === 'win32' ? { userSid: currentUserSid() } : {}),
		...(channel ? { channel } : {}),
	});
}

/** Records where the installed cockpit is, so an add-on can start its daemon. */
export function recordInstall(paths: DaemonPaths, launch: LaunchSpec): void {
	fs.mkdirSync(path.dirname(paths.installRecord), { recursive: true });
	fs.writeFileSync(paths.installRecord, `${JSON.stringify(launch, null, 2)}\n`, { mode: 0o600 });
}

/** The cockpit's own launch, as the extension or the `ev3` command last recorded it. */
export function installedLaunch(paths: DaemonPaths): LaunchSpec | undefined {
	try {
		const launch = JSON.parse(fs.readFileSync(paths.installRecord, 'utf8')) as LaunchSpec;
		return fs.existsSync(launch.entry) && fs.existsSync(launch.runtime) ? launch : undefined;
	} catch {
		return undefined;
	}
}

/** The daemon in this installation, run by the Node that runs this process. */
export function thisInstallLaunch(installRoot: string, version: string): LaunchSpec {
	return {
		runtime: process.execPath,
		entry: path.join(installRoot, 'out', 'daemon.js'),
		installRoot,
		version,
		...(process.versions.electron ? { electronRunAsNode: true } : {}),
	};
}
