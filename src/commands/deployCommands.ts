import * as vscode from 'vscode';
import * as path from 'node:path';
import { DEPLOY_PROFILE_PRESETS } from '../config/deployProfiles';
import { readFeatureConfig } from '../config/featureConfig';
import {
	buildRemoteDeployPath,
	buildRemoteProjectRoot,
	choosePreferredExecutableCandidate,
	isExecutableFileName
} from '../fs/deployActions';
import { DeployConflictPromptChoice, resolveDeployConflictDecision } from '../fs/deployConflict';
import { buildLocalProjectLayout, planRemoteCleanup } from '../fs/deployCleanup';
import { RemoteFileSnapshot, shouldUploadByRemoteSnapshotMeta } from '../fs/deployIncremental';
import { computeFileMd5Hex } from '../fs/hashUtils';
import { isDeployTransientTransportError, sleepMs } from '../fs/deployResilience';
import { verifyUploadedFile } from '../fs/deployVerify';
import { runRemoteExecutable } from '../fs/remoteExecutable';
import { deleteRemotePath, getRemotePathKind, renameRemotePath } from '../fs/remoteFsOps';
import { RemoteFsService } from '../fs/remoteFsService';
import { nextCorrelationId, withTiming } from '../diagnostics/perfTiming';
import { toErrorMessage, withBrickOperation } from './commandUtils';
import { resolveDeployFlow } from './deployFlow';
import { collectLocalFilesRecursive, collectRemoteFileIndexRecursive } from './deployScan';
import {
	DeployCommandOptions,
	DeployCommandRegistrations,
	DeployTargetContext,
	LocalProjectFileEntry,
	ProjectDeployRequest
} from './deployTypes';

function isRemoteAlreadyExistsError(error: unknown): boolean {
	const message = toErrorMessage(error);
	return /FILE_EXISTS/i.test(message);
}

