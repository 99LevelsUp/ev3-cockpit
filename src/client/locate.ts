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

/** A channel name that cannot leave its directory: lowercase letters, digits and dashes. */
const NATIVE_CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface NativeRootInputs {
	readonly platform?: NodeJS.Platform;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly homedir?: string;
}

/**
 * The native daemon's state root: the platform's state directory, then `ev3-cockpit/native`.
 * Windows `%LOCALAPPDATA%`, macOS `~/Library/Application Support`, Linux `$XDG_STATE_HOME` or
 * `~/.local/state`. It sits beside the Node daemon's state, never inside its files.
 */
export function nativeStateRoot(inputs: NativeRootInputs = {}): string {
	const platform = inputs.platform ?? process.platform;
	const env = inputs.env ?? process.env;
	const homedir = inputs.homedir ?? os.homedir();
	const flavour = platform === 'win32' ? path.win32 : path.posix;
	let base: string;
	if (platform === 'win32') {
		base = env.LOCALAPPDATA || flavour.join(homedir, 'AppData', 'Local');
	} else if (platform === 'darwin') {
		base = flavour.join(homedir, 'Library', 'Application Support');
	} else {
		// A relative XDG_STATE_HOME is invalid and ignored, as the XDG specification says and the
		// daemon does: both must land on the same root.
		const xdg = env.XDG_STATE_HOME;
		base = xdg && flavour.isAbsolute(xdg) ? xdg : flavour.join(homedir, '.local', 'state');
	}
	return flavour.join(base, 'ev3-cockpit', 'native');
}

/** The files a client reads to find and prove itself to one native daemon. */
export interface NativeChannelFiles {
	/** The channel's directory: the state root, or `channels/<name>/` in it for a test channel. */
	readonly dir: string;
	/** The per-user key, shared by every channel. Only the daemon creates it. */
	readonly keyFile: string;
	/** Held by the daemon, exclusively, for its whole life. */
	readonly lockFile: string;
	/** Where the lock holder records its pipe or socket path and its pid. */
	readonly channelFile: string;
}

/** The native daemon's files under `root`, for the user's own daemon or a named test channel. */
export function nativeChannelFiles(root: string, channel?: string): NativeChannelFiles {
	if (channel !== undefined && !NATIVE_CHANNEL_NAME.test(channel)) {
		throw new Error(`"${channel}" is not a usable channel name: use lowercase letters, digits and dashes.`);
	}
	const dir = channel === undefined ? root : path.join(root, 'channels', channel);
	return {
		dir,
		keyFile: path.join(root, 'key'),
		lockFile: path.join(dir, 'daemon.lock'),
		channelFile: path.join(dir, 'channel.json'),
	};
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
