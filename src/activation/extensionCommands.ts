import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toErrorMessage } from '../commands/commandUtils';
import { BrickRegistry } from '../device/brickRegistry';
import { BrickRuntimeSnapshot, BrickProgramSnapshot } from '../device/brickSessionManager';
import { Logger } from '../diagnostics/logger';
import { parseEv3UriParts } from '../fs/ev3Uri';
import { Ev3FileSystemProvider } from '../fs/ev3FileSystemProvider';
import {
	BrickTreeNode,
	BrickTreeProvider,
	isBrickDirectoryNode,
	isBrickRootNode
} from '../ui/brickTreeProvider';
import { BrickUiStateStore } from '../ui/brickUiStateStore';
import { normalizeRemotePathForReveal } from './helpers';

// --- inspectBrickSessions ---

export interface InspectBrickSessionsOptions {
	getLogger: () => Logger;
	brickRegistry: BrickRegistry;
	sessionManager: {
		listRuntimeSnapshots(): BrickRuntimeSnapshot[];
		listProgramSnapshots(): BrickProgramSnapshot[];
	};
}

export function registerInspectBrickSessions(options: InspectBrickSessionsOptions): vscode.Disposable {
	const { getLogger, brickRegistry, sessionManager } = options;
	return vscode.commands.registerCommand('ev3-cockpit.inspectBrickSessions', async () => {
		const brickSnapshots = brickRegistry.listSnapshots();
		const runtimeSnapshots = sessionManager.listRuntimeSnapshots();
		const programSnapshots = sessionManager.listProgramSnapshots();
		const busySessions = runtimeSnapshots.filter((entry) => entry.busyCommandCount > 0).length;
		const report = {
			generatedAtIso: new Date().toISOString(),
			activeBrickId: brickRegistry.getActiveBrickId(),
			bricks: brickSnapshots,
			runtimeSessions: runtimeSnapshots,
			programSessions: programSnapshots
		};

		getLogger().info('Brick session diagnostics report', {
			...report
		});
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const reportDirectory = path.join(workspaceRoot, 'artifacts', 'diagnostics');
		const reportPath = path.join(reportDirectory, 'brick-sessions-report.json');
		try {
			await fs.mkdir(reportDirectory, { recursive: true });
			await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
		} catch (error) {
			getLogger().warn('Failed to export brick session diagnostics report to JSON.', {
				reportPath,
				error: toErrorMessage(error)
			});
		}
		vscode.window.showInformationMessage(
			`Brick session diagnostics: bricks=${brickSnapshots.length}, runtime=${runtimeSnapshots.length}, busy=${busySessions}. JSON: ${reportPath}`
		);
	});
}

// --- toggleFavoriteBrick ---

export interface ToggleFavoriteBrickOptions {
	resolveBrickIdFromCommandArg: (arg: unknown) => string;
	resolveConcreteBrickId: (brickId: string) => string;
	brickRegistry: BrickRegistry;
	brickUiStateStore: BrickUiStateStore;
	treeProvider: BrickTreeProvider;
}

export function registerToggleFavoriteBrick(options: ToggleFavoriteBrickOptions): vscode.Disposable {
	const { resolveBrickIdFromCommandArg, resolveConcreteBrickId, brickRegistry, brickUiStateStore, treeProvider } = options;
	return vscode.commands.registerCommand('ev3-cockpit.toggleFavoriteBrick', async (arg?: unknown) => {
		const requestedBrickId = resolveBrickIdFromCommandArg(arg);
		const brickId = resolveConcreteBrickId(requestedBrickId);
		const snapshot = brickRegistry.getSnapshot(brickId);
		if (!snapshot) {
			vscode.window.showErrorMessage(`Brick "${requestedBrickId}" is not available in tree.`);
			return;
		}
		const pinned = await brickUiStateStore.toggleFavorite(snapshot.brickId);
		treeProvider.refresh();
		vscode.window.showInformationMessage(
			pinned
				? `Brick pinned: ${snapshot.displayName}`
				: `Brick unpinned: ${snapshot.displayName}`
		);
	});
}

// --- Tree filter state ---

export interface TreeFilterState {
	getQuery: () => string;
	setQuery: (query: string) => Promise<void>;
}

export function createTreeFilterState(getRefreshTree: () => (() => void)): TreeFilterState {
	let filterQuery = '';
	return {
		getQuery: () => filterQuery,
		setQuery: async (nextQuery: string): Promise<void> => {
			const normalized = nextQuery.trim();
			if (filterQuery === normalized) {
				return;
			}
			filterQuery = normalized;
			await vscode.commands.executeCommand(
				'setContext',
				'ev3-cockpit.bricksFilterActive',
				filterQuery.length > 0
			);
			getRefreshTree()();
		}
	};
}

