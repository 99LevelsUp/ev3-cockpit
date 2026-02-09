import * as vscode from 'vscode';

const BRICK_UI_STATE_KEY = 'ev3-cockpit.brickUiState.v1';

interface BrickUiStateShape {
	favoriteOrder: string[];
}

function sanitizeFavoriteOrder(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const unique = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== 'string') {
			continue;
		}
		const trimmed = entry.trim();
		if (!trimmed) {
			continue;
		}
		unique.add(trimmed);
	}
	return [...unique];
}

export class BrickUiStateStore {
	private favoriteOrder: string[];

	public constructor(private readonly storage: Pick<vscode.Memento, 'get' | 'update'>) {
		const state = this.storage.get<BrickUiStateShape>(BRICK_UI_STATE_KEY);
		this.favoriteOrder = sanitizeFavoriteOrder(state?.favoriteOrder);
	}

	public isFavorite(brickId: string): boolean {
		return this.favoriteOrder.includes(brickId);
	}

	public getFavoriteOrder(): string[] {
		return [...this.favoriteOrder];
	}

	public async toggleFavorite(brickId: string): Promise<boolean> {
		const normalized = brickId.trim();
		if (!normalized) {
			return false;
		}
		const existingIndex = this.favoriteOrder.indexOf(normalized);
		if (existingIndex >= 0) {
			this.favoriteOrder.splice(existingIndex, 1);
			await this.save();
			return false;
		}
		this.favoriteOrder.push(normalized);
		await this.save();
		return true;
	}

	public async pruneMissing(validBrickIds: Set<string>): Promise<void> {
		const nextOrder = this.favoriteOrder.filter((brickId) => validBrickIds.has(brickId));
		if (nextOrder.length === this.favoriteOrder.length) {
			return;
		}
		this.favoriteOrder = nextOrder;
		await this.save();
	}

	private async save(): Promise<void> {
		await this.storage.update(BRICK_UI_STATE_KEY, {
			favoriteOrder: this.favoriteOrder
		} as BrickUiStateShape);
	}
}
