import * as path from 'node:path';
import * as vscode from 'vscode';
import { Logger, NoopLogger } from '../diagnostics/logger';
import { buildRemoteChildPath } from '../fs/browserActions';
import type { RemoteFsService } from '../fs/remoteFsService';
import type { BrickDirectoryNode, BrickRootNode, BrickTreeNode } from './brickTreeProvider';

const TREE_DRAG_MIME = 'application/vnd.ev3-cockpit.brick-tree+json';
const URI_LIST_MIME = 'text/uri-list';

export interface DraggedRemoteEntry {
	kind: 'directory' | 'file';
	brickId: string;
	remotePath: string;
}

interface DropDestination {
	brickId: string;
	remoteDirectoryPath: string;
}

interface UploadSummary {
	files: number;
	directories: number;
}

interface RemoteMoveSummary {
	moved: number;
	affectedDirectories: string[];
}

export interface BrickTreeDragAndDropControllerOptions {
	resolveFsService: (brickId: string) => Promise<RemoteFsService>;
	refreshTree: (brickId: string, remotePath: string) => void;
	logger?: Logger;
}

export function parseUriListPayload(payload: string): string[] {
	return payload
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function parseTreeDragPayload(payload: string): DraggedRemoteEntry[] {
	const parsed = JSON.parse(payload) as unknown;
	if (!Array.isArray(parsed)) {
		return [];
	}

	const entries: DraggedRemoteEntry[] = [];
	for (const item of parsed) {
		if (
			typeof item === 'object' &&
			item !== null &&
			(item as { kind?: unknown }).kind !== undefined &&
			(item as { brickId?: unknown }).brickId !== undefined &&
			(item as { remotePath?: unknown }).remotePath !== undefined
		) {
			const kind = (item as { kind: unknown }).kind;
			const brickId = (item as { brickId: unknown }).brickId;
			const remotePath = (item as { remotePath: unknown }).remotePath;
			if ((kind === 'directory' || kind === 'file') && typeof brickId === 'string' && typeof remotePath === 'string') {
				entries.push({
					kind,
					brickId,
					remotePath
				});
			}
		}
	}

	return entries;
}

export function isDirectoryDropIntoSelf(sourceDirectoryPath: string, destinationDirectoryPath: string): boolean {
	return destinationDirectoryPath === sourceDirectoryPath || destinationDirectoryPath.startsWith(`${sourceDirectoryPath}/`);
}

function asDropDestination(node: BrickTreeNode | undefined): DropDestination | undefined {
	if (!node) {
		return undefined;
	}

	if (node.kind === 'brick') {
		return {
			brickId: node.brickId,
			remoteDirectoryPath: node.rootPath
		};
	}

	if (node.kind === 'directory') {
		return {
			brickId: node.brickId,
			remoteDirectoryPath: node.remotePath
		};
	}

	return undefined;
}

function remoteEntryFromNode(node: BrickTreeNode): DraggedRemoteEntry | undefined {
	if (node.kind === 'directory' || node.kind === 'file') {
		return {
			kind: node.kind,
			brickId: node.brickId,
			remotePath: node.remotePath
		};
	}
	return undefined;
}

function isAlreadyExistsError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /already exists|file exists|status FILE_EXISTS/i.test(message);
}

function isDirectoryType(fileType: vscode.FileType): boolean {
	return (fileType & vscode.FileType.Directory) !== 0;
}

function isFileType(fileType: vscode.FileType): boolean {
	return (fileType & vscode.FileType.File) !== 0;
}

function leafNameFromUri(uri: vscode.Uri): string {
	if (uri.fsPath.length > 0) {
		return path.basename(uri.fsPath);
	}
	return path.posix.basename(uri.path);
}

export class BrickTreeDragAndDropController implements vscode.TreeDragAndDropController<BrickTreeNode> {
	public readonly dragMimeTypes: readonly string[] = [TREE_DRAG_MIME, URI_LIST_MIME];
	public readonly dropMimeTypes: readonly string[] = [TREE_DRAG_MIME, URI_LIST_MIME];
	private readonly logger: Logger;

	public constructor(private readonly options: BrickTreeDragAndDropControllerOptions) {
		this.logger = options.logger ?? new NoopLogger();
	}

