import * as vscode from 'vscode';
import { registerMockCommands } from './commands/mockCommands';
import { registerBatchCommands } from './commands/batchCommands';
import { registerBrowseCommands } from './commands/browseCommands';
import { registerConnectCommands } from './commands/connectCommands';
import { registerDeployCommands } from './commands/deployCommands';
import { registerProgramControlCommands } from './commands/programControlCommands';
import { registerTransportCommands } from './commands/transportCommands';
import { readFeatureConfig } from './config/featureConfig';
import { readBrickPanelDiscoveryConfig } from './config/brickPanelDiscoveryConfig';
import { readSchedulerConfig } from './config/schedulerConfig';
import {
	BrickConnectionProfile,
	BrickConnectionProfileStore,
	captureConnectionProfileFromWorkspace
} from './device/brickConnectionProfiles';
import { BrickRegistry, BrickSnapshot } from './device/brickRegistry';
import { BrickSettingsService } from './device/brickSettingsService';
import { BrickRuntimeSession, BrickSessionManager, ProgramSessionState } from './device/brickSessionManager';
import { applyDisplayNameAcrossProfiles } from './device/brickNameResolver';
import { isUsbReconnectCandidateAvailable } from './device/brickReconnect';
import { Logger, OutputChannelLogger } from './diagnostics/logger';
import { nextCorrelationId, startEventLoopMonitor, withTimingSync } from './diagnostics/perfTiming';
import { Ev3FileSystemProvider, FsAvailabilityError } from './fs/ev3FileSystemProvider';
import { Ev3CommandClient } from './protocol/ev3CommandClient';
import { CommandScheduler } from './scheduler/commandScheduler';
import {
	createProbeTransportFromWorkspace,
	TransportConfigOverrides
} from './transport/transportFactory';
import {
	listSerialCandidates,
	listTcpDiscoveryCandidates,
	listUsbHidCandidates
} from './transport/discovery';
import {
	BrickTreeProvider
} from './ui/brickTreeProvider';
import { BrickTreeDragAndDropController } from './ui/brickTreeDragAndDrop';
import { BrickUiStateStore } from './ui/brickUiStateStore';
import { BrickTreeViewStateStore } from './ui/brickTreeViewStateStore';
import { createBusyIndicatorPoller } from './ui/busyIndicator';
import { createConnectionHealthPoller } from './ui/connectionHealthPoller';
import { createTreeStatePersistence } from './ui/treeStatePersistence';
import { LoggingOrphanRecoveryStrategy, normalizeBrickRootPath, toSafeIdentifier } from './activation/helpers';
import { createConfigWatcher } from './activation/configWatcher';
import { createBrickResolvers } from './activation/brickResolvers';
import { BrickPanelDiscoveryCandidate, BrickPanelProvider } from './ui/brickPanelProvider';
import {
	BrickDiscoveryService,
	DiscoveryConfig
} from './device/brickDiscoveryService';
import {
	createTreeFilterState,
	registerInspectBrickSessions,
	registerToggleFavoriteBrick,
	registerSetBricksTreeFilter,
	registerClearBricksTreeFilter,
	registerRetryDirectoryFromTree,
	registerRevealInBricksTree,
	registerFsChangeSubscription
} from './activation/extensionCommands';

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('EV3 Cockpit');
	let logger: OutputChannelLogger;
	const perfLogger: Logger = {
		error: (message, meta) => logger?.error(message, meta),
		warn: (message, meta) => logger?.warn(message, meta),
		info: (message, meta) => logger?.info(message, meta),
		debug: (message, meta) => logger?.debug(message, meta),
		trace: (message, meta) => logger?.trace(message, meta)
	};
	const brickRegistry = new BrickRegistry();
	const profileStore = new BrickConnectionProfileStore(context.workspaceState);
	const discoveryService = new BrickDiscoveryService({
		brickRegistry,
		profileStore,
		scanners: {
			listUsbHidCandidates,
			listSerialCandidates,
			listTcpDiscoveryCandidates
		},
		logger: perfLogger,
		toSafeIdentifier
	});
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
	const filterState = createTreeFilterState(() => () => treeProvider.refresh());

	const treeProvider = new BrickTreeProvider({
		dataSource: {
			listBricks: () => sortSnapshotsForTree(
				brickRegistry.listSnapshots().filter((s) => s.status === 'READY')
			),
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
		getFilterQuery: () => filterState.getQuery()
	});

	const fsProvider = new Ev3FileSystemProvider(async (brickId) => {
		const resolved = brickRegistry.resolveFsService(brickId);
		if (resolved) {
			return resolved;
		}

		if (brickId === 'active') {
			throw new FsAvailabilityError(
				'NO_ACTIVE_BRICK',
				'No active EV3 connection for filesystem access. Run "EV3 Cockpit: Connect to EV3 Brick".'
			);
		}

		const snapshot = brickRegistry.getSnapshot(brickId);
		if (snapshot) {
			throw new FsAvailabilityError(
				'BRICK_UNAVAILABLE',
				`Brick "${brickId}" is currently ${snapshot.status.toLowerCase()}.`
			);
		}

		throw new FsAvailabilityError(
			'BRICK_NOT_REGISTERED',
			`Brick "${brickId}" is not registered. Connect it first or use ev3://active/...`
		);
	});

	const toTransportOverrides = (profile?: BrickConnectionProfile): TransportConfigOverrides | undefined => {
		if (!profile?.transport) {
			return undefined;
		}
		return {
			mode: profile.transport.mode,
			usbPath: profile.transport.usbPath,
			btPort: profile.transport.btPort,
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
		const correlationId = nextCorrelationId();
		withTimingSync(
			perfLogger,
			'activate.rebuild-runtime',
			() => {
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
			},
			{
				correlationId
			}
		);
	};

	rebuildRuntime();
	const eventLoopMonitor = startEventLoopMonitor(perfLogger);

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

	const readDiscoveryConfig = (): DiscoveryConfig => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const showMockBricks = cfg.get<boolean>('ui.discovery.showMockBricks', false) === true;
		const discoveryPortRaw = cfg.get('transport.tcp.discoveryPort');
		const discoveryPort =
			typeof discoveryPortRaw === 'number' && Number.isFinite(discoveryPortRaw)
				? Math.max(1, Math.floor(discoveryPortRaw))
				: 3015;
		const discoveryTimeoutRaw = cfg.get('transport.tcp.discoveryTimeoutMs');
		const discoveryTimeoutMs =
			typeof discoveryTimeoutRaw === 'number' && Number.isFinite(discoveryTimeoutRaw)
				? Math.max(500, Math.min(3_000, Math.floor(discoveryTimeoutRaw)))
				: 1_500;
		const preferredBluetoothPortRaw = cfg.get('transport.bluetooth.port');
		const preferredBluetoothPort =
			typeof preferredBluetoothPortRaw === 'string' && preferredBluetoothPortRaw.trim().length > 0
				? preferredBluetoothPortRaw.trim().toUpperCase()
				: undefined;
		const defaultRootPath = normalizeBrickRootPath(readFeatureConfig().fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/');
		return { showMockBricks, tcpDiscoveryPort: discoveryPort, tcpDiscoveryTimeoutMs: discoveryTimeoutMs, preferredBluetoothPort, defaultRootPath };
	};

	const nameDeps = { brickRegistry, profileStore, discoveryService };
	const usbReconnectDeps = { brickRegistry, profileStore, listUsbHidCandidates };

	const discoverBricksForPanel = async (): Promise<BrickPanelDiscoveryCandidate[]> => {
		return discoveryService.scan(readDiscoveryConfig());
	};

	const connectDiscoveredBrickFromPanel = async (candidateId: string): Promise<void> => {
		return discoveryService.connectDiscoveredBrick(
			candidateId,
			profileStore,
			(brickId) => vscode.commands.executeCommand('ev3-cockpit.connectEV3', brickId) as Promise<void>
		);
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

	const inspectBrickSessions = registerInspectBrickSessions({
		getLogger: () => logger,
		brickRegistry,
		sessionManager
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
	const toggleFavoriteBrick = registerToggleFavoriteBrick({
		resolveBrickIdFromCommandArg,
		resolveConcreteBrickId,
		brickRegistry,
		brickUiStateStore,
		treeProvider
	});
	const setBricksTreeFilter = registerSetBricksTreeFilter({ filterState });
	const clearBricksTreeFilter = registerClearBricksTreeFilter(filterState);
	const retryDirectoryFromTree = registerRetryDirectoryFromTree(treeProvider);
	const mockRegistrations = registerMockCommands();

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

	const brickTreeView = vscode.window.createTreeView('ev3-cockpit.fileSystem', {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
		dragAndDropController: brickTreeDragAndDrop
	});
	const revealInBricksTree = registerRevealInBricksTree({
		brickRegistry,
		treeProvider,
		brickTreeView
	});
	void vscode.commands.executeCommand('setContext', 'ev3-cockpit.bricksFilterActive', false);
	const busyIndicatorSubscription = createBusyIndicatorPoller(
		brickRegistry, sessionManager, treeProvider, brickUiStateStore
	);
	const brickPanelConfig = readBrickPanelDiscoveryConfig(context.extensionPath, perfLogger);

	const treeStatePersistence = createTreeStatePersistence(
		brickTreeViewStateStore, treeProvider, brickTreeView
	);

	const fsChangeSubscription = registerFsChangeSubscription({
		fsProvider,
		brickRegistry,
		treeProvider
	});
	treeProvider.refresh();

	const brickPanelProvider = new BrickPanelProvider(context.extensionUri, {
		listBricks: () =>
			sortSnapshotsForTree(
				brickRegistry
					.listSnapshots()
					.filter((snapshot) =>
						snapshot.status === 'READY'
						|| snapshot.status === 'CONNECTING'
						|| (
							snapshot.status === 'UNAVAILABLE'
							&& snapshot.lastError !== 'Disconnected by user.'
						)
					)
			),
		setActiveBrick: (brickId) => brickRegistry.setActiveBrick(brickId),
		scanAvailableBricks: discoverBricksForPanel,
		connectScannedBrick: connectDiscoveredBrickFromPanel,
		disconnectBrick: async (brickId: string) => {
			await vscode.commands.executeCommand('ev3-cockpit.disconnectEV3', brickId);
		},
		setMockConnection: async (candidateId: string, connected: boolean) => {
			const normalizedCandidateId = candidateId.trim();
			if (!normalizedCandidateId || !normalizedCandidateId.startsWith('mock-')) {
				return;
			}
			if (connected) {
				await connectDiscoveredBrickFromPanel(normalizedCandidateId);
				return;
			}
			if (isBrickSessionAvailable(normalizedCandidateId)) {
				await closeBrickSession(normalizedCandidateId);
			}
			brickRegistry.markUnavailable(normalizedCandidateId, 'Connection lost.');
			clearProgramSession('mock-connection-toggle', normalizedCandidateId);
			treeProvider.refreshBrick(normalizedCandidateId);
		},
		applyPendingConfigChanges: async (request) => {
			const brickId = request.brickId.trim();
			const requestedName = request.brickName.trim();
			if (!brickId) {
				throw new Error('Missing Brick ID for configuration apply.');
			}
			if (!requestedName) {
				throw new Error('Brick name cannot be empty.');
			}
			const session = getBrickSession(brickId);
			if (!session) {
				throw new Error('Selected Brick is not connected.');
			}
			const previousSnapshot = brickRegistry.getSnapshot(brickId);
			const previousDisplayName = previousSnapshot?.displayName ?? '';
			const normalizedName = requestedName.slice(0, 12);
			const settingsService = new BrickSettingsService({
				commandClient: session.commandClient,
				defaultTimeoutMs: resolveProbeTimeoutMs(),
				logger
			});
			await settingsService.setBrickName(normalizedName);
			const relatedBrickIds = await applyDisplayNameAcrossProfiles(nameDeps, brickId, previousDisplayName, normalizedName);
			treeProvider.refreshThrottled();
			return {
				brickName: normalizedName,
				relatedBrickIds
			};
		},
		discardPendingConfigChanges: async (brickId) => {
			logger.info('Brick panel requested staged configuration discard.', { brickId });
		}
	}, brickPanelConfig);
	brickPanelProvider.setOnDidChangeActive(() => treeProvider.refresh());
	brickRegistry.onStatusChange(() => {
		treeProvider.refreshThrottled();
		brickPanelProvider.refresh();
	});
	const brickPanelRegistration = vscode.window.registerWebviewViewProvider(
		BrickPanelProvider.viewType,
		brickPanelProvider
	);
	const connectionHealthSubscription = createConnectionHealthPoller(
		brickRegistry,
		sessionManager,
		treeProvider,
		{
			activeIntervalMs: brickPanelConfig.connectionHealthActiveMs,
			idleIntervalMs: brickPanelConfig.connectionHealthIdleMs,
			probeTimeoutMs: brickPanelConfig.connectionHealthProbeTimeoutMs,
			onDisconnected: (brickId) => {
				clearProgramSession('connection-health', brickId);
				brickPanelProvider.refresh();
			},
			onReconnectRequested:
				context.extensionMode === vscode.ExtensionMode.Test
					? undefined
					: async (brickId) => {
						const profile = profileStore.get(brickId);
						if (!profile) {
							return;
						}
						if (profile.transport.mode === 'usb') {
							const usbReady = await isUsbReconnectCandidateAvailable(usbReconnectDeps, brickId);
							if (!usbReady) {
								return;
							}
						}
						await vscode.commands.executeCommand('ev3-cockpit.connectEV3', {
							brickId,
							silent: true
						});
						brickPanelProvider.refresh();
					},
			logger: perfLogger
		}
	);

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
		batchRegistrations.previewWorkspaceDeployToReadyBricks,
		batchRegistrations.deployWorkspaceToReadyBricks,
		batchRegistrations.deployWorkspaceAndRunExecutableToReadyBricks,
		toggleFavoriteBrick,
		setBricksTreeFilter,
		clearBricksTreeFilter,
		retryDirectoryFromTree,
		mockRegistrations.mockReset,
		mockRegistrations.mockShowState,
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
		connectionHealthSubscription,
		brickPanelRegistration,
		{
			dispose: () => eventLoopMonitor.stop()
		},
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
