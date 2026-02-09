import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { createFakeMemento } from './testHelpers';

async function withTreeViewStateModule<T>(
	run: (mod: {
		BrickTreeViewStateStore: new (storage: {
			get<T>(key: string): T | undefined;
			update(key: string, value: unknown): Promise<void>;
		}) => {
			getExpandedNodeIds: () => string[];
			getSelectedNodeId: () => string | undefined;
			update: (expandedNodeIds: Iterable<string>, selectedNodeId: string | undefined) => Promise<void>;
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
		const stateModule = require('../ui/brickTreeViewStateStore') as {
			BrickTreeViewStateStore: new (storage: {
				get<T>(key: string): T | undefined;
				update(key: string, value: unknown): Promise<void>;
			}) => {
				getExpandedNodeIds: () => string[];
				getSelectedNodeId: () => string | undefined;
				update: (expandedNodeIds: Iterable<string>, selectedNodeId: string | undefined) => Promise<void>;
			};
		};
		return await run(stateModule);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('BrickTreeViewStateStore loads and sanitizes persisted state', async () => {
	await withTreeViewStateModule(async ({ BrickTreeViewStateStore }) => {
		const store = new BrickTreeViewStateStore(
			createFakeMemento({
				'ev3-cockpit.brickTreeViewState.v1': {
					expandedNodeIds: ['brick:a', ' ', 'dir:a:/home', 'brick:a'],
					selectedNodeId: '  file:a:/home/main.rbf  '
				}
			})
		);

		assert.deepEqual(store.getExpandedNodeIds(), ['brick:a', 'dir:a:/home']);
		assert.equal(store.getSelectedNodeId(), 'file:a:/home/main.rbf');
	});
});

test('BrickTreeViewStateStore persists updates', async () => {
	await withTreeViewStateModule(async ({ BrickTreeViewStateStore }) => {
		const memento = createFakeMemento();
		const store = new BrickTreeViewStateStore(memento);

		await store.update(['brick:a', 'dir:a:/home', 'brick:a'], ' file:a:/home/main.rbf ');
		assert.deepEqual(store.getExpandedNodeIds(), ['brick:a', 'dir:a:/home']);
		assert.equal(store.getSelectedNodeId(), 'file:a:/home/main.rbf');

		const persisted = memento.get<{
			expandedNodeIds?: string[];
			selectedNodeId?: string;
		}>('ev3-cockpit.brickTreeViewState.v1');
		assert.deepEqual(persisted?.expandedNodeIds, ['brick:a', 'dir:a:/home']);
		assert.equal(persisted?.selectedNodeId, 'file:a:/home/main.rbf');
	});
});
