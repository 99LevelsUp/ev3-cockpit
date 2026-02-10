import * as path from 'node:path';
import * as vscode from 'vscode';
import { Logger, NoopLogger } from '../diagnostics/logger';
import { withTiming } from '../diagnostics/perfTiming';
import { RemoteFsService } from './remoteFsService';
import { parseEv3UriParts } from './ev3Uri';
import { copyRemotePath, deleteRemotePath, getRemotePathKind, RemoteFsPathError, renameRemotePath } from './remoteFsOps';
import { PathPolicyError } from './pathPolicy';

type RemoteFsResolver = (brickId: string) => Promise<RemoteFsService>;

export type FsAvailabilityErrorCode = 'NO_ACTIVE_BRICK' | 'BRICK_UNAVAILABLE' | 'BRICK_NOT_REGISTERED';

export class FsAvailabilityError extends Error {
	public readonly code: FsAvailabilityErrorCode;

	public constructor(code: FsAvailabilityErrorCode, message: string) {
		super(message);
		this.name = 'FsAvailabilityError';
		this.code = code;
	}
}

export class Ev3FileSystemProvider implements vscode.FileSystemProvider {
	private readonly eventEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	public readonly onDidChangeFile = this.eventEmitter.event;

	public constructor(
		private readonly resolveRemoteFs: RemoteFsResolver,
		private readonly logger: Logger = new NoopLogger()
	) {}

