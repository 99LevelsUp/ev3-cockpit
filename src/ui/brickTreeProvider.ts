import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BrickSnapshot } from '../device/brickRegistry';
import { Logger, NoopLogger } from '../diagnostics/logger';
import type { RemoteFsService } from '../fs/remoteFsService';

export type BrickTreeNode = BrickRootNode | BrickDirectoryNode | BrickFileNode | BrickMessageNode;

export interface BrickRootNode {
	kind: 'brick';
	brickId: string;
	displayName: string;
	role: BrickSnapshot['role'];
	transport: BrickSnapshot['transport'];
	status: BrickSnapshot['status'];
	isActive: boolean;
	rootPath: string;
	lastError?: string;
}

export interface BrickDirectoryNode {
	kind: 'directory';
	brickId: string;
	name: string;
	remotePath: string;
}

export interface BrickFileNode {
	kind: 'file';
	brickId: string;
	name: string;
	remotePath: string;
	size: number;
}

export interface BrickMessageNode {
	kind: 'message';
	brickId: string;
	label: string;
	detail?: string;
}

export interface BrickTreeDataSource {
	listBricks(): BrickSnapshot[];
	getBrickSnapshot(brickId: string): BrickSnapshot | undefined;
	resolveFsService(brickId: string): Promise<RemoteFsService>;
}

interface BrickTreeProviderOptions {
	dataSource: BrickTreeDataSource;
	logger?: Logger;
}

function buildEv3Uri(brickId: string, remotePath: string): vscode.Uri {
	return vscode.Uri.parse(`ev3://${brickId}${remotePath}`);
}

function normalizeRootPath(remotePath: string): string {
	const normalized = remotePath.replace(/\\/g, '/');
	if (!normalized.startsWith('/')) {
		return `/${normalized}`;
	}
	return normalized;
}

function isExecutablePath(remotePath: string): boolean {
	return remotePath.toLowerCase().endsWith('.rbf');
}

export class BrickTreeProvider implements vscode.TreeDataProvider<BrickTreeNode> {
	private readonly eventEmitter = new vscode.EventEmitter<BrickTreeNode | undefined | null | void>();
	private refreshTimer: NodeJS.Timeout | undefined;

	public readonly onDidChangeTreeData = this.eventEmitter.event;

	public constructor(
		private readonly options: BrickTreeProviderOptions
	) {}

	public dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	public refresh(): void {
		this.eventEmitter.fire(undefined);
	}

