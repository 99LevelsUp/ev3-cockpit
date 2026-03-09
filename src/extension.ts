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
import { readBrickTelemetryConfig } from './config/brickTelemetryConfig';
import { readSchedulerConfig } from './config/schedulerConfig';
import {
	BrickConnectionProfile,
	BrickConnectionProfileStore,
	captureConnectionProfileFromWorkspace
} from './device/brickConnectionProfiles';
import { BrickRegistry } from './device/brickRegistry';
import { BrickTelemetryPoller } from './device/brickTelemetryPoller';
import { BrickTelemetryStore } from './device/brickTelemetryStore';
import { BrickSettingsService } from './device/brickSettingsService';
import { BrickRuntimeSession, BrickSessionManager, ProgramSessionState } from './device/brickSessionManager';
import { applyDisplayNameAcrossProfiles } from './device/brickNameResolver';
import { isUsbReconnectCandidateAvailable, isBtReconnectCandidateAvailable } from './device/brickReconnect';
import { Logger, OutputChannelLogger } from './diagnostics/logger';
import { nextCorrelationId, startEventLoopMonitor, withTimingSync } from './diagnostics/perfTiming';
import { performance } from 'node:perf_hooks';
import { Ev3CommandClient } from './protocol/ev3CommandClient';
import { CommandScheduler } from './scheduler/commandScheduler';
import { pairWindowsBluetoothDevice } from './transport/windowsBluetoothPairing';
import {
	BrickTreeProvider
} from './ui/brickTreeProvider';
import { BrickTreeDragAndDropController } from './ui/brickTreeDragAndDrop';
import { BrickUiStateStore } from './ui/brickUiStateStore';
import { BrickTreeViewStateStore } from './ui/brickTreeViewStateStore';
import { createBusyIndicatorPoller } from './ui/busyIndicator';
import { createConnectionHealthPoller } from './ui/connectionHealthPoller';
import { createTreeStatePersistence } from './ui/treeStatePersistence';
import { normalizeBrickRootPath, toSafeIdentifier } from './activation/helpers';
import { createConfigWatcher } from './activation/configWatcher';
import { createBrickResolvers } from './activation/brickResolvers';
import { BrickPanelDiscoveryCandidate, BrickPanelProvider } from './ui/brickPanelProvider';
import { readMockBricksConfig } from './config/mockBricksConfig';
import { isMockBrickId, setMockBricks } from './mock/mockCatalog';
import {
	createTreeFilterState,
	registerInspectBrickSessions,
	registerToggleFavoriteBrick,
	registerSetBricksTreeFilter,
	registerClearBricksTreeFilter,
	registerRetryDirectoryFromTree,
	registerOpenBrickPanel,
	registerRevealInBricksTree,
	registerFsChangeSubscription
} from './activation/extensionCommands';
import { createBrickSessionFactory } from './activation/sessionFactory';
import { createFsProvider, createPresenceRuntime } from './activation/runtimeFactories';
import { sortBrickSnapshotsForTree } from './activation/runtimeHelpers';

