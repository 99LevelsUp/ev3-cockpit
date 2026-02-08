import * as vscode from 'vscode';
import * as path from 'node:path';
import { registerBrowseCommands } from './commands/browseCommands';
import { registerConnectCommands } from './commands/connectCommands';
import { registerDeployCommands, DeployTargetContext } from './commands/deployCommands';
import { registerProgramControlCommands } from './commands/programControlCommands';
import { registerTransportCommands } from './commands/transportCommands';
import { readFeatureConfig } from './config/featureConfig';
import { readSchedulerConfig } from './config/schedulerConfig';
import { BrickControlService } from './device/brickControlService';
import { BrickRegistry, BrickRole } from './device/brickRegistry';
import { OutputChannelLogger } from './diagnostics/logger';
import { assertRemoteExecutablePath } from './fs/remoteExecutable';
import { Ev3FileSystemProvider } from './fs/ev3FileSystemProvider';
import { RemoteFsService } from './fs/remoteFsService';
import { Ev3CommandClient } from './protocol/ev3CommandClient';
import { CommandScheduler } from './scheduler/commandScheduler';
import { OrphanRecoveryContext, OrphanRecoveryStrategy } from './scheduler/orphanRecovery';
import { createProbeTransportFromWorkspace, TransportMode } from './transport/transportFactory';
import {
	BrickTreeProvider,
	isBrickDirectoryNode,
	isBrickFileNode,
	isBrickRootNode
} from './ui/brickTreeProvider';
import { BrickTreeDragAndDropController } from './ui/brickTreeDragAndDrop';

class LoggingOrphanRecoveryStrategy implements OrphanRecoveryStrategy {
	public constructor(private readonly log: (message: string, meta?: Record<string, unknown>) => void) {}

	public async recover(context: OrphanRecoveryContext): Promise<void> {
		this.log('Running orphan-risk recovery', {
			requestId: context.requestId,
			lane: context.lane,
			reason: context.reason
		});

		// Placeholder recovery for current MVP.
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

interface ProgramSessionState {
	remotePath: string;
	startedAtIso: string;
	transportMode: TransportMode | 'unknown';
	source:
		| 'deploy-and-run-single'
		| 'deploy-project-run'
		| 'remote-fs-run'
		| 'run-command'
		| 'restart-command';
}

interface ConnectedBrickDescriptor {
	brickId: string;
	displayName: string;
	role: BrickRole;
	transport: TransportMode | 'unknown';
	rootPath: string;
}

function normalizeBrickRootPath(input: string): string {
	let rootPath = input.trim();
	if (!rootPath.startsWith('/')) {
		rootPath = `/${rootPath}`;
	}
	if (!rootPath.endsWith('/')) {
		rootPath = `${rootPath}/`;
	}
	return rootPath;
}

function toSafeIdentifier(input: string): string {
	const normalized = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized.length > 0 ? normalized : 'active';
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('EV3 Cockpit');
	let logger: OutputChannelLogger;
	let scheduler: CommandScheduler;
	let commandClient: Ev3CommandClient;
	const brickRegistry = new BrickRegistry();
	let lastRunProgramPath: string | undefined;
	let activeProgramSession: ProgramSessionState | undefined;

	const getActiveFsService = (): RemoteFsService | undefined => brickRegistry.getActiveFsService();
	const getActiveControlService = (): BrickControlService | undefined => brickRegistry.getActiveControlService();

	const treeProvider = new BrickTreeProvider({
		dataSource: {
			listBricks: () => brickRegistry.listSnapshots(),
			getBrickSnapshot: (brickId) => brickRegistry.getSnapshot(brickId),
			resolveFsService: async (brickId) => {
				const service = brickRegistry.resolveFsService(brickId);
				if (!service) {
					throw new Error(`Brick "${brickId}" is unavailable for filesystem access.`);
				}
				return service;
			}
		}
	});

	const fsProvider = new Ev3FileSystemProvider(async (brickId) => {
		const resolved = brickRegistry.resolveFsService(brickId);
		if (resolved) {
			return resolved;
		}

		if (brickId === 'active') {
			throw new Error('No active EV3 connection for filesystem access. Run "EV3 Cockpit: Connect to EV3 Brick".');
		}

		const snapshot = brickRegistry.getSnapshot(brickId);
		if (snapshot) {
			throw new Error(`Brick "${brickId}" is currently ${snapshot.status.toLowerCase()}.`);
		}

		throw new Error(`Brick "${brickId}" is not registered. Connect it first or use ev3://active/...`);
	});

	const rebuildRuntime = () => {
		const config = readSchedulerConfig();
		const featureConfig = readFeatureConfig();
		logger = new OutputChannelLogger((line) => output.appendLine(line), config.logLevel);
		void commandClient?.close().catch(() => undefined);
		scheduler?.dispose();
		brickRegistry.markAllUnavailable('Runtime reinitialized.');
		lastRunProgramPath = undefined;
		activeProgramSession = undefined;
		treeProvider.refreshThrottled();

		scheduler = new CommandScheduler({
			defaultTimeoutMs: config.timeoutMs,
			logger,
			defaultRetryPolicy: config.defaultRetryPolicy,
			orphanRecoveryStrategy: new LoggingOrphanRecoveryStrategy((msg, meta) => logger.info(msg, meta))
		});

		commandClient = new Ev3CommandClient({
			scheduler,
			transport: createProbeTransportFromWorkspace(logger, config.timeoutMs),
			logger
		});

		logger.info('Scheduler runtime (re)initialized', {
			timeoutMs: config.timeoutMs,
			logLevel: config.logLevel,
			retry: config.defaultRetryPolicy,
			compatProfileMode: featureConfig.compatProfileMode,
			fsMode: featureConfig.fs.mode
		});
	};

	rebuildRuntime();

	const resolveProbeTimeoutMs = (): number => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const modeRaw = cfg.get('transport.mode');
		const mode: TransportMode =
			modeRaw === 'usb' || modeRaw === 'bluetooth' || modeRaw === 'tcp' || modeRaw === 'mock' || modeRaw === 'auto'
				? modeRaw
				: 'auto';

		const base = readSchedulerConfig().timeoutMs;
		const btProbeRaw = cfg.get('transport.bluetooth.probeTimeoutMs');
		const btProbe =
			typeof btProbeRaw === 'number' && Number.isFinite(btProbeRaw) ? Math.max(50, Math.floor(btProbeRaw)) : 8_000;

		if (mode === 'bluetooth') {
			return Math.max(base, btProbe);
		}

		return base;
	};

	const resolveFsModeTarget = (): vscode.ConfigurationTarget => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const inspected = cfg.inspect('fs.mode');
		if (inspected?.workspaceFolderValue !== undefined) {
			return vscode.ConfigurationTarget.WorkspaceFolder;
		}
		if (inspected?.workspaceValue !== undefined) {
			return vscode.ConfigurationTarget.Workspace;
		}
		return vscode.ConfigurationTarget.Global;
	};

