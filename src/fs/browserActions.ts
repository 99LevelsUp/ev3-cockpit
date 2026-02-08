import * as path from 'node:path';
import { canonicalizeEv3Path } from './pathPolicy';

export function isValidRemoteEntryName(input: string): boolean {
	const name = input.trim();
	if (!name || name === '.' || name === '..') {
		return false;
	}
	if (name.includes('/') || name.includes('\\')) {
		return false;
	}
	return true;
}

export function buildRemoteChildPath(currentPath: string, childName: string): string {
	const base = canonicalizeEv3Path(currentPath);
	return canonicalizeEv3Path(path.posix.join(base, childName.trim()));
}

export function buildRemotePathFromLocal(currentPath: string, localFsPath: string): string {
	const filename = path.basename(localFsPath);
	return buildRemoteChildPath(currentPath, filename);
}