export function activate(context: vscode.ExtensionContext) {
	const activationStart = performance.now();
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
	const profileStore = new BrickConnectionProfileStore(context.workspaceState, {
		persistenceEnabled: false
	});
	const brickUiStateStore = new BrickUiStateStore(context.workspaceState);
	const brickTreeViewStateStore = new BrickTreeViewStateStore(context.workspaceState);
	const defaultRootPath = normalizeBrickRootPath(readFeatureConfig().fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/');
	const { presenceAggregator, mockPresenceSource } = createPresenceRuntime({
		brickRegistry,
		profileStore,
		logger: perfLogger,
		toSafeIdentifier,
		defaultRootPath,
		enableHardwarePresence: context.extensionMode !== vscode.ExtensionMode.Test
	});
	const filterState = createTreeFilterState(() => () => treeProvider.refresh());

	const treeProvider = new BrickTreeProvider({
		dataSource: {
			listBricks: () => sortBrickSnapshotsForTree(
				brickRegistry.listSnapshots().filter((s) => s.status === 'READY')
				,
				brickUiStateStore.getFavoriteOrder()
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

	const fsProvider = createFsProvider(brickRegistry);
	const sessionManager = new BrickSessionManager<CommandScheduler, Ev3CommandClient, BrickConnectionProfile>(
		createBrickSessionFactory({
			getLogger: () => logger,
			readSchedulerConfig: () => {
				const config = readSchedulerConfig();
				return {
					timeoutMs: config.timeoutMs,
					defaultRetryPolicy: config.defaultRetryPolicy
				};
			}
		})
	);
	const telemetryStore = new BrickTelemetryStore();
	const telemetryConfig = readBrickTelemetryConfig(context.extensionPath, perfLogger);

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

	const resolveBtComPathForMac = async (mac: string): Promise<string | undefined> => {
		const normalized = mac.trim().toLowerCase();
		if (!/^[0-9a-f]{12}$/.test(normalized)) {
			return undefined;
		}
		const candidateId = `bt-${normalized}`;
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const record = presenceAggregator.getLiveRecord(candidateId);
			if (
				record?.connectionParams.mode === 'bt'
				&& record.connectable
				&& record.connectionParams.btPortPath
				&& /^COM\d+$/i.test(record.connectionParams.btPortPath)
			) {
				return record.connectionParams.btPortPath;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		return undefined;
	};

	const isMockDiscoveryEnabled = (): boolean => {
		const cfg = vscode.workspace.getConfiguration();
		const explicit = cfg.get<boolean>('ev3-cockpit.mock');
		if (typeof explicit === 'boolean') {
			return explicit;
		}
		return cfg.get<boolean>('ev3-cockpit.ui.discovery.showMockBricks', false) === true;
	};

	const nameDeps = { brickRegistry, profileStore, discoveryService: presenceAggregator };
	const usbReconnectDeps = { brickRegistry, profileStore, presenceAggregator };
	const btReconnectDeps = { brickRegistry, profileStore, presenceAggregator };
	const discoverBricksForPanel = async (): Promise<BrickPanelDiscoveryCandidate[]> => {
		const showMockBricks = isMockDiscoveryEnabled();
		const mockBricks = readMockBricksConfig(context.extensionPath, perfLogger);
		setMockBricks(mockBricks);
		mockPresenceSource.refresh(showMockBricks ? mockBricks : []);
		return presenceAggregator.getCandidates({ showMockBricks });
	};

	const connectDiscoveredBrickFromPanel = async (candidateId: string): Promise<void> => {
		return presenceAggregator.connectDiscoveredBrick(
			candidateId,
			profileStore,
			(brickId) => vscode.commands.executeCommand('ev3-cockpit.connectEV3', brickId) as Promise<void>
		);
	};

	const forgetDiscoveredBrickFromPanel = async (candidateId: string): Promise<void> => {
		const normalizedCandidateId = candidateId.trim();
		if (!normalizedCandidateId) {
			return;
		}
		clearProgramSession('forget-known-brick', normalizedCandidateId);
		if (isBrickSessionAvailable(normalizedCandidateId)) {
			await closeBrickSession(normalizedCandidateId);
		}
		await profileStore.remove(normalizedCandidateId);
		brickRegistry.removeWhere((record) => record.brickId === normalizedCandidateId);
		await brickUiStateStore.pruneMissing(new Set(brickRegistry.listSnapshots().map((snapshot) => snapshot.brickId)));
		treeProvider.refreshThrottled();
	};


	// --- Register command modules ---

	const commandRegStart = performance.now();
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
		onBrickOperation: noteBrickOperation,
		pairBluetoothDevice: async (mac) => pairWindowsBluetoothDevice(mac),
		resolveBluetoothComPath: resolveBtComPathForMac
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

	const { inspectTransports, transportHealthReport, btDetectionDiagnostics } = registerTransportCommands({
		getLogger: () => logger,
		resolveProbeTimeoutMs,
		scanDiscoveryCandidates: discoverBricksForPanel
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
	const openBrickPanel = registerOpenBrickPanel();
	const mockRegistrations = registerMockCommands({ profileStore });

	perfLogger.info('[perf] activate.command-registrations', {
		durationMs: Number((performance.now() - commandRegStart).toFixed(1))
	});

	// --- FS provider, tree view ---

	const uiRegStart = performance.now();
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

	const pollerStartTime = performance.now();
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
		listBricks: () => {
			const includeMocks = isMockDiscoveryEnabled();
			const snapshots = brickRegistry.listSnapshots().filter((snapshot) => (
				snapshot.status === 'READY'
				|| snapshot.status === 'CONNECTING'
				|| (
					snapshot.status === 'UNAVAILABLE'
					&& snapshot.lastError !== 'Disconnected by user.'
				)
			)).filter((snapshot) => includeMocks || !isMockBrickId(snapshot.brickId));
			return sortBrickSnapshotsForTree(snapshots, brickUiStateStore.getFavoriteOrder());
		},
		setActiveBrick: (brickId) => brickRegistry.setActiveBrick(brickId),
		scanAvailableBricks: discoverBricksForPanel,
		connectScannedBrick: connectDiscoveredBrickFromPanel,
		forgetScannedBrick: forgetDiscoveredBrickFromPanel,
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
		},
		getSensorInfo: (brickId) => telemetryStore.getSensorInfo(brickId),
		getMotorInfo: (brickId) => telemetryStore.getMotorInfo(brickId),
		getButtonState: (brickId) => telemetryStore.getButtonState(brickId),
		getLedPattern: (brickId) => telemetryStore.getLedPattern(brickId)
	}, brickPanelConfig);
	const telemetryPoller = new BrickTelemetryPoller({
		brickRegistry,
		sessionManager,
		telemetryStore,
		config: telemetryConfig,
		defaultTimeoutMs: readSchedulerConfig().timeoutMs,
		onTelemetryChange: (brickId) => {
			if (brickRegistry.getActiveBrickId() === brickId) {
				brickPanelProvider.refresh();
			}
		},
		logger: perfLogger
	});
	telemetryPoller.start();

	perfLogger.info('[perf] activate.background-pollers', {
		durationMs: Number((performance.now() - pollerStartTime).toFixed(1))
	});

	brickRegistry.onStatusChange(() => {
		treeProvider.refreshThrottled();
		brickPanelProvider.refresh();
	});
	presenceAggregator.onCandidatesChanged(() => {
		brickPanelProvider.refresh();
	});
	const brickPanelRegistration = vscode.window.registerWebviewViewProvider(
		BrickPanelProvider.viewType,
		brickPanelProvider
	);

	perfLogger.info('[perf] activate.ui-provider-registration', {
		durationMs: Number((performance.now() - uiRegStart).toFixed(1))
	});

	const purgeMockBricks = async (reason: string): Promise<void> => {
		const mockSnapshots = brickRegistry.listSnapshots().filter((snapshot) => isMockBrickId(snapshot.brickId));
		if (mockSnapshots.length === 0) {
			return;
		}
		for (const snapshot of mockSnapshots) {
			clearProgramSession(reason, snapshot.brickId);
			await closeBrickSession(snapshot.brickId);
		}
		brickRegistry.removeWhere((record) => isMockBrickId(record.brickId));
		await profileStore.removeWhere((profile) => isMockBrickId(profile.brickId));
		await brickUiStateStore.pruneMissing(new Set(brickRegistry.listSnapshots().map((snapshot) => snapshot.brickId)));
		treeProvider.refreshThrottled();
		brickPanelProvider.refresh();
	};

	// --- Config watcher ---

	const configWatcher = createConfigWatcher({
		getLogger: () => logger,
		brickRegistry,
		sessionManager,
		profileStore,
		ensureFullFsModeConfirmation,
		resolveMockDiscoveryEnabled: isMockDiscoveryEnabled,
		onMockDiscoveryChanged: async (enabled) => {
			if (!enabled) {
				await purgeMockBricks('mock-discovery-disabled');
			} else {
				brickPanelProvider.refresh();
			}
		}
	});
	if (!isMockDiscoveryEnabled()) {
		void purgeMockBricks('mock-discovery-disabled');
	}
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
						if (profile.transport.mode === 'bt') {
							const btReady = await isBtReconnectCandidateAvailable(btReconnectDeps, brickId);
							if (!btReady) {
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
		btDetectionDiagnostics,
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
		openBrickPanel,
		mockRegistrations.mockReset,
		mockRegistrations.mockShowState,
		mockRegistrations.mockToggleDiscovery,
		mockRegistrations.clearBrickProfiles,
		telemetryPoller,
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
		{
			dispose: () => presenceAggregator.stop()
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

	perfLogger.info('[perf] activate.total', {
		durationMs: Number((performance.now() - activationStart).toFixed(1))
	});
}

export function deactivate() {}
