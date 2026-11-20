/**
 * Where the daemon lives on disk and on the channel, per user and per OS.
 *
 * - Windows: a named pipe whose name comes from a hash of the user's SID; state and logs under
 *   `%LOCALAPPDATA%\ev3-cockpit`.
 * - macOS: state under `~/Library/Application Support/ev3-cockpit`, logs under
 *   `~/Library/Logs/ev3-cockpit`.
 * - Linux: state under `$XDG_STATE_HOME/ev3-cockpit` (`~/.local/state` by default).
 * - Linux and macOS: a socket in `$XDG_RUNTIME_DIR/ev3-cockpit/`, or in `/tmp/ev3-cockpit-<uid>/`
 *   without it, kept short enough for the socket path limit.
 *
 * A named channel (a development or test daemon) gets its own pipe or socket and its own state
 * directory; the key is shared, because the user is the same.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** Unix socket paths are limited to 104–108 bytes; this leaves room. */
export const MAX_SOCKET_PATH = 95;

const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface PathInputs {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly homedir: string;
	/** Unix user id. */
	readonly uid?: number;
	/** Windows user SID. */
	readonly userSid?: string;
	/** A development or test channel; absent for the user's own daemon. */
	readonly channel?: string;
}

export interface DaemonPaths {
	/** The pipe name or the socket path clients connect to. */
	readonly channel: string;
	/** The socket's directory on Linux and macOS, made private to the user. */
	readonly socketDir?: string;
	/** Where the key lives, shared by every channel. */
	readonly keyFile: string;
	/** This channel's state: settings, held bricks, transfer debts, the handover marker. */
	readonly stateDir: string;
	readonly logFile: string;
	/** Taken while a daemon starts, so two starting at once cannot both win on Linux and macOS. */
	readonly startLock: string;
	/** Held by the daemon that owns the hardware. */
	readonly hardwareLock: string;
	readonly handoverMarker: string;
	readonly settingsFile: string;
	readonly heldFile: string;
	readonly ledgerFile: string;
	/** Where the VS Code extension records its install folder for add-ons to start the daemon from. */
	readonly installRecord: string;
}

/** Refuses a channel name that could escape its directory or its pipe name. */
export function checkChannelName(channel: string): string {
	if (!CHANNEL_NAME.test(channel)) {
		throw new Error(`"${channel}" is not a usable channel name: use lowercase letters, digits and dashes.`);
	}
	return channel;
}

export function daemonPaths(inputs: PathInputs): DaemonPaths {
	const channel = inputs.channel === undefined ? undefined : checkChannelName(inputs.channel);
	const suffix = channel ? `-${channel}` : '';
	const env = inputs.env;
	const flavour = inputs.platform === 'win32' ? path.win32 : path.posix;
	const join = (...parts: string[]): string => flavour.join(...parts);

	let root: string;
	let logDir: string;
	if (inputs.platform === 'win32') {
		root = join(env.LOCALAPPDATA || join(inputs.homedir, 'AppData', 'Local'), 'ev3-cockpit');
		logDir = join(root, 'logs');
	} else if (inputs.platform === 'darwin') {
		root = join(inputs.homedir, 'Library', 'Application Support', 'ev3-cockpit');
		logDir = join(inputs.homedir, 'Library', 'Logs', 'ev3-cockpit');
	} else {
		root = join(env.XDG_STATE_HOME || join(inputs.homedir, '.local', 'state'), 'ev3-cockpit');
		logDir = join(root, 'logs');
	}
	const stateDir = channel ? join(root, 'channels', channel) : root;

	let channelPath: string;
	let socketDir: string | undefined;
	if (inputs.platform === 'win32') {
		if (!inputs.userSid) { throw new Error('The user SID is needed to name the cockpit pipe.'); }
		const hash = createHash('sha256').update(inputs.userSid).digest('hex').slice(0, 16);
		channelPath = `\\\\.\\pipe\\ev3-cockpit-${hash}${suffix}`;
	} else {
		if (inputs.uid === undefined) { throw new Error('The user id is needed to place the cockpit socket.'); }
		const runtime = env.XDG_RUNTIME_DIR;
		socketDir = runtime ? path.posix.join(runtime, 'ev3-cockpit') : `/tmp/ev3-cockpit-${inputs.uid}`;
		channelPath = path.posix.join(socketDir, `daemon${suffix}.sock`);
		if (Buffer.byteLength(channelPath) > MAX_SOCKET_PATH && runtime) {
			socketDir = `/tmp/ev3-cockpit-${inputs.uid}`;
			channelPath = path.posix.join(socketDir, `daemon${suffix}.sock`);
		}
		if (Buffer.byteLength(channelPath) > MAX_SOCKET_PATH) {
			throw new Error(`The cockpit socket path ${channelPath} is too long for this system.`);
		}
	}

	return {
		channel: channelPath,
		...(socketDir ? { socketDir } : {}),
		keyFile: join(root, 'key'),
		stateDir,
		logFile: join(logDir, `daemon${suffix}.log`),
		startLock: join(stateDir, 'start.lock'),
		hardwareLock: join(root, 'hardware.lock'),
		handoverMarker: join(stateDir, 'handover.json'),
		settingsFile: join(stateDir, 'settings.json'),
		heldFile: join(stateDir, 'held.json'),
		ledgerFile: join(stateDir, 'ledger.json'),
		installRecord: join(root, 'install.json'),
	};
}
