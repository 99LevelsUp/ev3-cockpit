/**
 * The cockpit daemon: the one process per user that holds the bricks.
 *
 * It wins its channel before it touches any hardware, then builds the same runtime the extension
 * used to build, holds the settings, and serves clients that prove the user's key. It lives while a
 * client is connected or a brick is held, and exits a grace period after neither is true.
 *
 * Run as `node daemon.js [--channel <name>] [--install-root <dir>] [--simulated] [--mock-bricks] [--mock-workspace <dir>]
 * [--grace-ms <n>] [--debug]`.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as net from 'node:net';
import { ContractError, Endpoint, createEndpoint, needsPerson } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import type { HelloAccepted } from '../contract/hello';
import { type DaemonStatus, type LaunchSpec, isPersonClient } from '../contract/models';
import { spawnDaemon } from '../client/ensureDaemon';
import { CONTRACT_VERSION } from '../contract/version';
import { BrickId, Transport } from '../core/contracts';
import { BtTransportProvider } from '../core/transports';
import { DEFAULT_MOCK_CONFIG, MockTransportProvider, loadMockConfigFile } from '../core/mock';
import type { MockConfig } from '../core/mock';
import { Runtime, createRuntime } from '../core/runtime/createRuntime';
import { settingsSection } from '../core/settings/spec';
import { readProgramPresetSettings, readTelemetrySettings, readThrottleSettings } from '../core/telemetry/telemetrySettings';
import { setLedgerStore } from '../core/fs/transferLedger';
import { AlreadyRunningError, Listening, listenOnChannel } from './channel';
import { fileLedgerStore } from './stateStore';
import { BrickLoans, createBrickLoans } from './brickLoans';
import { HardwareLock } from './hardwareLock';
import { createBluetoothAccessQuestion } from './bluetoothAccess';
import { PeerLink } from './peer';
import { isDevelopmentChannel, withoutChannel } from '../client/channel';
import { LoanGate } from '../core/runtime/deviceGate';
import {
	Replacement, createReplacement, ownLaunch, removeHandoverMarker, takeHandoverState, writeHandoverMarker, writeHandoverState,
} from './handover';
import { createSurface } from './surface';
import { ask } from './questions';
import { ClientIdentity, acceptHello } from './hello';
import { ensureKey } from './key';
import { DaemonLog } from './log';
import { DaemonPaths, daemonPaths } from './paths';
import { SettingsStore } from './settingsStore';
import { Lifecycle } from './stateMachine';
import { currentUserSid, isElevated } from './systemTools';

export interface DaemonOptions {
	/** A development or test channel; absent for the user's own daemon. */
	readonly channel?: string;
	/** Where `package.json` and the native helpers are. */
	readonly installRoot: string;
	/** Simulated bricks only, no real transports: for tests. */
	readonly simulated?: boolean;
	/** Simulated bricks beside the real ones, from this file or the built-in set. */
	readonly mockBricks?: boolean;
	/** A workspace folder whose .vscode/ev3-cockpit-mock.json defines the simulated bricks. */
	readonly mockWorkspace?: string;
	readonly graceMs?: number;
	readonly debug?: boolean;
	/** The user's channel a development daemon borrows from; absent, the user's own daemon. For tests. */
	readonly userChannel?: string;
	/** Take the per-user hardware lock even with simulated bricks: for tests of loans. Default: only with real transports. */
	readonly hardwareLock?: boolean;
	/** False in tests that run the daemon in their own process: a handover then leaves it running. */
	readonly exitAfterHandover?: boolean;
	/** Overrides for tests: where state goes. */
	readonly env?: NodeJS.ProcessEnv;
	readonly homedir?: string;
}

/** One connected client. */
export interface DaemonClient {
	readonly id: string;
	readonly identity: ClientIdentity;
	readonly endpoint: Endpoint;
}

