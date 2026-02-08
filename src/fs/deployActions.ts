import * as path from 'node:path';
import { canonicalizeEv3Path } from './pathPolicy';
import { isRemoteExecutablePath, supportedExecutableExtensions } from './remoteExecutable';

export const DEFAULT_DEPLOY_ROOT = '/home/root/lms2012/prjs/';

export function isExecutableFileName(fileName: string): boolean {
	const trimmed = fileName.trim();
	if (trimmed.length === 0) {
		return false;
	}
	return isRemoteExecutablePath(`/tmp/${trimmed}`);
}

export function normalizeDeployRoot(remoteRoot: string): string {
	const trimmed = remoteRoot.trim();
	const candidate = trimmed.length > 0 ? trimmed : DEFAULT_DEPLOY_ROOT;
	const canonical = canonicalizeEv3Path(candidate);
	return canonical.endsWith('/') ? canonical : `${canonical}/`;
}

export function buildRemoteDeployPath(localFsPath: string, remoteRoot = DEFAULT_DEPLOY_ROOT): string {
	const baseName = path.basename(localFsPath).trim();
	if (!baseName || !isExecutableFileName(baseName)) {
		throw new Error(
			`Deploy supports only executable files (${supportedExecutableExtensions().join(', ')}). Got "${baseName || localFsPath}".`
		);
	}

	const normalizedRoot = normalizeDeployRoot(remoteRoot);
	return canonicalizeEv3Path(path.posix.join(normalizedRoot, baseName));
}

export function buildRemoteProjectRoot(localProjectFsPath: string, remoteRoot = DEFAULT_DEPLOY_ROOT): string {
	const projectName = path.basename(localProjectFsPath).trim();
	if (!projectName) {
		throw new Error(`Cannot derive project name from local path "${localProjectFsPath}".`);
	}

	const normalizedRoot = normalizeDeployRoot(remoteRoot);
	return canonicalizeEv3Path(path.posix.join(normalizedRoot, projectName));
}

export function buildRemoteProjectFilePath(
	localProjectFsPath: string,
	localFileFsPath: string,
	remoteRoot = DEFAULT_DEPLOY_ROOT
): string {
	const relative = path.relative(localProjectFsPath, localFileFsPath);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`Local file "${localFileFsPath}" is outside project root "${localProjectFsPath}".`);
	}

	const relativePosix = relative.split(path.sep).join('/');
	return canonicalizeEv3Path(path.posix.join(buildRemoteProjectRoot(localProjectFsPath, remoteRoot), relativePosix));
}

export function choosePreferredExecutableCandidate(executableRemotePaths: readonly string[]): string | undefined {
	if (executableRemotePaths.length === 0) {
		return undefined;
	}

	return [...executableRemotePaths].sort((a, b) => {
		const aDepth = a.split('/').filter((part) => part.length > 0).length;
		const bDepth = b.split('/').filter((part) => part.length > 0).length;
		if (aDepth !== bDepth) {
			return aDepth - bDepth;
		}
		return a.localeCompare(b);
	})[0];
}
