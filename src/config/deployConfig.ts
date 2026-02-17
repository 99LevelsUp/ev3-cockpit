import * as vscode from 'vscode';
import { sanitizeBoolean, sanitizeGlobList, sanitizeNumber, sanitizeStringList } from './sanitizers';
import { DeployVerifyMode, DeployConflictPolicy, DeployConflictAskFallback } from '../types/enums';

// Re-export for backward compatibility
export { DeployVerifyMode, DeployConflictPolicy, DeployConflictAskFallback };

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
export const DEFAULT_DEPLOY_VERIFY_AFTER_UPLOAD: DeployVerifyMode = DeployVerifyMode.NONE;
export const DEFAULT_DEPLOY_CONFLICT_POLICY: DeployConflictPolicy = DeployConflictPolicy.OVERWRITE;
export const DEFAULT_DEPLOY_CONFLICT_ASK_FALLBACK: DeployConflictAskFallback = DeployConflictAskFallback.PROMPT;
export const DEFAULT_DEPLOY_RESILIENCE_ENABLED = true;
export const DEFAULT_DEPLOY_RESILIENCE_MAX_RETRIES = 1;
export const DEFAULT_DEPLOY_RESILIENCE_RETRY_DELAY_MS = 300;
export const DEFAULT_DEPLOY_RESILIENCE_REOPEN_CONNECTION = true;

// --- Exported sanitizers ---

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

export function sanitizeDeployIncludeGlobs(value: unknown): string[] {
	const cleaned = sanitizeGlobList(value);
	return cleaned.length === 0 ? [...DEFAULT_DEPLOY_INCLUDE_GLOBS] : cleaned;
}

export function sanitizeDeployExcludeGlobs(value: unknown): string[] {
	const cleaned = sanitizeGlobList(value);
	return cleaned.length === 0 ? [...DEFAULT_DEPLOY_EXCLUDE_GLOBS] : cleaned;
}

export function sanitizeDeployMaxFileBytes(value: unknown): number {
	return sanitizeNumber(value, DEFAULT_DEPLOY_MAX_FILE_BYTES, 1);
}

export function sanitizeDeployIncrementalEnabled(value: unknown): boolean {
	return sanitizeBoolean(value, DEFAULT_DEPLOY_INCREMENTAL_ENABLED);
}

export function sanitizeDeployCleanupEnabled(value: unknown): boolean {
	return sanitizeBoolean(value, DEFAULT_DEPLOY_CLEANUP_ENABLED);
}

export function sanitizeDeployCleanupConfirmBeforeDelete(value: unknown): boolean {
	return sanitizeBoolean(value, DEFAULT_DEPLOY_CLEANUP_CONFIRM_BEFORE_DELETE);
}

export function sanitizeDeployCleanupDryRun(value: unknown): boolean {
	return sanitizeBoolean(value, DEFAULT_DEPLOY_CLEANUP_DRY_RUN);
}

export function sanitizeDeployAtomicEnabled(value: unknown): boolean {
	return sanitizeBoolean(value, DEFAULT_DEPLOY_ATOMIC_ENABLED);
}

export function sanitizeDeployVerifyAfterUpload(value: unknown): DeployVerifyMode {
	// Accept both enum values and string literals for backward compatibility
	if (value === DeployVerifyMode.NONE || value === 'none') return DeployVerifyMode.NONE;
	if (value === DeployVerifyMode.SIZE || value === 'size') return DeployVerifyMode.SIZE;
	if (value === DeployVerifyMode.MD5 || value === 'md5') return DeployVerifyMode.MD5;
	return DEFAULT_DEPLOY_VERIFY_AFTER_UPLOAD;
}

export function sanitizeDeployConflictPolicy(value: unknown): DeployConflictPolicy {
	// Accept both enum values and string literals for backward compatibility
	if (value === DeployConflictPolicy.OVERWRITE || value === 'overwrite') return DeployConflictPolicy.OVERWRITE;
	if (value === DeployConflictPolicy.SKIP || value === 'skip') return DeployConflictPolicy.SKIP;
	if (value === DeployConflictPolicy.ASK || value === 'ask') return DeployConflictPolicy.ASK;
	return DEFAULT_DEPLOY_CONFLICT_POLICY;
}

export function sanitizeDeployConflictAskFallback(value: unknown): DeployConflictAskFallback {
	// Accept both enum values and string literals for backward compatibility
	if (value === DeployConflictAskFallback.PROMPT || value === 'prompt') return DeployConflictAskFallback.PROMPT;
	if (value === DeployConflictAskFallback.SKIP || value === 'skip') return DeployConflictAskFallback.SKIP;
	if (value === DeployConflictAskFallback.OVERWRITE || value === 'overwrite') return DeployConflictAskFallback.OVERWRITE;
	return DEFAULT_DEPLOY_CONFLICT_ASK_FALLBACK;
}

export function sanitizeDeployResilienceEnabled(value: unknown): boolean {
	return sanitizeBoolean(value, DEFAULT_DEPLOY_RESILIENCE_ENABLED);
}

export function sanitizeDeployResilienceMaxRetries(value: unknown): number {
	return sanitizeNumber(value, DEFAULT_DEPLOY_RESILIENCE_MAX_RETRIES, 0);
}

export function sanitizeDeployResilienceRetryDelayMs(value: unknown): number {
	return sanitizeNumber(value, DEFAULT_DEPLOY_RESILIENCE_RETRY_DELAY_MS, 0);
}

export function sanitizeDeployResilienceReopenConnection(value: unknown): boolean {
	return sanitizeBoolean(value, DEFAULT_DEPLOY_RESILIENCE_REOPEN_CONNECTION);
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
