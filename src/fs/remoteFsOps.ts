import * as path from 'node:path';
import { ExtensionError } from '../errors/ExtensionError';
import { canonicalizeEv3Path, PathPolicyError } from './pathPolicy';

export type RemoteFsPathKind = 'file' | 'directory' | 'missing';

export interface RemoteFsLike {
	listDirectory(path: string): Promise<{ folders: string[]; files: Array<{ name: string }> }>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, contents: Uint8Array): Promise<void>;
	createDirectory(path: string): Promise<void>;
	deleteFile(path: string): Promise<void>;
}

export type RemoteFsPathErrorCode = 'NOT_FOUND' | 'ALREADY_EXISTS' | 'NOT_EMPTY' | 'INVALID_OPERATION';

export class RemoteFsPathError extends ExtensionError {
	public constructor(code: RemoteFsPathErrorCode, message: string) {
		super(code, message);
		this.name = 'RemoteFsPathError';
	}
}

function splitParentAndName(remotePath: string): { parentPath: string; name: string } {
	const normalized = canonicalizeEv3Path(remotePath);
	if (normalized === '/') {
		return { parentPath: '/', name: '' };
	}

	const parentPath = path.posix.dirname(normalized);
	const name = path.posix.basename(normalized);
	return { parentPath, name };
}

function isPathPolicyError(error: unknown): boolean {
	return error instanceof PathPolicyError;
}

export async function getRemotePathKind(fs: RemoteFsLike, remotePath: string): Promise<RemoteFsPathKind> {
	const normalized = canonicalizeEv3Path(remotePath);
	if (normalized === '/') {
		return 'directory';
	}

	try {
		await fs.listDirectory(normalized);
		return 'directory';
	} catch (error) {
		if (isPathPolicyError(error)) {
			throw error;
		}
	}

	const { parentPath, name } = splitParentAndName(normalized);
	const listing = await fs.listDirectory(parentPath);
	if (listing.folders.includes(name)) {
		return 'directory';
	}
	if (listing.files.some((entry) => entry.name === name)) {
		return 'file';
	}
	return 'missing';
}

async function ensureDestinationWritable(
	fs: RemoteFsLike,
	destinationPath: string,
	overwrite: boolean
): Promise<'missing' | 'file' | 'directory'> {
	const kind = await getRemotePathKind(fs, destinationPath);
	if (kind !== 'missing' && !overwrite) {
		throw new RemoteFsPathError('ALREADY_EXISTS', `Destination already exists: ${destinationPath}`);
	}
	return kind;
}

async function deletePathInternal(fs: RemoteFsLike, targetPath: string, recursive: boolean): Promise<void> {
	const normalized = canonicalizeEv3Path(targetPath);
	const kind = await getRemotePathKind(fs, normalized);
	if (kind === 'missing') {
		throw new RemoteFsPathError('NOT_FOUND', `Path not found: ${normalized}`);
	}

	if (kind === 'file') {
		await fs.deleteFile(normalized);
		return;
	}

	const listing = await fs.listDirectory(normalized);
	const hasChildren = listing.folders.length > 0 || listing.files.length > 0;
	if (hasChildren && !recursive) {
		throw new RemoteFsPathError('NOT_EMPTY', `Directory is not empty: ${normalized}`);
	}

	if (recursive) {
		for (const folder of listing.folders) {
			await deletePathInternal(fs, path.posix.join(normalized, folder), true);
		}
		for (const file of listing.files) {
			await fs.deleteFile(path.posix.join(normalized, file.name));
		}
	}

	await fs.deleteFile(normalized);
}

async function copyFile(fs: RemoteFsLike, sourcePath: string, destinationPath: string): Promise<void> {
	const data = await fs.readFile(sourcePath);
	await fs.writeFile(destinationPath, data);
}

async function copyDirectory(fs: RemoteFsLike, sourcePath: string, destinationPath: string): Promise<void> {
	await fs.createDirectory(destinationPath);
	const listing = await fs.listDirectory(sourcePath);

	for (const folder of listing.folders) {
		await copyDirectory(fs, path.posix.join(sourcePath, folder), path.posix.join(destinationPath, folder));
	}
	for (const file of listing.files) {
		await copyFile(fs, path.posix.join(sourcePath, file.name), path.posix.join(destinationPath, file.name));
	}
}

export async function copyRemotePath(
	fs: RemoteFsLike,
	sourcePath: string,
	destinationPath: string,
	options: { overwrite: boolean }
): Promise<void> {
	const source = canonicalizeEv3Path(sourcePath);
	const destination = canonicalizeEv3Path(destinationPath);
	if (source === destination) {
		return;
	}

	const sourceKind = await getRemotePathKind(fs, source);
	if (sourceKind === 'missing') {
		throw new RemoteFsPathError('NOT_FOUND', `Source not found: ${source}`);
	}

	if (sourceKind === 'directory' && destination.startsWith(`${source}/`)) {
		throw new RemoteFsPathError('INVALID_OPERATION', `Cannot copy directory into itself: ${source} -> ${destination}`);
	}

	const destinationKind = await ensureDestinationWritable(fs, destination, options.overwrite);
	if (destinationKind !== 'missing') {
		await deletePathInternal(fs, destination, true);
	}

	if (sourceKind === 'file') {
		await copyFile(fs, source, destination);
		return;
	}

	await copyDirectory(fs, source, destination);
}

export async function renameRemotePath(
	fs: RemoteFsLike,
	sourcePath: string,
	destinationPath: string,
	options: { overwrite: boolean }
): Promise<void> {
	const source = canonicalizeEv3Path(sourcePath);
	const destination = canonicalizeEv3Path(destinationPath);
	if (source === destination) {
		return;
	}

	await copyRemotePath(fs, source, destination, options);
	await deletePathInternal(fs, source, true);
}

export async function deleteRemotePath(
	fs: RemoteFsLike,
	targetPath: string,
	options: { recursive: boolean }
): Promise<void> {
	await deletePathInternal(fs, targetPath, options.recursive);
}