export interface Daemon {
	readonly paths: DaemonPaths;
	readonly log: DaemonLog;
	readonly settings: SettingsStore;
	readonly runtime: Runtime;
	readonly lifecycle: Lifecycle;
	readonly clients: ReadonlyMap<string, DaemonClient>;
	readonly version: string;
	readonly instanceId: string;
	/** Called for every client once it has proved itself; later units register their handlers here. */
	onClient(listener: (client: DaemonClient) => void): void;
	status(): DaemonStatus;
	/** Stops serving, releases the hardware, then closes the channel. */
	shutdown(): Promise<void>;
}

function readVersion(installRoot: string): string {
	try {
		return (JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
	const env = options.env ?? process.env;
	const platform = process.platform;
	if (platform === 'win32' && isElevated()) {
		throw new Error('The cockpit daemon does not run as administrator: its clients, running as you, could not reach it. Start it from a normal window.');
	}
	const paths = daemonPaths({
		platform, env, homedir: options.homedir ?? os.homedir(),
		...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
		...(platform === 'win32' ? { userSid: currentUserSid() } : {}),
		...(options.channel ? { channel: options.channel } : {}),
	});
	fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
	// Nothing the daemon starts is looked for in whatever folder it was started from.
	process.chdir(paths.stateDir);

	const key = ensureKey(paths.keyFile);
	const log = new DaemonLog(paths.logFile, { debug: options.debug });
	const version = readVersion(options.installRoot);
	const instanceId = randomBytes(8).toString('hex');
	const clients = new Map<string, DaemonClient>();
	const clientListeners: Array<(client: DaemonClient) => void> = [];
	/** Clients that finish their handshake before the runtime is built wait for it here. */
	let markReady: () => void = () => undefined;
	const ready = new Promise<void>((resolve) => { markReady = resolve; });
	/** Built once the channel is won; read by the handshake before that. */
	const built: {
		runtime?: Runtime; replacement?: Replacement; handOver?: (launch: LaunchSpec, why: string) => Promise<void>;
		loans?: BrickLoans; peer?: PeerLink;
	} = {};
	let listening: Listening | undefined;

	const settings = new SettingsStore(paths.settingsFile, (m) => log.warn(m));
	settings.load();

	const lifecycle = new Lifecycle({
		...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
		onExit: () => {
			log.info('No client and no held brick: exiting');
			void daemon.shutdown().then(() => process.exitCode === undefined && setImmediate(() => process.exit(0)));
		},
	});

	const accepted = (): HelloAccepted => ({
		version, contractVersion: CONTRACT_VERSION, instanceId, pid: process.pid,
		state: lifecycle.helloState(),
		transports: built.runtime ? built.runtime.registry.all().map((p) => String(p.transport)) : [],
	});

	const onConnection = (socket: net.Socket): void => {
		const endpoint = createEndpoint(socket, {
			onOversize: (bytes) => log.warn(`A client sent a message of ${bytes} bytes; connection closed`),
		});
		// A connection still in its handshake keeps the daemon from exiting under it.
		const handshake = `handshake-${randomBytes(6).toString('hex')}`;
		lifecycle.clientConnected(handshake);
		acceptHello(endpoint, { key, accepted }).then(async (identity) => {
			await ready;
			if (lifecycle.state === 'exiting') { endpoint.close(); return; }
			const client: DaemonClient = { id: randomBytes(6).toString('hex'), identity, endpoint };
			clients.set(client.id, client);
			log.info(`Client connected: ${identity.name} (${identity.kind} ${identity.version})`);
			endpoint.onClose(() => {
				clients.delete(client.id);
				log.info(`Client left: ${identity.name}`);
				lifecycle.clientLeft(client.id);
			});
			// A development daemon is never an ordinary client: it gets the held bricks and loans, nothing else.
			if (identity.kind === 'peer') {
				if (built.loans) { built.loans.attachPeer(client); } else { endpoint.close(); return; }
			} else {
				registerBaseHandlers(client);
				for (const listener of clientListeners) { listener(client); }
			}
			lifecycle.clientConnected(client.id);
		}).catch((error: unknown) => {
			log.debug(`A connection was refused: ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => lifecycle.clientLeft(handshake));
	};

	const registerBaseHandlers = (client: DaemonClient): void => {
		const { endpoint, identity } = client;
		endpoint.onRequest('daemon/status', () => daemon.status());
		endpoint.onRequest('settings/list', () => settings.list());
		endpoint.onRequest('settings/accessMode', () => settings.value('accessMode'));
		endpoint.onRequest('settings/set', (params) => {
			const { key: name, value, confirmedByPerson } = (params ?? {}) as { key?: unknown; value?: unknown; confirmedByPerson?: unknown };
			if (typeof name !== 'string') { throw new ContractError(WireErrorCode.InvalidRequest, 'settings/set needs a key.'); }
			const result = settings.set(name, value, { kind: identity.kind, confirmedByPerson: confirmedByPerson === true });
			log.info(`Setting ${name} = ${JSON.stringify(value)}`, identity.name);
			return result;
		});
		endpoint.onRequest('daemon/registerReplacement', (params) => {
			const launch = (params as { launch?: unknown } | undefined)?.launch;
			if (!isLaunch(launch)) { throw new ContractError(WireErrorCode.InvalidRequest, 'daemon/registerReplacement needs a launch.'); }
			const result = built.replacement?.register(launch) ?? { accepted: false, reason: 'The daemon is not serving yet.' };
			log.info(`Replacement by ${launch.version}: ${result.accepted ? 'registered' : `refused (${result.reason ?? ''})`}`, identity.name);
			return result;
		});
		endpoint.onRequest('daemon/restart', (params) => {
			const { confirmedByPerson, launch } = (params ?? {}) as { confirmedByPerson?: unknown; launch?: unknown };
			if (!isPersonClient(identity.kind) || confirmedByPerson !== true) {
				throw needsPerson('Restarting the cockpit daemon needs a person to confirm it: run ev3 daemon restart in a terminal, or use VS Code.', 'ev3 daemon restart');
			}
			if (lifecycle.state === 'lent' || built.loans?.anyLent) {
				throw new ContractError(WireErrorCode.InvalidRequest, 'Bricks are lent to a development daemon; restart the cockpit daemon once it has ended.');
			}
			if (lifecycle.state !== 'serving' || !built.replacement) { return { accepted: false }; }
			const replacement = built.replacement;
			log.info('Restart asked', identity.name);
			// After the answer is on its way.
			setImmediate(() => replacement.restart(ownLaunch(options.installRoot, version), isLaunch(launch) ? launch : undefined));
			return { accepted: true };
		});
		endpoint.onRequest('log/notice', (params) => {
			const { level, text } = (params ?? {}) as { level?: string; text?: string };
			log.write(level === 'error' ? 'ERROR' : level === 'warning' ? 'WARN' : 'INFO', `Shown: ${String(text)}`, identity.name);
			return null;
		});
	};

	try {
		listening = await listenOnChannel(paths, onConnection);
	} catch (error) {
		if (error instanceof AlreadyRunningError) { log.info('Another daemon serves this channel; this one exits'); }
		throw error;
	}

	// Only now, having won the channel, does the daemon touch the hardware — what of it is its to
	// touch (KTD17): with the hardware lock it owns everything; a development daemon without it
	// opens only what it borrows; the user's daemon without it waits in Lent until the lock is free.
	const devChannel = isDevelopmentChannel(paths.channelName);
	const lock = (options.hardwareLock ?? !options.simulated) ? new HardwareLock(paths.hardwareLock, paths.channelName) : undefined;
	let role: 'alone' | 'owner' | 'borrower' | 'waiting' = 'alone';
	/** The hardware lock, taken from a timer or a closed connection: a failure there is logged, never thrown. */
	const takeLock = (): boolean => {
		try {
			return lock?.tryTake() ?? false;
		} catch (error) {
			log.warn(`The hardware lock could not be taken: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	};
	/** A VS Code window first, else a terminal: a person who can answer a question. */
	const askablePerson = (): DaemonClient | undefined => [...clients.values()].find((c) => c.identity.kind === 'vscode')
		?? [...clients.values()].find((c) => c.identity.kind === 'cli');
	const gate = new LoanGate('owner');
	if (lock) {
		if (takeLock()) {
			role = 'owner';
		} else if (devChannel) {
			role = 'borrower';
			gate.borrow();
		} else {
			role = 'waiting';
			gate.setAll(true);
		}
		log.info(`Hardware: ${role === 'owner' ? 'this daemon owns it' : role === 'borrower' ? 'the user\'s daemon owns it; bricks are borrowed one by one' : `a development daemon (pid ${lock.holder()?.pid ?? '?'}) owns it; waiting`}`);
	}
	const current = settings.all();
	const warn = (m: string): void => log.warn(m);
	let mockConfig: MockConfig | undefined;
	if (options.mockWorkspace) {
		const loaded = loadMockConfigFile([options.mockWorkspace], (file) => fs.readFileSync(file, 'utf8'));
		if (loaded.kind === 'loaded') { mockConfig = loaded.config; }
	}
	const runtime = createRuntime({
		extensionPath: options.installRoot,
		log,
		startPresence: !options.simulated,
		...(lock ? { deviceGate: gate } : {}),
		...(options.simulated ? { providers: [new MockTransportProvider(mockConfig ?? DEFAULT_MOCK_CONFIG)] } : {}),
		...(options.mockBricks ? { mockBricks: true } : {}),
		...(mockConfig && !options.simulated ? { mockConfig } : {}),
		// Linux: BlueZ refused this user. Ask a person through a VS Code window or a terminal that is
		// connected; with nobody to ask, say in the log what to run.
		onBluetoothAccessDenied: createBluetoothAccessQuestion({
			canAsk: () => askablePerson() !== undefined,
			ask: async (question) => {
				const person = askablePerson();
				return person ? ask(person.endpoint, question) : 'keep';
			},
			log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
		}),
		telemetrySettings: readTelemetrySettings(settingsSection(current), warn),
		throttleSettings: readThrottleSettings(settingsSection(current), warn),
		programPreset: readProgramPresetSettings(settingsSection(current), warn),
		transferPacketBytes: (transport) => {
			const bytes = settings.value(transport === Transport.BT ? 'transfer.btPacketBytes' : 'transfer.tcpPacketBytes');
			return typeof bytes === 'number' ? bytes : undefined;
		},
	});
	built.runtime = runtime;
	// The first discovery round, or 8 s of it: a brick named before then is waited for, not refused.
	const firstRound = Promise.race([
		runtime.scheduler.scanOnce().then(() => undefined, () => undefined),
		new Promise<void>((resolve) => { setTimeout(resolve, 8000).unref(); }),
	]);
	const surface = createSurface({ status: () => daemon.status(), settings, log, clients, lifecycle }, runtime, () => firstRound,
		role === 'borrower' ? { ensureOpenable: (id) => built.peer!.ensureOpenable(id), borrowAll: () => built.peer!.borrowAll() } : undefined);
	if (role !== 'borrower') {
		built.loans = createBrickLoans({ surface, runtime, lifecycle, gate, clients, log });
	}
	if (role === 'borrower') {
		built.peer = new PeerLink({
			userPaths: daemonPaths({
				platform, env: withoutChannel(env), homedir: options.homedir ?? os.homedir(),
				...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
				...(platform === 'win32' ? { userSid: currentUserSid() } : {}),
				...(options.userChannel ? { channel: options.userChannel } : {}),
			}),
			name: `development daemon (${paths.channelName ?? 'dev'}, pid ${process.pid})`,
			version, gate, surface, runtime, log,
			takeHardware: takeLock,
		});
		built.peer.start();
	}
	clientListeners.push((client) => surface.attach(client));
	const btProviders = (): BtTransportProvider[] => runtime.registry.all().filter((p): p is BtTransportProvider => p instanceof BtTransportProvider);
	// What a predecessor handed over: its holds, `full` and its Bluetooth close times.
	const inherited = takeHandoverState(paths);
	if (inherited) {
		settings.restoreUnstored(inherited.unstored);
		for (const provider of btProviders()) { provider.honourCloseTimes(inherited.btCloseTimes); }
		surface.resume(inherited.holders);
		log.info(`Took over from ${inherited.from}: ${Object.keys(inherited.holders).length} held brick(s) to connect again`);
	}
	// Debts a previous daemon left are paid before each brick's next transfer.
	setLedgerStore(runtime.bricks, fileLedgerStore(paths.ledgerFile));
	settings.onChange(({ key: changed }) => {
		if (!changed.startsWith('telemetry.')) { return; }
		const section = settingsSection(settings.all());
		runtime.telemetryView.configure(readTelemetrySettings(section, warn));
		runtime.telemetry.configureThrottle(readThrottleSettings(section, warn));
		runtime.telemetry.configureProgramPreset(readProgramPresetSettings(section, warn));
	});
	listening.releaseStartLock();
	log.info(`Daemon ${version} serving on ${paths.channel} (pid ${process.pid}, Node ${process.versions.node}${process.versions.electron ? `, Electron ${process.versions.electron}` : ''})`);

	built.replacement = createReplacement({
		version,
		anyDifference: devChannel,
		// Nothing written, nothing lent, no brick connected: a replacement cuts nothing off.
		idle: () => lifecycle.replaceable(surface.leases.busy()) && surface.holders.heldBricks().length === 0,
		handOver: (launch, why) => { void handOver(launch, why); },
		log: (m) => log.info(m),
	});

	/**
	 * Hands over to a successor (KTD7): new clients wait, writes end with `outcome_unknown`, the
	 * bricks are released and the state saved, then the marker, the listener closed, the successor
	 * started and this daemon gone.
	 */
	const handOver = async (launch: LaunchSpec, why: string): Promise<void> => {
		if (lifecycle.state !== 'serving') { return; }
		lifecycle.handOver();
		log.info(`Handing over to ${launch.version} (${why})`);
		surface.broadcast('daemon/handingOver', { successorVersion: launch.version });
		await surface.leases.abortAll(new Error('the daemon is handing over'), 5000);
		// The aborted requests' answers leave before the connections close.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const holderSnapshot = surface.holders.snapshot();
		const unstored = settings.unstored();
		for (const brickId of surface.holders.heldBricks()) {
			await runtime.bricks.signOut(brickId as BrickId).catch((error: unknown) => log.warn(`Releasing ${brickId} for the handover failed: ${String(error)}`));
		}
		const btCloseTimes = Object.assign({}, ...btProviders().map((p) => p.closeTimes())) as Record<string, number>;
		writeHandoverState(paths, { at: Date.now(), from: version, holders: holderSnapshot, unstored, btCloseTimes });
		writeHandoverMarker(paths, launch.version);
		await daemon.shutdown();
		spawnDaemon(launch, successorArgs(options));
		log.info(`Successor ${launch.version} started; this daemon exits`);
		if (process.exitCode === undefined && options.exitAfterHandover !== false) { setImmediate(() => process.exit(0)); }
	};
	built.handOver = handOver;

	let shuttingDown: Promise<void> | undefined;
	const startedAt = Date.now();
	const daemon: Daemon = {
		paths, log, settings, runtime, lifecycle, clients, version, instanceId,
		onClient: (listener) => { clientListeners.push(listener); },
		status: (): DaemonStatus => ({
			version, contractVersion: CONTRACT_VERSION, pid: process.pid, channel: paths.channel,
			startedAt: startedAt,
			runtime: { node: process.versions.node, ...(process.versions.electron ? { electron: process.versions.electron } : {}) },
			clients: [...clients.values()].map((c) => ({ name: c.identity.name, kind: c.identity.kind })),
			bricks: [],
			logPath: paths.logFile,
			...(lifecycle.state === 'lent' ? { lent: true } : {}),
		}),
		shutdown: () => {
			shuttingDown ??= (async () => {
				lifecycle.dispose();
				built.replacement?.dispose();
				built.peer?.dispose();
				if (lockTimer) { clearInterval(lockTimer); }
				for (const client of [...clients.values()]) { client.endpoint.close(); }
				// Devices first, so a successor never finds them still open.
				surface.dispose();
				const bt = btProviders();
				runtime.dispose();
				await Promise.race([
					Promise.all(bt.map((p) => p.disposeAsync())),
					new Promise((resolve) => { setTimeout(resolve, 5000).unref(); }),
				]);
				settings.dispose();
				lock?.release();
				await listening?.close();
				log.info('Daemon stopped');
			})();
			return shuttingDown;
		},
	};
	lifecycle.serve();
	markReady();
	let lockTimer: NodeJS.Timeout | undefined;
	if (role === 'waiting') {
		// A development daemon has the hardware: wait in Lent, opening nothing, until it ends.
		lifecycle.lend();
		lockTimer = setInterval(() => {
			if (!takeLock()) { return; }
			clearInterval(lockTimer);
			lockTimer = undefined;
			gate.own();
			surface.blocked.clear();
			lifecycle.reclaim();
			surface.refreshBricks();
			void runtime.scheduler.scanOnce().catch(() => undefined);
			log.info('The development daemon ended: this daemon owns the hardware now');
		}, 2000);
		lockTimer.unref?.();
	}
	// Serving: any handover that brought this daemon here is over.
	removeHandoverMarker(paths);
	return daemon;
}

function isLaunch(value: unknown): value is LaunchSpec {
	const v = value as Partial<LaunchSpec> | undefined;
	return typeof v === 'object' && v !== null && typeof v.runtime === 'string' && typeof v.entry === 'string'
		&& typeof v.installRoot === 'string' && typeof v.version === 'string';
}

/** The arguments a successor gets: the same channel and the same kind of bricks. */
export function successorArgs(options: DaemonOptions): string[] {
	return [
		...(options.channel ? ['--channel', options.channel] : []),
		...(options.simulated ? ['--simulated'] : []),
		...(options.mockBricks ? ['--mock-bricks'] : []),
		...(options.mockWorkspace ? ['--mock-workspace', options.mockWorkspace] : []),
		...(options.graceMs !== undefined ? ['--grace-ms', String(options.graceMs)] : []),
		...(options.debug ? ['--debug'] : []),
		...(options.userChannel ? ['--user-channel', options.userChannel] : []),
		...(options.hardwareLock ? ['--hardware-lock'] : []),
	];
}

/**
 * Where this daemon is installed when nobody says: the bundle `out/daemon.js` sits one folder below
 * the install root, tsc's `out/daemon/main.js` two.
 */
export function defaultInstallRoot(dir: string): string {
	return path.basename(dir) === 'out' ? path.resolve(dir, '..') : path.resolve(dir, '..', '..');
}

/** Reads the command line. */
export function parseDaemonArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): DaemonOptions {
	const value = (flag: string): string | undefined => {
		const at = argv.indexOf(flag);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	const channel = value('--channel') ?? env.EV3_COCKPIT_CHANNEL;
	const grace = value('--grace-ms');
	const mockWorkspace = value('--mock-workspace');
	return {
		installRoot: value('--install-root') ?? defaultInstallRoot(__dirname),
		...(channel ? { channel } : {}),
		...(argv.includes('--simulated') ? { simulated: true } : {}),
		...(argv.includes('--mock-bricks') ? { mockBricks: true } : {}),
		...(mockWorkspace ? { mockWorkspace } : {}),
		...(grace ? { graceMs: Number(grace) } : {}),
		...(argv.includes('--debug') ? { debug: true } : {}),
		...(value('--user-channel') ? { userChannel: value('--user-channel')! } : {}),
		...(argv.includes('--hardware-lock') ? { hardwareLock: true } : {}),
	};
}

if (require.main === module) {
	// Children the daemon starts must run as ordinary programs, not as VS Code's Node.
	delete process.env.ELECTRON_RUN_AS_NODE;
	startDaemon(parseDaemonArgs(process.argv.slice(2))).then((daemon) => {
		const stop = (): void => { void daemon.shutdown().then(() => process.exit(0)); };
		process.on('SIGINT', stop);
		process.on('SIGTERM', stop);
	}).catch((error: unknown) => {
		const already = error instanceof AlreadyRunningError;
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(already ? 2 : 1);
	});
}
