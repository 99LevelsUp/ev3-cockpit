/**
 * Finding this user's daemon, starting it when nobody runs it, and proving it is ours.
 *
 * A client connects; with no daemon there it starts one from the launch it was given and waits for
 * the channel within a budget. A daemon that is exiting or handing over answers so in the
 * handshake, and the client waits for the next one rather than starting its own; so does a client
 * that finds no listener while a fresh handover marker says a successor is on its way. A daemon that
 * died at start is reported with the end of its log.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { WireErrorCode } from '../contract/errors';
import type { HelloAccepted } from '../contract/hello';
import type { LaunchSpec } from '../contract/models';
import type { DaemonPaths } from '../daemon/paths';
import { readKey } from '../daemon/key';
import { ContractError, Endpoint, createEndpoint } from './connection';
import { ClientIdentity, performHello } from './hello';

/** How long a client waits for a daemon to start or a successor to take over. */
export const READINESS_MS = 15_000;
/** A handover marker older than this belongs to a handover that never finished. */
export const HANDOVER_MARKER_MS = 30_000;

export interface ConnectOptions {
	readonly client: ClientIdentity;
	readonly paths: DaemonPaths;
	/** How to start a daemon when none runs; absent, a missing daemon is an error. */
	readonly launch?: LaunchSpec;
	/** Extra arguments for the daemon: the channel, simulated bricks. */
	readonly launchArgs?: readonly string[];
	readonly readinessMs?: number;
}

export interface Connected {
	readonly endpoint: Endpoint;
	readonly hello: HelloAccepted;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function connectSocket(where: string): Promise<net.Socket | undefined> {
	return new Promise((resolve) => {
		const socket = net.connect(where);
		socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket); });
		socket.once('error', () => resolve(undefined));
	});
}

function handoverUnderway(paths: DaemonPaths): boolean {
	try {
		const marker = JSON.parse(fs.readFileSync(paths.handoverMarker, 'utf8')) as { at?: number };
		return typeof marker.at === 'number' && Date.now() - marker.at < HANDOVER_MARKER_MS;
	} catch {
		return false;
	}
}

function logTail(file: string, lines = 15): string {
	try {
		return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
	} catch {
		return '';
	}
}

function unavailable(message: string, paths: DaemonPaths): ContractError {
	const tail = logTail(paths.logFile);
	return new ContractError(WireErrorCode.DaemonUnavailable,
		`${message} The daemon's log is ${paths.logFile}.${tail ? `\nIts last lines:\n${tail}` : ''}`);
}

/** Starts a daemon detached, so it outlives this client. Returns a check for an early exit. */
export function spawnDaemon(launch: LaunchSpec, args: readonly string[]): () => number | null | undefined {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (launch.electronRunAsNode) { env.ELECTRON_RUN_AS_NODE = '1'; } else { delete env.ELECTRON_RUN_AS_NODE; }
	const child = spawn(launch.runtime, [launch.entry, '--install-root', launch.installRoot, ...args], {
		detached: true, stdio: 'ignore', windowsHide: true, env,
	});
	let code: number | null | undefined;
	child.once('exit', (exitCode) => { code = exitCode; });
	child.once('error', () => { code = -1; });
	child.unref();
	return () => code;
}

/** Connects to this user's daemon, starting one when allowed. */
export async function connectToDaemon(options: ConnectOptions): Promise<Connected> {
	const { paths } = options;
	const budget = options.readinessMs ?? READINESS_MS;
	const until = Date.now() + budget;
	let started: (() => number | null | undefined) | undefined;
	let delay = 50;
	for (;;) {
		const socket = await connectSocket(paths.channel);
		if (socket) {
			const endpoint = createEndpoint(socket);
			try {
				const hello = await performHello(endpoint, readKey(paths.keyFile), options.client);
				if (hello.state === 'exiting' || hello.state === 'handingOver') {
					endpoint.close();
				} else {
					return { endpoint, hello };
				}
			} catch (error) {
				endpoint.close();
				if (error instanceof ContractError && error.code === WireErrorCode.DaemonUnavailable && !/closed/.test(error.message)) { throw error; }
			}
		} else if (!handoverUnderway(paths)) {
			if (!started) {
				if (!options.launch) { throw unavailable('No cockpit daemon runs, and this client cannot start one.', paths); }
				started = spawnDaemon(options.launch, options.launchArgs ?? []);
			} else {
				const code = started();
				// Code 2: another daemon won the channel at the same moment, which is fine.
				if (code !== undefined && code !== 2) {
					throw unavailable(`The cockpit daemon could not start (it exited with code ${String(code)}).`, paths);
				}
			}
		}
		if (Date.now() >= until) { throw unavailable(`The cockpit daemon did not answer within ${Math.round(budget / 1000)} s.`, paths); }
		await sleep(delay);
		delay = Math.min(delay * 2, 500);
	}
}
