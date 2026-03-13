/**
 * Deploy orchestration utilities for EV3 project deployment.
 *
 * @remarks
 * This module provides the pure-logic layer for deploying local projects to
 * a remote EV3 brick filesystem. It computes remote paths (including
 * atomic-staging paths), maps scanned local files to deploy entries,
 * resolves the preferred executable run-target, and provides a resilient
 * step-runner with retry/reconnect support.
 *
 * All functions are side-effect-free except {@link createDeployStepRunner},
 * which wraps async actions with retry logic.
 *
 * @see {@link ../fs/deployActions} for lower-level deploy helpers
 * @see {@link ../fs/deployResilience} for transient-error detection and sleep
 *
 * @module deployOrchestration
 */

import * as path from 'node:path';
import { Logger } from '../diagnostics/logger';
import { isDeployTransientTransportError, sleepMs } from '../fs/deployResilience';
import {
	buildRemoteProjectRoot,
	choosePreferredExecutableCandidate,
	isExecutableFileName
} from '../fs/deployActions';
import { LocalProjectFileEntry, LocalScannedFile } from './deployTypes';

/**
 * Describes the shape of a deploy operation request.
 *
 * @remarks
 * The two boolean flags determine which variant of the deploy workflow
 * is executed: preview-only, deploy-and-run, or plain sync.
 * These flags are mutually prioritised — {@link previewOnly} takes
 * precedence over {@link runAfterDeploy} when both are `true`.
 *
 * @see {@link describeDeployOperation} for mapping these flags to UI labels
 */
export interface DeployOperationShape {
	/** When `true`, the deploy only simulates changes without writing to the brick. */
	previewOnly: boolean;
	/** When `true`, the deployed program is automatically started after upload completes. */
	runAfterDeploy: boolean;
}

/**
 * All computed remote filesystem paths needed for a deploy operation.
 *
 * @remarks
 * When atomic deploy is enabled, files are first uploaded to
 * {@link atomicStagingRoot}, then swapped into {@link remoteProjectRoot}
 * in a single rename, with the previous version moved to
 * {@link atomicBackupRoot}. This minimises the window during which the
 * project on the brick is in an incomplete state.
 *
 * The {@link deployProjectRoot} accessor resolves to either the staging
 * root or the direct project root depending on whether atomic mode is on.
 *
 * @see {@link buildDeployRoots} for the factory that produces this structure
 */
export interface DeployRoots {
	/** Final remote path of the project on the EV3 brick (e.g. `/home/robot/myProject`). */
	remoteProjectRoot: string;
	/** Parent directory of the remote project root (e.g. `/home/robot`). */
	remoteProjectParent: string;
	/** Basename of the remote project directory (e.g. `myProject`). */
	remoteProjectName: string;
	/**
	 * Unique tag for atomic staging/backup directory names.
	 *
	 * @remarks
	 * Derived from the current timestamp and a random component, both
	 * encoded in base-36, to avoid collisions across concurrent deploys.
	 */
	atomicTag: string;
	/** Hidden staging directory where files are uploaded before the atomic swap. */
	atomicStagingRoot: string;
	/** Hidden backup directory where the previous project version is moved during swap. */
	atomicBackupRoot: string;
	/**
	 * The effective root used for uploading files.
	 *
	 * @remarks
	 * Equals {@link atomicStagingRoot} when atomic deploy is enabled,
	 * otherwise equals {@link remoteProjectRoot} for direct-write mode.
	 */
	deployProjectRoot: string;
}

/**
 * Configuration for the deploy resilience (retry) strategy.
 *
 * @remarks
 * Controls whether failed deploy steps are automatically retried and,
 * if so, how many times, with what delay, and whether the transport
 * connection should be cycled between attempts.
 *
 * Only transient transport errors (as classified by
 * {@link isDeployTransientTransportError}) are eligible for retry;
 * cancellation and non-transient errors always propagate immediately.
 *
 * @see {@link createDeployStepRunner} which consumes this config
 */
