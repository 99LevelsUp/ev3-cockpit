import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { registerBatchCommands } from './commands/batchCommands';
import { registerBrowseCommands } from './commands/browseCommands';
import { registerConnectCommands } from './commands/connectCommands';
import { registerDeployCommands, DeployTargetContext } from './commands/deployCommands';
import { registerProgramControlCommands } from './commands/programControlCommands';
import { registerTransportCommands } from './commands/transportCommands';
import { readFeatureConfig } from './config/featureConfig';
import { readSchedulerConfig } from './config/schedulerConfig';
import {
	BrickConnectionProfile,
	BrickConnectionProfileStore,
	captureConnectionProfileFromWorkspace
} from './device/brickConnectionProfiles';
import { BrickControlService } from './device/brickControlService';
import { BrickRegistry, BrickRole, BrickSnapshot } from './device/brickRegistry';
import { BrickRuntimeSession, BrickSessionManager, ProgramSessionState } from './device/brickSessionManager';
import { OutputChannelLogger } from './diagnostics/logger';
import { parseEv3UriParts } from './fs/ev3Uri';
import { assertRemoteExecutablePath } from './fs/remoteExecutable';
import { Ev3FileSystemProvider } from './fs/ev3FileSystemProvider';
import { RemoteFsService } from './fs/remoteFsService';
import { Ev3CommandClient } from './protocol/ev3CommandClient';
import { CommandScheduler } from './scheduler/commandScheduler';
import { OrphanRecoveryContext, OrphanRecoveryStrategy } from './scheduler/orphanRecovery';
import {
	createProbeTransportFromWorkspace,
	TransportConfigOverrides,
	TransportMode
} from './transport/transportFactory';
import {
	BrickTreeNode,
	BrickTreeProvider,
	getBrickTreeNodeId,
	isBrickDirectoryNode,
	isBrickFileNode,
	isBrickRootNode
} from './ui/brickTreeProvider';
import { BrickTreeDragAndDropController } from './ui/brickTreeDragAndDrop';
import { BrickUiStateStore } from './ui/brickUiStateStore';
import { BrickTreeViewStateStore } from './ui/brickTreeViewStateStore';

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

