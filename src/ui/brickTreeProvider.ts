import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BrickSnapshot } from '../device/brickRegistry';
import { Logger, NoopLogger } from '../diagnostics/logger';
import { isRemoteExecutablePath } from '../fs/remoteExecutable';
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
	lastOperation?: string;
	lastOperationAtIso?: string;
	busyCommandCount?: number;
	schedulerState?: string;
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
	contextValue?: string;
	command?: vscode.Command;
}

export interface BrickTreeDataSource {
	listBricks(): BrickSnapshot[];
	getBrickSnapshot(brickId: string): BrickSnapshot | undefined;
	resolveFsService(brickId: string): Promise<RemoteFsService>;
}

interface BrickTreeProviderOptions {
	dataSource: BrickTreeDataSource;
	logger?: Logger;
	isFavoriteBrick?: (brickId: string) => boolean;
	getFilterQuery?: () => string;
}

interface DirectoryCacheEntry {
	expiresAt: number;
	children: BrickTreeNode[];
}

const DIRECTORY_CACHE_TTL_ROOT_MS = 900;
const DIRECTORY_CACHE_TTL_DEEP_MS = 2_200;
const DIRECTORY_CACHE_MAX_ENTRIES = 256;

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

function normalizeRemotePath(remotePath: string): string {
	const normalized = path.posix.normalize(remotePath.replace(/\\/g, '/'));
	if (normalized === '.') {
		return '/';
	}
	return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function cacheKey(brickId: string, remotePath: string): string {
	return `${brickId}|${remotePath}`;
}

function getDirectoryCacheTtlMs(remotePath: string): number {
	return remotePath === '/' ? DIRECTORY_CACHE_TTL_ROOT_MS : DIRECTORY_CACHE_TTL_DEEP_MS;
}

function buildRootNodeId(brickId: string): string {
	return `brick:${brickId}`;
}

function buildDirectoryNodeId(brickId: string, remotePath: string): string {
	return `dir:${brickId}:${remotePath}`;
}

function buildFileNodeId(brickId: string, remotePath: string): string {
	return `file:${brickId}:${remotePath}`;
}

export function getBrickTreeNodeId(node: BrickTreeNode): string {
	if (node.kind === 'brick') {
		return buildRootNodeId(node.brickId);
	}
	if (node.kind === 'directory') {
		return buildDirectoryNodeId(node.brickId, node.remotePath);
	}
	if (node.kind === 'file') {
		return buildFileNodeId(node.brickId, node.remotePath);
	}
	return `message:${node.brickId}:${node.label}`;
}

export class BrickTreeProvider implements vscode.TreeDataProvider<BrickTreeNode> {
	private readonly eventEmitter = new vscode.EventEmitter<BrickTreeNode | undefined | null | void>();
	private refreshTimer: NodeJS.Timeout | undefined;
	private readonly rootNodesByBrickId = new Map<string, BrickRootNode>();
	private readonly directoryNodesByPath = new Map<string, BrickDirectoryNode>();
	private readonly fileNodesByPath = new Map<string, BrickFileNode>();
	private readonly nodesById = new Map<string, BrickTreeNode>();
	private readonly directoryCache = new Map<string, DirectoryCacheEntry>();

	public readonly onDidChangeTreeData = this.eventEmitter.event;

	public constructor(
		private readonly options: BrickTreeProviderOptions
	) {}

	public dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.rootNodesByBrickId.clear();
		this.directoryNodesByPath.clear();
		this.fileNodesByPath.clear();
		this.nodesById.clear();
		this.directoryCache.clear();
	}

	public refresh(element?: BrickTreeNode): void {
		this.eventEmitter.fire(element);
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

	public refreshBrick(brickId: string): void {
		this.invalidateBrickCache(brickId);
		const root = this.rootNodesByBrickId.get(brickId);
		this.refresh(root);
	}

	public refreshDirectory(brickId: string, remotePath: string): void {
		const normalized = normalizeRemotePath(remotePath);
		this.invalidatePathCache(brickId, normalized, {
			includeDescendants: true,
			includeParents: true
		});
		const targetNode =
			this.directoryNodesByPath.get(cacheKey(brickId, normalized)) ?? this.rootNodesByBrickId.get(brickId);
		this.refresh(targetNode);
	}

	public invalidateBrickCache(brickId: string): void {
		for (const key of this.directoryCache.keys()) {
			if (key.startsWith(`${brickId}|`)) {
				this.directoryCache.delete(key);
			}
		}
	}

	public invalidatePathCache(
		brickId: string,
		remotePath: string,
		options: {
			includeDescendants?: boolean;
			includeParents?: boolean;
		} = {}
	): void {
		const normalizedTargetPath = normalizeRemotePath(remotePath);
		const includeDescendants = options.includeDescendants ?? true;
		const includeParents = options.includeParents ?? false;

		for (const key of this.directoryCache.keys()) {
			if (!key.startsWith(`${brickId}|`)) {
				continue;
			}
			const cachedPath = key.slice(brickId.length + 1);
			const isTarget = cachedPath === normalizedTargetPath;
			const isDescendant =
				includeDescendants && cachedPath.startsWith(`${normalizedTargetPath === '/' ? '/' : `${normalizedTargetPath}/`}`);
			const isParent =
				includeParents &&
				normalizedTargetPath !== cachedPath &&
				normalizedTargetPath.startsWith(`${cachedPath === '/' ? '/' : `${cachedPath}/`}`);
			if (isTarget || isDescendant || isParent) {
				this.directoryCache.delete(key);
			}
		}
	}

	public getNodeById(nodeId: string): BrickTreeNode | undefined {
		return this.nodesById.get(nodeId);
	}

	private getCachedDirectoryChildren(key: string): BrickTreeNode[] | undefined {
		const entry = this.directoryCache.get(key);
		if (!entry) {
			return undefined;
		}
		if (entry.expiresAt <= Date.now()) {
			this.directoryCache.delete(key);
			return undefined;
		}

		// LRU touch.
		this.directoryCache.delete(key);
		this.directoryCache.set(key, entry);
		return entry.children;
	}

	private setCachedDirectoryChildren(key: string, remotePath: string, children: BrickTreeNode[]): void {
		this.directoryCache.delete(key);
		this.directoryCache.set(key, {
			expiresAt: Date.now() + getDirectoryCacheTtlMs(remotePath),
			children
		});
		while (this.directoryCache.size > DIRECTORY_CACHE_MAX_ENTRIES) {
			const oldestKey = this.directoryCache.keys().next().value as string | undefined;
			if (!oldestKey) {
				break;
			}
			this.directoryCache.delete(oldestKey);
		}
	}

	public getTreeItem(element: BrickTreeNode): vscode.TreeItem {
		switch (element.kind) {
			case 'brick': {
				const item = new vscode.TreeItem(element.displayName, vscode.TreeItemCollapsibleState.Collapsed);
				item.id = buildRootNodeId(element.brickId);
				const statusBadge = this.renderStatusBadge(element.status, element.isActive);
				const descriptionParts = [statusBadge];
				if (this.options.isFavoriteBrick?.(element.brickId)) {
					descriptionParts.push('PIN');
				}
				if ((element.busyCommandCount ?? 0) > 0) {
					descriptionParts.push(`busy:${element.busyCommandCount}`);
				}
				descriptionParts.push(element.transport, element.role);
				item.description = descriptionParts.join(' | ');
				item.tooltip = this.buildRootTooltip(element);
				item.contextValue = this.getRootContextValue(element);
				item.iconPath = this.getRootIcon(element);
				item.resourceUri = buildEv3Uri(element.brickId, element.rootPath);
				return item;
			}
			case 'directory': {
				const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.id = buildDirectoryNodeId(element.brickId, element.remotePath);
				item.contextValue = 'ev3RemoteDirectory';
				item.resourceUri = buildEv3Uri(element.brickId, element.remotePath);
				return item;
			}
			case 'file': {
				const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
				item.id = buildFileNodeId(element.brickId, element.remotePath);
				item.description = `${element.size} B`;
				const isExecutable = isRemoteExecutablePath(element.remotePath);
				item.contextValue = isExecutable ? 'ev3RemoteFileExecutable' : 'ev3RemoteFile';
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
				item.contextValue = element.contextValue ?? 'ev3BrickMessage';
				item.iconPath = new vscode.ThemeIcon('info');
				item.command = element.command;
				return item;
			}
		}
	}

	public async getChildren(element?: BrickTreeNode): Promise<BrickTreeNode[]> {
		if (!element) {
			const snapshots = this.options.dataSource.listBricks();
			const seenBrickIds = new Set<string>();
			const roots = snapshots.map((snapshot) => {
				seenBrickIds.add(snapshot.brickId);
				return this.upsertRootNode(snapshot);
			});

			for (const brickId of this.rootNodesByBrickId.keys()) {
				if (!seenBrickIds.has(brickId)) {
					const root = this.rootNodesByBrickId.get(brickId);
					if (root) {
						this.nodesById.delete(getBrickTreeNodeId(root));
					}
					this.rootNodesByBrickId.delete(brickId);
					this.invalidateBrickCache(brickId);
				}
			}
			const query = this.resolveFilterQuery();
			if (!query) {
				return roots;
			}
			return this.filterRootNodesByQuery(roots, query);
		}

		if (element.kind === 'message' || element.kind === 'file') {
			return [];
		}

		if (element.kind === 'brick') {
			if (element.status !== 'READY') {
				this.invalidateBrickCache(element.brickId);
				return [
					this.buildUnavailableMessageNode(
						element.brickId,
						element.status,
						element.lastError,
						'Connect to this brick to browse files.'
					)
				];
			}
			const children = await this.loadDirectoryChildren(element.brickId, element.rootPath);
			const query = this.resolveFilterQuery();
			if (!query) {
				return children;
			}
			return this.filterChildrenByQuery(children, query);
		}

		const snapshot = this.options.dataSource.getBrickSnapshot(element.brickId);
		if (snapshot && snapshot.status !== 'READY') {
			this.invalidateBrickCache(element.brickId);
			return [
				this.buildUnavailableMessageNode(
					element.brickId,
					snapshot.status,
					snapshot.lastError,
					'Connection was interrupted. Expand root after reconnect.'
				)
			];
		}

		const children = await this.loadDirectoryChildren(element.brickId, element.remotePath);
		const query = this.resolveFilterQuery();
		if (!query) {
			return children;
		}
		return this.filterChildrenByQuery(children, query);
	}

	private resolveFilterQuery(): string | undefined {
		const raw = this.options.getFilterQuery?.();
		if (typeof raw !== 'string') {
			return undefined;
		}
		const normalized = raw.trim().toLowerCase();
		return normalized.length > 0 ? normalized : undefined;
	}

	private matchesFilterQuery(query: string, ...candidates: Array<string | undefined>): boolean {
		for (const candidate of candidates) {
			if (typeof candidate !== 'string') {
				continue;
			}
			if (candidate.toLowerCase().includes(query)) {
				return true;
			}
		}
		return false;
	}

	private async filterRootNodesByQuery(roots: BrickTreeNode[], query: string): Promise<BrickTreeNode[]> {
		const filtered: BrickTreeNode[] = [];
		for (const node of roots) {
			if (node.kind !== 'brick') {
				continue;
			}
			if (this.matchesFilterQuery(query, node.displayName, node.brickId, node.rootPath)) {
				filtered.push(node);
				continue;
			}
			if (node.status !== 'READY') {
				continue;
			}
			if (await this.directoryHasMatchingDescendant(node.brickId, node.rootPath, query, new Set<string>())) {
				filtered.push(node);
			}
		}
		return filtered;
	}

	private async filterChildrenByQuery(children: BrickTreeNode[], query: string): Promise<BrickTreeNode[]> {
		const filtered: BrickTreeNode[] = [];
		for (const node of children) {
			if (node.kind === 'message') {
				continue;
			}
			if (node.kind === 'file') {
				if (this.matchesFilterQuery(query, node.name, node.remotePath)) {
					filtered.push(node);
				}
				continue;
			}
			if (node.kind !== 'directory') {
				continue;
			}
			if (this.matchesFilterQuery(query, node.name, node.remotePath)) {
				filtered.push(node);
				continue;
			}
			if (await this.directoryHasMatchingDescendant(node.brickId, node.remotePath, query, new Set<string>())) {
				filtered.push(node);
			}
		}
		return filtered;
	}

	private async directoryHasMatchingDescendant(
		brickId: string,
		remotePath: string,
		query: string,
		visitedPaths: Set<string>
	): Promise<boolean> {
		const normalizedPath = normalizeRemotePath(remotePath);
		const key = `${brickId}|${normalizedPath}`;
		if (visitedPaths.has(key)) {
			return false;
		}
		visitedPaths.add(key);
		const children = await this.loadDirectoryChildren(brickId, normalizedPath);
		for (const node of children) {
			if (node.kind === 'file' && this.matchesFilterQuery(query, node.name, node.remotePath)) {
				return true;
			}
			if (node.kind !== 'directory') {
				continue;
			}
			if (this.matchesFilterQuery(query, node.name, node.remotePath)) {
				return true;
			}
			if (await this.directoryHasMatchingDescendant(node.brickId, node.remotePath, query, visitedPaths)) {
				return true;
			}
		}
		return false;
	}

	private async loadDirectoryChildren(brickId: string, remotePath: string): Promise<BrickTreeNode[]> {
		const logger = this.options.logger ?? new NoopLogger();
		const normalizedPath = normalizeRemotePath(remotePath);
		const key = cacheKey(brickId, normalizedPath);
		const cachedChildren = this.getCachedDirectoryChildren(key);
		if (cachedChildren) {
			return cachedChildren;
		}

		try {
			const fsService = await this.options.dataSource.resolveFsService(brickId);
			const listing = await fsService.listDirectory(normalizedPath);
			const folders: BrickDirectoryNode[] = listing.folders
				.slice()
				.sort((left, right) => left.localeCompare(right))
				.map((name) => this.upsertDirectoryNode(brickId, name, path.posix.join(normalizedPath, name)));
			const files: BrickFileNode[] = listing.files
				.slice()
				.sort((left, right) => left.name.localeCompare(right.name))
				.map((entry) =>
					this.upsertFileNode(brickId, entry.name, path.posix.join(normalizedPath, entry.name), entry.size)
				);
			const children: BrickTreeNode[] =
				folders.length > 0 || files.length > 0
					? [...folders, ...files]
					: [
						{
							kind: 'message',
							brickId,
							label: 'Empty folder',
							detail: normalizedPath,
							contextValue: 'ev3RemoteDirectoryEmpty'
						}
					];
			this.setCachedDirectoryChildren(key, normalizedPath, children);
			return children;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const logFn = /offline|not connected|not open|timeout|unavailable/i.test(message)
				? logger.info.bind(logger)
				: logger.warn.bind(logger);
			logFn('Brick tree directory listing failed', {
				brickId,
				remotePath: normalizedPath,
				message
			});
			this.directoryCache.delete(key);
			return [
				{
					kind: 'message',
					brickId,
					label: 'Cannot list directory',
					detail: message,
					contextValue: 'ev3RemoteDirectoryError',
					command: {
						command: 'ev3-cockpit.retryDirectoryFromTree',
						title: 'Retry Directory Listing',
						arguments: [
							{
								kind: 'directory',
								brickId,
								remotePath: normalizedPath
							}
						]
					}
				}
			];
		}
	}

	private buildRootTooltip(node: BrickRootNode): string {
		const lines = [`${node.displayName}`, `Status: ${node.status}`, `Root: ${node.rootPath}`];
		lines.push(`Runtime: ${node.schedulerState ?? 'idle'}, busy=${node.busyCommandCount ?? 0}`);
		if (node.lastOperation) {
			lines.push(
				`Last operation: ${node.lastOperation}${
					node.lastOperationAtIso ? ` (${new Date(node.lastOperationAtIso).toLocaleTimeString()})` : ''
				}`
			);
		}
		if (node.lastError) {
			lines.push(`Error: ${node.lastError}`);
		}
		return lines.join('\n');
	}

	private getRootContextValue(node: BrickRootNode): string {
		if (node.status === 'READY') {
			return node.isActive ? 'ev3BrickRootReadyActive' : 'ev3BrickRootReady';
		}
		if (node.status === 'CONNECTING') {
			return 'ev3BrickRootConnecting';
		}
		if (node.status === 'ERROR') {
			return 'ev3BrickRootError';
		}
		return 'ev3BrickRootUnavailable';
	}

	private getRootIcon(node: BrickRootNode): vscode.ThemeIcon {
		if (node.status === 'READY') {
			if ((node.busyCommandCount ?? 0) > 0) {
				return new vscode.ThemeIcon('sync~spin');
			}
			return new vscode.ThemeIcon(node.isActive ? 'plug' : 'device-camera-video');
		}
		if (node.status === 'CONNECTING') {
			return new vscode.ThemeIcon('sync~spin');
		}
		if (node.status === 'ERROR') {
			return new vscode.ThemeIcon('error');
		}
		return new vscode.ThemeIcon('debug-disconnect');
	}

	private buildUnavailableMessageNode(
		brickId: string,
		status: BrickSnapshot['status'],
		lastError: string | undefined,
		fallbackDetail: string
	): BrickMessageNode {
		if (status === 'CONNECTING') {
			return {
				kind: 'message',
				brickId,
				label: 'Connecting...',
				detail: 'Connection is being established.',
				contextValue: 'ev3BrickMessageConnecting'
			};
		}
		if (status === 'ERROR') {
			return {
				kind: 'message',
				brickId,
				label: 'Brick error',
				detail: lastError ?? 'Connection failed. Reconnect to retry.',
				contextValue: 'ev3BrickMessageConnect',
				command: {
					command: 'ev3-cockpit.connectEV3',
					title: 'Connect EV3',
					arguments: [brickId]
				}
			};
		}
		return {
			kind: 'message',
			brickId,
			label: 'Brick unavailable',
			detail: lastError ?? fallbackDetail,
			contextValue: 'ev3BrickMessageConnect',
			command: {
				command: 'ev3-cockpit.connectEV3',
				title: 'Connect EV3',
				arguments: [brickId]
			}
		};
	}

	private upsertRootNode(snapshot: BrickSnapshot): BrickRootNode {
		const rootPath = normalizeRootPath(snapshot.rootPath);
		const existing = this.rootNodesByBrickId.get(snapshot.brickId);
		if (existing) {
			existing.displayName = snapshot.displayName;
			existing.role = snapshot.role;
			existing.transport = snapshot.transport;
			existing.status = snapshot.status;
			existing.isActive = snapshot.isActive;
			existing.rootPath = rootPath;
			existing.lastError = snapshot.lastError;
			existing.lastOperation = snapshot.lastOperation;
			existing.lastOperationAtIso = snapshot.lastOperationAtIso;
			existing.busyCommandCount = snapshot.busyCommandCount;
			existing.schedulerState = snapshot.schedulerState;
			this.nodesById.set(getBrickTreeNodeId(existing), existing);
			return existing;
		}

		const created: BrickRootNode = {
			kind: 'brick',
			brickId: snapshot.brickId,
			displayName: snapshot.displayName,
			role: snapshot.role,
			transport: snapshot.transport,
			status: snapshot.status,
			isActive: snapshot.isActive,
			rootPath,
			lastError: snapshot.lastError,
			lastOperation: snapshot.lastOperation,
			lastOperationAtIso: snapshot.lastOperationAtIso,
			busyCommandCount: snapshot.busyCommandCount,
			schedulerState: snapshot.schedulerState
		};
		this.rootNodesByBrickId.set(snapshot.brickId, created);
		this.nodesById.set(getBrickTreeNodeId(created), created);
		return created;
	}

	private upsertDirectoryNode(brickId: string, name: string, remotePath: string): BrickDirectoryNode {
		const normalizedPath = normalizeRemotePath(remotePath);
		const key = cacheKey(brickId, normalizedPath);
		const existing = this.directoryNodesByPath.get(key);
		if (existing) {
			existing.name = name;
			existing.remotePath = normalizedPath;
			this.nodesById.set(getBrickTreeNodeId(existing), existing);
			return existing;
		}

		const created: BrickDirectoryNode = {
			kind: 'directory',
			brickId,
			name,
			remotePath: normalizedPath
		};
		this.directoryNodesByPath.set(key, created);
		this.nodesById.set(getBrickTreeNodeId(created), created);
		return created;
	}

	private upsertFileNode(brickId: string, name: string, remotePath: string, size: number): BrickFileNode {
		const normalizedPath = normalizeRemotePath(remotePath);
		const key = cacheKey(brickId, normalizedPath);
		const existing = this.fileNodesByPath.get(key);
		if (existing) {
			existing.name = name;
			existing.remotePath = normalizedPath;
			existing.size = size;
			this.nodesById.set(getBrickTreeNodeId(existing), existing);
			return existing;
		}

		const created: BrickFileNode = {
			kind: 'file',
			brickId,
			name,
			remotePath: normalizedPath,
			size
		};
		this.fileNodesByPath.set(key, created);
		this.nodesById.set(getBrickTreeNodeId(created), created);
		return created;
	}

	private renderStatusBadge(status: BrickSnapshot['status'], isActive: boolean): string {
		if (status === 'READY' && isActive) {
			return 'ACTIVE';
		}
		if (status === 'UNAVAILABLE') {
			return 'OFFLINE';
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
