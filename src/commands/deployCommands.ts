import * as vscode from 'vscode';
import * as path from 'node:path';
import { DEPLOY_PROFILE_PRESETS } from '../config/deployProfiles';
import { DeployConflictPolicy, DeployConflictAskFallback } from '../types/enums';
import { readFeatureConfig } from '../config/featureConfig';
import {
	buildRemoteDeployPath
} from '../fs/deployActions';
import { buildLocalProjectLayout, planRemoteCleanup } from '../fs/deployCleanup';
import { RemoteFileSnapshot } from '../fs/deployIncremental';
import { verifyUploadedFile } from '../fs/deployVerify';
import { runRemoteExecutable } from '../fs/remoteExecutable';
import { deleteRemotePath, getRemotePathKind } from '../fs/remoteFsOps';
import { RemoteFsService } from '../fs/remoteFsService';
import { createFlowLogger } from '../diagnostics/flowLogger';
import { nextCorrelationId, withTiming } from '../diagnostics/perfTiming';
import { presentCommandError, toErrorMessage, toUserFacingErrorMessage, withBrickOperation } from './commandUtils';
import { executeAtomicSwap, executeDeployPlan } from './deployExecution';
import { resolveDeployFlow } from './deployFlow';
import {
	buildDeployRoots,
	createDeployStepRunner,
	describeDeployOperation,
	mapScannedFilesToDeployEntries,
	resolveRunTarget
} from './deployOrchestration';
import { collectLocalFilesRecursive, collectRemoteFileIndexRecursive } from './deployScan';
import {
	DeployCommandOptions,
	DeployCommandRegistrations,
	DeployTargetContext,
	ProjectDeployRequest
} from './deployTypes';

async function pickWorkspaceProjectFolder(): Promise<vscode.Uri | undefined> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		vscode.window.showErrorMessage('No workspace folder is open.');
		return undefined;
	}

	if (workspaceFolders.length === 1) {
		return workspaceFolders[0].uri;
	}

	const pick = await vscode.window.showQuickPick(
		workspaceFolders.map((folder) => ({
			label: folder.name,
			description: folder.uri.fsPath,
			uri: folder.uri
		})),
		{
			title: 'Select workspace folder to sync',
			placeHolder: 'Choose local project folder'
		}
	);
	return pick?.uri;
}

