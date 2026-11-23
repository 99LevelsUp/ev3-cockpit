/**
 * Which daemon a client talks to: the user's own, or a development or test daemon on a channel of
 * its own, so a development build never takes the user's daemon or its bricks. The VS Code
 * extension sets `EV3_COCKPIT_CHANNEL` in its Development and Test modes; the client library and
 * the `ev3` command honour it.
 *
 * Below that: how a client finds the native daemon. Only the daemon that holds the single-instance
 * lock writes `channel.json`, so a client connects only to the path recorded there and never
 * computes a pipe or socket name itself. A record whose daemon no longer holds the lock is deleted
 * and never contacted.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { WireErrorCode } from '../contract/errors';
import type { ChannelRecord } from '../contract/generated';
import { ContractError } from './connection';
import type { NativeChannelFiles } from './locate';

/** The environment variable that names a channel. */
export const CHANNEL_ENV = 'EV3_COCKPIT_CHANNEL';

/** The channel the environment names, or undefined for the user's own daemon. */
export function channelFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const channel = env[CHANNEL_ENV]?.trim();
	return channel ? channel : undefined;
}

/** The environment without a channel: what reaches the user's own daemon from inside a development one. */
export function withoutChannel(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const copy = { ...env };
	delete copy[CHANNEL_ENV];
	return copy;
}

/** What finding the native daemon needs from the operating system; replaceable in tests. */
export interface NativeChannelHost {
	readonly platform: NodeJS.Platform;
	/** The user's id on Linux and macOS, which must own the socket directory. */
	readonly uid?: number;
	/**
	 * Windows: opens the lock file for writing without creating or truncating it and returns what
	 * closes it again. Throws the operating system's error: `EBUSY` or `EPERM` when the daemon holds
	 * it with no sharing, `ENOENT` when there is none.
	 */
	openLockForWriting(file: string): () => void;
	/** Linux and macOS: whether a process with this pid exists. */
	processAlive(pid: number): boolean;
	lstat(dir: string): { isDirectory(): boolean; isSymbolicLink(): boolean; readonly uid: number; readonly mode: number };
	/** Connects to a pipe or socket path; rejects with the operating system's error. */
	connect(where: string): Promise<Duplex>;
}

export function systemChannelHost(): NativeChannelHost {
	return {
		platform: process.platform,
		...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
		openLockForWriting(file) {
			const handle = fs.openSync(file, 'r+');
			return () => fs.closeSync(handle);
		},
		processAlive(pid) {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				// EPERM: the process exists, it is just not ours to signal.
				return (error as NodeJS.ErrnoException).code === 'EPERM';
			}
		},
		lstat: (dir) => fs.lstatSync(dir),
		connect: (where) => new Promise((resolve, reject) => {
			const socket = net.connect(where);
			const onError = (error: Error): void => { socket.destroy(); reject(error); };
			socket.once('error', onError);
			socket.once('connect', () => { socket.off('error', onError); resolve(socket); });
		}),
	};
}

/** A `channel.json` as text, or undefined when it is not a usable record. Unknown properties are ignored. */
export function readChannelRecord(text: string): ChannelRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) { return undefined; }
	const { path: where, pid } = value as { path?: unknown; pid?: unknown };
	if (typeof where !== 'string' || where.length === 0) { return undefined; }
	if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) { return undefined; }
	return { path: where, pid };
}

export type NativeChannel =
	| { readonly kind: 'none' }
	| { readonly kind: 'open'; readonly stream: Duplex; readonly record: ChannelRecord };

const NONE: NativeChannel = { kind: 'none' };

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
		throw error;
	}
}

/**
 * Deletes a stale record, unless it changed since it was judged stale: a daemon that started
 * meanwhile has written its own, and that one stays.
 */
function deleteStale(file: string, judged: string): void {
	if (readText(file) !== judged) { return; }
	try { fs.unlinkSync(file); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
	}
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function unavailable(message: string): ContractError {
	return new ContractError(WireErrorCode.DaemonUnavailable, message);
}

/** Refuses a socket directory anyone but the user could have put a socket in. */
function checkSocketDir(socketPath: string, host: NativeChannelHost): void {
	const dir = path.posix.dirname(socketPath);
	let stat: ReturnType<NativeChannelHost['lstat']>;
	try {
		stat = host.lstat(dir);
	} catch (error) {
		throw unavailable(`The cockpit daemon's socket directory ${dir} cannot be checked (${errorCode(error) ?? String(error)}); the client did not connect.`);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw unavailable(`The cockpit daemon's socket directory ${dir} is not a plain directory; the client did not connect.`);
	}
	if (host.uid !== undefined && stat.uid !== host.uid) {
		throw unavailable(`The cockpit daemon's socket directory ${dir} belongs to another user; the client did not connect.`);
	}
	if ((stat.mode & 0o077) !== 0) {
		throw unavailable(`The cockpit daemon's socket directory ${dir} can be opened by other users (mode ${(stat.mode & 0o777).toString(8)}); the client did not connect.`);
	}
}

/**
 * Finds the native daemon and opens its pipe or socket, or reports that none runs.
 *
 * - No `channel.json`: no daemon.
 * - Windows: the daemon keeps the lock file open with no sharing. A client that can open it for
 *   writing knows no daemon holds it, and deletes the record while it still has the file open, so
 *   no daemon starting meanwhile can take the lock and write a record of its own in between.
 * - Linux and macOS: a dead pid, or a connect refused or missing, means the record is stale.
 *
 * A stale record is deleted and its path is never contacted.
 */
export async function openNativeChannel(
	files: Pick<NativeChannelFiles, 'channelFile' | 'lockFile'>,
	host: NativeChannelHost = systemChannelHost(),
): Promise<NativeChannel> {
	const text = readText(files.channelFile);
	if (text === undefined) { return NONE; }
	const record = readChannelRecord(text);

	if (host.platform === 'win32') {
		let close: (() => void) | undefined;
		try {
			close = host.openLockForWriting(files.lockFile);
		} catch (error) {
			const code = errorCode(error);
			if (code === 'ENOENT') {
				deleteStale(files.channelFile, text);
				return NONE;
			}
			if (code !== 'EBUSY' && code !== 'EPERM') { throw error; }
		}
		if (close) {
			try { deleteStale(files.channelFile, text); } finally { close(); }
			return NONE;
		}
		if (!record) {
			throw unavailable(`A cockpit daemon runs, but its channel record ${files.channelFile} cannot be read.`);
		}
		try {
			return { kind: 'open', stream: await host.connect(record.path), record };
		} catch (error) {
			throw unavailable(`The cockpit daemon (pid ${record.pid}) runs but is not answering on ${record.path} (${errorCode(error) ?? String(error)}).`);
		}
	}

	if (!record || !host.processAlive(record.pid)) {
		deleteStale(files.channelFile, text);
		return NONE;
	}
	checkSocketDir(record.path, host);
	try {
		return { kind: 'open', stream: await host.connect(record.path), record };
	} catch (error) {
		const code = errorCode(error);
		if (code === 'ENOENT' || code === 'ECONNREFUSED') {
			deleteStale(files.channelFile, text);
			return NONE;
		}
		throw unavailable(`The cockpit daemon (pid ${record.pid}) is not answering on ${record.path} (${code ?? String(error)}).`);
	}
}
