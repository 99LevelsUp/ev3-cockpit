/**
 * Which native daemon a client works with, from the client's side. The daemon judges an exit
 * request itself; the client decides when to ask.
 *
 * - No daemon: the client starts its own verified copy.
 * - A daemon runs: the hello says its version, contract version and build kind.
 *   - A development client meeting a release daemon asks it to exit and starts its own.
 *   - A release client newer than a release daemon asks it to exit, then starts its own.
 *   - A release client meeting a development daemon uses it and tells the user one runs.
 *   - Otherwise the client uses it.
 *   - A client that would use a daemon on another contract version says so and stops.
 * - Only the VS Code extension and the `ev3` command, which carry a daemon, ever ask a daemon to
 *   exit. An add-on starts the installed cockpit's daemon from `install.json`; the MCP server asks
 *   nothing either.
 * - An exit request may take up to two minutes to answer (a person's answer, then a write still
 *   running). Its answer is `{accepted, reason}`; once accepted the daemon is ending, so the client
 *   waits for its channel to go before it starts its own.
 */

import * as path from 'node:path';
import { WireErrorCode } from '../contract/errors';
import { CONTRACT_VERSION } from '../contract/generated';
import type { BuildKind, ChannelRecord, ClientKind, DaemonExitResult, LaunchSpec } from '../contract/generated';
import { NativeChannelHost, openNativeChannel, systemChannelHost } from './channel';
import { ContractError, Endpoint } from './connection';
import { DaemonIdentity, KeyReadHost, NativeConnection, connectNativeDaemon } from './hello';
import { NativeChannelFiles, nativeChannelFiles, nativeStateRoot } from './locate';
import {
	DaemonStartError, LaunchHost, classifyStartFailure, installedNativeLaunch, recordNativeInstall, removeOldCopies,
	systemLaunchHost, verifiedCopy,
} from './nativeLaunch';
import { compareVersions } from './versions';

/** How long starting a daemon, or waiting for one to end, may take. */
export const NATIVE_READINESS_MS = 15_000;
/** How long the client waits for the answer to an exit request: a person's 60 s, then a write's 60 s. */
export const EXIT_ANSWER_MS = 130_000;
/** How many times the client meets a daemon and decides again before it gives up. */
const MAX_ROUNDS = 5;
/** How long without a channel after a lock-held exit before the client starts its copy again. */
const RESPAWN_AFTER_MS = 1_000;

/** Who the client is, as the launch decides. */
export interface LaunchingClient {
	readonly kind: ClientKind;
	readonly buildKind: BuildKind;
	readonly version: string;
	readonly contractVersion: number;
	/** The client carries a daemon it could start in place of the running one. */
	readonly canStart: boolean;
}

export type LaunchDecision =
	| { readonly action: 'use'; readonly notice?: string }
	| { readonly action: 'replace' }
	| { readonly action: 'stop'; readonly reason: string };

function describeDaemon(daemon: Pick<DaemonIdentity, 'version' | 'buildKind'>): string {
	return daemon.buildKind === 'development'
		? `A development build of the EVƎ Cockpit daemon (version ${daemon.version})`
		: `The EVƎ Cockpit daemon ${daemon.version}`;
}

function contractStop(daemon: Pick<DaemonIdentity, 'version' | 'buildKind' | 'contractVersion'>, clientContract: number, why = ''): string {
	return `${describeDaemon(daemon)} runs and speaks contract ${daemon.contractVersion}; this client speaks contract ${clientContract}, so it cannot use it.${why ? ` ${why}` : ''} Update the older of the two.`;
}

/** What a client does about a daemon it met. */
export function decideOnDaemon(client: LaunchingClient, daemon: Pick<DaemonIdentity, 'version' | 'buildKind' | 'contractVersion'>): LaunchDecision {
	const mayReplace = client.canStart && (client.kind === 'vscode' || client.kind === 'cli');
	if (mayReplace && daemon.buildKind === 'release'
		&& (client.buildKind === 'development' || compareVersions(client.version, daemon.version) > 0)) {
		return { action: 'replace' };
	}
	if (daemon.contractVersion !== client.contractVersion) {
		return { action: 'stop', reason: contractStop(daemon, client.contractVersion) };
	}
	if (client.buildKind === 'release' && daemon.buildKind === 'development') {
		return { action: 'use', notice: `${describeDaemon(daemon)} runs; this client uses it.` };
	}
	return { action: 'use' };
}