export interface DeployResilienceConfig {
	/** Master switch — when `false`, all retry logic is bypassed. */
	enabled: boolean;
	/** Maximum number of retry attempts per deploy step (0 = no retries). */
	maxRetries: number;
	/** Delay in milliseconds to wait between retry attempts. */
	retryDelayMs: number;
	/** When `true`, close and reopen the transport connection before each retry. */
	reopenConnection: boolean;
}

/**
 * Runtime callbacks required by the deploy resilience step runner.
 *
 * @remarks
 * Separates pure retry logic from the side-effectful operations it
 * needs (logging, cancellation detection, connection management).
 * Supplied by the caller so the orchestration layer stays testable
 * without real transport connections.
 *
 * @see {@link createDeployStepRunner} which consumes this runtime
 */
export interface DeployResilienceRuntime {
	/** Logger instance for recording retry warnings and diagnostic context. */
	logger: Logger;
	/**
	 * Predicate that returns `true` when the given error represents
	 * user-initiated cancellation (e.g. VS Code `CancellationToken`).
	 * Cancellation errors are never retried.
	 */
	isCancellationError: (error: unknown) => boolean;
	/** Closes the current transport/command-client connection. */
	closeCommandClient: () => Promise<void>;
	/** Opens (or reopens) the transport/command-client connection. */
	openCommandClient: () => Promise<void>;
}

/**
 * Returns human-readable labels for each deploy operation variant.
 *
 * @remarks
 * Maps the {@link DeployOperationShape} flags to a set of UI strings used
 * in progress notifications, status messages, and command palette labels.
 *
 * Priority order:
 * 1. `previewOnly` → preview labels (no actual writes)
 * 2. `runAfterDeploy` → deploy-and-run labels
 * 3. Otherwise → plain sync labels
 *
 * @param input - The deploy operation shape describing which variant is active.
 * @returns An object with localised status strings for the operation lifecycle.
 *
 * @example
 * ```ts
 * const labels = describeDeployOperation({ previewOnly: false, runAfterDeploy: true });
 * console.log(labels.progressTitle); // "Deploying EVƎ project"
 * ```
 */
export function describeDeployOperation(input: DeployOperationShape): {
	started: string;
	completed: string;
	failed: string;
	progressTitle: string;
	openLabel: string;
} {
	// Preview-only: no files are written, user inspects planned changes
	if (input.previewOnly) {
		return {
			started: 'Deploy preview started',
			completed: 'Deploy preview completed',
			failed: 'Deploy project preview failed',
			progressTitle: 'Previewing EVƎ deploy',
			openLabel: 'Preview Project Deploy Changes'
		};
	}
	// Deploy + auto-run: upload then immediately start the program
	if (input.runAfterDeploy) {
		return {
			started: 'Deploy and run started',
			completed: 'Deploy and run completed',
			failed: 'Deploy project and run failed',
			progressTitle: 'Deploying EVƎ project',
			openLabel: 'Deploy Project to EV3'
		};
	}
	// Default: plain sync — upload files without running afterwards
	return {
		started: 'Deploy sync started',
		completed: 'Deploy sync completed',
		failed: 'Deploy project sync failed',
		progressTitle: 'Deploying EVƎ project',
		openLabel: 'Sync Project to EV3'
	};
}

/**
 * Computes all remote filesystem paths required for a deploy operation.
 *
 * @remarks
 * Derives the canonical remote project root from the local project path
 * and default root, then generates unique atomic staging and backup
 * directory names using a timestamp + random tag. The tag is base-36
 * encoded for compactness on the EV3's limited filesystem display.
 *
 * When `atomicEnabled` is `true`, {@link DeployRoots.deployProjectRoot}
 * points to the staging directory; otherwise it points directly to the
 * final project root (in-place deploy).
 *
 * @param projectFsPath - Absolute local filesystem path of the project folder.
 * @param defaultRoot - Default remote root directory on the EV3 (e.g. `/home/robot`).
 * @param atomicEnabled - Whether to use atomic (staging + swap) deploy.
 * @param now - Current epoch milliseconds, used for the atomic tag. Defaults to `Date.now()`.
 * @param random - Random number generator (`[0, 1)`), used for the atomic tag. Defaults to `Math.random`.
 * @returns A fully populated {@link DeployRoots} structure.
 *
 * @example
 * ```ts
 * const roots = buildDeployRoots('/home/user/myProject', '/home/robot', true);
 * console.log(roots.deployProjectRoot); // staging path like "/home/robot/.myProject.ev3-cockpit-staging-..."
 * ```
 */
