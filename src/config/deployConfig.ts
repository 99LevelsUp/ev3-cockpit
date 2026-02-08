import * as vscode from 'vscode';

export interface DeployConfigSnapshot {
	excludeDirectories: string[];
	excludeExtensions: string[];
	maxFileBytes: number;
	incrementalEnabled: boolean;
	cleanupEnabled: boolean;
}

export const DEFAULT_DEPLOY_EXCLUDE_DIRECTORIES = ['.git', 'node_modules', '.vscode-test', 'out'];
export const DEFAULT_DEPLOY_EXCLUDE_EXTENSIONS = ['.map'];
export const DEFAULT_DEPLOY_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_DEPLOY_INCREMENTAL_ENABLED = false;
export const DEFAULT_DEPLOY_CLEANUP_ENABLED = false;

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

export function readDeployConfig(cfg: vscode.WorkspaceConfiguration): DeployConfigSnapshot {
	return {
		excludeDirectories: sanitizeDeployExcludeDirectories(cfg.get('deploy.excludeDirectories')),
		excludeExtensions: sanitizeDeployExcludeExtensions(cfg.get('deploy.excludeExtensions')),
		maxFileBytes: sanitizeDeployMaxFileBytes(cfg.get('deploy.maxFileBytes')),
		incrementalEnabled: sanitizeDeployIncrementalEnabled(cfg.get('deploy.incremental.enabled')),
		cleanupEnabled: sanitizeDeployCleanupEnabled(cfg.get('deploy.cleanup.enabled'))
	};
}