// --- setBricksTreeFilter ---

export interface SetBricksTreeFilterOptions {
	filterState: TreeFilterState;
}

export function registerSetBricksTreeFilter(options: SetBricksTreeFilterOptions): vscode.Disposable {
	const { filterState } = options;
	return vscode.commands.registerCommand('ev3-cockpit.setBricksTreeFilter', async (arg?: unknown) => {
		const query =
			typeof arg === 'string'
				? arg
				: await vscode.window.showInputBox({
					prompt: 'Filter bricks tree by brick name or remote path',
					value: filterState.getQuery(),
					placeHolder: 'Example: EV3 TCP, /docs/, main.rbf'
				});
		if (query === undefined) {
			return;
		}
		await filterState.setQuery(query);
		if (query.trim().length === 0) {
			vscode.window.showInformationMessage('Bricks tree filter cleared.');
		} else {
			vscode.window.showInformationMessage(`Bricks tree filter: "${query.trim()}"`);
		}
	});
}

// --- clearBricksTreeFilter ---

export function registerClearBricksTreeFilter(filterState: TreeFilterState): vscode.Disposable {
	return vscode.commands.registerCommand('ev3-cockpit.clearBricksTreeFilter', async () => {
		await filterState.setQuery('');
		vscode.window.showInformationMessage('Bricks tree filter cleared.');
	});
}

// --- retryDirectoryFromTree ---

export function registerRetryDirectoryFromTree(treeProvider: BrickTreeProvider): vscode.Disposable {
	return vscode.commands.registerCommand('ev3-cockpit.retryDirectoryFromTree', async (arg?: unknown) => {
		const directoryArg = (input: unknown): { brickId: string; remotePath: string } | undefined => {
			if (isBrickDirectoryNode(input)) {
				return {
					brickId: input.brickId,
					remotePath: input.remotePath
				};
			}
			if (isBrickRootNode(input)) {
				return {
					brickId: input.brickId,
					remotePath: input.rootPath
				};
			}
			if (!input || typeof input !== 'object') {
				return undefined;
			}
			const candidate = input as {
				brickId?: unknown;
				remotePath?: unknown;
			};
			if (typeof candidate.brickId !== 'string' || typeof candidate.remotePath !== 'string') {
				return undefined;
			}
			return {
				brickId: candidate.brickId,
				remotePath: candidate.remotePath
			};
		};
		const target = directoryArg(arg);
		if (!target) {
			vscode.window.showErrorMessage('Retry directory listing requires a directory node argument.');
			return;
		}
		treeProvider.refreshDirectory(target.brickId, target.remotePath);
	});
}

// --- revealInBricksTree ---

export interface RevealInBricksTreeOptions {
	brickRegistry: BrickRegistry;
	treeProvider: BrickTreeProvider;
	brickTreeView: vscode.TreeView<BrickTreeNode>;
}

