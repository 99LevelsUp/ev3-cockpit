import * as path from 'node:path';
import { Logger } from '../diagnostics/logger';
import { isDeployTransientTransportError, sleepMs } from '../fs/deployResilience';
import {
	buildRemoteProjectRoot,
	choosePreferredExecutableCandidate,
	isExecutableFileName
} from '../fs/deployActions';
import { LocalProjectFileEntry, LocalScannedFile } from './deployTypes';

export interface DeployOperationShape {
	previewOnly: boolean;
	runAfterDeploy: boolean;
}

export interface DeployRoots {
	remoteProjectRoot: string;
	remoteProjectParent: string;
	remoteProjectName: string;
	atomicTag: string;
	atomicStagingRoot: string;
	atomicBackupRoot: string;
	deployProjectRoot: string;
}

export interface DeployResilienceConfig {
	enabled: boolean;
	maxRetries: number;
	retryDelayMs: number;
	reopenConnection: boolean;
}

export interface DeployResilienceRuntime {
	logger: Logger;
	isCancellationError: (error: unknown) => boolean;
	closeCommandClient: () => Promise<void>;
	openCommandClient: () => Promise<void>;
}

export function describeDeployOperation(input: DeployOperationShape): {
	started: string;
	completed: string;
	failed: string;
	progressTitle: string;
	openLabel: string;
} {
	if (input.previewOnly) {
		return {
			started: 'Deploy preview started',
			completed: 'Deploy preview completed',
			failed: 'Deploy project preview failed',
			progressTitle: 'Previewing EVƎ deploy',
			openLabel: 'Preview Project Deploy Changes'
		};
	}
	if (input.runAfterDeploy) {
		return {
			started: 'Deploy and run started',
			completed: 'Deploy and run completed',
			failed: 'Deploy project and run failed',
			progressTitle: 'Deploying EVƎ project',
			openLabel: 'Deploy Project to EV3'
		};
	}
	return {
		started: 'Deploy sync started',
		completed: 'Deploy sync completed',
		failed: 'Deploy project sync failed',
		progressTitle: 'Deploying EVƎ project',
		openLabel: 'Sync Project to EV3'
	};
}

export function buildDeployRoots(
	projectFsPath: string,
	defaultRoot: string,
	atomicEnabled: boolean,
	now: number = Date.now(),
	random: () => number = Math.random
): DeployRoots {
	const remoteProjectRoot = buildRemoteProjectRoot(projectFsPath, defaultRoot);
	const remoteProjectParent = path.posix.dirname(remoteProjectRoot);
	const remoteProjectName = path.posix.basename(remoteProjectRoot);
	const atomicTag = `${now.toString(36)}-${Math.floor(random() * 10_000).toString(36)}`;
	const atomicStagingRoot = path.posix.join(
		remoteProjectParent,
		`.${remoteProjectName}.ev3-cockpit-staging-${atomicTag}`
	);
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
		deployProjectRoot: atomicEnabled ? atomicStagingRoot : remoteProjectRoot
	};
}

export function mapScannedFilesToDeployEntries(
	files: readonly LocalScannedFile[],
	deployProjectRoot: string
): LocalProjectFileEntry[] {
	return files.map((entry) => {
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

export function resolveRunTarget(entries: readonly LocalProjectFileEntry[], remoteProjectRoot: string): string | undefined {
	const executableFiles = entries.filter((entry) => entry.isExecutable);
	if (executableFiles.length === 0) {
		return undefined;
	}
	return choosePreferredExecutableCandidate(
		executableFiles.map((entry) =>
			path.posix.join(remoteProjectRoot, entry.relativePath.split(path.sep).join('/'))
		)
	);
}

export function createDeployStepRunner(
	config: DeployResilienceConfig,
	runtime: DeployResilienceRuntime
): <T>(step: string, action: () => Promise<T>) => Promise<T> {
	return async <T>(step: string, action: () => Promise<T>): Promise<T> => {
		for (let attempt = 0; ; ) {
			try {
				return await action();
			} catch (error) {
				if (runtime.isCancellationError(error)) {
					throw error;
				}

				const message = error instanceof Error ? error.message : String(error);
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
				if (config.reopenConnection) {
					try {
						await runtime.closeCommandClient();
					} catch {
						// ignore close errors during reconnect attempt
					}
					await runtime.openCommandClient();
				}
				await sleepMs(config.retryDelayMs);
			}
		}
	};
}
