import * as vscode from 'vscode';
import * as path from 'node:path';
import { buildCapabilityProfile } from './compat/capabilityProfile';
import { readFeatureConfig } from './config/featureConfig';
import { readSchedulerConfig } from './config/schedulerConfig';
import { BrickControlService } from './device/brickControlService';
import { OutputChannelLogger } from './diagnostics/logger';
import { buildRemoteChildPath, buildRemotePathFromLocal, isValidRemoteEntryName } from './fs/browserActions';
import {
	buildRemoteDeployPath,
	buildRemoteProjectRoot,
	choosePreferredRunCandidate,
	isRbfFileName
} from './fs/deployActions';
import { DeployConflictPromptChoice, resolveDeployConflictDecision } from './fs/deployConflict';
import { buildLocalProjectLayout, planRemoteCleanup } from './fs/deployCleanup';
import { RemoteFileSnapshot, shouldUploadByRemoteSnapshot } from './fs/deployIncremental';
import { verifyUploadedFile } from './fs/deployVerify';
import { Ev3FileSystemProvider } from './fs/ev3FileSystemProvider';
import { isLikelyBinaryPath } from './fs/fileKind';
import { createGlobMatcher } from './fs/globMatch';
import { deleteRemotePath, getRemotePathKind, renameRemotePath } from './fs/remoteFsOps';
import { RemoteFsService } from './fs/remoteFsService';
import { buildCapabilityProbeDirectPayload, parseCapabilityProbeReply } from './protocol/capabilityProbe';
import { Ev3CommandClient } from './protocol/ev3CommandClient';
import { EV3_COMMAND, EV3_REPLY } from './protocol/ev3Packet';
import { CommandScheduler } from './scheduler/commandScheduler';
import { OrphanRecoveryContext, OrphanRecoveryStrategy } from './scheduler/orphanRecovery';
import { listSerialCandidates, listUsbHidCandidates } from './transport/discovery';
import { createProbeTransportForMode, createProbeTransportFromWorkspace, TransportMode } from './transport/transportFactory';

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

interface LocalProjectFileEntry {
	localUri: vscode.Uri;
	relativePath: string;
	remotePath: string;
	sizeBytes: number;
	isRbf: boolean;
}

interface LocalScannedFile {
	localUri: vscode.Uri;
	relativePath: string;
	sizeBytes: number;
}

interface ProjectScanResult {
	files: LocalScannedFile[];
	skippedDirectories: string[];
	skippedByExtension: string[];
	skippedByIncludeGlob: string[];
	skippedByExcludeGlob: string[];
	skippedBySize: Array<{ relativePath: string; sizeBytes: number }>;
}

interface RemoteFileIndexResult {
	available: boolean;
	truncated: boolean;
	files: Map<string, RemoteFileSnapshot>;
	directories: string[];
	message?: string;
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

function isRemoteAlreadyExistsError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /FILE_EXISTS/i.test(message);
}

function pathDepth(remotePath: string): number {
	return remotePath.split('/').filter((part) => part.length > 0).length;
}

async function collectRemoteFileIndexRecursive(
	fsService: RemoteFsService,
	rootPath: string
): Promise<RemoteFileIndexResult> {
	const files = new Map<string, RemoteFileSnapshot>();
	const directories = new Set<string>();
	const queue: string[] = [rootPath];
	let truncated = false;

	while (queue.length > 0) {
		const current = queue.shift() ?? rootPath;
		directories.add(current);
		let listing;
		try {
			listing = await fsService.listDirectory(current);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				available: false,
				truncated,
				files,
				directories: [...directories],
				message
			};
		}

		truncated = truncated || listing.truncated;
		for (const folder of listing.folders) {
			queue.push(path.posix.join(current, folder));
		}
		for (const file of listing.files) {
			const filePath = path.posix.join(current, file.name);
			files.set(filePath, {
				sizeBytes: file.size,
				md5: file.md5
			});
		}
	}

	return {
		available: true,
		truncated,
		files,
		directories: [...directories].sort((a, b) => a.localeCompare(b))
	};
}

