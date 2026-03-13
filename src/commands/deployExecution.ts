/**
 * Deploy plan execution engine that uploads files and verifies integrity.
 *
 * @packageDocumentation
 */

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

/**
 * Checks whether an error indicates a remote FILE_EXISTS conflict.
 *
 * @param error - The error to inspect.
 * @returns `true` if the error message contains `FILE_EXISTS`.
 */
function isRemoteAlreadyExistsError(error: unknown): boolean {
	const message = toErrorMessage(error);
	return /FILE_EXISTS/i.test(message);
}

/**
 * Counts the number of non-empty path segments in a POSIX path.
 * Used to sort directories by depth so parents are created before children.
 *
 * @param remotePath - POSIX-style remote path.
 * @returns The depth (number of non-empty segments).
 */
function pathDepth(remotePath: string): number {
	return remotePath.split('/').filter((part) => part.length > 0).length;
}

/**
 * Runtime context provided to {@link executeDeployPlan}.
 *
 * @remarks
 * Bundles the logger, correlation ID, target brick, filesystem service,
 * and the resilience-wrapped step runner into a single context object.
 */
export interface DeployExecutionContext {
	/** Logger instance for diagnostics. */
	logger: Logger;
	/** Correlation ID for tracing this deploy operation across log entries. */
	correlationId: string;
	/** Brick ID of the deploy target. */
	targetBrickId: string;
	/** Remote filesystem service for the target brick. */
	fsService: RemoteFsService;
	/** Resilience-wrapped step runner that retries transient transport errors. */
	runDeployStepWithResilience: <T>(step: string, action: () => Promise<T>) => Promise<T>;
}

/**
 * Complete plan for a deploy execution pass.
 *
 * @remarks
 * Captures all inputs needed by {@link executeDeployPlan}: the file list,
 * remote paths, feature flags (incremental, cleanup, atomic, verify, conflict),
 * the pre-built remote index, cleanup plan, and preview flag.
 */
export interface DeployExecutionPlan {
	/** Files to upload, each with local URI, remote path, and metadata. */
	files: LocalProjectFileEntry[];
	/** The effective remote root for file uploads (staging root if atomic). */
	deployProjectRoot: string;
	/** The final remote project root (the user-facing path). */
	remoteProjectRoot: string;
	/** Whether incremental (diff-based) upload skipping is enabled. */
	incrementalEnabled: boolean;
	/** Whether stale-entry cleanup is enabled after upload. */
	cleanupEnabled: boolean;
	/** When `true`, cleanup logs what would be deleted without acting. */
	cleanupDryRun: boolean;
	/** Post-upload verification strategy. */
	verifyAfterUpload: DeployVerifyMode;
	/** Effective conflict policy after preview/config resolution. */
	effectiveConflictPolicy: DeployConflictPolicy;
	/** Fallback behaviour when conflict policy is `'ask'` but no prompt is possible. */
	conflictAskFallback: DeployConflictAskFallback;
	/** Pre-built remote file index for incremental/conflict checks. */
	remoteIndex: Map<string, RemoteFileSnapshot>;
	/** Pre-computed cleanup plan listing files and directories to delete. */
	cleanupPlan: { filesToDelete: string[]; directoriesToDelete: string[] };
	/** When `true`, generates a plan only — no files are actually uploaded. */
	previewOnly: boolean;
}

/**
 * Detailed result counters from a deploy execution pass.
 *
 * @remarks
 * Returned by {@link executeDeployPlan}. Covers upload, verification,
 * skip (incremental/conflict), cleanup, and preview statistics.
 */
export interface DeployExecutionResult {
	/** Number of files actually uploaded to the brick. */
	uploadedFilesCount: number;
	/** Number of files that passed post-upload verification. */
	verifiedFilesCount: number;
	/** Number of files skipped because the remote copy is unchanged (incremental). */
	skippedUnchangedCount: number;
	/** Number of files skipped due to a conflict policy decision (skip). */
	skippedByConflictCount: number;
	/** Number of existing remote files overwritten after conflict resolution. */
	overwrittenConflictCount: number;
	/** Number of files where the ask-fallback policy was applied automatically. */
	conflictFallbackAppliedCount: number;
	/** Total bytes uploaded (or planned in preview mode). */
	uploadedBytes: number;
	/** Number of files that *would* be uploaded (preview mode only). */
	plannedUploadCount: number;
	/** Number of stale remote files deleted during cleanup. */
	deletedStaleFilesCount: number;
	/** Number of stale remote directories deleted during cleanup. */
	deletedStaleDirectoriesCount: number;
	/** Up to 8 sample relative paths of files planned for upload (preview). */
	previewUploadSamples: string[];
}