export interface NativeDaemonOptions {
	/** Shown in the daemon's log, in other clients' `brick_busy` and in questions. */
	readonly name: string;
	readonly kind: ClientKind;
	/** This client's package version. */
	readonly version: string;
	/** This client's build kind; by default its daemon's, and `release` for a client that carries none. */
	readonly buildKind?: BuildKind;
	/**
	 * The daemon this client carries: `packagedDaemon` or `developmentDaemon`. An add-on carries
	 * none; it starts the one the installed cockpit recorded.
	 */
	readonly daemon?: LaunchSpec;
	/** The state root; by default the platform's. A root of its own needs a test channel. */
	readonly stateRoot?: string;
	/** A test channel; by default the user's own. */
	readonly channel?: string;
	/** More arguments for a daemon this client starts on a test channel: replay and its recording. */
	readonly daemonArgs?: readonly string[];
	readonly readinessMs?: number;
	readonly exitAnswerMs?: number;
	/** Before starting a daemon, wait this long for another client's (a replacement on its way). */
	readonly successorWaitMs?: number;
	/** Told what the user should know: a development daemon runs, an exit request was refused. */
	readonly onNotice?: (text: string) => void;
	readonly host?: LaunchHost;
	readonly channelHost?: NativeChannelHost;
	readonly keyHost?: KeyReadHost;
}

export interface NativeDaemonConnection {
	readonly endpoint: Endpoint;
	readonly daemon: DaemonIdentity;
	readonly record: ChannelRecord;
	readonly files: NativeChannelFiles;
	/** This client started the daemon it is connected to. */
	readonly started: boolean;
}

type Connected = Extract<NativeConnection, { kind: 'connected' }>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isUnavailable(error: unknown): boolean {
	return error instanceof ContractError && error.code === WireErrorCode.DaemonUnavailable && !(error instanceof DaemonStartError);
}

/** The arguments that put a daemon on the client's channel and state root. */
function channelArgs(options: NativeDaemonOptions, stateRoot: string): string[] {
	if (!options.channel) {
		if (options.stateRoot !== undefined || options.daemonArgs?.length) {
			throw new Error('A state root of its own and daemon arguments need a test channel.');
		}
		return [];
	}
	return ['--channel', options.channel, ...(options.stateRoot !== undefined ? ['--state-root', stateRoot] : []), ...(options.daemonArgs ?? [])];
}

/**
 * Connects to the daemon this client should work with, starting or replacing one as the rules
 * above say. Throws a `DaemonStartError` when it cannot.
 */