export function buildDeployRoots(
	projectFsPath: string,
	defaultRoot: string,
	atomicEnabled: boolean,
	now: number = Date.now(),
	random: () => number = Math.random
): DeployRoots {
	// Derive the canonical remote root from the local project name + configured default root
	const remoteProjectRoot = buildRemoteProjectRoot(projectFsPath, defaultRoot);
	const remoteProjectParent = path.posix.dirname(remoteProjectRoot);
	const remoteProjectName = path.posix.basename(remoteProjectRoot);

	// Build a collision-resistant tag from timestamp + random, both in base-36 for brevity
	const atomicTag = `${now.toString(36)}-${Math.floor(random() * 10_000).toString(36)}`;

	// Hidden staging dir: files are uploaded here first during atomic deploy
	const atomicStagingRoot = path.posix.join(
		remoteProjectParent,
		`.${remoteProjectName}.ev3-cockpit-staging-${atomicTag}`
	);
	// Hidden backup dir: the previous project version is moved here during the swap
	const atomicBackupRoot = path.posix.join(
		remoteProjectParent,
		`.${remoteProjectName}.ev3-cockpit-backup-${atomicTag}`
	);
	return {
		remoteProjectRoot,
		remoteProjectParent,
		remoteProjectName,
		atomicTag,
		atomicStagingRoot,
		atomicBackupRoot,
		// Atomic mode writes to staging dir; direct mode writes straight to the final root
		deployProjectRoot: atomicEnabled ? atomicStagingRoot : remoteProjectRoot
	};
}

/**
 * Maps locally scanned project files to deploy entries with computed remote paths.
 *
 * @remarks
 * Each scanned file's relative path is normalised to POSIX separators and
 * joined with the deploy project root to produce the target remote path.
 * Files whose names match known executable patterns (`.rbf`, `.elf`, etc.)
 * are flagged via {@link LocalProjectFileEntry.isExecutable}.
 *
 * @param files - Read-only array of locally scanned files from the project tree.
 * @param deployProjectRoot - The remote directory root under which files will be placed
 *   (may be an atomic staging root or the final project root).
 * @returns An array of {@link LocalProjectFileEntry} objects ready for upload.
 *
 * @example
 * ```ts
 * const entries = mapScannedFilesToDeployEntries(scanned, '/home/robot/myProject');
 * entries.forEach(e => console.log(e.remotePath));
 * ```
 */
export function mapScannedFilesToDeployEntries(
	files: readonly LocalScannedFile[],
	deployProjectRoot: string
): LocalProjectFileEntry[] {
	return files.map((entry) => {
		// Convert OS-specific separators (e.g. backslash on Windows) to POSIX forward-slash
		const relativePosix = entry.relativePath.split(path.sep).join('/');
		return {
			localUri: entry.localUri,
			relativePath: entry.relativePath,
			remotePath: path.posix.join(deployProjectRoot, relativePosix),
			sizeBytes: entry.sizeBytes,
			isExecutable: isExecutableFileName(path.basename(entry.localUri.fsPath))
		};
	});
}