export function registerRevealInBricksTree(options: RevealInBricksTreeOptions): vscode.Disposable {
	const { brickRegistry, treeProvider, brickTreeView } = options;
	return vscode.commands.registerCommand('ev3-cockpit.revealInBricksTree', async (arg?: unknown) => {
		const resolveUriFromArg = (): vscode.Uri | undefined => {
			if (arg instanceof vscode.Uri) {
				return arg;
			}
			if (typeof arg === 'string') {
				try {
					return vscode.Uri.parse(arg);
				} catch {
					return undefined;
				}
			}
			if (arg && typeof arg === 'object' && 'uri' in (arg as Record<string, unknown>)) {
				const candidate = (arg as { uri?: unknown }).uri;
				if (candidate instanceof vscode.Uri) {
					return candidate;
				}
				if (typeof candidate === 'string') {
					try {
						return vscode.Uri.parse(candidate);
					} catch {
						return undefined;
					}
				}
			}
			return vscode.window.activeTextEditor?.document.uri;
		};

		const targetUri = resolveUriFromArg();
		if (!targetUri || targetUri.scheme !== 'ev3') {
			vscode.window.showErrorMessage('Reveal in Bricks Tree requires an ev3:// URI.');
			return;
		}

		let parsed: ReturnType<typeof parseEv3UriParts>;
		try {
			parsed = parseEv3UriParts(targetUri.authority, targetUri.path);
		} catch (error) {
			const message = toErrorMessage(error);
			vscode.window.showErrorMessage(`Cannot parse EV3 URI: ${message}`);
			return;
		}

		const resolvedBrickId = parsed.brickId === 'active' ? brickRegistry.getActiveBrickId() : parsed.brickId;
		if (!resolvedBrickId) {
			vscode.window.showErrorMessage('No active brick is available for ev3://active URI.');
			return;
		}

		await treeProvider.getChildren();
		const rootNodeId = `brick:${resolvedBrickId}`;
		const rootNode = treeProvider.getNodeById(rootNodeId);
		if (!rootNode || rootNode.kind !== 'brick') {
			vscode.window.showErrorMessage(`Brick "${resolvedBrickId}" is not present in Bricks Tree.`);
			return;
		}

		const rootPath = normalizeRemotePathForReveal(rootNode.rootPath);
		const targetPath = normalizeRemotePathForReveal(parsed.remotePath);
		if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath === '/' ? '/' : `${rootPath}/`}`)) {
			vscode.window.showWarningMessage(`Path "${targetPath}" is outside root "${rootPath}" for this brick.`);
			return;
		}

		let currentNode: BrickTreeNode = rootNode;
		let currentPath = rootPath;
		const relativePath =
			targetPath === rootPath
				? ''
				: targetPath.slice(rootPath === '/' ? 1 : rootPath.length + 1);
		const segments = relativePath.length > 0 ? relativePath.split('/').filter((segment) => segment.length > 0) : [];
		try {
			await brickTreeView.reveal(rootNode, {
				expand: true,
				focus: false,
				select: segments.length === 0
			});
		} catch {
			// reveal fallback below handles unavailable target
		}

		for (let index = 0; index < segments.length; index += 1) {
			const segment = segments[index];
			const nextPath = path.posix.join(currentPath, segment);
			const children = await treeProvider.getChildren(currentNode);
			const isLast = index === segments.length - 1;
			const nextDirectory = children.find(
				(node): node is Extract<BrickTreeNode, { kind: 'directory' }> =>
					node.kind === 'directory' && normalizeRemotePathForReveal(node.remotePath) === nextPath
			);
			if (nextDirectory) {
				currentNode = nextDirectory;
				currentPath = nextPath;
				if (!isLast) {
					await brickTreeView.reveal(currentNode, {
						expand: true,
						focus: false,
						select: false
					});
				}
				continue;
			}

			if (isLast) {
				const targetFile = children.find(
					(node): node is Extract<BrickTreeNode, { kind: 'file' }> =>
						node.kind === 'file' && normalizeRemotePathForReveal(node.remotePath) === nextPath
				);
				if (targetFile) {
					currentNode = targetFile;
					currentPath = nextPath;
					continue;
				}
			}

			vscode.window.showWarningMessage(`Cannot reveal "${targetPath}" in Bricks Tree (missing path segment "${segment}").`);
			return;
		}

		try {
			await brickTreeView.reveal(currentNode, {
				expand: currentNode.kind === 'directory',
				focus: true,
				select: true
			});
		} catch (error) {
			const message = toErrorMessage(error);
			vscode.window.showWarningMessage(`Reveal in Bricks Tree failed: ${message}`);
		}
	});
}

// --- fsChangeSubscription ---

export interface FsChangeSubscriptionOptions {
	fsProvider: Ev3FileSystemProvider;
	brickRegistry: BrickRegistry;
	treeProvider: BrickTreeProvider;
}

export function registerFsChangeSubscription(options: FsChangeSubscriptionOptions): vscode.Disposable {
	const { fsProvider, brickRegistry, treeProvider } = options;
	return fsProvider.onDidChangeFile((events) => {
		const refreshTargets = new Set<string>();
		for (const event of events) {
			if (event.uri.scheme !== 'ev3') {
				continue;
			}
			try {
				const parsed = parseEv3UriParts(event.uri.authority, event.uri.path);
				const targetBrickId = parsed.brickId === 'active' ? brickRegistry.getActiveBrickId() ?? 'active' : parsed.brickId;
				const parentPath = path.posix.dirname(parsed.remotePath);
				refreshTargets.add(`${targetBrickId}|${parentPath}`);
			} catch {
				// ignore malformed URI events
			}
		}
		for (const target of refreshTargets) {
			const [brickId, remotePath] = target.split('|', 2);
			treeProvider.refreshDirectory(brickId, remotePath);
		}
	});
}