/**
 * Executes a deploy plan: creates directories, uploads files, resolves
 * conflicts, verifies uploads, and cleans up stale entries.
 *
 * @remarks
 * The execution proceeds in four phases:
 * 1. **Directory creation** — ensures all required remote directories exist,
 *    sorted by depth so parents are created first.
 * 2. **File upload** — iterates files sequentially, applying incremental skip,
 *    conflict resolution (ask/overwrite/skip with bulk decisions), and
 *    post-upload verification.
 * 3. **Cleanup** — deletes stale remote files and directories not present in
 *    the local project layout.
 * 4. **Perf logging** — emits upload throughput metrics when perf is enabled.
 *
 * Supports preview mode where no writes occur — only counters are accumulated.
 * Supports cancellation via the VS Code cancellation token.
 *
 * @param ctx - Runtime context with logger, FS service, and resilience runner.
 * @param plan - The deploy plan with files, paths, and feature flags.
 * @param progress - VS Code progress reporter for UI updates.
 * @param token - Cancellation token to abort the operation.
 * @returns Detailed result counters.
 *
 * @throws {@link vscode.CancellationError} if the user cancels.
 *
 * @see {@link DeployExecutionContext}
 * @see {@link DeployExecutionPlan}
 * @see {@link DeployExecutionResult}
 */
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

	// Cache of directory listings used for per-file conflict checks
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

	// --- Phase 1: Create all required remote directories (sorted by depth) ---
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

	// --- Phase 2: Upload files sequentially with incremental/conflict/verify ---
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

	// --- Phase 3: Clean up stale remote entries not present in local project ---
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

	// --- Phase 4: Log upload throughput metrics when perf is enabled ---
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

/**
 * Context for an atomic deploy swap operation.
 *
 * @remarks
 * Used by {@link executeAtomicSwap} to perform a three-step atomic root
 * replacement: backup → rename staging → cleanup.
 */
export interface DeployAtomicSwapContext {
	/** Logger for diagnostics. */
	logger: Logger;
	/** Remote filesystem service. */
	fsService: RemoteFsService;
	/** The final user-facing remote project root. */
	remoteProjectRoot: string;
	/** Temporary staging root where new files were uploaded. */
	atomicStagingRoot: string;
	/** Temporary backup root for the previous project version. */
	atomicBackupRoot: string;
}

/**
 * Performs an atomic root swap: replaces the project root with the staging
 * root in a single rename operation, with rollback on failure.
 *
 * @remarks
 * Steps:
 * 1. Rename current project root → backup root (if it exists)
 * 2. Rename staging root → project root
 * 3. Delete backup root (best-effort)
 *
 * If step 2 fails, the backup is restored to the project root. The staging
 * directory is cleaned up in a `finally` block regardless of success/failure.
 *
 * @param ctx - Atomic swap context with paths and services.
 * @throws Re-throws the swap error after attempting rollback.
 *
 * @see {@link DeployAtomicSwapContext}
 */
export async function executeAtomicSwap(ctx: DeployAtomicSwapContext): Promise<void> {
	const { logger, fsService, remoteProjectRoot, atomicStagingRoot, atomicBackupRoot } = ctx;

	logger.info('Atomic deploy swap started', {
		remoteProjectRoot,
		atomicStagingRoot,
		atomicBackupRoot
	});

	let backupCreated = false;
	try {
		// Step 1: Back up current project root (if it exists on the brick)
		const currentRootKind = await getRemotePathKind(fsService, remoteProjectRoot);
		if (currentRootKind !== 'missing') {
			await renameRemotePath(fsService, remoteProjectRoot, atomicBackupRoot, { overwrite: true });
			backupCreated = true;
		}

		// Step 2: Rename staging root → project root (the atomic swap)
		await renameRemotePath(fsService, atomicStagingRoot, remoteProjectRoot, { overwrite: true });

		// Step 3: Delete backup root (best-effort; failure is non-fatal)
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
		// Swap failed — attempt rollback by restoring the backup
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
		// Always clean up the staging directory regardless of success/failure
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