	const ensureFullFsModeConfirmation = async (): Promise<boolean> => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const mode = cfg.get('fs.mode');
		const confirmationRequired = cfg.get('fs.fullMode.confirmationRequired', true);
		if (mode !== 'full' || !confirmationRequired) {
			return true;
		}

		const choice = await vscode.window.showWarningMessage(
			'Full EV3 filesystem mode allows risky operations outside safe roots. Continue?',
			{ modal: true },
			'Enable Full Mode'
		);
		if (choice === 'Enable Full Mode') {
			logger.info('Full filesystem mode explicitly confirmed by user.');
			return true;
		}

		await cfg.update('fs.mode', 'safe', resolveFsModeTarget());
		logger.warn('Full filesystem mode rejected by user; reverted to safe mode.');
		return false;
	};

	const normalizeRunExecutablePath = (input: string): string => {
		const trimmed = input.trim();
		if (!trimmed) {
			throw new Error('Executable path must not be empty.');
		}

		let candidate = trimmed;
		if (candidate.toLowerCase().startsWith('ev3://')) {
			const parsed = vscode.Uri.parse(candidate);
			if (parsed.authority && parsed.authority !== 'active') {
				throw new Error(`Unsupported EV3 authority "${parsed.authority}". Use ev3://active/...`);
			}
			candidate = parsed.path;
		}

		const normalized = path.posix.normalize(candidate.startsWith('/') ? candidate : `/${candidate}`);
		assertRemoteExecutablePath(normalized);
		return normalized;
	};

	const resolveCurrentTransportMode = (): TransportMode | 'unknown' => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const mode = cfg.get('transport.mode');
		return mode === 'auto' || mode === 'usb' || mode === 'bluetooth' || mode === 'tcp' || mode === 'mock'
			? mode
			: 'unknown';
	};

	const resolveConnectedBrickDescriptor = (rootPath: string): ConnectedBrickDescriptor => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const transport = resolveCurrentTransportMode();
		const normalizedRootPath = normalizeBrickRootPath(rootPath);
		const role: BrickRole = 'standalone';

		if (transport === 'tcp') {
			const hostRaw = cfg.get('transport.tcp.host');
			const host = typeof hostRaw === 'string' && hostRaw.trim().length > 0 ? hostRaw.trim() : 'active';
			return {
				brickId: `tcp-${toSafeIdentifier(host)}`,
				displayName: `EV3 TCP (${host})`,
				role,
				transport,
				rootPath: normalizedRootPath
			};
		}

		if (transport === 'bluetooth') {
			const portRaw = cfg.get('transport.bluetooth.port');
			const port = typeof portRaw === 'string' && portRaw.trim().length > 0 ? portRaw.trim() : 'auto';
			return {
				brickId: `bluetooth-${toSafeIdentifier(port)}`,
				displayName: `EV3 Bluetooth (${port})`,
				role,
				transport,
				rootPath: normalizedRootPath
			};
		}

		if (transport === 'usb') {
			const pathRaw = cfg.get('transport.usb.path');
			const usbPath = typeof pathRaw === 'string' && pathRaw.trim().length > 0 ? pathRaw.trim() : 'auto';
			return {
				brickId: `usb-${toSafeIdentifier(usbPath)}`,
				displayName: `EV3 USB (${usbPath})`,
				role,
				transport,
				rootPath: normalizedRootPath
			};
		}

		if (transport === 'mock') {
			return {
				brickId: 'mock-active',
				displayName: 'EV3 Mock',
				role,
				transport,
				rootPath: normalizedRootPath
			};
		}

		return {
			brickId: 'auto-active',
			displayName: 'EV3 (Auto)',
			role,
			transport,
			rootPath: normalizedRootPath
		};
	};

	const markProgramStarted = (
		remotePath: string,
		source: ProgramSessionState['source']
	): void => {
		lastRunProgramPath = remotePath;
		activeProgramSession = {
			remotePath,
			startedAtIso: new Date().toISOString(),
			transportMode: resolveCurrentTransportMode(),
			source
		};
		logger.info('Program session updated', {
			...activeProgramSession
		});
	};

	const clearProgramSession = (reason: string): void => {
		if (!activeProgramSession && !lastRunProgramPath) {
			return;
		}
		logger.info('Program session cleared', {
			reason,
			lastRunProgramPath,
			activeProgramSession
		});
		activeProgramSession = undefined;
	};

	const resolveBrickIdFromCommandArg = (arg: unknown): string => {
		if (typeof arg === 'string' && arg.trim().length > 0) {
			return arg.trim();
		}
		if (isBrickRootNode(arg)) {
			return arg.brickId;
		}
		if (isBrickDirectoryNode(arg) || isBrickFileNode(arg)) {
			return arg.brickId;
		}
		return 'active';
	};

	const resolveFsAccessContext = (
		arg: unknown
	): { brickId: string; authority: string; fsService: RemoteFsService } | { error: string } => {
		const requestedBrickId = resolveBrickIdFromCommandArg(arg);
		const authority = requestedBrickId === 'active' ? 'active' : requestedBrickId;
		const fsService = brickRegistry.resolveFsService(requestedBrickId);
		if (!fsService) {
			const snapshot = requestedBrickId === 'active' ? undefined : brickRegistry.getSnapshot(requestedBrickId);
			if (snapshot) {
				return {
					error: `Brick "${requestedBrickId}" is currently ${snapshot.status.toLowerCase()}.`
				};
			}
			return {
				error:
					requestedBrickId === 'active'
						? 'No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.'
						: `Brick "${requestedBrickId}" is not connected.`
			};
		}

		const brickId = requestedBrickId === 'active' ? brickRegistry.getActiveBrickId() ?? 'active' : requestedBrickId;
		return {
			brickId,
			authority,
			fsService
		};
	};

	const resolveDeployTargetFromArg = (arg: unknown): DeployTargetContext | { error: string } => {
		const fsContext = resolveFsAccessContext(arg);
		if ('error' in fsContext) {
			return fsContext;
		}

		const rootPath =
			isBrickRootNode(arg)
				? arg.rootPath
				: isBrickDirectoryNode(arg)
				? arg.remotePath
				: brickRegistry.getSnapshot(fsContext.brickId)?.rootPath;

		return {
			brickId: fsContext.brickId,
			authority: fsContext.authority,
			rootPath,
			fsService: fsContext.fsService
		};
	};

	// --- Register command modules ---

	const { connect, disconnect, reconnect } = registerConnectCommands({
		getCommandClient: () => commandClient,
		getLogger: () => logger,
		getBrickRegistry: () => brickRegistry,
		getTreeProvider: () => treeProvider,
		clearProgramSession,
		resolveProbeTimeoutMs,
		resolveConnectedBrickDescriptor
	});

	const deployRegistrations = registerDeployCommands({
		getLogger: () => logger,
		getCommandClient: () => commandClient,
		resolveDeployTargetFromArg,
		resolveFsAccessContext,
		markProgramStarted
	});

	const { runRemoteProgram, stopProgram, restartProgram, emergencyStop } = registerProgramControlCommands({
		getActiveFsService,
		getActiveControlService,
		getLastRunProgramPath: () => lastRunProgramPath,
		getRestartCandidatePath: () => activeProgramSession?.remotePath ?? lastRunProgramPath,
		getLogger: () => logger,
		normalizeRunExecutablePath,
		onProgramStarted: markProgramStarted,
		onProgramCleared: clearProgramSession
	});

	const { inspectTransports, transportHealthReport } = registerTransportCommands({
		getLogger: () => logger,
		resolveProbeTimeoutMs
	});

	const browseRegistrations = registerBrowseCommands({
		getLogger: () => logger,
		getBrickRegistry: () => brickRegistry,
		getTreeProvider: () => treeProvider,
		resolveFsAccessContext,
		resolveBrickIdFromCommandArg,
		markProgramStarted
	});

	// --- Config watcher, FS provider, tree view ---

	const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
		void (async () => {
			if (event.affectsConfiguration('ev3-cockpit.fs.mode') || event.affectsConfiguration('ev3-cockpit.fs.fullMode.confirmationRequired')) {
				const confirmed = await ensureFullFsModeConfirmation();
				if (!confirmed) {
					return;
				}
			}

			if (event.affectsConfiguration('ev3-cockpit')) {
				rebuildRuntime();
			}
		})();
	});

	const fsDisposable = vscode.workspace.registerFileSystemProvider('ev3', fsProvider, {
		isCaseSensitive: true,
		isReadonly: false
	});
	const brickTreeDragAndDrop = new BrickTreeDragAndDropController({
		resolveFsService: async (brickId) => {
			const service = brickRegistry.resolveFsService(brickId);
			if (!service) {
				throw new Error(`Brick "${brickId}" is unavailable for filesystem access.`);
			}
			return service;
		},
		refreshTree: () => treeProvider.refreshThrottled(),
		logger: logger!
	});

	const brickTreeView = vscode.window.createTreeView('ev3-cockpit.bricksView', {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
		dragAndDropController: brickTreeDragAndDrop
	});
	treeProvider.refresh();

	context.subscriptions.push(
		connect,
		deployRegistrations.deployAndRunExecutable,
		deployRegistrations.previewProjectDeploy,
		deployRegistrations.deployProject,
		deployRegistrations.previewProjectDeployToBrick,
		deployRegistrations.deployProjectToBrick,
		deployRegistrations.deployProjectAndRunExecutableToBrick,
		deployRegistrations.previewWorkspaceDeploy,
		deployRegistrations.deployWorkspace,
		deployRegistrations.previewWorkspaceDeployToBrick,
		deployRegistrations.deployWorkspaceToBrick,
		deployRegistrations.deployWorkspaceAndRunExecutableToBrick,
		deployRegistrations.deployProjectAndRunExecutable,
		deployRegistrations.deployWorkspaceAndRunExecutable,
		deployRegistrations.applyDeployProfile,
		deployRegistrations.applyDeployProfileToBrick,
		runRemoteProgram,
		stopProgram,
		restartProgram,
		reconnect,
		disconnect,
		emergencyStop,
		inspectTransports,
		transportHealthReport,
		browseRegistrations.browseRemoteFs,
		browseRegistrations.refreshBricksView,
		browseRegistrations.uploadToBrickFolder,
		browseRegistrations.deleteRemoteEntryFromTree,
		browseRegistrations.runRemoteExecutableFromTree,
		configWatcher,
		fsDisposable,
		brickTreeView,
		treeProvider,
		output,
		{
		dispose: () => {
			scheduler.dispose();
			brickRegistry.markAllUnavailable('Extension disposed.');
			treeProvider.dispose();
			clearProgramSession('extension-dispose');
			void commandClient.close();
		}
		}
	);
}

export function deactivate() {}
