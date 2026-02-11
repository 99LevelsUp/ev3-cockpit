import * as vscode from 'vscode';
import { BrickTreeNode, BrickTreeProvider, getBrickTreeNodeId } from './brickTreeProvider';
import { BrickTreeViewStateStore } from './brickTreeViewStateStore';

export interface TreeStatePersistenceHandle extends vscode.Disposable {
	readonly expandSubscription: vscode.Disposable;
	readonly collapseSubscription: vscode.Disposable;
	readonly selectionSubscription: vscode.Disposable;
	readonly changeSubscription: vscode.Disposable;
}

/** Debounce delay (ms) before persisting tree view expand/collapse state. */
const PERSIST_DEBOUNCE_MS = 120;

export function createTreeStatePersistence(
	store: BrickTreeViewStateStore,
	treeProvider: BrickTreeProvider,
	treeView: vscode.TreeView<BrickTreeNode>
): TreeStatePersistenceHandle {
	const expandedNodeIds = new Set<string>(store.getExpandedNodeIds());
	let pendingSelectionRestoreNodeId = store.getSelectedNodeId();
	let selectedNodeId = pendingSelectionRestoreNodeId;
	let persistTimer: NodeJS.Timeout | undefined;

	const persistState = async (): Promise<void> => {
		await store.update(expandedNodeIds, selectedNodeId);
	};

	const schedulePersist = (): void => {
		if (persistTimer) {
			clearTimeout(persistTimer);
		}
		persistTimer = setTimeout(() => {
			persistTimer = undefined;
			void persistState();
		}, PERSIST_DEBOUNCE_MS);
	};

	const rememberExpandedState = (element: BrickTreeNode, expanded: boolean): void => {
		if (element.kind !== 'brick' && element.kind !== 'directory') {
			return;
		}
		const nodeId = getBrickTreeNodeId(element);
		if (expanded) {
			expandedNodeIds.add(nodeId);
		} else {
			expandedNodeIds.delete(nodeId);
		}
		schedulePersist();
	};

	const rememberSelectionState = (selection: readonly BrickTreeNode[]): void => {
		const element = selection[0];
		if (!element || element.kind === 'message') {
			selectedNodeId = undefined;
			schedulePersist();
			return;
		}
		selectedNodeId = getBrickTreeNodeId(element);
		schedulePersist();
	};

	const restoreTreeViewState = async (): Promise<void> => {
		if (expandedNodeIds.size === 0 && !pendingSelectionRestoreNodeId) {
			return;
		}
		const sortedNodeIds = [...expandedNodeIds].sort((left, right) => left.localeCompare(right));
		for (let pass = 0; pass < 3; pass += 1) {
			let revealedAny = false;
			for (const nodeId of sortedNodeIds) {
				const node = treeProvider.getNodeById(nodeId);
				if (!node) {
					continue;
				}
				try {
					await treeView.reveal(node, {
						expand: true,
						focus: false,
						select: false
					});
					revealedAny = true;
				} catch {
					// ignore reveal failures for stale node ids
				}
			}
			if (!revealedAny) {
				break;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		if (!pendingSelectionRestoreNodeId) {
			return;
		}
		const selectedNode = treeProvider.getNodeById(pendingSelectionRestoreNodeId);
		if (!selectedNode || selectedNode.kind === 'message') {
			pendingSelectionRestoreNodeId = undefined;
			selectedNodeId = undefined;
			schedulePersist();
			return;
		}
		try {
			await treeView.reveal(selectedNode, {
				focus: false,
				select: true,
				expand: true
			});
			pendingSelectionRestoreNodeId = undefined;
		} catch {
			// Selection restore can race with async tree updates. Keep retrying on next tree refresh.
		}
	};

	const expandSubscription = treeView.onDidExpandElement((event) => {
		rememberExpandedState(event.element, true);
	});
	const collapseSubscription = treeView.onDidCollapseElement((event) => {
		rememberExpandedState(event.element, false);
	});
	const selectionSubscription = treeView.onDidChangeSelection((event) => {
		rememberSelectionState(event.selection);
	});
	const changeSubscription = treeProvider.onDidChangeTreeData(() => {
		void restoreTreeViewState();
	});

	return {
		expandSubscription,
		collapseSubscription,
		selectionSubscription,
		changeSubscription,
		dispose: () => {
			if (persistTimer) {
				clearTimeout(persistTimer);
				persistTimer = undefined;
			}
			void persistState();
		}
	};
}