	public async handleDrag(source: readonly BrickTreeNode[], dataTransfer: vscode.DataTransfer): Promise<void> {
		const entries = source
			.map((node) => remoteEntryFromNode(node))
			.filter((entry): entry is DraggedRemoteEntry => entry !== undefined);
		if (entries.length === 0) {
			return;
		}

		dataTransfer.set(TREE_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(entries)));
		dataTransfer.set(
			URI_LIST_MIME,
			new vscode.DataTransferItem(entries.map((entry) => `ev3://${entry.brickId}${entry.remotePath}`).join('\r\n'))
		);
	}

	public async handleDrop(
		target: BrickTreeNode | undefined,
		dataTransfer: vscode.DataTransfer,
		_token: vscode.CancellationToken
	): Promise<void> {
		const destination = asDropDestination(target);
		if (!destination) {
			return;
		}

		const moved = await this.handleRemoteMoveDrop(destination, dataTransfer);
		const uploaded = await this.handleLocalUploadDrop(destination, dataTransfer);

		if (moved.moved > 0 || uploaded.files > 0 || uploaded.directories > 0) {
			const refreshPaths = new Set<string>([...moved.affectedDirectories, destination.remoteDirectoryPath]);
			for (const refreshPath of refreshPaths) {
				this.options.refreshTree(destination.brickId, refreshPath);
			}
		}
	}

	private async handleRemoteMoveDrop(
		destination: DropDestination,
		dataTransfer: vscode.DataTransfer
	): Promise<RemoteMoveSummary> {
		const dragItem = dataTransfer.get(TREE_DRAG_MIME);
		if (!dragItem) {
			return {
				moved: 0,
				affectedDirectories: []
			};
		}

		const payload = await dragItem.asString();
		let entries: DraggedRemoteEntry[];
		try {
			entries = parseTreeDragPayload(payload);
		} catch (error) {
			this.logger.warn('Failed to parse tree drag payload', {
				message: error instanceof Error ? error.message : String(error)
			});
			return {
				moved: 0,
				affectedDirectories: []
			};
		}

		let moved = 0;
		const affectedDirectories = new Set<string>();
		const errors: string[] = [];
		for (const entry of entries) {
			if (entry.brickId !== destination.brickId) {
				errors.push(`Cross-brick move is not supported (${entry.brickId} -> ${destination.brickId}).`);
				continue;
			}

			const destinationPath = buildRemoteChildPath(destination.remoteDirectoryPath, path.posix.basename(entry.remotePath));
			if (entry.kind === 'directory' && isDirectoryDropIntoSelf(entry.remotePath, destinationPath)) {
				errors.push(`Cannot move directory into itself: ${entry.remotePath}`);
				continue;
			}
			if (destinationPath === entry.remotePath) {
				continue;
			}

			try {
				await vscode.workspace.fs.rename(
					vscode.Uri.parse(`ev3://${entry.brickId}${entry.remotePath}`),
					vscode.Uri.parse(`ev3://${destination.brickId}${destinationPath}`),
					{ overwrite: false }
				);
				moved += 1;
				affectedDirectories.add(path.posix.dirname(entry.remotePath));
				affectedDirectories.add(destination.remoteDirectoryPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(message);
				this.logger.warn('Tree remote move failed', {
					brickId: entry.brickId,
					sourcePath: entry.remotePath,
					destinationPath,
					message
				});
			}
		}

		if (errors.length > 0) {
			void vscode.window.showWarningMessage(`Remote move completed with ${errors.length} warning(s).`);
		}
		return {
			moved,
			affectedDirectories: [...affectedDirectories]
		};
	}

	private async handleLocalUploadDrop(destination: DropDestination, dataTransfer: vscode.DataTransfer): Promise<UploadSummary> {
		const uriListItem = dataTransfer.get(URI_LIST_MIME);
		if (!uriListItem) {
			return {
				files: 0,
				directories: 0
			};
		}

		const uriListRaw = await uriListItem.asString();
		const localUris = parseUriListPayload(uriListRaw)
			.map((value) => vscode.Uri.parse(value))
			.filter((uri) => uri.scheme === 'file');
		if (localUris.length === 0) {
			return {
				files: 0,
				directories: 0
			};
		}

		const fsService = await this.options.resolveFsService(destination.brickId);
		const summary: UploadSummary = {
			files: 0,
			directories: 0
		};
		const errors: string[] = [];

		for (const localUri of localUris) {
			try {
				const part = await this.uploadLocalUriToRemoteDirectory(fsService, localUri, destination.remoteDirectoryPath);
				summary.files += part.files;
				summary.directories += part.directories;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(message);
				this.logger.warn('Tree local upload failed', {
					localUri: localUri.toString(),
					brickId: destination.brickId,
					remoteDirectoryPath: destination.remoteDirectoryPath,
					message
				});
			}
		}

		if (errors.length > 0) {
			void vscode.window.showWarningMessage(`Remote upload completed with ${errors.length} warning(s).`);
		}
		return summary;
	}

	private async uploadLocalUriToRemoteDirectory(
		fsService: RemoteFsService,
		localUri: vscode.Uri,
		remoteDirectoryPath: string
	): Promise<UploadSummary> {
		const stat = await vscode.workspace.fs.stat(localUri);
		const targetName = leafNameFromUri(localUri);
		if (!targetName) {
			return {
				files: 0,
				directories: 0
			};
		}

		if (isFileType(stat.type)) {
			const remotePath = buildRemoteChildPath(remoteDirectoryPath, targetName);
			const bytes = await vscode.workspace.fs.readFile(localUri);
			await fsService.writeFile(remotePath, bytes);
			return {
				files: 1,
				directories: 0
			};
		}

		if (!isDirectoryType(stat.type)) {
			return {
				files: 0,
				directories: 0
			};
		}

		const remoteRoot = buildRemoteChildPath(remoteDirectoryPath, targetName);
		try {
			await fsService.createDirectory(remoteRoot);
		} catch (error) {
			if (!isAlreadyExistsError(error)) {
				throw error;
			}
		}

		const entries = await vscode.workspace.fs.readDirectory(localUri);
		const summary: UploadSummary = {
			files: 0,
			directories: 1
		};
		for (const [name, type] of entries) {
			const childUri = vscode.Uri.joinPath(localUri, name);
			if (isFileType(type) || isDirectoryType(type)) {
				const part = await this.uploadLocalUriToRemoteDirectory(fsService, childUri, remoteRoot);
				summary.files += part.files;
				summary.directories += part.directories;
			}
		}
		return summary;
	}
}

export function isBrickTreeDropTargetNode(value: BrickTreeNode): value is BrickRootNode | BrickDirectoryNode {
	return value.kind === 'brick' || value.kind === 'directory';
}
