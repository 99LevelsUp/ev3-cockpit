import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { registerBatchCommands } from './commands/batchCommands';
import { registerBrowseCommands } from './commands/browseCommands';
import { toErrorMessage } from './commands/commandUtils';
import { registerConnectCommands } from './commands/connectCommands';
import { registerDeployCommands } from './commands/deployCommands';
import { registerProgramControlCommands } from './commands/programControlCommands';
import { registerTransportCommands } from './commands/transportCommands';
import { readFeatureConfig } from './config/featureConfig';
import { readSchedulerConfig } from './config/schedulerConfig';
import {
	BrickConnectionProfile,
	BrickConnectionProfileStore,
	captureConnectionProfileFromWorkspace
} from './device/brickConnectionProfiles';
import { BrickRegistry, BrickSnapshot } from './device/brickRegistry';
import { BrickRuntimeSession, BrickSessionManager, ProgramSessionState } from './device/brickSessionManager';
import { OutputChannelLogger } from './diagnostics/logger';
import { parseEv3UriParts } from './fs/ev3Uri';
import { Ev3FileSystemProvider } from './fs/ev3FileSystemProvider';
import { Ev3CommandClient } from './protocol/ev3CommandClient';
import { CommandScheduler } from './scheduler/commandScheduler';
import {
	createProbeTransportFromWorkspace,
	TransportConfigOverrides
} from './transport/transportFactory';
import {
	BrickTreeNode,
	BrickTreeProvider,
	isBrickDirectoryNode,
	isBrickRootNode
} from './ui/brickTreeProvider';
import { BrickTreeDragAndDropController } from './ui/brickTreeDragAndDrop';
import { BrickUiStateStore } from './ui/brickUiStateStore';
import { BrickTreeViewStateStore } from './ui/brickTreeViewStateStore';
import { createBusyIndicatorPoller } from './ui/busyIndicator';
import { createTreeStatePersistence } from './ui/treeStatePersistence';
import { LoggingOrphanRecoveryStrategy, normalizeRemotePathForReveal } from './activation/helpers';
import { createConfigWatcher } from './activation/configWatcher';
import { createBrickResolvers } from './activation/brickResolvers';

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

	const resolvers = createBrickResolvers({ brickRegistry, getLogger: () => logger });
	const {
		resolveProbeTimeoutMs,
		resolveCurrentTransportMode,
		resolveConnectedBrickDescriptor,
		resolveConcreteBrickId,
		resolveBrickIdFromCommandArg,
		resolveFsAccessContext,
		resolveControlAccessContext,
		resolveDeployTargetFromArg,
		normalizeRunExecutablePath,
		resolveDefaultRunDirectory,
		ensureFullFsModeConfirmation
	} = resolvers;

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
				error: toErrorMessage(error)
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

	const configWatcher = createConfigWatcher({
		getLogger: () => logger,
		brickRegistry,
		sessionManager,
		profileStore,
		ensureFullFsModeConfirmation
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
			const message = toErrorMessage(error);
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
			const message = toErrorMessage(error);
			vscode.window.showWarningMessage(`Reveal in Bricks Tree failed: ${message}`);
		}
	});
	void vscode.commands.executeCommand('setContext', 'ev3-cockpit.bricksFilterActive', false);
	const busyIndicatorSubscription = createBusyIndicatorPoller(
		brickRegistry, sessionManager, treeProvider, brickUiStateStore
	);

	const treeStatePersistence = createTreeStatePersistence(
		brickTreeViewStateStore, treeProvider, brickTreeView
	);

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
		treeStatePersistence.expandSubscription,
		treeStatePersistence.collapseSubscription,
		treeStatePersistence.selectionSubscription,
		treeStatePersistence.changeSubscription,
		treeStatePersistence,
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