function pathDepth(remotePath: string): number {
	return remotePath.split('/').filter((part) => part.length > 0).length;
}

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
		options.onBrickOperation(
			targetBrickId,
			deployOptions.previewOnly
				? 'Deploy preview started'
				: deployOptions.runAfterDeploy
				? 'Deploy and run started'
				: 'Deploy sync started'
		);
		const isCancellationError = (error: unknown): boolean =>
			error instanceof vscode.CancellationError || (error instanceof Error && error.name === 'Canceled');

		let projectUri = deployOptions.projectUri;
		if (!projectUri) {
			const selection = await vscode.window.showOpenDialog({
				canSelectMany: false,
				canSelectFiles: false,
				canSelectFolders: true,
				openLabel: deployOptions.previewOnly
					? 'Preview Project Deploy Changes'
					: deployOptions.runAfterDeploy
					? 'Deploy Project to EV3'
					: 'Sync Project to EV3'
			});
			if (!selection || selection.length === 0) {
				return;
			}
			projectUri = selection[0];
		}
		const featureConfig = readFeatureConfig();
		const deployResilience = featureConfig.deploy.resilience;
		const runDeployStepWithResilience = async <T>(step: string, action: () => Promise<T>): Promise<T> => {
			for (let attempt = 0; ; ) {
				try {
					return await action();
				} catch (error) {
					if (isCancellationError(error)) {
						throw error;
					}

					const message = toErrorMessage(error);
					const canRetry =
						deployResilience.enabled &&
						attempt < deployResilience.maxRetries &&
						isDeployTransientTransportError(message);
					if (!canRetry) {
						throw error;
					}

					attempt += 1;
					logger.warn('Deploy step failed, retrying.', {
						step,
						attempt,
						maxRetries: deployResilience.maxRetries,
						reopenConnection: deployResilience.reopenConnection,
						delayMs: deployResilience.retryDelayMs,
						message
					});
					if (deployResilience.reopenConnection) {
						try {
							await commandClient.close();
						} catch {
							// ignore close errors during reconnect attempt
						}
						await commandClient.open();
					}
					await sleepMs(deployResilience.retryDelayMs);
				}
			}
		};
		const defaultRoot = fsTarget.rootPath ?? featureConfig.fs.defaultRoots[0] ?? '/home/root/lms2012/prjs/';
		let remoteProjectRoot: string;
		try {
			remoteProjectRoot = buildRemoteProjectRoot(projectUri.fsPath, defaultRoot);
		} catch (error) {
			const message = toErrorMessage(error);
			vscode.window.showErrorMessage(`Deploy path error: ${message}`);
			return;
		}
		const atomicEnabled = featureConfig.deploy.atomicEnabled && !deployOptions.previewOnly;
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

			const files: LocalProjectFileEntry[] = scan.files.map((entry) => {
				const relativePosix = entry.relativePath.split(path.sep).join('/');
				return {
					localUri: entry.localUri,
					relativePath: entry.relativePath,
					remotePath: path.posix.join(deployProjectRoot, relativePosix),
					sizeBytes: entry.sizeBytes,
					isExecutable: isExecutableFileName(path.basename(entry.localUri.fsPath))
				};
			});

			let runTarget: string | undefined;
			if (deployOptions.runAfterDeploy) {
				const executableFiles = files.filter((entry) => entry.isExecutable);
				if (executableFiles.length === 0) {
					vscode.window.showErrorMessage(`No executable file found in project folder "${projectUri.fsPath}".`);
					return;
				}

				runTarget = choosePreferredExecutableCandidate(
					executableFiles.map((entry) =>
						path.posix.join(remoteProjectRoot, entry.relativePath.split(path.sep).join('/'))
					)
				);
				if (!runTarget) {
					vscode.window.showErrorMessage('Could not determine executable run target.');
					return;
				}

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
			const effectiveConflictPolicy = deployOptions.previewOnly ? 'overwrite' : conflictPolicy;
			if (effectiveConflictPolicy === 'ask' && conflictAskFallback !== 'prompt') {
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

			let uploadedFilesCount = 0;
			let verifiedFilesCount = 0;
			let skippedUnchangedCount = 0;
			let skippedByConflictCount = 0;
			let overwrittenConflictCount = 0;
			let conflictFallbackAppliedCount = 0;
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

				const listing = await runDeployStepWithResilience('conflict-list-directory', () =>
					fsService.listDirectory(parent)
				);
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
					title: deployOptions.previewOnly
						? `Previewing EV3 deploy: ${path.basename(projectUri.fsPath)}`
						: `Deploying EV3 project: ${path.basename(projectUri.fsPath)}`,
					cancellable: true
				},
				async (progress, token) => {
					const throwIfCancelled = (): void => {
						if (token.isCancellationRequested) {
							throw new vscode.CancellationError();
						}
					};

					throwIfCancelled();
					if (!deployOptions.previewOnly) {
						const directories = new Set<string>();
						directories.add(deployProjectRoot);
						for (const file of files) {
							directories.add(path.posix.dirname(file.remotePath));
						}
						const orderedDirectories = [...directories].sort((a, b) => pathDepth(a) - pathDepth(b));
						for (const dirPath of orderedDirectories) {
							throwIfCancelled();
							try {
								await runDeployStepWithResilience('create-directory', () => fsService.createDirectory(dirPath));
							} catch (error) {
								if (!isRemoteAlreadyExistsError(error)) {
									throw error;
								}
							}
						}
					}

					for (let index = 0; index < files.length; index += 1) {
						throwIfCancelled();
						const file = files[index];
						if (incrementalEnabled) {
							const remoteSnapshot = remoteIndex.get(file.remotePath);
							let decision: { upload: boolean; localMd5: string } | undefined;
							if (!remoteSnapshot || remoteSnapshot.sizeBytes !== file.sizeBytes) {
								decision = {
									upload: true,
									localMd5: ''
								};
							} else {
								const localMd5 = await withTiming(
									logger,
									'deploy.compute-local-md5',
									() => computeFileMd5Hex(file.localUri.fsPath),
									{
										correlationId,
										brickId: targetBrickId,
										file: file.relativePath,
										fileIndex: index + 1,
										fileCount: files.length
									}
								);
								decision = shouldUploadByRemoteSnapshotMeta(file.sizeBytes, localMd5, remoteSnapshot);
							}
							if (!decision.upload) {
								skippedUnchangedCount += 1;
								progress.report({
									increment: 100 / files.length,
									message: `Skipped unchanged ${index + 1}/${files.length}: ${file.relativePath}`
								});
								continue;
							}
						}

						const bytes =
							deployOptions.previewOnly
								? undefined
								: await withTiming(
									logger,
									'deploy.read-local-file',
									() => vscode.workspace.fs.readFile(file.localUri),
									{
										correlationId,
										brickId: targetBrickId,
										file: file.relativePath,
										fileIndex: index + 1,
										fileCount: files.length
									}
								);

						if (deployOptions.previewOnly) {
							plannedUploadCount += 1;
							uploadedBytes += file.sizeBytes;
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
										if (conflictAskFallback === 'overwrite') {
											promptChoice = 'Overwrite';
											conflictFallbackAppliedCount += 1;
										} else if (conflictAskFallback === 'skip') {
											promptChoice = 'Skip';
											conflictFallbackAppliedCount += 1;
										} else {
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

							await withTiming(
								logger,
								'deploy.write-remote-file',
								() =>
									runDeployStepWithResilience('write-file', () =>
										fsService.writeFile(file.remotePath, bytes ?? new Uint8Array())
									),
								{
									correlationId,
									brickId: targetBrickId,
									file: file.relativePath,
									remotePath: file.remotePath,
									bytes: (bytes ?? new Uint8Array()).length,
									fileIndex: index + 1,
									fileCount: files.length
								}
							);
							if (verifyAfterUpload !== 'none') {
								await withTiming(
									logger,
									'deploy.verify-upload',
									() =>
										runDeployStepWithResilience('verify-upload', () =>
											verifyUploadedFile(fsService, file.remotePath, bytes ?? new Uint8Array(), verifyAfterUpload)
										),
									{
										correlationId,
										brickId: targetBrickId,
										file: file.relativePath,
										remotePath: file.remotePath,
										mode: verifyAfterUpload,
										fileIndex: index + 1,
										fileCount: files.length
									}
								);
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
						if (cleanupDryRun || deployOptions.previewOnly) {
							progress.report({
								message: `${deployOptions.previewOnly ? 'Cleanup preview' : 'Cleanup dry-run'}: ${plannedStaleFilesCount} file(s), ${plannedStaleDirectoriesCount} director${plannedStaleDirectoriesCount === 1 ? 'y' : 'ies'} planned`
							});
						} else {
							for (const filePath of cleanupPlan.filesToDelete) {
								throwIfCancelled();
								await runDeployStepWithResilience('cleanup-delete-file', () => fsService.deleteFile(filePath));
								deletedStaleFilesCount += 1;
								progress.report({
									message: `Deleted stale file: ${path.posix.basename(filePath)}`
								});
							}

							for (const dirPath of cleanupPlan.directoriesToDelete) {
								throwIfCancelled();
								try {
									await runDeployStepWithResilience('cleanup-delete-directory', () => fsService.deleteFile(dirPath));
									deletedStaleDirectoriesCount += 1;
								} catch (error) {
									logger.warn('Deploy cleanup directory delete skipped', {
										path: dirPath,
										message: toErrorMessage(error)
									});
								}
							}
						}
					}
				}
			);

			if (atomicEnabled && !deployOptions.previewOnly) {
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

			logger.info(
				deployOptions.previewOnly
					? 'Deploy project preview completed'
					: deployOptions.runAfterDeploy
					? 'Deploy project and run completed'
					: 'Deploy project sync completed',
				{
				localProjectPath: projectUri.fsPath,
				remoteProjectRoot,
				brickId: targetBrickId,
				authority: targetAuthority,
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
				logger.info('Deploy preview upload sample', {
					remoteProjectRoot,
					files: previewUploadSamples
				});
			}
			if (deployOptions.previewOnly && (plannedStaleFilesCount > 0 || plannedStaleDirectoriesCount > 0)) {
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
				options.onBrickOperation(targetBrickId, 'Deploy preview completed');
				vscode.window.showInformationMessage(
					`Preview: ${plannedUploadCount}/${files.length} file(s) would upload${cleanupSummary}. See EV3 Cockpit output for sample paths.`
				);
			} else {
				options.onBrickOperation(
					targetBrickId,
					deployOptions.runAfterDeploy ? 'Deploy and run completed' : 'Deploy sync completed'
				);
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
				logger.info('Deploy project operation cancelled by user.', {
					localProjectPath: projectUri.fsPath,
					remoteProjectRoot,
					runAfterDeploy: deployOptions.runAfterDeploy,
					previewOnly: deployOptions.previewOnly
				});
				vscode.window.showWarningMessage('Deploy cancelled.');
				return;
			}

			const message = toErrorMessage(error);
			options.onBrickOperation(targetBrickId, 'Deploy failed');
			logger.warn(
				deployOptions.previewOnly
					? 'Deploy project preview failed'
					: deployOptions.runAfterDeploy
					? 'Deploy project and run failed'
					: 'Deploy project sync failed',
				{
				localProjectPath: projectUri.fsPath,
				remoteProjectRoot,
				brickId: targetBrickId,
				message
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
			const message = toErrorMessage(error);
			vscode.window.showErrorMessage(`Deploy path error: ${message}`);
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
			const message = toErrorMessage(error);
			logger.warn('Deploy and run failed', {
				localPath: localUri.fsPath,
				remotePath,
				message
			});
			vscode.window.showErrorMessage(`Deploy and run failed: ${message}`);
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