export async function ensureNativeDaemon(options: NativeDaemonOptions): Promise<NativeDaemonConnection> {
	const stateRoot = options.stateRoot ?? nativeStateRoot();
	const files = nativeChannelFiles(stateRoot, options.channel);
	const host = options.host ?? systemLaunchHost();
	const channelHost = options.channelHost ?? systemChannelHost();
	const readiness = options.readinessMs ?? NATIVE_READINESS_MS;
	const args = channelArgs(options, stateRoot);
	const own = options.daemon ?? (options.kind === 'addon' ? installedNativeLaunch(files) : undefined);
	const buildKind = options.buildKind ?? options.daemon?.buildKind ?? 'release';
	const identity = { name: options.name, kind: options.kind, version: options.version, buildKind };
	const client: LaunchingClient = {
		kind: options.kind, buildKind, version: options.version, contractVersion: CONTRACT_VERSION, canStart: own !== undefined,
	};
	const notice = (text: string): void => { try { options.onNotice?.(text); } catch { /* the caller's own failure */ } };

	/** Finds a daemon; one that is there but not answering yet is tried again within the budget. */
	const find = async (until: number): Promise<NativeConnection> => {
		for (;;) {
			try {
				return await connectNativeDaemon({
					files, client: identity, host: channelHost, acceptOtherContract: true,
					...(options.keyHost ? { keyHost: options.keyHost } : {}),
				});
			} catch (error) {
				if (!isUnavailable(error) || Date.now() >= until) { throw error; }
				await sleep(100);
			}
		}
	};

	/** Whether a daemon serves the channel now. */
	const channelPresent = async (): Promise<boolean> => {
		try {
			const channel = await openNativeChannel(files, channelHost);
			if (channel.kind === 'none') { return false; }
			channel.stream.destroy();
			return true;
		} catch {
			return true;
		}
	};

	/** Waits until no daemon holds the channel. */
	const waitGone = async (): Promise<void> => {
		const until = Date.now() + readiness;
		while (Date.now() < until) {
			try {
				const channel = await openNativeChannel(files, channelHost);
				if (channel.kind === 'none') { return; }
				channel.stream.destroy();
			} catch { /* ending: its pipe no longer answers */ }
			await sleep(100);
		}
		throw new DaemonStartError('lock_held', `The cockpit daemon was asked to exit but still held its channel after ${Math.round(readiness / 1000)} s.`);
	};

	/** Starts this client's verified copy and connects to whichever daemon then serves the channel. */
	const start = async (launch: LaunchSpec): Promise<{ connection: Connected; ours: boolean }> => {
		const until = Date.now() + readiness;
		let binary = await verifiedCopy(launch, stateRoot, host);
		let child = host.spawn(binary, args, stateRoot);
		let lockHeldSince: number | undefined;
		let delay = 50;
		for (;;) {
			const outcome = child.outcome();
			if (outcome) {
				const failure = classifyStartFailure(outcome, binary, host, path.join(files.dir, 'daemon.log'));
				// Another daemon starts or ends on this channel: its channel shows up, or the lock frees.
				if (failure.failure !== 'lock_held') { throw failure; }
				lockHeldSince ??= Date.now();
				if (Date.now() - lockHeldSince >= RESPAWN_AFTER_MS && Date.now() < until) {
					binary = await verifiedCopy(launch, stateRoot, host);
					child = host.spawn(binary, args, stateRoot);
					lockHeldSince = undefined;
				}
			}
			const found = await find(0).catch((error: unknown) => {
				if (isUnavailable(error)) { return { kind: 'none' } as const; }
				throw error;
			});
			if (found.kind === 'connected') { return { connection: found, ours: found.record.pid === child.pid }; }
			if (Date.now() >= until) {
				const failure = child.outcome();
				if (failure && classifyStartFailure(failure, binary, host, '').failure === 'lock_held') {
					throw new DaemonStartError('lock_held', `Another cockpit daemon held this channel's lock and did not become reachable within ${Math.round(readiness / 1000)} s; try again.`);
				}
				throw new DaemonStartError('failed', `The cockpit daemon did not answer within ${Math.round(readiness / 1000)} s.`);
			}
			await sleep(delay);
			delay = Math.min(delay * 2, 250);
		}
	};

	const finish = (connection: Connected, started: boolean): NativeDaemonConnection => {
		try {
			removeOldCopies(stateRoot, [...(own ? [own.sha256] : []), connection.daemon.buildId]);
			// The installed cockpit records its daemon for add-ons; a development build is not the installed one.
			if (options.daemon?.buildKind === 'release' && (options.kind === 'vscode' || options.kind === 'cli')) {
				recordNativeInstall(files, options.daemon);
			}
		} catch { /* housekeeping only: the connection stands */ }
		return { endpoint: connection.endpoint, daemon: connection.daemon, record: connection.record, files, started };
	};

	let successorWait = options.successorWaitMs ?? 0;
	for (let round = 1; round <= MAX_ROUNDS; round++) {
		let found = await find(Date.now() + readiness);
		let started = false;
		if (found.kind === 'none') {
			if (successorWait > 0) {
				const until = Date.now() + successorWait;
				successorWait = 0;
				while (Date.now() < until && !(await channelPresent())) { await sleep(100); }
				round--;
				continue;
			}
			if (!own) {
				throw new DaemonStartError('missing_binary', options.kind === 'addon'
					? 'No cockpit daemon runs and EVƎ Cockpit has not recorded one to start: install EVƎ Cockpit, or open VS Code with it once.'
					: 'No cockpit daemon runs, and this client carries none to start.');
			}
			const result = await start(own);
			found = result.connection;
			started = result.ours;
		}
		const connection: Connected = found;
		if (connection.daemon.state === 'exiting') {
			connection.endpoint.close();
			await waitGone();
			continue;
		}
		const decision = started && connection.daemon.contractVersion === CONTRACT_VERSION
			? { action: 'use' } as const
			: decideOnDaemon(client, connection.daemon);
		if (decision.action === 'use') {
			if (decision.notice) { notice(decision.notice); }
			return finish(connection, started);
		}
		if (decision.action === 'stop') {
			connection.endpoint.close();
			throw new DaemonStartError('contract_mismatch', decision.reason);
		}
		const answer = await askToExit(connection.endpoint, options.exitAnswerMs ?? EXIT_ANSWER_MS);
		if (answer.accepted) {
			connection.endpoint.close();
			await waitGone();
			continue;
		}
		const reason = answer.reason ?? 'The cockpit daemon refused to exit.';
		notice(reason);
		if (connection.daemon.contractVersion === CONTRACT_VERSION) { return finish(connection, false); }
		connection.endpoint.close();
		throw new DaemonStartError('contract_mismatch', contractStop(connection.daemon, CONTRACT_VERSION, reason));
	}
	throw new DaemonStartError('failed', 'The cockpit daemon kept changing while this client connected; try again.');
}

/**
 * Asks a daemon to exit and waits for its answer. A daemon that goes meanwhile counts as ending,
 * and so does one that cancelled the request: it does that only as it shuts down, when another
 * client's exit request came first.
 */
export async function askToExit(endpoint: Endpoint, timeoutMs: number): Promise<DaemonExitResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await endpoint.request<DaemonExitResult>('daemon/exit', {}, { signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			return { accepted: false, reason: `The cockpit daemon did not answer the exit request within ${Math.round(timeoutMs / 1000)} s.` };
		}
		if (isUnavailable(error)) { return { accepted: true }; }
		if (error instanceof ContractError && error.code === WireErrorCode.Cancelled) { return { accepted: true }; }
		return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}
