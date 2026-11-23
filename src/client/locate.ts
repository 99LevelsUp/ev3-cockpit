/**
 * Where this user's daemon keeps its state and channel files, from a client's side.
 */

import * as os from 'node:os';
import * as path from 'node:path';

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
 * `~/.local/state`.
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