	public refreshThrottled(delayMs = 120): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.refresh();
		}, Math.max(0, delayMs));
	}

	public getTreeItem(element: BrickTreeNode): vscode.TreeItem {
		switch (element.kind) {
			case 'brick': {
				const item = new vscode.TreeItem(
					element.displayName,
					vscode.TreeItemCollapsibleState.Collapsed
				);
				item.id = `brick:${element.brickId}`;
				const statusBadge = this.renderStatusBadge(element.status, element.isActive);
				item.description = `${statusBadge} | ${element.transport} | ${element.role}`;
				item.tooltip = element.lastError
					? `${element.displayName}\n${element.rootPath}\n${element.lastError}`
					: `${element.displayName}\n${element.rootPath}`;
				item.contextValue =
					element.status === 'READY'
						? element.isActive
							? 'ev3BrickRootReadyActive'
							: 'ev3BrickRootReady'
						: 'ev3BrickRootUnavailable';
				item.iconPath = new vscode.ThemeIcon(
					element.status === 'READY' ? (element.isActive ? 'plug' : 'device-camera-video') : 'warning'
				);
				item.resourceUri = buildEv3Uri(element.brickId, element.rootPath);
				item.command =
					element.status === 'READY'
						? {
								command: 'ev3-cockpit.browseRemoteFs',
								title: 'Browse Remote FS',
								arguments: [element]
							}
						: {
								command: 'ev3-cockpit.connectEV3',
								title: 'Connect EV3'
							};
				return item;
			}
			case 'directory': {
				const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.id = `dir:${element.brickId}:${element.remotePath}`;
				item.contextValue = 'ev3RemoteDirectory';
				item.resourceUri = buildEv3Uri(element.brickId, element.remotePath);
				return item;
			}
			case 'file': {
				const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
				item.id = `file:${element.brickId}:${element.remotePath}`;
				item.description = `${element.size} B`;
				const isExecutable = isExecutablePath(element.remotePath);
				item.contextValue = isExecutable ? 'ev3RemoteFileRbf' : 'ev3RemoteFile';
				item.iconPath = new vscode.ThemeIcon(isExecutable ? 'play' : 'file');
				item.resourceUri = buildEv3Uri(element.brickId, element.remotePath);
				item.command = {
					command: 'vscode.open',
					title: 'Open Remote File',
					arguments: [item.resourceUri]
				};
				return item;
			}
			case 'message': {
				const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
				item.id = `message:${element.brickId}:${element.label}`;
				item.description = element.detail;
				item.contextValue = 'ev3BrickMessage';
				item.iconPath = new vscode.ThemeIcon('info');
				return item;
			}
		}
	}

	public async getChildren(element?: BrickTreeNode): Promise<BrickTreeNode[]> {
		if (!element) {
			return this.options.dataSource.listBricks().map((brick) => ({
				kind: 'brick',
				brickId: brick.brickId,
				displayName: brick.displayName,
				role: brick.role,
				transport: brick.transport,
				status: brick.status,
				isActive: brick.isActive,
				rootPath: normalizeRootPath(brick.rootPath),
				lastError: brick.lastError
			}));
		}

		if (element.kind === 'message' || element.kind === 'file') {
			return [];
		}

		if (element.kind === 'brick') {
			if (element.status !== 'READY') {
				return [
					{
						kind: 'message',
						brickId: element.brickId,
						label: 'Brick unavailable',
						detail: element.lastError ?? 'Connect to this brick to browse files.'
					}
				];
			}
			return this.loadDirectoryChildren(element.brickId, element.rootPath);
		}

		const snapshot = this.options.dataSource.getBrickSnapshot(element.brickId);
		if (snapshot && snapshot.status !== 'READY') {
			return [
				{
					kind: 'message',
					brickId: element.brickId,
					label: 'Brick unavailable',
					detail: snapshot.lastError ?? 'Connection was interrupted. Expand root after reconnect.'
				}
			];
		}

		return this.loadDirectoryChildren(element.brickId, element.remotePath);
	}

	private async loadDirectoryChildren(brickId: string, remotePath: string): Promise<BrickTreeNode[]> {
		const logger = this.options.logger ?? new NoopLogger();
		try {
			const fsService = await this.options.dataSource.resolveFsService(brickId);
			const listing = await fsService.listDirectory(remotePath);
			const folders: BrickDirectoryNode[] = listing.folders
				.slice()
				.sort((left, right) => left.localeCompare(right))
				.map((name) => ({
					kind: 'directory',
					brickId,
					name,
					remotePath: path.posix.join(remotePath, name)
				}));
			const files: BrickFileNode[] = listing.files
				.slice()
				.sort((left, right) => left.name.localeCompare(right.name))
				.map((entry) => ({
					kind: 'file',
					brickId,
					name: entry.name,
					remotePath: path.posix.join(remotePath, entry.name),
					size: entry.size
				}));
			return [...folders, ...files];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const logFn = /offline|not connected|not open|timeout|unavailable/i.test(message) ? logger.info.bind(logger) : logger.warn.bind(logger);
			logFn('Brick tree directory listing failed', {
				brickId,
				remotePath,
				message
			});
			return [
				{
					kind: 'message',
					brickId,
					label: 'Cannot list directory',
					detail: message
				}
			];
		}
	}

	private renderStatusBadge(status: BrickSnapshot['status'], isActive: boolean): string {
		if (status === 'READY' && isActive) {
			return 'ACTIVE';
		}
		return status;
	}
}

export function isBrickRootNode(value: unknown): value is BrickRootNode {
	return !!value && typeof value === 'object' && (value as Partial<BrickRootNode>).kind === 'brick';
}

export function isBrickDirectoryNode(value: unknown): value is BrickDirectoryNode {
	return !!value && typeof value === 'object' && (value as Partial<BrickDirectoryNode>).kind === 'directory';
}

export function isBrickFileNode(value: unknown): value is BrickFileNode {
	return !!value && typeof value === 'object' && (value as Partial<BrickFileNode>).kind === 'file';
}
