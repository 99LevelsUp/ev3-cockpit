import * as vscode from 'vscode';

const BRICK_TREE_VIEW_STATE_KEY = 'ev3-cockpit.brickTreeViewState.v1';

interface BrickTreeViewStateShape {
	expandedNodeIds: string[];
	selectedNodeId?: string;
}

function sanitizeNodeId(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeExpandedNodeIds(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const unique = new Set<string>();
	for (const entry of value) {
		const normalized = sanitizeNodeId(entry);
		if (!normalized) {
			continue;
		}
		unique.add(normalized);
	}
	return [...unique];
}

function sameList(left: string[], right: string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

export class BrickTreeViewStateStore {
	private expandedNodeIds: string[];
	private selectedNodeId: string | undefined;

	public constructor(private readonly storage: Pick<vscode.Memento, 'get' | 'update'>) {
		const state = this.storage.get<BrickTreeViewStateShape>(BRICK_TREE_VIEW_STATE_KEY);
		this.expandedNodeIds = sanitizeExpandedNodeIds(state?.expandedNodeIds);
		this.selectedNodeId = sanitizeNodeId(state?.selectedNodeId);
	}

	public getExpandedNodeIds(): string[] {
		return [...this.expandedNodeIds];
	}

	public getSelectedNodeId(): string | undefined {
		return this.selectedNodeId;
	}

	public async update(expandedNodeIds: Iterable<string>, selectedNodeId: string | undefined): Promise<void> {
		const nextExpandedNodeIds = sanitizeExpandedNodeIds([...expandedNodeIds]);
		const nextSelectedNodeId = sanitizeNodeId(selectedNodeId);
		if (sameList(this.expandedNodeIds, nextExpandedNodeIds) && this.selectedNodeId === nextSelectedNodeId) {
			return;
		}
		this.expandedNodeIds = nextExpandedNodeIds;
		this.selectedNodeId = nextSelectedNodeId;
		await this.save();
	}

	private async save(): Promise<void> {
		await this.storage.update(BRICK_TREE_VIEW_STATE_KEY, {
			expandedNodeIds: this.expandedNodeIds,
			selectedNodeId: this.selectedNodeId
		} as BrickTreeViewStateShape);
	}
}