	public watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		return withTiming(
			this.logger,
			'fs-provider.stat',
			() =>
				this.withFs(uri, 'read', async (service, remotePath) => {
					const kind = await getRemotePathKind(service, remotePath);
					if (kind === 'directory') {
						return this.makeDirectoryStat();
					}
					if (kind === 'file') {
						const parentPath = path.posix.dirname(remotePath);
						const name = path.posix.basename(remotePath);
						const listing = await service.listDirectory(parentPath);
						const file = listing.files.find((entry) => entry.name === name);
						return this.makeFileStat(file?.size ?? 0);
					}

					throw new RemoteFsPathError('NOT_FOUND', `Path not found: ${remotePath}`);
				}),
			{
				uri: uri.path,
				authority: uri.authority
			}
		);
	}

	public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		return withTiming(
			this.logger,
			'fs-provider.read-directory',
			() =>
				this.withFs(uri, 'read', async (service, remotePath) => {
					const listing = await service.listDirectory(remotePath);
					const folders: [string, vscode.FileType][] = listing.folders.map((name) => [name, vscode.FileType.Directory]);
					const files: [string, vscode.FileType][] = listing.files.map((entry) => [entry.name, vscode.FileType.File]);
					return [...folders, ...files];
				}),
			{
				uri: uri.path,
				authority: uri.authority
			}
		);
	}

	public async createDirectory(uri: vscode.Uri): Promise<void> {
		await withTiming(
			this.logger,
			'fs-provider.create-directory',
			() =>
				this.withFs(uri, 'write', async (service, remotePath) => {
					await service.createDirectory(remotePath);
					this.emitChanged(uri, vscode.FileChangeType.Created);
				}),
			{
				uri: uri.path,
				authority: uri.authority
			}
		);
	}

	public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		return withTiming(
			this.logger,
			'fs-provider.read-file',
			() =>
				this.withFs(uri, 'read', async (service, remotePath) => {
					return service.readFile(remotePath);
				}),
			{
				uri: uri.path,
				authority: uri.authority
			}
		);
	}

	public async writeFile(
		uri: vscode.Uri,
		content: Uint8Array,
		options: { readonly create: boolean; readonly overwrite: boolean }
	): Promise<void> {
		await withTiming(
			this.logger,
			'fs-provider.write-file',
			() =>
				this.withFs(uri, 'write', async (service, remotePath) => {
					const exists = await this.fileExists(uri);
					if (!exists && !options.create) {
						throw new RemoteFsPathError('NOT_FOUND', `Path not found: ${remotePath}`);
					}
					if (exists && !options.overwrite) {
						throw new RemoteFsPathError('ALREADY_EXISTS', `Path already exists: ${remotePath}`);
					}

					await service.writeFile(remotePath, content);
					this.emitChanged(uri, exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created);
				}),
			{
				uri: uri.path,
				authority: uri.authority,
				size: content.length,
				create: options.create,
				overwrite: options.overwrite
			}
		);
	}

	public async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
		await withTiming(
			this.logger,
			'fs-provider.delete',
			() =>
				this.withFs(uri, 'write', async (service, remotePath) => {
					await deleteRemotePath(service, remotePath, { recursive: options.recursive });
					this.emitChanged(uri, vscode.FileChangeType.Deleted);
				}),
			{
				uri: uri.path,
				authority: uri.authority,
				recursive: options.recursive
			}
		);
	}

	public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
		await withTiming(
			this.logger,
			'fs-provider.rename',
			() =>
				this.withFs(oldUri, 'write', async (service, sourcePath) => {
					const { brickId: sourceBrickId } = parseEv3UriParts(oldUri.authority, oldUri.path);
					const { brickId: destinationBrickId, remotePath: destinationPath } = parseEv3UriParts(newUri.authority, newUri.path);
					if (sourceBrickId !== destinationBrickId) {
						throw new RemoteFsPathError('INVALID_OPERATION', 'Cross-brick rename is not supported.');
					}

					await renameRemotePath(service, sourcePath, destinationPath, { overwrite: options.overwrite });
					this.emitChanged(oldUri, vscode.FileChangeType.Deleted);
					this.emitChanged(newUri, vscode.FileChangeType.Created);
				}),
			{
				from: oldUri.path,
				to: newUri.path,
				authority: oldUri.authority,
				overwrite: options.overwrite
			}
		);
	}

	public async copy(source: vscode.Uri, destination: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
		await withTiming(
			this.logger,
			'fs-provider.copy',
			() =>
				this.withFs(source, 'write', async (service, sourcePath) => {
					const { brickId: sourceBrickId } = parseEv3UriParts(source.authority, source.path);
					const { brickId: destinationBrickId, remotePath: destinationPath } = parseEv3UriParts(
						destination.authority,
						destination.path
					);
					if (sourceBrickId !== destinationBrickId) {
						throw new RemoteFsPathError('INVALID_OPERATION', 'Cross-brick copy is not supported.');
					}

					await copyRemotePath(service, sourcePath, destinationPath, { overwrite: options.overwrite });
					this.emitChanged(source, vscode.FileChangeType.Changed);
					this.emitChanged(destination, vscode.FileChangeType.Created);
				}),
			{
				from: source.path,
				to: destination.path,
				authority: source.authority,
				overwrite: options.overwrite
			}
		);
	}

	private async withFs<T>(
		uri: vscode.Uri,
		access: 'read' | 'write',
		operation: (service: RemoteFsService, remotePath: string) => Promise<T>
	): Promise<T> {
		try {
			const { brickId, remotePath } = parseEv3UriParts(uri.authority, uri.path);
			const service = await this.resolveRemoteFs(brickId);
			return await operation(service, remotePath);
		} catch (error) {
			throw this.toFileSystemError(uri, error, access);
		}
	}

	private async fileExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await this.stat(uri);
			return true;
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
				return false;
			}
			throw error;
		}
	}

	private emitChanged(uri: vscode.Uri, type: vscode.FileChangeType): void {
		this.eventEmitter.fire([{ type, uri }]);
	}

	private toFileSystemError(uri: vscode.Uri, error: unknown, access: 'read' | 'write'): vscode.FileSystemError {
		if (error instanceof vscode.FileSystemError) {
			return error;
		}

		if (error instanceof RemoteFsPathError) {
			if (error.code === 'NOT_FOUND') {
				return vscode.FileSystemError.FileNotFound(uri);
			}
			if (error.code === 'ALREADY_EXISTS') {
				return vscode.FileSystemError.FileExists(uri);
			}
			if (error.code === 'NOT_EMPTY') {
				return vscode.FileSystemError.NoPermissions(error.message);
			}
			return vscode.FileSystemError.NoPermissions(error.message);
		}

		if (error instanceof PathPolicyError) {
			return vscode.FileSystemError.NoPermissions(error.message);
		}

		if (error instanceof FsAvailabilityError) {
			if (error.code === 'NO_ACTIVE_BRICK') {
				if (access === 'write') {
					return vscode.FileSystemError.NoPermissions('EV3 is offline. Filesystem is currently read-only.');
				}
				return vscode.FileSystemError.Unavailable(error.message);
			}
			return vscode.FileSystemError.Unavailable(error.message);
		}

		const message = error instanceof Error ? error.message : String(error);
		if (/No active EV3 connection/i.test(message)) {
			if (access === 'write') {
				return vscode.FileSystemError.NoPermissions('EV3 is offline. Filesystem is currently read-only.');
			}
			return vscode.FileSystemError.Unavailable(message);
		}
		if (/not found|no such/i.test(message)) {
			return vscode.FileSystemError.FileNotFound(uri);
		}

		this.logger.warn('EV3 FileSystemProvider operation failed', {
			uri: uri.toString(),
			message
		});
		return vscode.FileSystemError.Unavailable(message);
	}

	private makeDirectoryStat(): vscode.FileStat {
		return {
			type: vscode.FileType.Directory,
			ctime: 0,
			mtime: 0,
			size: 0
		};
	}

	private makeFileStat(size: number): vscode.FileStat {
		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: 0,
			size
		};
	}
}
