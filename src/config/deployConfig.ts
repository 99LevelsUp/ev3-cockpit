import * as vscode from 'vscode';

export type DeployVerifyMode = 'none' | 'size' | 'md5';
export type DeployConflictPolicy = 'overwrite' | 'skip' | 'ask';
export type DeployConflictAskFallback = 'prompt' | 'skip' | 'overwrite';

export interface DeployResilienceConfigSnapshot {
	enabled: boolean;
	maxRetries: number;
	retryDelayMs: number;
	reopenConnection: boolean;
}

export interface DeployConfigSnapshot {
	excludeDirectories: string[];
	excludeExtensions: string[];
	includeGlobs: string[];
	excludeGlobs: string[];
	maxFileBytes: number;
	incrementalEnabled: boolean;
	cleanupEnabled: boolean;
	cleanupConfirmBeforeDelete: boolean;
	cleanupDryRun: boolean;
	atomicEnabled: boolean;
	verifyAfterUpload: DeployVerifyMode;
	conflictPolicy: DeployConflictPolicy;
	conflictAskFallback: DeployConflictAskFallback;
	resilience: DeployResilienceConfigSnapshot;
}

export const DEFAULT_DEPLOY_EXCLUDE_DIRECTORIES = ['.git', 'node_modules', '.vscode-test', 'out'];
export const DEFAULT_DEPLOY_EXCLUDE_EXTENSIONS = ['.map'];
export const DEFAULT_DEPLOY_INCLUDE_GLOBS = ['**/*'];
export const DEFAULT_DEPLOY_EXCLUDE_GLOBS: string[] = [];
export const DEFAULT_DEPLOY_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_DEPLOY_INCREMENTAL_ENABLED = false;
export const DEFAULT_DEPLOY_CLEANUP_ENABLED = false;
export const DEFAULT_DEPLOY_CLEANUP_CONFIRM_BEFORE_DELETE = true;
export const DEFAULT_DEPLOY_CLEANUP_DRY_RUN = false;
export const DEFAULT_DEPLOY_ATOMIC_ENABLED = false;
export const DEFAULT_DEPLOY_VERIFY_AFTER_UPLOAD: DeployVerifyMode = 'none';
export const DEFAULT_DEPLOY_CONFLICT_POLICY: DeployConflictPolicy = 'overwrite';
export const DEFAULT_DEPLOY_CONFLICT_ASK_FALLBACK: DeployConflictAskFallback = 'prompt';
export const DEFAULT_DEPLOY_RESILIENCE_ENABLED = true;
export const DEFAULT_DEPLOY_RESILIENCE_MAX_RETRIES = 1;
export const DEFAULT_DEPLOY_RESILIENCE_RETRY_DELAY_MS = 300;
export const DEFAULT_DEPLOY_RESILIENCE_REOPEN_CONNECTION = true;

function sanitizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function sanitizeDeployExcludeDirectories(value: unknown): string[] {
	const cleaned = sanitizeStringList(value).map((entry) => entry.toLowerCase());
	if (cleaned.length === 0) {
		return [...DEFAULT_DEPLOY_EXCLUDE_DIRECTORIES];
	}
	return [...new Set(cleaned)];
}

export function sanitizeDeployExcludeExtensions(value: unknown): string[] {
	const cleaned = sanitizeStringList(value)
		.map((entry) => (entry.startsWith('.') ? entry : `.${entry}`))
		.map((entry) => entry.toLowerCase());

	if (cleaned.length === 0) {
		return [...DEFAULT_DEPLOY_EXCLUDE_EXTENSIONS];
	}
	return [...new Set(cleaned)];
}

function sanitizeGlobList(value: unknown): string[] {
	const cleaned = sanitizeStringList(value)
		.map((entry) => entry.replace(/\\/g, '/'))
		.map((entry) => entry.replace(/^\.\//, ''));
	return [...new Set(cleaned)];
}

export function sanitizeDeployIncludeGlobs(value: unknown): string[] {
	const cleaned = sanitizeGlobList(value);
	if (cleaned.length === 0) {
		return [...DEFAULT_DEPLOY_INCLUDE_GLOBS];
	}
	return cleaned;
}

export function sanitizeDeployExcludeGlobs(value: unknown): string[] {
	const cleaned = sanitizeGlobList(value);
	if (cleaned.length === 0) {
		return [...DEFAULT_DEPLOY_EXCLUDE_GLOBS];
	}
	return cleaned;
}

export function sanitizeDeployMaxFileBytes(value: unknown): number {
	if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
		return DEFAULT_DEPLOY_MAX_FILE_BYTES;
	}
	return Math.max(1, Math.floor(value));
}

export function sanitizeDeployIncrementalEnabled(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		return DEFAULT_DEPLOY_INCREMENTAL_ENABLED;
	}
	return value;
}