export function registerDeployCommands(options: DeployCommandOptions): DeployCommandRegistrations {
	const executeProjectDeploy = async (deployOptions: ProjectDeployRequest): Promise<void> => {
		const logger = options.getLogger();
		const operation = describeDeployOperation(deployOptions);
		const correlationId = nextCorrelationId();
		const deployStartedAt = Date.now();
		const fsTarget: DeployTargetContext | undefined = deployOptions.target ?? (() => {
			const resolved = options.resolveFsAccessContext('active');
			if ('error' in resolved) {
				return undefined;
			}
			return {
				brickId: resolved.brickId,
				authority: resolved.authority,
				fsService: resolved.fsService
			};
		})();
		if (!fsTarget) {
			vscode.window.showErrorMessage('No EV3 connection available for deploy. Connect to a brick first.');
			return;
		}
		const commandClient = options.resolveCommandClient(fsTarget.brickId);
		if (!commandClient) {
			vscode.window.showErrorMessage(`Brick "${fsTarget.brickId}" is not connected for deploy runtime.`);
			return;
		}
		const fsService = fsTarget.fsService;
		const targetBrickId = fsTarget.brickId;
		const targetAuthority = fsTarget.authority;
		const isCancellationError = (error: unknown): boolean =>
			error instanceof vscode.CancellationError || (error instanceof Error && error.name === 'Canceled');

		let projectUri = deployOptions.projectUri;
		if (!projectUri) {
			const selection = await vscode.window.showOpenDialog({
				canSelectMany: false,
				canSelectFiles: false,
				canSelectFolders: true,
				openLabel: operation.openLabel
			});
			if (!selection || selection.length === 0) {
				return;
			}
			projectUri = selection[0];
		}
		const featureConfig = readFeatureConfig();
		const deployResilience = featureConfig.deploy.resilience;
		const runDeployStepWithResilience = createDeployStepRunner(deployResilience, {
			logger,
			isCancellationError,
			closeCommandClient: () => commandClient.close(),
			openCommandClient: () => commandClient.open()
		});
		const defaultRoot = fsTarget.rootPath ?? featureConfig.fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/';
		let remoteProjectRoot: string;
		let atomicStagingRoot = '';
		let atomicBackupRoot = '';
		let deployProjectRoot = '';
		try {
			const roots = buildDeployRoots(projectUri.fsPath, defaultRoot, featureConfig.deploy.atomicEnabled && !deployOptions.previewOnly);
			remoteProjectRoot = roots.remoteProjectRoot;
			atomicStagingRoot = roots.atomicStagingRoot;
			atomicBackupRoot = roots.atomicBackupRoot;
			deployProjectRoot = roots.deployProjectRoot;
		} catch (error) {
			vscode.window.showErrorMessage(
				presentCommandError({
					logger,
					operation: 'Resolve deploy paths',
					level: 'warn',
					context: {
						brickId: targetBrickId,
						projectPath: projectUri.fsPath,
						defaultRoot
					},
					userMessage: `Deploy path error: ${toUserFacingErrorMessage(error)}`,
					error
				})
			);
			return;
		}
		const atomicEnabled = featureConfig.deploy.atomicEnabled && !deployOptions.previewOnly;
		const flowLogger = createFlowLogger(logger, 'deploy.project', {
			correlationId,
			brickId: targetBrickId,
			authority: targetAuthority,
			projectPath: projectUri.fsPath,
			remoteProjectRoot,
			previewOnly: deployOptions.previewOnly,
			runAfterDeploy: deployOptions.runAfterDeploy
		});
		options.onBrickOperation(targetBrickId, operation.started);
		flowLogger.started();

		try {
			const scan = await withTiming(
				logger,
				'deploy.scan-local',
				() => collectLocalFilesRecursive(projectUri, featureConfig.deploy),
				{
					correlationId,
					brickId: targetBrickId,
					projectPath: projectUri.fsPath,
					previewOnly: deployOptions.previewOnly
				}
			);
			if (scan.files.length === 0) {
				vscode.window.showWarningMessage(
					`Project folder "${projectUri.fsPath}" has no deployable files after filters.`
				);
				return;
			}

			const files = mapScannedFilesToDeployEntries(scan.files, deployProjectRoot);

			let runTarget: string | undefined;
			if (deployOptions.runAfterDeploy) {
				runTarget = resolveRunTarget(files, remoteProjectRoot);
				if (!runTarget) {
					vscode.window.showErrorMessage(`No executable file found in project folder "${projectUri.fsPath}".`);
					return;
				}

				const executableFiles = files.filter((entry) => entry.isExecutable);
				if (executableFiles.length > 1) {
					const quickPickItems = executableFiles.map((entry) => ({
						label: entry.relativePath,
						description: path.posix.join(remoteProjectRoot, entry.relativePath.split(path.sep).join('/'))
					}));
					const selected = await vscode.window.showQuickPick(quickPickItems, {
						title: 'Select executable file to run after deploy',
						placeHolder: 'Choose run target'
					});
					if (!selected) {
						return;
					}
					runTarget = selected.description ?? runTarget;
				}
			}

			const cleanupConfirmBeforeDelete = featureConfig.deploy.cleanupConfirmBeforeDelete;
			const cleanupDryRun = featureConfig.deploy.cleanupDryRun;
			const flow = resolveDeployFlow({
				incrementalEnabled: featureConfig.deploy.incrementalEnabled,
				cleanupEnabled: featureConfig.deploy.cleanupEnabled,
				atomicEnabled,
				previewOnly: deployOptions.previewOnly,
				verifyAfterUpload: featureConfig.deploy.verifyAfterUpload
			});
			let incrementalEnabled = flow.incrementalEnabled;
			let cleanupEnabled = flow.cleanupEnabled;
			const verifyAfterUpload = flow.verifyAfterUpload;
			const conflictPolicy = featureConfig.deploy.conflictPolicy;
			const conflictAskFallback = featureConfig.deploy.conflictAskFallback;
			const effectiveConflictPolicy = deployOptions.previewOnly ? DeployConflictPolicy.OVERWRITE : conflictPolicy;
			if (effectiveConflictPolicy === DeployConflictPolicy.ASK && conflictAskFallback !== DeployConflictAskFallback.PROMPT) {
				logger.info('Project deploy ask conflict fallback is active.', {
					conflictAskFallback
				});
			}
			if (flow.atomicDisabledIncremental) {
				logger.info('Project deploy incremental mode disabled because atomic deploy is enabled.', {
					remoteProjectRoot,
					atomicStagingRoot
				});
			}
			if (flow.atomicDisabledCleanup) {
				logger.info('Project deploy cleanup mode disabled because atomic deploy performs full root swap.', {
					remoteProjectRoot,
					atomicStagingRoot
				});
			}
			let remoteIndex = new Map<string, RemoteFileSnapshot>();
			let remoteDirectories: string[] = [];
			if (incrementalEnabled || cleanupEnabled || effectiveConflictPolicy !== 'overwrite') {
				const remoteIndexResult = await withTiming(
					logger,
					'deploy.collect-remote-index',
					() =>
						runDeployStepWithResilience('collect-remote-index', () =>
							collectRemoteFileIndexRecursive(fsService, remoteProjectRoot)
						),
					{
						correlationId,
						brickId: targetBrickId,
						remoteProjectRoot
					}
				);
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

			let plannedStaleFilesCount = 0;
			let plannedStaleDirectoriesCount = 0;
			const localLayout = buildLocalProjectLayout(files.map((entry) => entry.relativePath));
			let cleanupPlan = {
				filesToDelete: [] as string[],
				directoriesToDelete: [] as string[]
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
						`Deploy cleanup will delete ${cleanupPlan.filesToDelete.length} file(s) and ${cleanupPlan.directoriesToDelete.length} director${cleanupPlan.directoriesToDelete.length === 1 ? 'y' : 'ies'} on EVƎ. Continue?`,
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

			const executionResult = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: deployOptions.previewOnly
						? `${operation.progressTitle}: ${path.basename(projectUri.fsPath)}`
						: `${operation.progressTitle}: ${path.basename(projectUri.fsPath)}`,
					cancellable: true
				},
				(progress, token) =>
					executeDeployPlan(
						{
							logger,
							correlationId,
							targetBrickId,
							fsService,
							runDeployStepWithResilience
						},
						{
							files,
							deployProjectRoot,
							remoteProjectRoot,
							incrementalEnabled,
							cleanupEnabled,
							cleanupDryRun,
							verifyAfterUpload,
							effectiveConflictPolicy,
							conflictAskFallback,
							remoteIndex,
							cleanupPlan,
							previewOnly: deployOptions.previewOnly
						},
						progress,
						token
					)
			);

			const {
				uploadedFilesCount, verifiedFilesCount, skippedUnchangedCount,
				skippedByConflictCount, overwrittenConflictCount, conflictFallbackAppliedCount,
				uploadedBytes, plannedUploadCount,
				deletedStaleFilesCount, deletedStaleDirectoriesCount,
				previewUploadSamples
			} = executionResult;

			if (atomicEnabled && !deployOptions.previewOnly) {
				await executeAtomicSwap({
					logger,
					fsService,
					remoteProjectRoot,
					atomicStagingRoot,
					atomicBackupRoot
				});
			}

			if (!deployOptions.previewOnly && deployOptions.runAfterDeploy && runTarget) {
				await withTiming(
					logger,
					'deploy.run-program',
					() => runDeployStepWithResilience('run-program', () => runRemoteExecutable(fsService, runTarget)),
					{
						correlationId,
						brickId: targetBrickId,
						runTarget
					}
				);
				options.markProgramStarted(runTarget, 'deploy-project-run', targetBrickId);
			}

			flowLogger.completed({
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
				conflictAskFallback,
				conflictFallbackAppliedCount,
				resilienceEnabled: deployResilience.enabled,
				resilienceMaxRetries: deployResilience.maxRetries,
				resilienceRetryDelayMs: deployResilience.retryDelayMs,
				resilienceReopenConnection: deployResilience.reopenConnection,
				totalDurationMs: Date.now() - deployStartedAt,
				correlationId,
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
				runAfterDeploy: deployOptions.runAfterDeploy,
				previewOnly: deployOptions.previewOnly,
				runTarget: runTarget ?? null
			});
			if (deployOptions.previewOnly && previewUploadSamples.length > 0) {
				flowLogger.info('preview-upload-sample', {
					remoteProjectRoot,
					files: previewUploadSamples
				});
			}
			if (deployOptions.previewOnly && (plannedStaleFilesCount > 0 || plannedStaleDirectoriesCount > 0)) {
				flowLogger.info('preview-cleanup-sample', {
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
				flowLogger.info('scan-skipped-entries', {
					skippedDirectories: scan.skippedDirectories,
					skippedByExtension: scan.skippedByExtension,
					skippedByIncludeGlob: scan.skippedByIncludeGlob,
					skippedByExcludeGlob: scan.skippedByExcludeGlob,
					skippedBySize: scan.skippedBySize
				});
			}

			const cleanupSummary =
				cleanupEnabled && (cleanupDryRun || deployOptions.previewOnly)
					? `; cleanup planned ${plannedStaleFilesCount} file(s), ${plannedStaleDirectoriesCount} director${plannedStaleDirectoriesCount === 1 ? 'y' : 'ies'}`
					: cleanupEnabled || deletedStaleFilesCount > 0 || deletedStaleDirectoriesCount > 0
					? `; cleanup deleted ${deletedStaleFilesCount} file(s), ${deletedStaleDirectoriesCount} director${deletedStaleDirectoriesCount === 1 ? 'y' : 'ies'}`
					: '';
			const conflictSummary =
				effectiveConflictPolicy !== 'overwrite'
					? `; conflict skipped ${skippedByConflictCount}, overwritten ${overwrittenConflictCount} (${effectiveConflictPolicy})`
					: '';

			if (deployOptions.previewOnly) {
				options.onBrickOperation(targetBrickId, operation.completed);
				vscode.window.showInformationMessage(
					`Preview: ${plannedUploadCount}/${files.length} file(s) would upload${cleanupSummary}. See EVƎ Cockpit output for sample paths.`
				);
			} else {
				options.onBrickOperation(targetBrickId, operation.completed);
				const verifySummary =
					verifyAfterUpload !== 'none'
					? `; verified ${verifiedFilesCount} file(s) (${verifyAfterUpload})`
						: '';
				const targetSummary =
					deployOptions.runAfterDeploy && runTarget
						? ` and started: ev3://${targetAuthority}${runTarget}`
						: ` to ev3://${targetAuthority}${remoteProjectRoot}`;
				vscode.window.showInformationMessage(
					`Deployed ${uploadedFilesCount}/${files.length} file(s)${targetSummary}${cleanupSummary}${verifySummary}${conflictSummary}`
				);
			}
		} catch (error) {
			if (isCancellationError(error)) {
				options.onBrickOperation(targetBrickId, 'Deploy cancelled');
				flowLogger.cancelled({
					localProjectPath: projectUri.fsPath,
					remoteProjectRoot,
					runAfterDeploy: deployOptions.runAfterDeploy,
					previewOnly: deployOptions.previewOnly
				});
				vscode.window.showWarningMessage('Deploy cancelled.');
				return;
			}

			const message = toUserFacingErrorMessage(error);
			options.onBrickOperation(targetBrickId, 'Deploy failed');
			flowLogger.failed(error, {
				localProjectPath: projectUri.fsPath,
				remoteProjectRoot,
				userMessage: message
			});
			vscode.window.showErrorMessage(
				deployOptions.previewOnly
					? `Deploy project preview failed: ${message}`
					: deployOptions.runAfterDeploy
					? `Deploy project and run failed: ${message}`
					: `Deploy project sync failed: ${message}`
			);
		} finally {
			if (atomicEnabled && !deployOptions.previewOnly) {
				try {
					const stagingKind = await getRemotePathKind(fsService, atomicStagingRoot);
					if (stagingKind !== 'missing') {
						await deleteRemotePath(fsService, atomicStagingRoot, { recursive: true });
						logger.info('Deploy finalizer removed stale atomic staging root.', {
							path: atomicStagingRoot
						});
					}
				} catch (cleanupError) {
					logger.warn('Deploy finalizer staging cleanup failed', {
						path: atomicStagingRoot,
						message: toErrorMessage(cleanupError)
					});
				}
			}
		}
	};

	const executeApplyDeployProfile = async (requestingBrickId?: string): Promise<void> => {
		const logger = options.getLogger();
		const picks = DEPLOY_PROFILE_PRESETS.map((profile) => ({
			label: profile.label,
			description: profile.description,
			detail: profile.detail,
			profile
		}));
		const selected = await vscode.window.showQuickPick(picks, {
			title: 'Apply EV3 Deploy Profile',
			placeHolder: 'Choose deploy profile preset'
		});
		if (!selected) {
			return;
		}

		const configTarget =
			vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
		const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
		for (const [key, value] of Object.entries(selected.profile.settings)) {
			await cfg.update(key, value, configTarget);
		}

		logger.info('Deploy profile applied', {
			profileId: selected.profile.id,
			brickId: requestingBrickId ?? 'n/a',
			target: configTarget === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'global',
			settings: selected.profile.settings
		});
		vscode.window.showInformationMessage(`Deploy profile applied: ${selected.profile.label}`);
	};

	const getActiveFsTarget = (): { brickId: string; authority: string; fsService: RemoteFsService } | undefined => {
		const resolved = options.resolveFsAccessContext('active');
		if ('error' in resolved) {
			return undefined;
		}
		return resolved;
	};

	const deployAndRunExecutable = vscode.commands.registerCommand('ev3-cockpit.deployAndRunExecutable', async () => {
		const logger = options.getLogger();
		const target = getActiveFsTarget();
		if (!target) {
			vscode.window.showErrorMessage('No active EV3 connection. Run "EV3 Cockpit: Connect to EV3 Brick" first.');
			return;
		}
		const fsService = target.fsService;

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
			vscode.window.showErrorMessage(
				presentCommandError({
					logger,
					operation: 'Resolve deploy path',
					level: 'warn',
					context: {
						brickId: target.brickId,
						localPath: localUri.fsPath,
						defaultRoot
					},
					userMessage: `Deploy path error: ${toUserFacingErrorMessage(error)}`,
					error
				})
			);
			return;
		}
		const correlationId = nextCorrelationId();

		try {
			const executable = await withBrickOperation(target.brickId, 'Deploy and run executable', options.onBrickOperation, async () => {
				const bytes = await withTiming(logger, 'deploy-single.read-local-file', () => vscode.workspace.fs.readFile(localUri), {
					correlationId,
					brickId: target.brickId,
					localPath: localUri.fsPath
				});
				await withTiming(logger, 'deploy-single.write-remote-file', () => fsService.writeFile(remotePath, bytes), {
					correlationId,
					brickId: target.brickId,
					remotePath,
					bytes: bytes.length
				});
				const verifyMode = featureConfig.deploy.verifyAfterUpload;
				if (verifyMode !== 'none') {
					await withTiming(
						logger,
						'deploy-single.verify-upload',
						() => verifyUploadedFile(fsService, remotePath, bytes, verifyMode),
						{
							correlationId,
							brickId: target.brickId,
							remotePath,
							mode: verifyMode
						}
					);
				}
				const exec = await withTiming(
					logger,
					'deploy-single.run-program',
					() => runRemoteExecutable(fsService, remotePath),
					{
						correlationId,
						brickId: target.brickId,
						remotePath
					}
				);
				options.markProgramStarted(remotePath, 'deploy-and-run-single', target.brickId);
				return { exec, bytes };
			});

			logger.info('Deploy and run completed', {
				localPath: localUri.fsPath,
				remotePath,
				size: executable.bytes.length,
				type: executable.exec.typeId,
				verifyAfterUpload: featureConfig.deploy.verifyAfterUpload
			});
			vscode.window.showInformationMessage(`Deployed and started: ev3://${target.authority}${remotePath}`);
		} catch (error) {
			vscode.window.showErrorMessage(
				presentCommandError({
					logger,
					operation: 'Deploy and run',
					level: 'warn',
					context: {
						brickId: target.brickId,
						localPath: localUri.fsPath,
						remotePath
					},
					userMessage: `Deploy and run failed: ${toUserFacingErrorMessage(error)}`,
					error
				})
			);
		}
	});

	const previewProjectDeploy = vscode.commands.registerCommand('ev3-cockpit.previewProjectDeploy', async () => {
		await executeProjectDeploy({ runAfterDeploy: false, previewOnly: true });
	});

	const deployProject = vscode.commands.registerCommand('ev3-cockpit.deployProject', async () => {
		await executeProjectDeploy({ runAfterDeploy: false, previewOnly: false });
	});

	const previewProjectDeployToBrick = vscode.commands.registerCommand(
		'ev3-cockpit.previewProjectDeployToBrick',
		async (node?: unknown) => {
			const target = options.resolveDeployTargetFromArg(node);
			if ('error' in target) {
				vscode.window.showErrorMessage(target.error);
				return;
			}

			await executeProjectDeploy({
				runAfterDeploy: false,
				previewOnly: true,
				target
			});
		}
	);

	const deployProjectToBrick = vscode.commands.registerCommand(
		'ev3-cockpit.deployProjectToBrick',
		async (node?: unknown) => {
			const target = options.resolveDeployTargetFromArg(node);
			if ('error' in target) {
				vscode.window.showErrorMessage(target.error);
				return;
			}

			await executeProjectDeploy({
				runAfterDeploy: false,
				previewOnly: false,
				target
			});
		}
	);

	const deployProjectAndRunExecutableToBrick = vscode.commands.registerCommand(
		'ev3-cockpit.deployProjectAndRunExecutableToBrick',
		async (node?: unknown) => {
			const target = options.resolveDeployTargetFromArg(node);
			if ('error' in target) {
				vscode.window.showErrorMessage(target.error);
				return;
			}

			await executeProjectDeploy({
				runAfterDeploy: true,
				previewOnly: false,
				target
			});
		}
	);

	const deployWorkspace = vscode.commands.registerCommand('ev3-cockpit.deployWorkspace', async () => {
		const workspaceUri = await pickWorkspaceProjectFolder();
		if (!workspaceUri) {
			return;
		}

		await executeProjectDeploy({
			runAfterDeploy: false,
			previewOnly: false,
			projectUri: workspaceUri
		});
	});

	const previewWorkspaceDeploy = vscode.commands.registerCommand('ev3-cockpit.previewWorkspaceDeploy', async () => {
		const workspaceUri = await pickWorkspaceProjectFolder();
		if (!workspaceUri) {
			return;
		}

		await executeProjectDeploy({
			runAfterDeploy: false,
			previewOnly: true,
			projectUri: workspaceUri
		});
	});

	const previewWorkspaceDeployToBrick = vscode.commands.registerCommand(
		'ev3-cockpit.previewWorkspaceDeployToBrick',
		async (node?: unknown) => {
			const target = options.resolveDeployTargetFromArg(node);
			if ('error' in target) {
				vscode.window.showErrorMessage(target.error);
				return;
			}

			const workspaceUri = await pickWorkspaceProjectFolder();
			if (!workspaceUri) {
				return;
			}

			await executeProjectDeploy({
				runAfterDeploy: false,
				previewOnly: true,
				projectUri: workspaceUri,
				target
			});
		}
	);

	const deployWorkspaceToBrick = vscode.commands.registerCommand(
		'ev3-cockpit.deployWorkspaceToBrick',
		async (node?: unknown) => {
			const target = options.resolveDeployTargetFromArg(node);
			if ('error' in target) {
				vscode.window.showErrorMessage(target.error);
				return;
			}

			const workspaceUri = await pickWorkspaceProjectFolder();
			if (!workspaceUri) {
				return;
			}

			await executeProjectDeploy({
				runAfterDeploy: false,
				previewOnly: false,
				projectUri: workspaceUri,
				target
			});
		}
	);

	const deployWorkspaceAndRunExecutableToBrick = vscode.commands.registerCommand(
		'ev3-cockpit.deployWorkspaceAndRunExecutableToBrick',
		async (node?: unknown) => {
			const target = options.resolveDeployTargetFromArg(node);
			if ('error' in target) {
				vscode.window.showErrorMessage(target.error);
				return;
			}

			const workspaceUri = await pickWorkspaceProjectFolder();
			if (!workspaceUri) {
				return;
			}

			await executeProjectDeploy({
				runAfterDeploy: true,
				previewOnly: false,
				projectUri: workspaceUri,
				target
			});
		}
	);

	const deployProjectAndRunExecutable = vscode.commands.registerCommand('ev3-cockpit.deployProjectAndRunExecutable', async () => {
		await executeProjectDeploy({ runAfterDeploy: true, previewOnly: false });
	});

	const deployWorkspaceAndRunExecutable = vscode.commands.registerCommand(
		'ev3-cockpit.deployWorkspaceAndRunExecutable',
		async () => {
			const workspaceUri = await pickWorkspaceProjectFolder();
			if (!workspaceUri) {
				return;
			}

			await executeProjectDeploy({
				runAfterDeploy: true,
				previewOnly: false,
				projectUri: workspaceUri
			});
		}
	);

	const applyDeployProfile = vscode.commands.registerCommand('ev3-cockpit.applyDeployProfile', async () => {
		await executeApplyDeployProfile();
	});

	const applyDeployProfileToBrick = vscode.commands.registerCommand(
		'ev3-cockpit.applyDeployProfileToBrick',
		async (node?: unknown) => {
			const target = options.resolveDeployTargetFromArg(node);
			if ('error' in target) {
				vscode.window.showErrorMessage(target.error);
				return;
			}

			await executeApplyDeployProfile(target.brickId);
		}
	);

	return {
		deployAndRunExecutable,
		previewProjectDeploy,
		deployProject,
		previewProjectDeployToBrick,
		deployProjectToBrick,
		deployProjectAndRunExecutableToBrick,
		deployWorkspace,
		previewWorkspaceDeploy,
		previewWorkspaceDeployToBrick,
		deployWorkspaceToBrick,
		deployWorkspaceAndRunExecutableToBrick,
		deployProjectAndRunExecutable,
		deployWorkspaceAndRunExecutable,
		applyDeployProfile,
		applyDeployProfileToBrick
	};
}
