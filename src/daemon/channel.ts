/**
 * Winning the channel: only the daemon that binds it may touch the hardware.
 *
 * On Windows the pipe itself decides: a second daemon's listen fails with `EADDRINUSE`. On Linux
 * and macOS a socket file outlives a crashed daemon, so a start lock keeps two starters from both
 * clearing a stale socket, a probe tells a live socket from a stale one, and the socket's directory
 * must belong to the user alone.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import type { DaemonPaths } from './paths';
import { processAlive } from './systemTools';

export class AlreadyRunningError extends Error {
	constructor(message = 'A cockpit daemon already runs on this channel.') {
		super(message);
		this.name = 'AlreadyRunningError';
	}
}

export interface ChannelHost {
	readonly platform: NodeJS.Platform;
	readonly uid?: number;
}

export interface Listening {
	readonly server: net.Server;
	/** Lets the next starter in; call once this daemon has proved it serves. */
	releaseStartLock(): void;
	close(): Promise<void>;
}

/** Makes the socket directory, or refuses one that is not the user's alone. */
export function ensurePrivateDir(dir: string, host: ChannelHost): void {
	try {
		fs.mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
	}
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`${dir} is not a directory the cockpit can use for its socket.`);
	}
	if (host.uid !== undefined && stat.uid !== host.uid) {
		throw new Error(`${dir} belongs to another user; the cockpit will not put its socket there.`);
	}
	if ((stat.mode & 0o077) !== 0) {
		throw new Error(`${dir} can be opened by other users (mode ${(stat.mode & 0o777).toString(8)}); the cockpit will not put its socket there.`);
	}
}

/** Takes the start lock, clearing one a dead process left. */
function takeStartLock(file: string): () => void {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
			return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
			const owner = Number(fs.readFileSync(file, 'utf8'));
			if (Number.isInteger(owner) && owner > 0 && processAlive(owner)) {
				throw new AlreadyRunningError('Another cockpit daemon is starting on this channel.');
			}
			try { fs.unlinkSync(file); } catch { /* raced */ }
		}
	}
	throw new AlreadyRunningError('Another cockpit daemon is starting on this channel.');
}

/** Whether something answers on a socket path. */
function probe(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(socketPath);
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => resolve(false));
	});
}

function listen(server: net.Server, where: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException): void => {
			server.off('listening', onListening);
			reject(error.code === 'EADDRINUSE' ? new AlreadyRunningError() : error);
		};
		const onListening = (): void => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(where);
	});
}

/** Binds the channel, or throws {@link AlreadyRunningError} when another daemon has it. */
export async function listenOnChannel(
	paths: DaemonPaths,
	onConnection: (socket: net.Socket) => void,
	host: ChannelHost = { platform: process.platform, ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}) },
): Promise<Listening> {
	const server = net.createServer(onConnection);
	if (host.platform === 'win32') {
		await listen(server, paths.channel);
		return { server, releaseStartLock: () => undefined, close: () => closeServer(server) };
	}
	if (!paths.socketDir) { throw new Error('No socket directory for this channel.'); }
	ensurePrivateDir(paths.socketDir, host);
	fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
	const release = takeStartLock(paths.startLock);
	try {
		if (fs.existsSync(paths.channel)) {
			if (await probe(paths.channel)) { throw new AlreadyRunningError(); }
			fs.unlinkSync(paths.channel);
		}
		await listen(server, paths.channel);
		fs.chmodSync(paths.channel, 0o600);
	} catch (error) {
		release();
		throw error;
	}
	return {
		server,
		releaseStartLock: release,
		close: async () => {
			await closeServer(server);
			try { fs.unlinkSync(paths.channel); } catch { /* gone */ }
		},
	};
}

function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}