export function sanitizeDeployCleanupEnabled(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		return DEFAULT_DEPLOY_CLEANUP_ENABLED;
	}
	return value;
}

export function sanitizeDeployCleanupConfirmBeforeDelete(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		return DEFAULT_DEPLOY_CLEANUP_CONFIRM_BEFORE_DELETE;
	}
	return value;
}

export function sanitizeDeployCleanupDryRun(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		return DEFAULT_DEPLOY_CLEANUP_DRY_RUN;
	}
	return value;
}

export function sanitizeDeployAtomicEnabled(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		return DEFAULT_DEPLOY_ATOMIC_ENABLED;
	}
	return value;
}

export function sanitizeDeployVerifyAfterUpload(value: unknown): DeployVerifyMode {
	if (value === 'none' || value === 'size' || value === 'md5') {
		return value;
	}
	return DEFAULT_DEPLOY_VERIFY_AFTER_UPLOAD;
}

export function sanitizeDeployConflictPolicy(value: unknown): DeployConflictPolicy {
	if (value === 'overwrite' || value === 'skip' || value === 'ask') {
		return value;
	}
	return DEFAULT_DEPLOY_CONFLICT_POLICY;
}

export function sanitizeDeployConflictAskFallback(value: unknown): DeployConflictAskFallback {
	if (value === 'prompt' || value === 'skip' || value === 'overwrite') {
		return value;
	}
	return DEFAULT_DEPLOY_CONFLICT_ASK_FALLBACK;
}

export function sanitizeDeployResilienceEnabled(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		return DEFAULT_DEPLOY_RESILIENCE_ENABLED;
	}
	return value;
}

export function sanitizeDeployResilienceMaxRetries(value: unknown): number {
	if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
		return DEFAULT_DEPLOY_RESILIENCE_MAX_RETRIES;
	}
	return Math.max(0, Math.floor(value));
}

export function sanitizeDeployResilienceRetryDelayMs(value: unknown): number {
	if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
		return DEFAULT_DEPLOY_RESILIENCE_RETRY_DELAY_MS;
	}
	return Math.max(0, Math.floor(value));
}

export function sanitizeDeployResilienceReopenConnection(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		return DEFAULT_DEPLOY_RESILIENCE_REOPEN_CONNECTION;
	}
	return value;
}

export function readDeployConfig(cfg: vscode.WorkspaceConfiguration): DeployConfigSnapshot {
	return {
		excludeDirectories: sanitizeDeployExcludeDirectories(cfg.get('deploy.excludeDirectories')),
		excludeExtensions: sanitizeDeployExcludeExtensions(cfg.get('deploy.excludeExtensions')),
		includeGlobs: sanitizeDeployIncludeGlobs(cfg.get('deploy.includeGlobs')),
		excludeGlobs: sanitizeDeployExcludeGlobs(cfg.get('deploy.excludeGlobs')),
		maxFileBytes: sanitizeDeployMaxFileBytes(cfg.get('deploy.maxFileBytes')),
		incrementalEnabled: sanitizeDeployIncrementalEnabled(cfg.get('deploy.incremental.enabled')),
		cleanupEnabled: sanitizeDeployCleanupEnabled(cfg.get('deploy.cleanup.enabled')),
		cleanupConfirmBeforeDelete: sanitizeDeployCleanupConfirmBeforeDelete(
			cfg.get('deploy.cleanup.confirmBeforeDelete')
		),
		cleanupDryRun: sanitizeDeployCleanupDryRun(cfg.get('deploy.cleanup.dryRun')),
		atomicEnabled: sanitizeDeployAtomicEnabled(cfg.get('deploy.atomic.enabled')),
		verifyAfterUpload: sanitizeDeployVerifyAfterUpload(cfg.get('deploy.verifyAfterUpload')),
		conflictPolicy: sanitizeDeployConflictPolicy(cfg.get('deploy.conflictPolicy')),
		conflictAskFallback: sanitizeDeployConflictAskFallback(cfg.get('deploy.conflictAskFallback')),
		resilience: {
			enabled: sanitizeDeployResilienceEnabled(cfg.get('deploy.resilience.enabled')),
			maxRetries: sanitizeDeployResilienceMaxRetries(cfg.get('deploy.resilience.maxRetries')),
			retryDelayMs: sanitizeDeployResilienceRetryDelayMs(cfg.get('deploy.resilience.retryDelayMs')),
			reopenConnection: sanitizeDeployResilienceReopenConnection(cfg.get('deploy.resilience.reopenConnection'))
		}
	};
}