/**
 * Selects the preferred executable from a set of deploy entries.
 *
 * @remarks
 * Filters the entries to those marked as executable, then delegates to
 * {@link choosePreferredExecutableCandidate} which applies heuristics
 * (e.g. preferring `main.rbf` over other executables) to pick the
 * best candidate. Returns `undefined` when no executables are present.
 *
 * The returned path uses the final {@link remoteProjectRoot} (not the
 * staging root), because run-after-deploy happens after the atomic swap.
 *
 * @param entries - Read-only array of deploy entries to search.
 * @param remoteProjectRoot - The final remote project root (post-swap) for
 *   constructing the executable's absolute remote path.
 * @returns The absolute remote path of the chosen executable, or `undefined`
 *   if no executable files were found among the entries.
 *
 * @example
 * ```ts
 * const target = resolveRunTarget(entries, '/home/robot/myProject');
 * if (target) {
 *   console.log(`Will run: ${target}`);
 * }
 * ```
 */
export function resolveRunTarget(entries: readonly LocalProjectFileEntry[], remoteProjectRoot: string): string | undefined {
	const executableFiles = entries.filter((entry) => entry.isExecutable);
	if (executableFiles.length === 0) {
		return undefined;
	}
	// Re-derive absolute remote paths using the final project root, not the staging root
	return choosePreferredExecutableCandidate(
		executableFiles.map((entry) =>
			path.posix.join(remoteProjectRoot, entry.relativePath.split(path.sep).join('/'))
		)
	);
}

/**
 * Creates a resilient step runner that wraps deploy actions with retry logic.
 *
 * @remarks
 * Returns a generic async function that executes a named deploy step and
 * automatically retries on transient transport errors (e.g. USB disconnects,
 * TCP timeouts). The retry policy is governed by {@link DeployResilienceConfig}.
 *
 * On each retry:
 * 1. The error is classified — cancellation errors propagate immediately.
 * 2. Transient transport errors trigger a retry if the attempt budget allows.
 * 3. If {@link DeployResilienceConfig.reopenConnection} is `true`, the
 *    transport connection is cycled (close + open) before the next attempt.
 * 4. A configurable delay is applied between retries.
 *
 * Non-transient or budget-exhausted errors are re-thrown as-is.
 *
 * @param config - Resilience configuration (retries, delay, reconnect toggle).
 * @param runtime - Runtime callbacks for logging, cancellation, and connection management.
 * @returns A step-runner function: `(step: string, action: () => Promise<T>) => Promise<T>`.
 *
 * @throws Re-throws the original error when retries are exhausted or the error is non-transient.
 *
 * @example
 * ```ts
 * const runStep = createDeployStepRunner(resilienceConfig, resilienceRuntime);
 * await runStep('upload file', () => client.writeFile(remotePath, data));
 * ```
 *
 * @see {@link DeployResilienceConfig}
 * @see {@link DeployResilienceRuntime}
 */
export function createDeployStepRunner(
	config: DeployResilienceConfig,
	runtime: DeployResilienceRuntime
): <T>(step: string, action: () => Promise<T>) => Promise<T> {
	return async <T>(step: string, action: () => Promise<T>): Promise<T> => {
		// Infinite loop with internal break — attempt counter tracks retries
		for (let attempt = 0; ; ) {
			try {
				return await action();
			} catch (error) {
				// Cancellation is always fatal — never retry a user-initiated abort
				if (runtime.isCancellationError(error)) {
					throw error;
				}

				const message = error instanceof Error ? error.message : String(error);

				// Only retry when resilience is enabled, budget remains, and error is transient
				const canRetry =
					config.enabled &&
					attempt < config.maxRetries &&
					isDeployTransientTransportError(message);
				if (!canRetry) {
					throw error;
				}

				attempt += 1;
				runtime.logger.warn('Deploy step failed, retrying.', {
					step,
					attempt,
					maxRetries: config.maxRetries,
					reopenConnection: config.reopenConnection,
					delayMs: config.retryDelayMs,
					message
				});

				// Optionally cycle the connection to recover from transport-level faults
				if (config.reopenConnection) {
					try {
						await runtime.closeCommandClient();
					} catch {
						// ignore close errors during reconnect attempt
					}
					await runtime.openCommandClient();
				}

				// Back-off before the next attempt
				await sleepMs(config.retryDelayMs);
			}
		}
	};
}