async function collectLocalFilesRecursive(
	root: vscode.Uri,
	options: {
		excludeDirectories: string[];
		excludeExtensions: string[];
		includeGlobs: string[];
		excludeGlobs: string[];
		maxFileBytes: number;
	}
): Promise<ProjectScanResult> {
	const files: LocalScannedFile[] = [];
	const skippedDirectories: string[] = [];
	const skippedByExtension: string[] = [];
	const skippedByIncludeGlob: string[] = [];
	const skippedByExcludeGlob: string[] = [];
	const skippedBySize: Array<{ relativePath: string; sizeBytes: number }> = [];
	const excludedDirNames = new Set(options.excludeDirectories.map((entry) => entry.toLowerCase()));
	const excludedExtensions = new Set(options.excludeExtensions.map((entry) => entry.toLowerCase()));
	const includeMatcher = createGlobMatcher(options.includeGlobs);
	const excludeMatcher = createGlobMatcher(options.excludeGlobs);

	const walk = async (dir: vscode.Uri, relativeDir: string): Promise<void> => {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		for (const [name, type] of entries) {
			const child = vscode.Uri.joinPath(dir, name);
			const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
			if (type === vscode.FileType.Directory) {
				if (excludedDirNames.has(name.toLowerCase())) {
					skippedDirectories.push(relativePath);
					continue;
				}
				await walk(child, relativePath);
			} else if (type === vscode.FileType.File) {
				const extension = path.extname(name).toLowerCase();
				if (excludedExtensions.has(extension)) {
					skippedByExtension.push(relativePath);
					continue;
				}
				if (!includeMatcher(relativePath)) {
					skippedByIncludeGlob.push(relativePath);
					continue;
				}
				if (excludeMatcher(relativePath)) {
					skippedByExcludeGlob.push(relativePath);
					continue;
				}

				const stat = await vscode.workspace.fs.stat(child);
				if (stat.size > options.maxFileBytes) {
					skippedBySize.push({
						relativePath,
						sizeBytes: stat.size
					});
					continue;
				}

				files.push({
					localUri: child,
					relativePath,
					sizeBytes: stat.size
				});
			}
		}
	};

	await walk(root, '');
	files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	skippedDirectories.sort((a, b) => a.localeCompare(b));
	skippedByExtension.sort((a, b) => a.localeCompare(b));
	skippedByIncludeGlob.sort((a, b) => a.localeCompare(b));
	skippedByExcludeGlob.sort((a, b) => a.localeCompare(b));
	skippedBySize.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	return {
		files,
		skippedDirectories,
		skippedByExtension,
		skippedByIncludeGlob,
		skippedByExcludeGlob,
		skippedBySize
	};
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('EV3 Cockpit');
	let logger: OutputChannelLogger;
	let scheduler: CommandScheduler;
	let commandClient: Ev3CommandClient;
	let activeFsService: RemoteFsService | undefined;
	let activeControlService: BrickControlService | undefined;
	let lastRunProgramPath: string | undefined;
	let activeProgramSession: ProgramSessionState | undefined;

	const fsProvider = new Ev3FileSystemProvider(async (brickId) => {
		if (brickId !== 'active') {
			throw new Error(`Brick "${brickId}" is not available. Use ev3://active/... for current connection.`);
		}
		if (!activeFsService) {
			throw new Error('No active EV3 connection for filesystem access. Run "EV3 Cockpit: Connect to EV3 Brick".');
		}
		return activeFsService;
	});

	const rebuildRuntime = () => {
		const config = readSchedulerConfig();
		const featureConfig = readFeatureConfig();
		logger = new OutputChannelLogger((line) => output.appendLine(line), config.logLevel);
		void commandClient?.close().catch(() => undefined);
		scheduler?.dispose();
		activeFsService = undefined;
		activeControlService = undefined;
		lastRunProgramPath = undefined;
		activeProgramSession = undefined;

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

	const normalizeRunProgramPath = (input: string): string => {
		const trimmed = input.trim();
		if (!trimmed) {
			throw new Error('Program path must not be empty.');
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
		if (!normalized.toLowerCase().endsWith('.rbf')) {
			throw new Error('Only .rbf program paths are supported.');
		}
		return normalized;
	};

	const resolveCurrentTransportMode = (): TransportMode | 'unknown' => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const mode = cfg.get('transport.mode');
		return mode === 'auto' || mode === 'usb' || mode === 'bluetooth' || mode === 'tcp' || mode === 'mock'
			? mode
			: 'unknown';
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

	const isTransportLikelyUnavailable = (message: string): boolean =>
		/not found|requires setting|timeout|unknown error code 121|unknown error code 1256|access is denied|send aborted/i.test(
			message
		);

	const runTransportProbe = async (
		mode: 'usb' | 'tcp' | 'bluetooth'
	): Promise<{ mode: 'usb' | 'tcp' | 'bluetooth'; status: 'PASS' | 'SKIP' | 'FAIL'; message: string }> => {
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		const timeoutMs = resolveProbeTimeoutMs();
		let probeScheduler: CommandScheduler | undefined;
		let probeClient: Ev3CommandClient | undefined;

		try {
			probeScheduler = new CommandScheduler({
				defaultTimeoutMs: timeoutMs,
				logger,
				defaultRetryPolicy: readSchedulerConfig().defaultRetryPolicy,
				orphanRecoveryStrategy: new LoggingOrphanRecoveryStrategy((msg, meta) => logger.info(msg, meta))
			});
			probeClient = new Ev3CommandClient({
				scheduler: probeScheduler,
				transport: createProbeTransportForMode(cfg, logger, timeoutMs, mode),
				logger
			});

			await probeClient.open();
			const probeResult = await probeClient.send({
				id: `transport-health-${mode}-probe`,
				lane: 'high',
				idempotent: true,
				timeoutMs,
				type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
				payload: new Uint8Array([0x9d])
			});
			if (probeResult.reply.type !== EV3_REPLY.SYSTEM_REPLY && probeResult.reply.type !== EV3_REPLY.SYSTEM_REPLY_ERROR) {
				throw new Error(`Unexpected probe reply type 0x${probeResult.reply.type.toString(16)}.`);
			}
			if (probeResult.reply.type === EV3_REPLY.SYSTEM_REPLY_ERROR) {
				throw new Error('Probe returned SYSTEM_REPLY_ERROR.');
			}

			const capabilityResult = await probeClient.send({
				id: `transport-health-${mode}-capability`,
				lane: 'high',
				idempotent: true,
				timeoutMs,
				type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
				payload: buildCapabilityProbeDirectPayload()
			});
			if (capabilityResult.reply.type !== EV3_REPLY.DIRECT_REPLY) {
				throw new Error(`Unexpected capability reply type 0x${capabilityResult.reply.type.toString(16)}.`);
			}
			const capability = parseCapabilityProbeReply(capabilityResult.reply.payload);
			return {
				mode,
				status: 'PASS',
				message: `probe+capability ok (fw=${capability.fwVersion || '?'}, build=${capability.fwBuild || '?'})`
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isTransportLikelyUnavailable(message)) {
				return {
					mode,
					status: 'SKIP',
					message
				};
			}
			return {
				mode,
				status: 'FAIL',
				message
			};
		} finally {
			await probeClient?.close().catch(() => undefined);
			probeScheduler?.dispose();
		}
	};

	const disposable = vscode.commands.registerCommand('ev3-cockpit.connectEV3', async () => {
		vscode.window.showInformationMessage('Connecting to EV3 brick...');
		const activeClient = commandClient;
		const activeLogger = logger;
		let keepConnectionOpen = false;

		try {
			clearProgramSession('connect-start');
			activeFsService = undefined;
			activeControlService = undefined;
			await activeClient.close().catch(() => undefined);
			await activeClient.open();
			const probeCommand = 0x9d; // LIST_OPEN_HANDLES
			const result = await activeClient.send({
				id: 'connect-probe',
				lane: 'high',
				idempotent: true,
				timeoutMs: resolveProbeTimeoutMs(),
				type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
				payload: new Uint8Array([probeCommand])
			});
			const replyType = result.reply.type;
			const isSystemReply = replyType === EV3_REPLY.SYSTEM_REPLY || replyType === EV3_REPLY.SYSTEM_REPLY_ERROR;
			if (!isSystemReply) {
				throw new Error(`Unexpected probe reply type 0x${replyType.toString(16)}.`);
			}

			if (result.reply.payload.length < 2) {
				throw new Error('Probe reply payload is too short.');
			}

			const echoedCommand = result.reply.payload[0];
			const status = result.reply.payload[1];
			if (echoedCommand !== probeCommand) {
				throw new Error(
					`Probe reply command mismatch: expected 0x${probeCommand.toString(16)}, got 0x${echoedCommand.toString(16)}.`
				);
			}

			if (replyType === EV3_REPLY.SYSTEM_REPLY_ERROR || status !== 0x00) {
				throw new Error(`Probe reply returned status 0x${status.toString(16)}.`);
			}

			activeLogger.info('Connect probe completed', {
				requestId: result.requestId,
				lane: 'high',
				messageCounter: result.messageCounter,
				opcode: probeCommand,
				replyType,
				status,
				durationMs: result.durationMs,
				result: 'ok'
			});

			let capabilitySummary = '';
			const featureConfig = readFeatureConfig();
			let profile = buildCapabilityProfile(
				{
					osVersion: '',
					hwVersion: '',
					fwVersion: 'unknown',
					osBuild: '',
					fwBuild: ''
				},
				featureConfig.compatProfileMode
			);
			try {
				const capabilityResult = await activeClient.send({
					id: 'connect-capability',
					lane: 'high',
					idempotent: true,
					timeoutMs: resolveProbeTimeoutMs(),
					type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
					payload: buildCapabilityProbeDirectPayload()
				});
				if (capabilityResult.reply.type !== EV3_REPLY.DIRECT_REPLY) {
					throw new Error(`Unexpected capability reply type 0x${capabilityResult.reply.type.toString(16)}.`);
				}

				const capability = parseCapabilityProbeReply(capabilityResult.reply.payload);
				profile = buildCapabilityProfile(capability, featureConfig.compatProfileMode);
				activeLogger.info('Capability probe completed', {
					requestId: capabilityResult.requestId,
					lane: 'high',
					messageCounter: capabilityResult.messageCounter,
					durationMs: capabilityResult.durationMs,
					payloadBytes: capabilityResult.reply.payload.length,
					osVersion: capability.osVersion,
					hwVersion: capability.hwVersion,
					fwVersion: capability.fwVersion,
					osBuild: capability.osBuild,
					fwBuild: capability.fwBuild
				});
				activeLogger.info('Capability profile selected', {
					profileId: profile.id,
					firmwareFamily: profile.firmwareFamily,
					supportsContinueList: profile.supportsContinueList,
					uploadChunkBytes: profile.uploadChunkBytes,
					recommendedTimeoutMs: profile.recommendedTimeoutMs,
					fsMode: featureConfig.fs.mode,
					fsSafeRoots: featureConfig.fs.defaultRoots
				});

				if (capability.fwVersion || capability.fwBuild) {
					capabilitySummary = ` fw=${capability.fwVersion || '?'} (${capability.fwBuild || '?'})`;
				}
			} catch (capabilityError) {
				activeLogger.warn('Capability probe failed', {
					message: capabilityError instanceof Error ? capabilityError.message : String(capabilityError)
				});
				activeLogger.info('Capability profile selected (fallback)', {
					profileId: profile.id,
					firmwareFamily: profile.firmwareFamily,
					supportsContinueList: profile.supportsContinueList,
					uploadChunkBytes: profile.uploadChunkBytes,
					recommendedTimeoutMs: profile.recommendedTimeoutMs,
					fsMode: featureConfig.fs.mode,
					fsSafeRoots: featureConfig.fs.defaultRoots
				});
			}

			activeFsService = new RemoteFsService({
				commandClient: activeClient,
				capabilityProfile: profile,
				fsConfig: featureConfig.fs,
				defaultTimeoutMs: Math.max(resolveProbeTimeoutMs(), profile.recommendedTimeoutMs),
				logger: activeLogger
			});
			activeControlService = new BrickControlService({
				commandClient: activeClient,
				defaultTimeoutMs: Math.max(resolveProbeTimeoutMs(), profile.recommendedTimeoutMs),
				logger: activeLogger
			});
			keepConnectionOpen = true;
			activeLogger.info('Remote FS service ready', {
				scheme: 'ev3',
				brickId: 'active',
				mode: featureConfig.fs.mode
			});

			vscode.window.showInformationMessage(
				`EV3 connect probe completed (mc=${result.messageCounter})${capabilitySummary}. FS: ev3://active/`
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown scheduler error';
			activeLogger.error('Connect probe failed', { message });
			activeFsService = undefined;
			activeControlService = undefined;
			vscode.window.showErrorMessage(`EV3 connect probe failed: ${message}`);
		} finally {
			if (!keepConnectionOpen) {
				await activeClient.close().catch((closeError: unknown) => {
					activeLogger.warn('Connect probe transport close failed', {
						error: closeError instanceof Error ? closeError.message : String(closeError)
					});
				});
			}
		}
	});

	const disconnect = vscode.commands.registerCommand('ev3-cockpit.disconnectEV3', async () => {
		try {
			await commandClient.close();
			activeFsService = undefined;
			activeControlService = undefined;
			clearProgramSession('disconnect-command');
			logger.info('Disconnected active EV3 session.');
			vscode.window.showInformationMessage('EV3 disconnected.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn('Disconnect failed', { message });
			vscode.window.showErrorMessage(`Disconnect failed: ${message}`);
		}
	});

	const reconnect = vscode.commands.registerCommand('ev3-cockpit.reconnectEV3', async () => {
		logger.info('Reconnect requested via command palette; delegating to connect flow.');
		await vscode.commands.executeCommand('ev3-cockpit.connectEV3');
	});

	const deployAndRunRbf = vscode.commands.registerCommand('ev3-cockpit.deployAndRunRbf', async () => {
		if (!activeFsService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}
		const fsService = activeFsService;

		const localSelection = await vscode.window.showOpenDialog({
			canSelectMany: false,
			canSelectFiles: true,
			canSelectFolders: false,
			openLabel: 'Deploy and Run on EV3',
			filters: {
				'EV3 bytecode': ['rbf']
			}
		});
		if (!localSelection || localSelection.length === 0) {
			return;
		}

		const localUri = localSelection[0];
		const featureConfig = readFeatureConfig();
		const defaultRoot = featureConfig.fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/';

		let remotePath: string;
		try {
			remotePath = buildRemoteDeployPath(localUri.fsPath, defaultRoot);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Deploy path error: ${message}`);
			return;
		}

		try {
			const bytes = await vscode.workspace.fs.readFile(localUri);
			await fsService.writeFile(remotePath, bytes);
			if (featureConfig.deploy.verifyAfterUpload !== 'none') {
				await verifyUploadedFile(fsService, remotePath, bytes, featureConfig.deploy.verifyAfterUpload);
			}
			await fsService.runProgram(remotePath);
			markProgramStarted(remotePath, 'deploy-and-run-single');

			logger.info('Deploy and run completed', {
				localPath: localUri.fsPath,
				remotePath,
				size: bytes.length,
				verifyAfterUpload: featureConfig.deploy.verifyAfterUpload
			});
			vscode.window.showInformationMessage(`Deployed and started: ev3://active${remotePath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn('Deploy and run failed', {
				localPath: localUri.fsPath,
				remotePath,
				message
			});
			vscode.window.showErrorMessage(`Deploy and run failed: ${message}`);
		}
	});

	const executeProjectDeploy = async (options: { runAfterDeploy: boolean; previewOnly: boolean }): Promise<void> => {
		if (!activeFsService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}
		const fsService = activeFsService;

		const selection = await vscode.window.showOpenDialog({
			canSelectMany: false,
			canSelectFiles: false,
			canSelectFolders: true,
			openLabel: options.previewOnly
				? 'Preview Project Deploy Changes'
				: options.runAfterDeploy
				? 'Deploy Project to EV3'
				: 'Sync Project to EV3'
		});
		if (!selection || selection.length === 0) {
			return;
		}

		const projectUri = selection[0];
		const featureConfig = readFeatureConfig();
		const defaultRoot = featureConfig.fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/';
		let remoteProjectRoot: string;
		try {
			remoteProjectRoot = buildRemoteProjectRoot(projectUri.fsPath, defaultRoot);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Deploy path error: ${message}`);
			return;
		}
		const atomicEnabled = featureConfig.deploy.atomicEnabled && !options.previewOnly;
		const remoteProjectParent = path.posix.dirname(remoteProjectRoot);
		const remoteProjectName = path.posix.basename(remoteProjectRoot);
		const atomicTag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 10_000).toString(36)}`;
		const atomicStagingRoot = path.posix.join(
			remoteProjectParent,
			`.${remoteProjectName}.ev3-cockpit-staging-${atomicTag}`
		);
		const atomicBackupRoot = path.posix.join(
			remoteProjectParent,
			`.${remoteProjectName}.ev3-cockpit-backup-${atomicTag}`
		);
		const deployProjectRoot = atomicEnabled ? atomicStagingRoot : remoteProjectRoot;

		try {
			const scan = await collectLocalFilesRecursive(projectUri, featureConfig.deploy);
			if (scan.files.length === 0) {
				vscode.window.showWarningMessage(
					`Project folder "${projectUri.fsPath}" has no deployable files after filters.`
				);
				return;
			}

			const files: LocalProjectFileEntry[] = scan.files.map((entry) => {
				const relativePosix = entry.relativePath.split(path.sep).join('/');
				return {
					localUri: entry.localUri,
					relativePath: entry.relativePath,
					remotePath: path.posix.join(deployProjectRoot, relativePosix),
					sizeBytes: entry.sizeBytes,
					isRbf: isRbfFileName(path.basename(entry.localUri.fsPath))
				};
			});

			let runTarget: string | undefined;
			if (options.runAfterDeploy) {
				const rbfFiles = files.filter((entry) => entry.isRbf);
				if (rbfFiles.length === 0) {
					vscode.window.showErrorMessage(`No .rbf file found in project folder "${projectUri.fsPath}".`);
					return;
				}

				runTarget = choosePreferredRunCandidate(
					rbfFiles.map((entry) => path.posix.join(remoteProjectRoot, entry.relativePath.split(path.sep).join('/')))
				);
				if (!runTarget) {
					vscode.window.showErrorMessage('Could not determine run target .rbf file.');
					return;
				}

				if (rbfFiles.length > 1) {
					const quickPickItems = rbfFiles.map((entry) => ({
						label: entry.relativePath,
						description: path.posix.join(remoteProjectRoot, entry.relativePath.split(path.sep).join('/'))
					}));
					const selected = await vscode.window.showQuickPick(quickPickItems, {
						title: 'Select .rbf file to run after deploy',
						placeHolder: 'Choose run target'
					});
					if (!selected) {
						return;
					}
					runTarget = selected.description ?? runTarget;
				}
			}

			let incrementalEnabled = featureConfig.deploy.incrementalEnabled;
			let cleanupEnabled = featureConfig.deploy.cleanupEnabled;
			const cleanupConfirmBeforeDelete = featureConfig.deploy.cleanupConfirmBeforeDelete;
			const cleanupDryRun = featureConfig.deploy.cleanupDryRun;
			const verifyAfterUpload = featureConfig.deploy.verifyAfterUpload;
			const conflictPolicy = featureConfig.deploy.conflictPolicy;
			const effectiveConflictPolicy = options.previewOnly ? 'overwrite' : conflictPolicy;
			if (atomicEnabled && incrementalEnabled) {
				incrementalEnabled = false;
				logger.info('Project deploy incremental mode disabled because atomic deploy is enabled.', {
					remoteProjectRoot,
					atomicStagingRoot
				});
			}
			if (atomicEnabled && cleanupEnabled) {
				cleanupEnabled = false;
				logger.info('Project deploy cleanup mode disabled because atomic deploy performs full root swap.', {
					remoteProjectRoot,
					atomicStagingRoot
				});
			}
			let remoteIndex = new Map<string, RemoteFileSnapshot>();
			let remoteDirectories: string[] = [];
			if (incrementalEnabled || cleanupEnabled || effectiveConflictPolicy !== 'overwrite') {
				const remoteIndexResult = await collectRemoteFileIndexRecursive(fsService, remoteProjectRoot);
				if (!remoteIndexResult.available) {
					if (incrementalEnabled) {
						incrementalEnabled = false;
						logger.info('Project deploy incremental mode disabled; falling back to full upload.', {
							reason: remoteIndexResult.message ?? 'remote-index-unavailable',
							remoteProjectRoot
						});
					}
					if (cleanupEnabled) {
						cleanupEnabled = false;
						logger.info('Project deploy cleanup mode disabled; remote index unavailable.', {
							reason: remoteIndexResult.message ?? 'remote-index-unavailable',
							remoteProjectRoot
						});
					}
					if (effectiveConflictPolicy !== 'overwrite') {
						logger.info('Project deploy conflict policy will use per-file lookup; remote index unavailable.', {
							reason: remoteIndexResult.message ?? 'remote-index-unavailable',
							remoteProjectRoot,
							conflictPolicy: effectiveConflictPolicy
						});
					}
				} else if (remoteIndexResult.truncated) {
					if (incrementalEnabled) {
						incrementalEnabled = false;
						logger.info('Project deploy incremental mode disabled due to truncated remote listing.', {
							remoteProjectRoot
						});
					}
					if (cleanupEnabled) {
						cleanupEnabled = false;
						logger.info('Project deploy cleanup mode disabled due to truncated remote listing.', {
							remoteProjectRoot
						});
					}
					if (effectiveConflictPolicy !== 'overwrite') {
						logger.info('Project deploy conflict policy will use per-file lookup due to truncated remote listing.', {
							remoteProjectRoot,
							conflictPolicy: effectiveConflictPolicy
						});
					}
				} else {
					remoteIndex = remoteIndexResult.files;
					remoteDirectories = remoteIndexResult.directories;
					logger.info('Project deploy incremental index loaded', {
						remoteProjectRoot,
						remoteFiles: remoteIndex.size,
						remoteDirectories: remoteDirectories.length
					});
				}
			}

			let uploadedFilesCount = 0;
			let verifiedFilesCount = 0;
			let skippedUnchangedCount = 0;
			let skippedByConflictCount = 0;
			let overwrittenConflictCount = 0;
			let uploadedBytes = 0;
			let plannedUploadCount = 0;
			let deletedStaleFilesCount = 0;
			let deletedStaleDirectoriesCount = 0;
			let plannedStaleFilesCount = 0;
			let plannedStaleDirectoriesCount = 0;
			const previewUploadSamples: string[] = [];
			const localLayout = buildLocalProjectLayout(files.map((entry) => entry.relativePath));
			let cleanupPlan = {
				filesToDelete: [] as string[],
				directoriesToDelete: [] as string[]
			};
			const conflictDirectoryCache = new Map<string, Set<string>>();
			let conflictBulkDecision: 'overwrite' | 'skip' | undefined;

			const remoteFileExists = async (remotePath: string): Promise<boolean> => {
				if (remoteIndex.has(remotePath)) {
					return true;
				}

				const parent = path.posix.dirname(remotePath);
				const fileName = path.posix.basename(remotePath);
				const cached = conflictDirectoryCache.get(parent);
				if (cached) {
					return cached.has(fileName);
				}

				const listing = await fsService.listDirectory(parent);
				const names = new Set(listing.files.map((entry) => entry.name));
				if (!listing.truncated) {
					conflictDirectoryCache.set(parent, names);
				}
				return names.has(fileName);
			};

			if (cleanupEnabled) {
				cleanupPlan = planRemoteCleanup({
					remoteProjectRoot,
					remoteFilePaths: [...remoteIndex.keys()],
					remoteDirectoryPaths: remoteDirectories,
					localLayout
				});
				plannedStaleFilesCount = cleanupPlan.filesToDelete.length;
				plannedStaleDirectoriesCount = cleanupPlan.directoriesToDelete.length;

				const totalCleanupTargets = cleanupPlan.filesToDelete.length + cleanupPlan.directoriesToDelete.length;
				if (totalCleanupTargets > 0 && cleanupDryRun) {
					logger.info('Project deploy cleanup dry-run planned stale entries.', {
						remoteProjectRoot,
						staleFiles: plannedStaleFilesCount,
						staleDirectories: plannedStaleDirectoriesCount
					});
				}

				if (totalCleanupTargets > 0 && !cleanupDryRun && cleanupConfirmBeforeDelete) {
					const previewItems = [
						...cleanupPlan.filesToDelete.slice(0, 4),
						...cleanupPlan.directoriesToDelete.slice(0, 4).map((entry) => `${entry}/`)
					];
					const previewText = previewItems.join('\n');
					const decision = await vscode.window.showWarningMessage(
						`Deploy cleanup will delete ${cleanupPlan.filesToDelete.length} file(s) and ${cleanupPlan.directoriesToDelete.length} director${cleanupPlan.directoriesToDelete.length === 1 ? 'y' : 'ies'} on EV3. Continue?`,
						{
							modal: true,
							detail:
								previewItems.length > 0
									? `${previewText}${totalCleanupTargets > previewItems.length ? '\n...' : ''}`
									: undefined
						},
						'Delete Stale Entries'
					);
					if (decision !== 'Delete Stale Entries') {
						cleanupEnabled = false;
						plannedStaleFilesCount = 0;
						plannedStaleDirectoriesCount = 0;
						logger.info('Project deploy cleanup cancelled by user confirmation prompt.', {
							remoteProjectRoot,
							staleFiles: cleanupPlan.filesToDelete.length,
							staleDirectories: cleanupPlan.directoriesToDelete.length
						});
					}
				}
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: options.previewOnly
						? `Previewing EV3 deploy: ${path.basename(projectUri.fsPath)}`
						: `Deploying EV3 project: ${path.basename(projectUri.fsPath)}`,
					cancellable: false
				},
				async (progress) => {
					if (!options.previewOnly) {
						const directories = new Set<string>();
						directories.add(deployProjectRoot);
						for (const file of files) {
							directories.add(path.posix.dirname(file.remotePath));
						}
						const orderedDirectories = [...directories].sort((a, b) => pathDepth(a) - pathDepth(b));
						for (const dirPath of orderedDirectories) {
							try {
								await fsService.createDirectory(dirPath);
							} catch (error) {
								if (!isRemoteAlreadyExistsError(error)) {
									throw error;
								}
							}
						}
					}

					for (let index = 0; index < files.length; index += 1) {
						const file = files[index];
						const bytes =
							options.previewOnly && !incrementalEnabled ? undefined : await vscode.workspace.fs.readFile(file.localUri);
						if (incrementalEnabled) {
							const decision = shouldUploadByRemoteSnapshot(bytes ?? new Uint8Array(), remoteIndex.get(file.remotePath));
							if (!decision.upload) {
								skippedUnchangedCount += 1;
								progress.report({
									increment: 100 / files.length,
									message: `Skipped unchanged ${index + 1}/${files.length}: ${file.relativePath}`
								});
								continue;
							}
						}

						if (options.previewOnly) {
							plannedUploadCount += 1;
							uploadedBytes += bytes?.length ?? file.sizeBytes;
							if (previewUploadSamples.length < 8) {
								previewUploadSamples.push(file.relativePath);
							}
							progress.report({
								increment: 100 / files.length,
								message: `Would upload ${index + 1}/${files.length}: ${file.relativePath}`
							});
						} else {
							if (effectiveConflictPolicy !== 'overwrite') {
								const exists = await remoteFileExists(file.remotePath);
								if (exists) {
									let promptChoice: DeployConflictPromptChoice;
									if (effectiveConflictPolicy === 'ask' && !conflictBulkDecision) {
										const choice = await vscode.window.showWarningMessage(
											`Remote file already exists: ${file.remotePath}`,
											{
												modal: true,
												detail: 'Choose how deploy should resolve this file conflict.'
											},
											'Overwrite',
											'Skip',
											'Overwrite All',
											'Skip All'
										);
										promptChoice = choice as DeployConflictPromptChoice;
									}
									const resolvedConflict = resolveDeployConflictDecision({
										policy: effectiveConflictPolicy,
										bulkDecision: conflictBulkDecision,
										promptChoice
									});
									const decision = resolvedConflict.decision;
									conflictBulkDecision = resolvedConflict.nextBulkDecision ?? conflictBulkDecision;

									if (decision === 'skip') {
										skippedByConflictCount += 1;
										progress.report({
											increment: 100 / files.length,
											message: `Skipped conflict ${index + 1}/${files.length}: ${file.relativePath}`
										});
										continue;
									}

									overwrittenConflictCount += 1;
								}
							}

							await fsService.writeFile(file.remotePath, bytes ?? new Uint8Array());
							if (verifyAfterUpload !== 'none') {
								await verifyUploadedFile(fsService, file.remotePath, bytes ?? new Uint8Array(), verifyAfterUpload);
								verifiedFilesCount += 1;
							}
							uploadedFilesCount += 1;
							uploadedBytes += (bytes ?? new Uint8Array()).length;
							progress.report({
								increment: 100 / files.length,
								message: `Uploaded ${index + 1}/${files.length}: ${file.relativePath}`
							});
						}
					}

					if (cleanupEnabled) {
						if (cleanupDryRun || options.previewOnly) {
							progress.report({
								message: `${options.previewOnly ? 'Cleanup preview' : 'Cleanup dry-run'}: ${plannedStaleFilesCount} file(s), ${plannedStaleDirectoriesCount} director${plannedStaleDirectoriesCount === 1 ? 'y' : 'ies'} planned`
							});
						} else {
							for (const filePath of cleanupPlan.filesToDelete) {
								await fsService.deleteFile(filePath);
								deletedStaleFilesCount += 1;
								progress.report({
									message: `Deleted stale file: ${path.posix.basename(filePath)}`
								});
							}

							for (const dirPath of cleanupPlan.directoriesToDelete) {
								try {
									await fsService.deleteFile(dirPath);
									deletedStaleDirectoriesCount += 1;
								} catch (error) {
									logger.warn('Deploy cleanup directory delete skipped', {
										path: dirPath,
										message: error instanceof Error ? error.message : String(error)
									});
								}
							}
						}
					}
				}
			);

			if (atomicEnabled && !options.previewOnly) {
				logger.info('Atomic deploy swap started', {
					remoteProjectRoot,
					atomicStagingRoot,
					atomicBackupRoot
				});

				let backupCreated = false;
				try {
					const currentRootKind = await getRemotePathKind(fsService, remoteProjectRoot);
					if (currentRootKind !== 'missing') {
						await renameRemotePath(fsService, remoteProjectRoot, atomicBackupRoot, { overwrite: true });
						backupCreated = true;
					}

					await renameRemotePath(fsService, atomicStagingRoot, remoteProjectRoot, { overwrite: true });

					if (backupCreated) {
						try {
							await deleteRemotePath(fsService, atomicBackupRoot, { recursive: true });
						} catch (cleanupError) {
							logger.warn('Atomic deploy backup cleanup failed', {
								path: atomicBackupRoot,
								message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
							});
						}
					}
				} catch (swapError) {
					logger.warn('Atomic deploy swap failed, attempting rollback.', {
						remoteProjectRoot,
						atomicStagingRoot,
						atomicBackupRoot,
						message: swapError instanceof Error ? swapError.message : String(swapError)
					});

					if (backupCreated) {
						try {
							const rootKindAfterSwapError = await getRemotePathKind(fsService, remoteProjectRoot);
							if (rootKindAfterSwapError !== 'missing') {
								await deleteRemotePath(fsService, remoteProjectRoot, { recursive: true });
							}
							await renameRemotePath(fsService, atomicBackupRoot, remoteProjectRoot, { overwrite: true });
							logger.info('Atomic deploy rollback completed.', {
								remoteProjectRoot,
								atomicBackupRoot
							});
						} catch (rollbackError) {
							logger.error('Atomic deploy rollback failed.', {
								remoteProjectRoot,
								atomicBackupRoot,
								message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
							});
						}
					}

					throw swapError;
				} finally {
					try {
						const stagingKind = await getRemotePathKind(fsService, atomicStagingRoot);
						if (stagingKind !== 'missing') {
							await deleteRemotePath(fsService, atomicStagingRoot, { recursive: true });
						}
					} catch (stagingCleanupError) {
						logger.warn('Atomic deploy staging cleanup failed', {
							path: atomicStagingRoot,
							message: stagingCleanupError instanceof Error ? stagingCleanupError.message : String(stagingCleanupError)
						});
					}
				}
			}

			if (!options.previewOnly && options.runAfterDeploy && runTarget) {
				await fsService.runProgram(runTarget);
				markProgramStarted(runTarget, 'deploy-project-run');
			}

			logger.info(
				options.previewOnly
					? 'Deploy project preview completed'
					: options.runAfterDeploy
					? 'Deploy project and run completed'
					: 'Deploy project sync completed',
				{
				localProjectPath: projectUri.fsPath,
				remoteProjectRoot,
				filesScanned: files.length,
				filesUploaded: uploadedFilesCount,
				filesVerified: verifiedFilesCount,
				filesPlannedUpload: plannedUploadCount,
				filesSkippedUnchanged: skippedUnchangedCount,
				filesSkippedByConflict: skippedByConflictCount,
				filesOverwrittenConflict: overwrittenConflictCount,
				incrementalEnabled,
				cleanupEnabled,
				cleanupDryRun,
				atomicEnabled,
				verifyAfterUpload,
				conflictPolicy: effectiveConflictPolicy,
				totalUploadedBytes: uploadedBytes,
				deletedStaleFilesCount,
				deletedStaleDirectoriesCount,
				plannedStaleFilesCount,
				plannedStaleDirectoriesCount,
				skippedDirectories: scan.skippedDirectories.length,
				skippedByExtension: scan.skippedByExtension.length,
				skippedByIncludeGlob: scan.skippedByIncludeGlob.length,
				skippedByExcludeGlob: scan.skippedByExcludeGlob.length,
				skippedBySize: scan.skippedBySize.length,
				runAfterDeploy: options.runAfterDeploy,
				previewOnly: options.previewOnly,
				runTarget: runTarget ?? null
			});
			if (options.previewOnly && previewUploadSamples.length > 0) {
				logger.info('Deploy preview upload sample', {
					remoteProjectRoot,
					files: previewUploadSamples
				});
			}
			if (options.previewOnly && (plannedStaleFilesCount > 0 || plannedStaleDirectoriesCount > 0)) {
				logger.info('Deploy preview cleanup sample', {
					remoteProjectRoot,
					files: cleanupPlan.filesToDelete.slice(0, 8),
					directories: cleanupPlan.directoriesToDelete.slice(0, 8)
				});
			}

			if (
				scan.skippedDirectories.length > 0 ||
				scan.skippedByExtension.length > 0 ||
				scan.skippedByIncludeGlob.length > 0 ||
				scan.skippedByExcludeGlob.length > 0 ||
				scan.skippedBySize.length > 0
			) {
				logger.info('Deploy project scan skipped entries', {
					skippedDirectories: scan.skippedDirectories,
					skippedByExtension: scan.skippedByExtension,
					skippedByIncludeGlob: scan.skippedByIncludeGlob,
					skippedByExcludeGlob: scan.skippedByExcludeGlob,
					skippedBySize: scan.skippedBySize
				});
			}

			const cleanupSummary =
				cleanupEnabled && (cleanupDryRun || options.previewOnly)
					? `; cleanup planned ${plannedStaleFilesCount} file(s), ${plannedStaleDirectoriesCount} director${plannedStaleDirectoriesCount === 1 ? 'y' : 'ies'}`
					: cleanupEnabled || deletedStaleFilesCount > 0 || deletedStaleDirectoriesCount > 0
					? `; cleanup deleted ${deletedStaleFilesCount} file(s), ${deletedStaleDirectoriesCount} director${deletedStaleDirectoriesCount === 1 ? 'y' : 'ies'}`
					: '';
			const conflictSummary =
				effectiveConflictPolicy !== 'overwrite'
					? `; conflict skipped ${skippedByConflictCount}, overwritten ${overwrittenConflictCount} (${effectiveConflictPolicy})`
					: '';

			if (options.previewOnly) {
				vscode.window.showInformationMessage(
					`Preview: ${plannedUploadCount}/${files.length} file(s) would upload${cleanupSummary}. See EV3 Cockpit output for sample paths.`
				);
			} else {
				const verifySummary =
					verifyAfterUpload !== 'none'
						? `; verified ${verifiedFilesCount} file(s) (${verifyAfterUpload})`
						: '';
				const targetSummary =
					options.runAfterDeploy && runTarget
						? ` and started: ev3://active${runTarget}`
						: ` to ev3://active${remoteProjectRoot}`;
				vscode.window.showInformationMessage(
					`Deployed ${uploadedFilesCount}/${files.length} file(s)${targetSummary}${cleanupSummary}${verifySummary}${conflictSummary}`
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				options.previewOnly
					? 'Deploy project preview failed'
					: options.runAfterDeploy
					? 'Deploy project and run failed'
					: 'Deploy project sync failed',
				{
				localProjectPath: projectUri.fsPath,
				remoteProjectRoot,
				message
			});
			vscode.window.showErrorMessage(
				options.previewOnly
					? `Deploy project preview failed: ${message}`
					: options.runAfterDeploy
					? `Deploy project and run failed: ${message}`
					: `Deploy project sync failed: ${message}`
			);
		}
	};

	const previewProjectDeploy = vscode.commands.registerCommand('ev3-cockpit.previewProjectDeploy', async () => {
		await executeProjectDeploy({ runAfterDeploy: false, previewOnly: true });
	});

	const deployProject = vscode.commands.registerCommand('ev3-cockpit.deployProject', async () => {
		await executeProjectDeploy({ runAfterDeploy: false, previewOnly: false });
	});

	const deployProjectAndRunRbf = vscode.commands.registerCommand('ev3-cockpit.deployProjectAndRunRbf', async () => {
		await executeProjectDeploy({ runAfterDeploy: true, previewOnly: false });
	});

	const runRemoteProgram = vscode.commands.registerCommand('ev3-cockpit.runRemoteProgram', async () => {
		if (!activeFsService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}
		const fsService = activeFsService;

		const input = await vscode.window.showInputBox({
			title: 'Run EV3 Program (.rbf)',
			prompt: 'Remote path or ev3://active/... URI',
			value: lastRunProgramPath ?? '/home/root/lms2012/prjs/',
			validateInput: (value) => {
				try {
					normalizeRunProgramPath(value);
					return undefined;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			}
		});
		if (!input) {
			return;
		}

		try {
			const runPath = normalizeRunProgramPath(input);
			await fsService.runProgram(runPath);
			markProgramStarted(runPath, 'run-command');
			logger.info('Run program command completed', {
				path: runPath
			});
			vscode.window.showInformationMessage(`Program started: ev3://active${runPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn('Run program command failed', {
				message
			});
			vscode.window.showErrorMessage(`Run program failed: ${message}`);
		}
	});

	const stopProgram = vscode.commands.registerCommand('ev3-cockpit.stopProgram', async () => {
		if (!activeControlService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}

		try {
			await activeControlService.stopProgram();
			clearProgramSession('stop-program-command');
			vscode.window.showInformationMessage('Program stop command sent to EV3.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error('Program stop failed', { message });
			vscode.window.showErrorMessage(`Program stop failed: ${message}`);
		}
	});

	const restartProgram = vscode.commands.registerCommand('ev3-cockpit.restartProgram', async () => {
		if (!activeFsService || !activeControlService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}

		let runPath = activeProgramSession?.remotePath ?? lastRunProgramPath;
		if (!runPath) {
			const input = await vscode.window.showInputBox({
				title: 'Restart EV3 Program (.rbf)',
				prompt: 'Remote path or ev3://active/... URI',
				value: '/home/root/lms2012/prjs/',
				validateInput: (value) => {
					try {
						normalizeRunProgramPath(value);
						return undefined;
					} catch (error) {
						return error instanceof Error ? error.message : String(error);
					}
				}
			});
			if (!input) {
				return;
			}
			runPath = normalizeRunProgramPath(input);
		}

		try {
			await activeControlService.stopProgram();
			await activeFsService.runProgram(runPath);
			markProgramStarted(runPath, 'restart-command');
			logger.info('Restart program command completed', {
				path: runPath
			});
			vscode.window.showInformationMessage(`Program restarted: ev3://active${runPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error('Restart program failed', { message });
			vscode.window.showErrorMessage(`Restart program failed: ${message}`);
		}
	});

	const emergencyStop = vscode.commands.registerCommand('ev3-cockpit.emergencyStop', async () => {
		if (!activeControlService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}

		try {
			await activeControlService.emergencyStopAll();
			clearProgramSession('emergency-stop-command');
			vscode.window.showInformationMessage('Emergency stop command sent to EV3.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error('Emergency stop failed', { message });
			vscode.window.showErrorMessage(`Emergency stop failed: ${message}`);
		}
	});

	const inspectTransports = vscode.commands.registerCommand('ev3-cockpit.inspectTransports', async () => {
		const [usbCandidates, serialCandidates] = await Promise.all([
			listUsbHidCandidates(),
			listSerialCandidates()
		]);

		logger.info('Transport discovery snapshot', {
			usbCandidates,
			serialCandidates
		});

		vscode.window.showInformationMessage(
			`Transport discovery done: USB=${usbCandidates.length}, Serial=${serialCandidates.length}. See output channel EV3 Cockpit.`
		);
	});

	const transportHealthReport = vscode.commands.registerCommand('ev3-cockpit.transportHealthReport', async () => {
		const [usbCandidates, serialCandidates] = await Promise.all([
			listUsbHidCandidates(),
			listSerialCandidates()
		]);

		logger.info('Transport health report discovery snapshot', {
			usbCandidates,
			serialCandidates,
			activeProgramSession
		});

		const modes: Array<'usb' | 'tcp' | 'bluetooth'> = ['usb', 'tcp', 'bluetooth'];
		const results: Array<{ mode: 'usb' | 'tcp' | 'bluetooth'; status: 'PASS' | 'SKIP' | 'FAIL'; message: string }> = [];
		for (const mode of modes) {
			const result = await runTransportProbe(mode);
			results.push(result);
			logger.info('Transport health probe result', result);
		}

		const pass = results.filter((entry) => entry.status === 'PASS').length;
		const skip = results.filter((entry) => entry.status === 'SKIP').length;
		const fail = results.filter((entry) => entry.status === 'FAIL').length;
		vscode.window.showInformationMessage(
			`Transport health report: PASS=${pass}, SKIP=${skip}, FAIL=${fail}. See EV3 Cockpit output for details.`
		);
	});

	const browseRemoteFs = vscode.commands.registerCommand('ev3-cockpit.browseRemoteFs', async () => {
		if (!activeFsService) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}
		const fsService = activeFsService;

		const handleBinaryFile = async (uri: vscode.Uri, remotePath: string): Promise<void> => {
			const items: Array<
				vscode.QuickPickItem & {
					action: 'preview' | 'download' | 'run';
				}
			> = [
				{
					label: 'Open Preview',
					description: 'Open in editor preview (binary/text detection handled by VS Code).',
					action: 'preview'
				},
				{
					label: 'Download to Local...',
					description: 'Save a local copy of this remote EV3 file.',
					action: 'download'
				}
			];
			if (remotePath.toLowerCase().endsWith('.rbf')) {
				items.push({
					label: 'Run on EV3',
					description: 'Load and start this bytecode program in USER slot.',
					action: 'run'
				});
			}

			const action = await vscode.window.showQuickPick(items, {
				title: `Binary file: ${path.posix.basename(remotePath)}`,
				placeHolder: 'Choose action'
			});
			if (!action) {
				return;
			}

			if (action.action === 'preview') {
				await vscode.commands.executeCommand('vscode.open', uri);
				return;
			}

			if (action.action === 'run') {
				try {
					await fsService.runProgram(remotePath);
					markProgramStarted(remotePath, 'remote-fs-run');
					logger.info('Remote FS run program completed', {
						path: remotePath
					});
					vscode.window.showInformationMessage(`Program started: ev3://active${remotePath}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn('Remote FS run program failed', {
						path: remotePath,
						message
					});
					vscode.window.showErrorMessage(`Cannot run ${uri.toString()}. Detail: ${message}`);
				}
				return;
			}

			const defaultFileName = path.posix.basename(remotePath) || 'ev3-binary.bin';
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
			const target = await vscode.window.showSaveDialog({
				saveLabel: 'Download EV3 File',
				defaultUri:
					workspaceRoot !== undefined
						? vscode.Uri.joinPath(workspaceRoot, defaultFileName)
						: vscode.Uri.file(path.join(process.cwd(), defaultFileName))
			});
			if (!target) {
				return;
			}

			const bytes = await vscode.workspace.fs.readFile(uri);
			await vscode.workspace.fs.writeFile(target, bytes);
			vscode.window.showInformationMessage(`Downloaded ${uri.toString()} to ${target.fsPath}.`);
		};

		const featureConfig = readFeatureConfig();
		let currentPath = featureConfig.fs.defaultRoots[0] ?? '/';
		if (!currentPath.startsWith('/')) {
			currentPath = `/${currentPath}`;
		}
		if (!currentPath.endsWith('/')) {
			currentPath = `${currentPath}/`;
		}

		let browsing = true;
		while (browsing) {
			let listing;
			try {
				listing = await fsService.listDirectory(currentPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn('Remote FS browse listing failed', {
					path: currentPath,
					message
				});
				vscode.window.showErrorMessage(`EV3 browse failed for ${currentPath}: ${message}`);
				break;
			}
			type FsQuickPick = vscode.QuickPickItem & {
				action: 'up' | 'dir' | 'file' | 'upload' | 'mkdir' | 'delete';
				targetPath: string;
			};

			const picks: FsQuickPick[] = [];
			picks.push({
				label: '$(upload) Upload File Here...',
				description: currentPath,
				action: 'upload',
				targetPath: currentPath
			});
			picks.push({
				label: '$(new-folder) Create Folder...',
				description: currentPath,
				action: 'mkdir',
				targetPath: currentPath
			});
			picks.push({
				label: '$(trash) Delete Entry...',
				description: currentPath,
				action: 'delete',
				targetPath: currentPath
			});

			if (currentPath !== '/') {
				const trimmed = currentPath.endsWith('/') ? currentPath.slice(0, -1) : currentPath;
				const parent = path.posix.dirname(trimmed);
				picks.push({
					label: '$(arrow-up) ..',
					description: parent,
					action: 'up',
					targetPath: parent === '/' ? '/' : `${parent}/`
				});
			}

			for (const folder of [...listing.folders].sort((a, b) => a.localeCompare(b))) {
				const targetPath = path.posix.join(currentPath, folder);
				picks.push({
					label: `$(folder) ${folder}/`,
					description: targetPath,
					action: 'dir',
					targetPath: `${targetPath}/`
				});
			}

			for (const file of [...listing.files].sort((a, b) => a.name.localeCompare(b.name))) {
				const targetPath = path.posix.join(currentPath, file.name);
				picks.push({
					label: `$(file) ${file.name}`,
					description: `${file.size} B`,
					detail: targetPath,
					action: 'file',
					targetPath
				});
			}

			const selected = await vscode.window.showQuickPick(picks, {
				title: `ev3://active${currentPath}`,
				placeHolder: 'Select folder to enter or file to open'
			});
			if (!selected) {
				browsing = false;
				continue;
			}

			if (selected.action === 'up' || selected.action === 'dir') {
				currentPath = selected.targetPath;
				continue;
			}

			if (selected.action === 'upload') {
				const locals = await vscode.window.showOpenDialog({
					canSelectMany: true,
					canSelectFolders: false,
					canSelectFiles: true,
					openLabel: 'Upload to EV3'
				});
				if (!locals || locals.length === 0) {
					continue;
				}

				let uploaded = 0;
				for (const local of locals) {
					const remotePath = buildRemotePathFromLocal(currentPath, local.fsPath);
					try {
						const bytes = await vscode.workspace.fs.readFile(local);
						await fsService.writeFile(remotePath, bytes);
						uploaded += 1;
					} catch (error) {
						logger.warn('Remote FS upload failed', {
							localPath: local.fsPath,
							remotePath,
							message: error instanceof Error ? error.message : String(error)
						});
					}
				}

				if (uploaded > 0) {
					vscode.window.showInformationMessage(`Uploaded ${uploaded} file(s) to ev3://active${currentPath}`);
				}
				continue;
			}

			if (selected.action === 'mkdir') {
				const folderName = await vscode.window.showInputBox({
					title: `Create folder in ev3://active${currentPath}`,
					placeHolder: 'Folder name',
					validateInput: (value) =>
						isValidRemoteEntryName(value) ? undefined : 'Use non-empty name without "/" or "\\".'
				});
				if (!folderName) {
					continue;
				}

				const remotePath = buildRemoteChildPath(currentPath, folderName);
				try {
					await fsService.createDirectory(remotePath);
					vscode.window.showInformationMessage(`Folder created: ev3://active${remotePath}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn('Remote FS mkdir failed', {
						path: remotePath,
						message
					});
					vscode.window.showErrorMessage(`Cannot create folder ${remotePath}. Detail: ${message}`);
				}
				continue;
			}

			if (selected.action === 'delete') {
				type DeletePick = vscode.QuickPickItem & {
					targetPath: string;
					isDirectory: boolean;
				};

				const deleteTargets: DeletePick[] = [
					...listing.folders
						.sort((a, b) => a.localeCompare(b))
						.map((folder) => ({
							label: `$(folder) ${folder}/`,
							targetPath: buildRemoteChildPath(currentPath, folder),
							isDirectory: true
						})),
					...listing.files
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((file) => ({
							label: `$(file) ${file.name}`,
							targetPath: buildRemoteChildPath(currentPath, file.name),
							isDirectory: false
						}))
				];

				if (deleteTargets.length === 0) {
					vscode.window.showInformationMessage(`Nothing to delete in ev3://active${currentPath}`);
					continue;
				}

				const toDelete = await vscode.window.showQuickPick(deleteTargets, {
					title: `Delete entry in ev3://active${currentPath}`,
					placeHolder: 'Select file or folder to delete'
				});
				if (!toDelete) {
					continue;
				}

				const confirm = await vscode.window.showWarningMessage(
					`Delete ev3://active${toDelete.targetPath}?`,
					{ modal: true },
					'Delete'
				);
				if (confirm !== 'Delete') {
					continue;
				}

				const targetUri = vscode.Uri.parse(`ev3://active${toDelete.targetPath}`);
				try {
					await vscode.workspace.fs.delete(targetUri, { recursive: toDelete.isDirectory, useTrash: false });
					vscode.window.showInformationMessage(`Deleted ev3://active${toDelete.targetPath}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn('Remote FS delete failed', {
						path: toDelete.targetPath,
						message
					});
					vscode.window.showErrorMessage(`Cannot delete ${targetUri.toString()}. Detail: ${message}`);
				}
				continue;
			}

			const uri = vscode.Uri.parse(`ev3://active${selected.targetPath}`);
			try {
				if (isLikelyBinaryPath(selected.targetPath)) {
					await handleBinaryFile(uri, selected.targetPath);
					continue;
				}

				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, {
					preview: false
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/binary/i.test(message)) {
					await handleBinaryFile(uri, selected.targetPath);
					continue;
				}

				logger.warn('Remote FS open failed', {
					path: selected.targetPath,
					message
				});
				vscode.window.showErrorMessage(`Cannot open ${uri.toString()}. Detail: ${message}`);
			}
		}
	});

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

	context.subscriptions.push(
		disposable,
		deployAndRunRbf,
		previewProjectDeploy,
		deployProject,
		deployProjectAndRunRbf,
		runRemoteProgram,
		stopProgram,
		restartProgram,
		reconnect,
		disconnect,
		emergencyStop,
		inspectTransports,
		transportHealthReport,
		browseRemoteFs,
		configWatcher,
		fsDisposable,
		output,
		{
		dispose: () => {
			scheduler.dispose();
			activeFsService = undefined;
			activeControlService = undefined;
			clearProgramSession('extension-dispose');
			void commandClient.close();
		}
		}
	);
}

export function deactivate() {}
