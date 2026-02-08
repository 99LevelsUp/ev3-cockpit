import * as path from 'node:path';
import * as vscode from 'vscode';
import { Logger, NoopLogger } from '../diagnostics/logger';
import { RemoteFsService } from './remoteFsService';
import { parseEv3UriParts } from './ev3Uri';
import { copyRemotePath, deleteRemotePath, getRemotePathKind, RemoteFsPathError, renameRemotePath } from './remoteFsOps';

type RemoteFsResolver = (brickId: string) => Promise<RemoteFsService>;

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
		return this.withFs(uri, 'read', async (service, remotePath) => {
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
		});
	}

	public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		return this.withFs(uri, 'read', async (service, remotePath) => {
			const listing = await service.listDirectory(remotePath);
			const folders: [string, vscode.FileType][] = listing.folders.map((name) => [name, vscode.FileType.Directory]);
			const files: [string, vscode.FileType][] = listing.files.map((entry) => [entry.name, vscode.FileType.File]);
			return [...folders, ...files];
		});
	}

	public async createDirectory(uri: vscode.Uri): Promise<void> {
		await this.withFs(uri, 'write', async (service, remotePath) => {
			await service.createDirectory(remotePath);
			this.emitChanged(uri, vscode.FileChangeType.Created);
		});
	}

	public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		return this.withFs(uri, 'read', async (service, remotePath) => {
			return service.readFile(remotePath);
		});
	}

	public async writeFile(
		uri: vscode.Uri,
		content: Uint8Array,
		options: { readonly create: boolean; readonly overwrite: boolean }
	): Promise<void> {
		await this.withFs(uri, 'write', async (service, remotePath) => {
			const exists = await this.fileExists(uri);
			if (!exists && !options.create) {
				throw new RemoteFsPathError('NOT_FOUND', `Path not found: ${remotePath}`);
			}
			if (exists && !options.overwrite) {
				throw new RemoteFsPathError('ALREADY_EXISTS', `Path already exists: ${remotePath}`);
			}

			await service.writeFile(remotePath, content);
			this.emitChanged(uri, exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created);
		});
	}

	public async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
		await this.withFs(uri, 'write', async (service, remotePath) => {
			await deleteRemotePath(service, remotePath, { recursive: options.recursive });
			this.emitChanged(uri, vscode.FileChangeType.Deleted);
		});
	}

	public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
		await this.withFs(oldUri, 'write', async (service, sourcePath) => {
			const { brickId: sourceBrickId } = parseEv3UriParts(oldUri.authority, oldUri.path);
			const { brickId: destinationBrickId, remotePath: destinationPath } = parseEv3UriParts(newUri.authority, newUri.path);
			if (sourceBrickId !== destinationBrickId) {
				throw new RemoteFsPathError('INVALID_OPERATION', 'Cross-brick rename is not supported.');
			}

			await renameRemotePath(service, sourcePath, destinationPath, { overwrite: options.overwrite });
			this.emitChanged(oldUri, vscode.FileChangeType.Deleted);
			this.emitChanged(newUri, vscode.FileChangeType.Created);
		});
	}

	public async copy(source: vscode.Uri, destination: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
		await this.withFs(source, 'write', async (service, sourcePath) => {
			const { brickId: sourceBrickId } = parseEv3UriParts(source.authority, source.path);
			const { brickId: destinationBrickId, remotePath: destinationPath } = parseEv3UriParts(
				destination.authority,
				destination.path
			);
			if (sourceBrickId !== destinationBrickId) {
				throw new RemoteFsPathError('INVALID_OPERATION', 'Cross-brick copy is not supported.');
			}

			await copyRemotePath(service, sourcePath, destinationPath, { overwrite: options.overwrite });
			this.emitChanged(destination, vscode.FileChangeType.Created);
		});
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

		const message = error instanceof Error ? error.message : String(error);
		if (/outside safe roots|safe mode|blocked/i.test(message)) {
			return vscode.FileSystemError.NoPermissions(message);
		}
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
