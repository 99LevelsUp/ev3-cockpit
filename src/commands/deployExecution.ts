import * as vscode from 'vscode';
import * as path from 'node:path';
import { DeployConflictAskFallback, DeployConflictPolicy, DeployVerifyMode } from '../config/deployConfig';
import { DeployConflictBulkDecision, DeployConflictPromptChoice, resolveDeployConflictDecision } from '../fs/deployConflict';
import { RemoteFileSnapshot, shouldUploadByRemoteSnapshotMeta } from '../fs/deployIncremental';
import { computeFileMd5Hex } from '../fs/hashUtils';
import { verifyUploadedFile } from '../fs/deployVerify';
import { deleteRemotePath, getRemotePathKind, renameRemotePath } from '../fs/remoteFsOps';
import { RemoteFsService } from '../fs/remoteFsService';
import { Logger } from '../diagnostics/logger';
import { withTiming, isPerfEnabled } from '../diagnostics/perfTiming';
import { performance } from 'node:perf_hooks';
import { toErrorMessage } from './commandUtils';
import { LocalProjectFileEntry } from './deployTypes';

function isRemoteAlreadyExistsError(error: unknown): boolean {
	const message = toErrorMessage(error);
	return /FILE_EXISTS/i.test(message);
}

function pathDepth(remotePath: string): number {
	return remotePath.split('/').filter((part) => part.length > 0).length;
}

export interface DeployExecutionContext {
	logger: Logger;
	correlationId: string;
	targetBrickId: string;
	fsService: RemoteFsService;
	runDeployStepWithResilience: <T>(step: string, action: () => Promise<T>) => Promise<T>;
}

export interface DeployExecutionPlan {
	files: LocalProjectFileEntry[];
	deployProjectRoot: string;
	remoteProjectRoot: string;
	incrementalEnabled: boolean;
	cleanupEnabled: boolean;
	cleanupDryRun: boolean;
	verifyAfterUpload: DeployVerifyMode;
	effectiveConflictPolicy: DeployConflictPolicy;
	conflictAskFallback: DeployConflictAskFallback;
	remoteIndex: Map<string, RemoteFileSnapshot>;
	cleanupPlan: { filesToDelete: string[]; directoriesToDelete: string[] };
	previewOnly: boolean;
}

export interface DeployExecutionResult {
	uploadedFilesCount: number;
	verifiedFilesCount: number;
	skippedUnchangedCount: number;
	skippedByConflictCount: number;
	overwrittenConflictCount: number;
	conflictFallbackAppliedCount: number;
	uploadedBytes: number;
	plannedUploadCount: number;
	deletedStaleFilesCount: number;
	deletedStaleDirectoriesCount: number;
	previewUploadSamples: string[];
}

export async function executeDeployPlan(
	ctx: DeployExecutionContext,
	plan: DeployExecutionPlan,
	progress: vscode.Progress<{ increment?: number; message?: string }>,
	token: vscode.CancellationToken
): Promise<DeployExecutionResult> {
	const { logger, correlationId, targetBrickId, fsService, runDeployStepWithResilience } = ctx;
	const {
		files, deployProjectRoot,
		incrementalEnabled, cleanupEnabled, cleanupDryRun,
		verifyAfterUpload, effectiveConflictPolicy, conflictAskFallback,
		remoteIndex, cleanupPlan, previewOnly
	} = plan;

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
	const previewUploadSamples: string[] = [];
	const uploadStartedAt = performance.now();

	const conflictDirectoryCache = new Map<string, Set<string>>();
	let conflictBulkDecision: DeployConflictBulkDecision;

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

	const throwIfCancelled = (): void => {
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
	};

	throwIfCancelled();
	if (!previewOnly) {
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
		// [experimental.parallelUploads] When enabled, replace this sequential loop
		// with a concurrency-limited parallel upload strategy (e.g. process N files
		// at a time using a semaphore or work-stealing queue). The concurrency limit
		// should be configurable and default to a conservative value (e.g. 3).
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
			previewOnly
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

		if (previewOnly) {
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
					const conflictDecision = resolvedConflict.decision;
					conflictBulkDecision = resolvedConflict.nextBulkDecision ?? conflictBulkDecision;

					if (conflictDecision === 'skip') {
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
		if (cleanupDryRun || previewOnly) {
			const plannedStaleFilesCount = cleanupPlan.filesToDelete.length;
			const plannedStaleDirectoriesCount = cleanupPlan.directoriesToDelete.length;
			progress.report({
				message: `${previewOnly ? 'Cleanup preview' : 'Cleanup dry-run'}: ${plannedStaleFilesCount} file(s), ${plannedStaleDirectoriesCount} director${plannedStaleDirectoriesCount === 1 ? 'y' : 'ies'} planned`
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

	if (isPerfEnabled() && uploadedFilesCount > 0) {
		const uploadDurationMs = performance.now() - uploadStartedAt;
		const throughputBytesPerSec = uploadDurationMs > 0 ? Math.round((uploadedBytes / uploadDurationMs) * 1000) : 0;
		const avgFileMs = uploadDurationMs > 0 ? Number((uploadDurationMs / uploadedFilesCount).toFixed(1)) : 0;
		logger.info('[perf] deploy.upload-throughput', {
			correlationId,
			brickId: targetBrickId,
			totalBytes: uploadedBytes,
			uploadDurationMs: Number(uploadDurationMs.toFixed(1)),
			throughputBytesPerSec,
			uploadedFilesCount,
			avgFileUploadMs: avgFileMs
		});
	}

	return {
		uploadedFilesCount,
		verifiedFilesCount,
		skippedUnchangedCount,
		skippedByConflictCount,
		overwrittenConflictCount,
		conflictFallbackAppliedCount,
		uploadedBytes,
		plannedUploadCount,
		deletedStaleFilesCount,
		deletedStaleDirectoriesCount,
		previewUploadSamples
	};
}

export interface DeployAtomicSwapContext {
	logger: Logger;
	fsService: RemoteFsService;
	remoteProjectRoot: string;
	atomicStagingRoot: string;
	atomicBackupRoot: string;
}

export async function executeAtomicSwap(ctx: DeployAtomicSwapContext): Promise<void> {
	const { logger, fsService, remoteProjectRoot, atomicStagingRoot, atomicBackupRoot } = ctx;

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
