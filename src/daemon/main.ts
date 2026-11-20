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
import { ContractError, Endpoint, createEndpoint } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import type { HelloAccepted } from '../contract/hello';
import type { DaemonStatus } from '../contract/models';
import { CONTRACT_VERSION } from '../contract/version';
import { Transport } from '../core/contracts';
import { DEFAULT_MOCK_CONFIG, MockTransportProvider, loadMockConfigFile } from '../core/mock';
import type { MockConfig } from '../core/mock';
import { Runtime, createRuntime } from '../core/runtime/createRuntime';
import { settingsSection } from '../core/settings/spec';
import { readProgramPresetSettings, readTelemetrySettings, readThrottleSettings } from '../core/telemetry/telemetrySettings';
import { setLedgerStore } from '../core/fs/transferLedger';
import { AlreadyRunningError, Listening, listenOnChannel } from './channel';
import { fileLedgerStore } from './stateStore';
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
	const built: { runtime?: Runtime } = {};
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
			registerBaseHandlers(client);
			for (const listener of clientListeners) { listener(client); }
			lifecycle.clientConnected(client.id);
		}).catch((error: unknown) => {
			log.debug(`A connection was refused: ${error instanceof Error ? error.message : String(error)}`);
		});
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

	// Only now, having won the channel, does the daemon touch the hardware.
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
		...(options.simulated ? { providers: [new MockTransportProvider(mockConfig ?? DEFAULT_MOCK_CONFIG)] } : {}),
		...(options.mockBricks ? { mockBricks: true } : {}),
		...(mockConfig && !options.simulated ? { mockConfig } : {}),
		// Linux: BlueZ refused this user. Ask a person through a VS Code window or a terminal that is
		// connected; with nobody to ask, say in the log what to run.
		onBluetoothAccessDenied: (fix) => {
			const person = [...clients.values()].find((c) => c.identity.kind === 'vscode')
				?? [...clients.values()].find((c) => c.identity.kind === 'cli');
			log.warn(`Bluetooth: BlueZ refused this user. The fix: ${fix.command}`);
			if (!person) { return; }
			void fix.offer(async (prompt) => (await ask(person.endpoint, {
				kind: 'bluetoothAccess', text: prompt.message, details: [prompt.command],
			})) === 'yes').then(() => fix.checkAgain()).catch((error: unknown) => {
				log.warn(`Bluetooth access fix failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		},
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
	const surface = createSurface({ status: () => daemon.status(), settings, log, clients, lifecycle }, runtime, () => firstRound);
	clientListeners.push((client) => surface.attach(client));
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
				for (const client of [...clients.values()]) { client.endpoint.close(); }
				// Devices first, so a successor never finds them still open.
				surface.dispose();
				runtime.dispose();
				settings.dispose();
				await listening?.close();
				log.info('Daemon stopped');
			})();
			return shuttingDown;
		},
	};
	lifecycle.serve();
	markReady();
	return daemon;
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
		installRoot: value('--install-root') ?? path.resolve(__dirname, '..', '..'),
		...(channel ? { channel } : {}),
		...(argv.includes('--simulated') ? { simulated: true } : {}),
		...(argv.includes('--mock-bricks') ? { mockBricks: true } : {}),
		...(mockWorkspace ? { mockWorkspace } : {}),
		...(grace ? { graceMs: Number(grace) } : {}),
		...(argv.includes('--debug') ? { debug: true } : {}),
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
