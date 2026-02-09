import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { createFakeMemento } from './testHelpers';

async function withUiStateModule<T>(
	run: (mod: {
		BrickUiStateStore: new (storage: {
			get<T>(key: string): T | undefined;
			update(key: string, value: unknown): Promise<void>;
		}) => {
			isFavorite: (brickId: string) => boolean;
			getFavoriteOrder: () => string[];
			toggleFavorite: (brickId: string) => Promise<boolean>;
			pruneMissing: (validBrickIds: Set<string>) => Promise<void>;
		};
	}) => Promise<T>
): Promise<T> {
	const moduleAny = Module as unknown as {
		_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
	};
	const originalLoad = moduleAny._load;

	moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
		if (request === 'vscode') {
			return {};
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const uiStateModule = require('../ui/brickUiStateStore') as {
			BrickUiStateStore: new (storage: {
				get<T>(key: string): T | undefined;
				update(key: string, value: unknown): Promise<void>;
			}) => {
				isFavorite: (brickId: string) => boolean;
				getFavoriteOrder: () => string[];
				toggleFavorite: (brickId: string) => Promise<boolean>;
				pruneMissing: (validBrickIds: Set<string>) => Promise<void>;
			};
		};
		return await run(uiStateModule);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('BrickUiStateStore toggles favorite membership', async () => {
	await withUiStateModule(async ({ BrickUiStateStore }) => {
		const store = new BrickUiStateStore(createFakeMemento());

		assert.equal(await store.toggleFavorite('brick-a'), true);
		assert.equal(store.isFavorite('brick-a'), true);
		assert.equal(await store.toggleFavorite('brick-a'), false);
		assert.equal(store.isFavorite('brick-a'), false);
	});
});

test('BrickUiStateStore prunes missing brick IDs while keeping order', async () => {
	await withUiStateModule(async ({ BrickUiStateStore }) => {
		const store = new BrickUiStateStore(
			createFakeMemento({
				'ev3-cockpit.brickUiState.v1': {
					favoriteOrder: ['brick-a', 'brick-b', 'brick-c']
				}
			})
		);

		await store.pruneMissing(new Set(['brick-c', 'brick-a']));
		assert.deepEqual(store.getFavoriteOrder(), ['brick-a', 'brick-c']);
	});
});
