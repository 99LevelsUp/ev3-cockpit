import * as path from 'node:path';
import { canonicalizeEv3Path } from './pathPolicy';

export interface DeployCleanupPlan {
	filesToDelete: string[];
	directoriesToDelete: string[];
}

export interface LocalProjectLayout {
	files: Set<string>;
	directories: Set<string>;
}

function normalizeRelativePath(relativePath: string): string {
	const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/').trim());
	if (normalized === '.' || normalized === '/') {
		return '';
	}
	return normalized.replace(/^\/+/, '');
}

function normalizeRootPath(rootPath: string): string {
	const canonical = canonicalizeEv3Path(rootPath);
	return canonical.endsWith('/') ? canonical.slice(0, -1) : canonical;
}

function toRelativeWithinRoot(rootPath: string, remotePath: string): string | undefined {
	const root = normalizeRootPath(rootPath);
	const remote = canonicalizeEv3Path(remotePath);
	if (remote === root) {
		return '';
	}
	if (!remote.startsWith(`${root}/`)) {
		return undefined;
	}
	return normalizeRelativePath(remote.slice(root.length + 1));
}

function pathDepth(inputPath: string): number {
	return inputPath.split('/').filter((part) => part.length > 0).length;
}

export function buildLocalProjectLayout(relativeFilePaths: readonly string[]): LocalProjectLayout {
	const files = new Set<string>();
	const directories = new Set<string>(['']);

	for (const entry of relativeFilePaths) {
		const normalizedFile = normalizeRelativePath(entry);
		if (!normalizedFile) {
			continue;
		}

		files.add(normalizedFile);
		let currentDir = path.posix.dirname(normalizedFile);
		while (currentDir !== '.' && currentDir !== '/' && currentDir.length > 0) {
			const normalizedDir = normalizeRelativePath(currentDir);
			if (!normalizedDir) {
				break;
			}
			directories.add(normalizedDir);
			currentDir = path.posix.dirname(currentDir);
		}
	}

	return {
		files,
		directories
	};
}

export function planRemoteCleanup(options: {
	remoteProjectRoot: string;
	remoteFilePaths: readonly string[];
	remoteDirectoryPaths: readonly string[];
	localLayout: LocalProjectLayout;
}): DeployCleanupPlan {
	const staleFiles = new Set<string>();
	const staleDirectories = new Set<string>();
	const root = normalizeRootPath(options.remoteProjectRoot);

	for (const remoteFilePath of options.remoteFilePaths) {
		const relativePath = toRelativeWithinRoot(root, remoteFilePath);
		if (relativePath === undefined || relativePath.length === 0) {
			continue;
		}
		if (!options.localLayout.files.has(relativePath)) {
			staleFiles.add(canonicalizeEv3Path(remoteFilePath));
		}
	}

	for (const remoteDirectoryPath of options.remoteDirectoryPaths) {
		const relativePath = toRelativeWithinRoot(root, remoteDirectoryPath);
		if (relativePath === undefined || relativePath.length === 0) {
			continue;
		}
		if (!options.localLayout.directories.has(relativePath)) {
			staleDirectories.add(canonicalizeEv3Path(remoteDirectoryPath));
		}
	}

	return {
		filesToDelete: [...staleFiles].sort((a, b) => {
			const depthDiff = pathDepth(b) - pathDepth(a);
			if (depthDiff !== 0) {
				return depthDiff;
			}
			return a.localeCompare(b);
		}),
		directoriesToDelete: [...staleDirectories].sort((a, b) => {
			const depthDiff = pathDepth(b) - pathDepth(a);
			if (depthDiff !== 0) {
				return depthDiff;
			}
			return a.localeCompare(b);
		})
	};
}