function normalizeRemotePathForReveal(input: string): string {
	const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
	if (normalized === '.') {
		return '/';
	}
	return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function toSafeIdentifier(input: string): string {
	const normalized = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized.length > 0 ? normalized : 'active';
}

const RUNTIME_RECONNECT_CONFIG_KEYS = [
	'ev3-cockpit.transport.mode',
	'ev3-cockpit.transport.usb.path',
	'ev3-cockpit.transport.bluetooth.port',
	'ev3-cockpit.transport.tcp.host',
	'ev3-cockpit.transport.tcp.port',
	'ev3-cockpit.compat.profile'
] as const;

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('EV3 Cockpit');
	let logger: OutputChannelLogger;
	const brickRegistry = new BrickRegistry();
	const profileStore = new BrickConnectionProfileStore(context.workspaceState);
	const brickUiStateStore = new BrickUiStateStore(context.workspaceState);
	const brickTreeViewStateStore = new BrickTreeViewStateStore(context.workspaceState);

	const sortSnapshotsForTree = (snapshots: BrickSnapshot[]): BrickSnapshot[] => {
		const favoriteOrder = brickUiStateStore.getFavoriteOrder();
		const favoriteIndex = new Map<string, number>();
		for (let i = 0; i < favoriteOrder.length; i += 1) {
			favoriteIndex.set(favoriteOrder[i], i);
		}
		return snapshots
			.slice()
			.sort((left, right) => {
				const leftPinned = favoriteIndex.has(left.brickId);
				const rightPinned = favoriteIndex.has(right.brickId);
				if (leftPinned !== rightPinned) {
					return leftPinned ? -1 : 1;
				}
				if (leftPinned && rightPinned) {
					return (favoriteIndex.get(left.brickId) ?? 0) - (favoriteIndex.get(right.brickId) ?? 0);
				}
				if (left.isActive !== right.isActive) {
					return left.isActive ? -1 : 1;
				}
				return left.displayName.localeCompare(right.displayName);
			});
	};
	let bricksTreeFilterQuery = '';
	const updateBricksTreeFilterQuery = async (nextQuery: string): Promise<void> => {
		const normalized = nextQuery.trim();
		if (bricksTreeFilterQuery === normalized) {
			return;
		}
		bricksTreeFilterQuery = normalized;
		await vscode.commands.executeCommand(
			'setContext',
			'ev3-cockpit.bricksFilterActive',
			bricksTreeFilterQuery.length > 0
		);
		treeProvider.refresh();
	};

	const treeProvider = new BrickTreeProvider({
		dataSource: {
			listBricks: () => sortSnapshotsForTree(brickRegistry.listSnapshots()),
			getBrickSnapshot: (brickId) => brickRegistry.getSnapshot(brickId),
			resolveFsService: async (brickId) => {
				const service = brickRegistry.resolveFsService(brickId);
				if (!service) {
					throw new Error(`Brick "${brickId}" is unavailable for filesystem access.`);
				}
				return service;
			}
		},
		isFavoriteBrick: (brickId) => brickUiStateStore.isFavorite(brickId),
		getFilterQuery: () => bricksTreeFilterQuery
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

	const toTransportOverrides = (profile?: BrickConnectionProfile): TransportConfigOverrides | undefined => {
		if (!profile?.transport) {
			return undefined;
		}
		return {
			mode: profile.transport.mode,
			usbPath: profile.transport.usbPath,
			bluetoothPort: profile.transport.bluetoothPort,
			tcpHost: profile.transport.tcpHost,
			tcpPort: profile.transport.tcpPort,
			tcpUseDiscovery: profile.transport.tcpUseDiscovery,
			tcpSerialNumber: profile.transport.tcpSerialNumber
		};
	};

	const createBrickSession = (
		brickId: string,
		connectionProfile?: BrickConnectionProfile
	): BrickRuntimeSession<CommandScheduler, Ev3CommandClient> => {
		const config = readSchedulerConfig();
		const scheduler = new CommandScheduler({
			defaultTimeoutMs: config.timeoutMs,
			logger,
			defaultRetryPolicy: config.defaultRetryPolicy,
			orphanRecoveryStrategy: new LoggingOrphanRecoveryStrategy((msg, meta) => logger.info(msg, meta))
		});
		const commandClient = new Ev3CommandClient({
			scheduler,
			transport: createProbeTransportFromWorkspace(logger, config.timeoutMs, toTransportOverrides(connectionProfile)),
			logger
		});
		return {
			brickId,
			scheduler,
			commandClient
		};
	};

	const sessionManager = new BrickSessionManager<CommandScheduler, Ev3CommandClient, BrickConnectionProfile>(
		createBrickSession
	);

	const closeBrickSession = async (brickId: string): Promise<void> => {
		await sessionManager.closeSession(brickId);
	};

	const closeAllBrickSessions = async (): Promise<void> => {
		await sessionManager.closeAllSessions();
	};

	const getBrickSession = (brickId: string): BrickRuntimeSession<CommandScheduler, Ev3CommandClient> | undefined => {
		const concreteBrickId = brickId === 'active' ? brickRegistry.getActiveBrickId() : brickId;
		if (!concreteBrickId) {
			return undefined;
		}
		return sessionManager.getSession(concreteBrickId);
	};

	const prepareBrickSession = async (brickId: string, profile?: BrickConnectionProfile): Promise<Ev3CommandClient> => {
		return sessionManager.prepareSession(brickId, profile);
	};

	const isBrickSessionAvailable = (brickId: string): boolean => {
		const concreteBrickId = brickId === 'active' ? brickRegistry.getActiveBrickId() : brickId;
		if (!concreteBrickId) {
			return false;
		}
		return sessionManager.isSessionAvailable(concreteBrickId);
	};

	const rebuildRuntime = () => {
		const config = readSchedulerConfig();
		const featureConfig = readFeatureConfig();
		logger = new OutputChannelLogger((line) => output.appendLine(line), config.logLevel);
		void closeAllBrickSessions();
		brickRegistry.markAllUnavailable('Runtime reinitialized.');
		sessionManager.clearProgramSession();
		treeProvider.refreshThrottled();

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

	const resolveConnectedBrickDescriptor = (rootPath: string, profile?: BrickConnectionProfile): ConnectedBrickDescriptor => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const transport = profile?.transport.mode ?? resolveCurrentTransportMode();
		const normalizedRootPath = normalizeBrickRootPath(profile?.rootPath ?? rootPath);
		const role: BrickRole = 'standalone';

		if (transport === 'tcp') {
			const hostRaw = profile?.transport.tcpHost ?? cfg.get('transport.tcp.host');
			const host = typeof hostRaw === 'string' && hostRaw.trim().length > 0 ? hostRaw.trim() : 'active';
			const portRaw = profile?.transport.tcpPort ?? cfg.get('transport.tcp.port');
			const port = typeof portRaw === 'number' && Number.isFinite(portRaw) ? Math.max(1, Math.floor(portRaw)) : 5555;
			const endpoint = `${host}:${port}`;
			return {
				brickId: `tcp-${toSafeIdentifier(endpoint)}`,
				displayName: `EV3 TCP (${endpoint})`,
				role,
				transport,
				rootPath: normalizedRootPath
			};
		}

		if (transport === 'bluetooth') {
			const portRaw = profile?.transport.bluetoothPort ?? cfg.get('transport.bluetooth.port');
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
			const pathRaw = profile?.transport.usbPath ?? cfg.get('transport.usb.path');
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

	const resolveConcreteBrickId = (brickId: string): string =>
		brickId === 'active' ? brickRegistry.getActiveBrickId() ?? 'active' : brickId;

	const noteBrickOperation = (brickId: string, operation: string): void => {
		const concreteBrickId = resolveConcreteBrickId(brickId);
		const updated = brickRegistry.noteOperation(concreteBrickId, operation);
		if (updated) {
			treeProvider.refreshBrick(concreteBrickId);
		}
	};

	const markProgramStarted = (
		remotePath: string,
		source: ProgramSessionState['source'],
		brickId: string
	): void => {
		const concreteBrickId = resolveConcreteBrickId(brickId);
		const session = sessionManager.markProgramStarted(concreteBrickId, remotePath, source, resolveCurrentTransportMode());
		logger.info('Program session updated', {
			brickId: concreteBrickId,
			...session
		});
	};

	const clearProgramSession = (reason: string, brickId?: string): void => {
		if (!brickId) {
			const removed = sessionManager.clearProgramSession();
			if (!removed) {
				return;
			}
			logger.info('Program sessions cleared', { reason, scope: 'all' });
			return;
		}

		const concreteBrickId = resolveConcreteBrickId(brickId);
		const removed = sessionManager.clearProgramSession(concreteBrickId);
		if (!removed) {
			return;
		}
		logger.info('Program session cleared', {
			reason,
			brickId: concreteBrickId,
			lastRunProgramPath: removed.removedPath,
			activeProgramSession: removed.removedSession
		});
	};

	const getLastRunProgramPathForBrick = (brickId: string): string | undefined => {
		const concreteBrickId = resolveConcreteBrickId(brickId);
		return sessionManager.getLastRunProgramPath(concreteBrickId);
	};

	const getRestartCandidatePathForBrick = (brickId: string): string | undefined => {
		const concreteBrickId = resolveConcreteBrickId(brickId);
		return sessionManager.getRestartCandidatePath(concreteBrickId);
	};

	const resolveDefaultRunDirectory = (brickId: string): string => {
		const concreteBrickId = resolveConcreteBrickId(brickId);
		const snapshot = brickRegistry.getSnapshot(concreteBrickId);
		if (snapshot?.rootPath) {
			return snapshot.rootPath;
		}
		const defaultRoot = readFeatureConfig().fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/';
		return normalizeBrickRootPath(defaultRoot);
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

	const resolveControlAccessContext = (
		arg: unknown
	): { brickId: string; authority: string; controlService: BrickControlService } | { error: string } => {
		const requestedBrickId = resolveBrickIdFromCommandArg(arg);
		const authority = requestedBrickId === 'active' ? 'active' : requestedBrickId;
		const controlService = brickRegistry.resolveControlService(requestedBrickId);
		if (!controlService) {
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
			controlService
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
		getLogger: () => logger,
		getBrickRegistry: () => brickRegistry,
		getTreeProvider: () => treeProvider,
		clearProgramSession,
		resolveBrickIdFromCommandArg,
		resolveProbeTimeoutMs,
		resolveConnectedBrickDescriptor,
		prepareBrickSession,
		closeBrickSession,
		isBrickSessionAvailable,
		getConnectionProfile: (brickId) => profileStore.get(brickId),
		captureConnectionProfile: (brickId, displayName, rootPath, existingProfile) => {
			if (existingProfile) {
				return {
					...existingProfile,
					brickId,
					displayName,
					rootPath,
					savedAtIso: new Date().toISOString()
				};
			}
			return captureConnectionProfileFromWorkspace(brickId, displayName, rootPath);
		},
		rememberConnectionProfile: async (profile) => {
			await profileStore.upsert(profile);
		},
		onBrickOperation: noteBrickOperation
	});

	const deployRegistrations = registerDeployCommands({
		getLogger: () => logger,
		resolveCommandClient: (brickId) => getBrickSession(brickId)?.commandClient,
		resolveDeployTargetFromArg,
		resolveFsAccessContext,
		markProgramStarted,
		onBrickOperation: noteBrickOperation
	});

	const { runRemoteProgram, stopProgram, restartProgram, emergencyStop } = registerProgramControlCommands({
		resolveFsAccessContext,
		resolveControlAccessContext,
		getLastRunProgramPath: getLastRunProgramPathForBrick,
		getRestartCandidatePath: getRestartCandidatePathForBrick,
		resolveDefaultRunDirectory,
		getLogger: () => logger,
		normalizeRunExecutablePath,
		onProgramStarted: markProgramStarted,
		onProgramCleared: clearProgramSession,
		onBrickOperation: noteBrickOperation
	});

	const { inspectTransports, transportHealthReport } = registerTransportCommands({
		getLogger: () => logger,
		resolveProbeTimeoutMs
	});

	const inspectBrickSessions = vscode.commands.registerCommand('ev3-cockpit.inspectBrickSessions', async () => {
		const brickSnapshots = brickRegistry.listSnapshots();
		const runtimeSnapshots = sessionManager.listRuntimeSnapshots();
		const programSnapshots = sessionManager.listProgramSnapshots();
		const busySessions = runtimeSnapshots.filter((entry) => entry.busyCommandCount > 0).length;
		const report = {
			generatedAtIso: new Date().toISOString(),
			activeBrickId: brickRegistry.getActiveBrickId(),
			bricks: brickSnapshots,
			runtimeSessions: runtimeSnapshots,
			programSessions: programSnapshots
		};

		logger.info('Brick session diagnostics report', {
			...report
		});
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const reportDirectory = path.join(workspaceRoot, 'artifacts', 'diagnostics');
		const reportPath = path.join(reportDirectory, 'brick-sessions-report.json');
		try {
			await fs.mkdir(reportDirectory, { recursive: true });
			await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
		} catch (error) {
			logger.warn('Failed to export brick session diagnostics report to JSON.', {
				reportPath,
				error: error instanceof Error ? error.message : String(error)
			});
		}
		vscode.window.showInformationMessage(
			`Brick session diagnostics: bricks=${brickSnapshots.length}, runtime=${runtimeSnapshots.length}, busy=${busySessions}. JSON: ${reportPath}`
		);
	});

	const browseRegistrations = registerBrowseCommands({
		getLogger: () => logger,
		getBrickRegistry: () => brickRegistry,
		getTreeProvider: () => treeProvider,
		resolveFsAccessContext,
		resolveBrickIdFromCommandArg,
		markProgramStarted,
		onBrickOperation: noteBrickOperation
	});
	const batchRegistrations = registerBatchCommands({
		getLogger: () => logger,
		getBrickRegistry: () => brickRegistry
	});
	const toggleFavoriteBrick = vscode.commands.registerCommand('ev3-cockpit.toggleFavoriteBrick', async (arg?: unknown) => {
		const requestedBrickId = resolveBrickIdFromCommandArg(arg);
		const brickId = resolveConcreteBrickId(requestedBrickId);
		const snapshot = brickRegistry.getSnapshot(brickId);
		if (!snapshot) {
			vscode.window.showErrorMessage(`Brick "${requestedBrickId}" is not available in tree.`);
			return;
		}
		const pinned = await brickUiStateStore.toggleFavorite(snapshot.brickId);
		treeProvider.refresh();
		vscode.window.showInformationMessage(
			pinned
				? `Brick pinned: ${snapshot.displayName}`
				: `Brick unpinned: ${snapshot.displayName}`
		);
	});
	const setBricksTreeFilter = vscode.commands.registerCommand('ev3-cockpit.setBricksTreeFilter', async (arg?: unknown) => {
		const query =
			typeof arg === 'string'
				? arg
				: await vscode.window.showInputBox({
					prompt: 'Filter bricks tree by brick name or remote path',
					value: bricksTreeFilterQuery,
					placeHolder: 'Example: EV3 TCP, /docs/, main.rbf'
				});
		if (query === undefined) {
			return;
		}
		await updateBricksTreeFilterQuery(query);
		if (query.trim().length === 0) {
			vscode.window.showInformationMessage('Bricks tree filter cleared.');
		} else {
			vscode.window.showInformationMessage(`Bricks tree filter: "${query.trim()}"`);
		}
	});
	const clearBricksTreeFilter = vscode.commands.registerCommand('ev3-cockpit.clearBricksTreeFilter', async () => {
		await updateBricksTreeFilterQuery('');
		vscode.window.showInformationMessage('Bricks tree filter cleared.');
	});
	const retryDirectoryFromTree = vscode.commands.registerCommand('ev3-cockpit.retryDirectoryFromTree', async (arg?: unknown) => {
		const directoryArg = (input: unknown): { brickId: string; remotePath: string } | undefined => {
			if (isBrickDirectoryNode(input)) {
				return {
					brickId: input.brickId,
					remotePath: input.remotePath
				};
			}
			if (isBrickRootNode(input)) {
				return {
					brickId: input.brickId,
					remotePath: input.rootPath
				};
			}
			if (!input || typeof input !== 'object') {
				return undefined;
			}
			const candidate = input as {
				brickId?: unknown;
				remotePath?: unknown;
			};
			if (typeof candidate.brickId !== 'string' || typeof candidate.remotePath !== 'string') {
				return undefined;
			}
			return {
				brickId: candidate.brickId,
				remotePath: candidate.remotePath
			};
		};
		const target = directoryArg(arg);
		if (!target) {
			vscode.window.showErrorMessage('Retry directory listing requires a directory node argument.');
			return;
		}
		treeProvider.refreshDirectory(target.brickId, target.remotePath);
	});

	// --- Config watcher, FS provider, tree view ---

	let reconnectPromptInFlight = false;
	const affectsRuntimeReconnectConfig = (event: vscode.ConfigurationChangeEvent): boolean => {
		return RUNTIME_RECONNECT_CONFIG_KEYS.some((section) => event.affectsConfiguration(section));
	};
	const offerReconnectAfterConfigChange = async (): Promise<void> => {
		if (reconnectPromptInFlight) {
			return;
		}

		const connectedBrickIds = brickRegistry
			.listSnapshots()
			.filter((snapshot) => snapshot.status === 'READY' && sessionManager.isSessionAvailable(snapshot.brickId))
			.map((snapshot) => snapshot.brickId);
		if (connectedBrickIds.length === 0) {
			return;
		}

		reconnectPromptInFlight = true;
		try {
			const choice = await vscode.window.showInformationMessage(
				`Connection settings changed. Reconnect ${connectedBrickIds.length} brick(s) now to apply them?`,
				'Reconnect all',
				'Later'
			);
			if (choice !== 'Reconnect all') {
				logger.info('Reconnect prompt after configuration change was deferred by user.', {
					brickIds: connectedBrickIds
				});
				return;
			}

			logger.info('Reconnect all requested after configuration change.', {
				brickIds: connectedBrickIds
			});
			for (const brickId of connectedBrickIds) {
				try {
					const snapshot = brickRegistry.getSnapshot(brickId);
					if (snapshot) {
						const updatedProfile = captureConnectionProfileFromWorkspace(
							brickId,
							snapshot.displayName,
							snapshot.rootPath
						);
						await profileStore.upsert(updatedProfile);
					}
					await vscode.commands.executeCommand('ev3-cockpit.reconnectEV3', brickId);
				} catch (error) {
					logger.warn('Reconnect after configuration change failed.', {
						brickId,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
		} finally {
			reconnectPromptInFlight = false;
		}
	};

	const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
		void (async () => {
			if (event.affectsConfiguration('ev3-cockpit.fs.mode') || event.affectsConfiguration('ev3-cockpit.fs.fullMode.confirmationRequired')) {
				const confirmed = await ensureFullFsModeConfirmation();
				if (!confirmed) {
					return;
				}
			}

			if (event.affectsConfiguration('ev3-cockpit')) {
				logger.info('EV3 Cockpit configuration changed. Existing brick sessions stay online; new connections use updated settings.');
				if (affectsRuntimeReconnectConfig(event)) {
					await offerReconnectAfterConfigChange();
				}
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
		refreshTree: (brickId, remotePath) => treeProvider.refreshDirectory(brickId, remotePath),
		logger: logger!
	});

	const brickTreeView = vscode.window.createTreeView('ev3-cockpit.bricksView', {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
		dragAndDropController: brickTreeDragAndDrop
	});
	const revealInBricksTree = vscode.commands.registerCommand('ev3-cockpit.revealInBricksTree', async (arg?: unknown) => {
		const resolveUriFromArg = (): vscode.Uri | undefined => {
			if (arg instanceof vscode.Uri) {
				return arg;
			}
			if (typeof arg === 'string') {
				try {
					return vscode.Uri.parse(arg);
				} catch {
					return undefined;
				}
			}
			if (arg && typeof arg === 'object' && 'uri' in (arg as Record<string, unknown>)) {
				const candidate = (arg as { uri?: unknown }).uri;
				if (candidate instanceof vscode.Uri) {
					return candidate;
				}
				if (typeof candidate === 'string') {
					try {
						return vscode.Uri.parse(candidate);
					} catch {
						return undefined;
					}
				}
			}
			return vscode.window.activeTextEditor?.document.uri;
		};

		const targetUri = resolveUriFromArg();
		if (!targetUri || targetUri.scheme !== 'ev3') {
			vscode.window.showErrorMessage('Reveal in Bricks Tree requires an ev3:// URI.');
			return;
		}

		let parsed: ReturnType<typeof parseEv3UriParts>;
		try {
			parsed = parseEv3UriParts(targetUri.authority, targetUri.path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Cannot parse EV3 URI: ${message}`);
			return;
		}

		const resolvedBrickId = parsed.brickId === 'active' ? brickRegistry.getActiveBrickId() : parsed.brickId;
		if (!resolvedBrickId) {
			vscode.window.showErrorMessage('No active brick is available for ev3://active URI.');
			return;
		}

		await treeProvider.getChildren();
		const rootNodeId = `brick:${resolvedBrickId}`;
		const rootNode = treeProvider.getNodeById(rootNodeId);
		if (!rootNode || rootNode.kind !== 'brick') {
			vscode.window.showErrorMessage(`Brick "${resolvedBrickId}" is not present in Bricks Tree.`);
			return;
		}

		const rootPath = normalizeRemotePathForReveal(rootNode.rootPath);
		const targetPath = normalizeRemotePathForReveal(parsed.remotePath);
		if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath === '/' ? '/' : `${rootPath}/`}`)) {
			vscode.window.showWarningMessage(`Path "${targetPath}" is outside root "${rootPath}" for this brick.`);
			return;
		}

		let currentNode: BrickTreeNode = rootNode;
		let currentPath = rootPath;
		const relativePath =
			targetPath === rootPath
				? ''
				: targetPath.slice(rootPath === '/' ? 1 : rootPath.length + 1);
		const segments = relativePath.length > 0 ? relativePath.split('/').filter((segment) => segment.length > 0) : [];
		try {
			await brickTreeView.reveal(rootNode, {
				expand: true,
				focus: false,
				select: segments.length === 0
			});
		} catch {
			// reveal fallback below handles unavailable target
		}

		for (let index = 0; index < segments.length; index += 1) {
			const segment = segments[index];
			const nextPath = path.posix.join(currentPath, segment);
			const children = await treeProvider.getChildren(currentNode);
			const isLast = index === segments.length - 1;
			const nextDirectory = children.find(
				(node): node is Extract<BrickTreeNode, { kind: 'directory' }> =>
					node.kind === 'directory' && normalizeRemotePathForReveal(node.remotePath) === nextPath
			);
			if (nextDirectory) {
				currentNode = nextDirectory;
				currentPath = nextPath;
				if (!isLast) {
					await brickTreeView.reveal(currentNode, {
						expand: true,
						focus: false,
						select: false
					});
				}
				continue;
			}

			if (isLast) {
				const targetFile = children.find(
					(node): node is Extract<BrickTreeNode, { kind: 'file' }> =>
						node.kind === 'file' && normalizeRemotePathForReveal(node.remotePath) === nextPath
				);
				if (targetFile) {
					currentNode = targetFile;
					currentPath = nextPath;
					continue;
				}
			}

			vscode.window.showWarningMessage(`Cannot reveal "${targetPath}" in Bricks Tree (missing path segment "${segment}").`);
			return;
		}

		try {
			await brickTreeView.reveal(currentNode, {
				expand: currentNode.kind === 'directory',
				focus: true,
				select: true
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showWarningMessage(`Reveal in Bricks Tree failed: ${message}`);
		}
	});
	void vscode.commands.executeCommand('setContext', 'ev3-cockpit.bricksFilterActive', false);
	const busyStateByBrickId = new Map<string, string>();
	const refreshBusyIndicators = (): void => {
		const snapshots = brickRegistry.listSnapshots();
		const knownBrickIds = new Set<string>();
		for (const snapshot of snapshots) {
			knownBrickIds.add(snapshot.brickId);
			const runtime = sessionManager.getRuntimeSnapshot(snapshot.brickId);
			const busyCount = runtime?.busyCommandCount ?? 0;
			const schedulerState = runtime?.schedulerState;
			const nextSignature = `${busyCount}|${schedulerState ?? 'none'}`;
			if (busyStateByBrickId.get(snapshot.brickId) === nextSignature) {
				continue;
			}
			busyStateByBrickId.set(snapshot.brickId, nextSignature);
			brickRegistry.updateRuntimeMetrics(snapshot.brickId, {
				busyCommandCount: busyCount,
				schedulerState
			});
			treeProvider.refreshBrick(snapshot.brickId);
		}

		for (const brickId of [...busyStateByBrickId.keys()]) {
			if (!knownBrickIds.has(brickId)) {
				busyStateByBrickId.delete(brickId);
			}
		}
		void brickUiStateStore.pruneMissing(knownBrickIds);
	};
	const busyIndicatorInterval = setInterval(() => {
		refreshBusyIndicators();
	}, 250);
	const busyIndicatorSubscription = new vscode.Disposable(() => {
		clearInterval(busyIndicatorInterval);
	});

	const expandedNodeIds = new Set<string>(brickTreeViewStateStore.getExpandedNodeIds());
	let pendingSelectionRestoreNodeId = brickTreeViewStateStore.getSelectedNodeId();
	let selectedNodeId = pendingSelectionRestoreNodeId;
	let persistTreeStateTimer: NodeJS.Timeout | undefined;
	const persistTreeViewState = async (): Promise<void> => {
		await brickTreeViewStateStore.update(expandedNodeIds, selectedNodeId);
	};
	const schedulePersistTreeViewState = (): void => {
		if (persistTreeStateTimer) {
			clearTimeout(persistTreeStateTimer);
		}
		persistTreeStateTimer = setTimeout(() => {
			persistTreeStateTimer = undefined;
			void persistTreeViewState();
		}, 120);
	};
	const rememberExpandedState = (element: BrickTreeNode, expanded: boolean): void => {
		if (element.kind !== 'brick' && element.kind !== 'directory') {
			return;
		}
		const nodeId = getBrickTreeNodeId(element);
		if (expanded) {
			expandedNodeIds.add(nodeId);
		} else {
			expandedNodeIds.delete(nodeId);
		}
		schedulePersistTreeViewState();
	};
	const rememberSelectionState = (selection: readonly BrickTreeNode[]): void => {
		const element = selection[0];
		if (!element || element.kind === 'message') {
			return;
		}
		selectedNodeId = getBrickTreeNodeId(element);
		schedulePersistTreeViewState();
	};
	const restoreTreeViewState = async (): Promise<void> => {
		if (expandedNodeIds.size === 0 && !pendingSelectionRestoreNodeId) {
			return;
		}
		const sortedNodeIds = [...expandedNodeIds].sort((left, right) => left.localeCompare(right));
		for (let pass = 0; pass < 3; pass += 1) {
			let revealedAny = false;
			for (const nodeId of sortedNodeIds) {
				const node = treeProvider.getNodeById(nodeId);
				if (!node) {
					continue;
				}
				try {
					await brickTreeView.reveal(node, {
						expand: true,
						focus: false,
						select: false
					});
					revealedAny = true;
				} catch {
					// ignore reveal failures for stale node ids
				}
			}
			if (!revealedAny) {
				break;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		if (!pendingSelectionRestoreNodeId) {
			return;
		}
		const selectedNode = treeProvider.getNodeById(pendingSelectionRestoreNodeId);
		if (!selectedNode || selectedNode.kind === 'message') {
			pendingSelectionRestoreNodeId = undefined;
			selectedNodeId = undefined;
			schedulePersistTreeViewState();
			return;
		}
		try {
			await brickTreeView.reveal(selectedNode, {
				focus: false,
				select: true,
				expand: true
			});
			pendingSelectionRestoreNodeId = undefined;
		} catch {
			// Selection restore can race with async tree updates. Keep retrying on next tree refresh.
		}
	};
	const treeExpandSubscription = brickTreeView.onDidExpandElement((event) => {
		rememberExpandedState(event.element, true);
	});
	const treeCollapseSubscription = brickTreeView.onDidCollapseElement((event) => {
		rememberExpandedState(event.element, false);
	});
	const treeSelectionSubscription = brickTreeView.onDidChangeSelection((event) => {
		rememberSelectionState(event.selection);
	});
	const treeChangeSubscription = treeProvider.onDidChangeTreeData(() => {
		void restoreTreeViewState();
	});
	const treeStatePersistenceSubscription = new vscode.Disposable(() => {
		if (persistTreeStateTimer) {
			clearTimeout(persistTreeStateTimer);
			persistTreeStateTimer = undefined;
		}
		void persistTreeViewState();
	});
	const fsChangeSubscription = fsProvider.onDidChangeFile((events) => {
		const refreshTargets = new Set<string>();
		for (const event of events) {
			if (event.uri.scheme !== 'ev3') {
				continue;
			}
			try {
				const parsed = parseEv3UriParts(event.uri.authority, event.uri.path);
				const targetBrickId = parsed.brickId === 'active' ? brickRegistry.getActiveBrickId() ?? 'active' : parsed.brickId;
				const parentPath = path.posix.dirname(parsed.remotePath);
				refreshTargets.add(`${targetBrickId}|${parentPath}`);
			} catch {
				// ignore malformed URI events
			}
		}
		for (const target of refreshTargets) {
			const [brickId, remotePath] = target.split('|', 2);
			treeProvider.refreshDirectory(brickId, remotePath);
		}
	});
	refreshBusyIndicators();
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
		inspectBrickSessions,
		revealInBricksTree,
		browseRegistrations.browseRemoteFs,
		browseRegistrations.refreshBricksView,
		browseRegistrations.uploadToBrickFolder,
		browseRegistrations.deleteRemoteEntryFromTree,
		browseRegistrations.runRemoteExecutableFromTree,
		batchRegistrations.reconnectReadyBricks,
		batchRegistrations.deployWorkspaceToReadyBricks,
		toggleFavoriteBrick,
		setBricksTreeFilter,
		clearBricksTreeFilter,
		retryDirectoryFromTree,
		configWatcher,
		fsDisposable,
		brickTreeView,
		treeExpandSubscription,
		treeCollapseSubscription,
		treeSelectionSubscription,
		treeChangeSubscription,
		treeStatePersistenceSubscription,
		fsChangeSubscription,
		busyIndicatorSubscription,
		treeProvider,
		output,
		{
		dispose: () => {
			brickRegistry.markAllUnavailable('Extension disposed.');
			treeProvider.dispose();
			clearProgramSession('extension-dispose');
			void closeAllBrickSessions();
		}
		}
	);
}

export function deactivate() {}
