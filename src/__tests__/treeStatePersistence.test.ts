import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

class FakeDisposable {
	private readonly disposeFn: () => void;

	public constructor(disposeFn: () => void) {
		this.disposeFn = disposeFn;
	}

	public dispose(): void {
		this.disposeFn();
	}
}

class FakeEvent<T> {
	private listeners: Array<(value: T) => void> = [];

	public subscribe(listener: (value: T) => void): FakeDisposable {
		this.listeners.push(listener);
		return new FakeDisposable(() => {
			this.listeners = this.listeners.filter((entry) => entry !== listener);
		});
	}

	public fire(value: T): void {
		for (const listener of this.listeners) {
			listener(value);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withMockedTreePersistenceModule<T>(
	run: (mod: {
		createTreeStatePersistence: typeof import('../ui/treeStatePersistence').createTreeStatePersistence;
	}) => Promise<T>
): Promise<T> {
	const moduleAny = Module as unknown as {
		_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
	};
	const originalLoad = moduleAny._load;
	moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
		if (request === 'vscode') {
			return {
				Disposable: FakeDisposable
			};
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('../ui/treeStatePersistence') as {
			createTreeStatePersistence: typeof import('../ui/treeStatePersistence').createTreeStatePersistence;
		};
		return await run(mod);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('treeStatePersistence restores saved expansion and selection on tree refresh', async () => {
	await withMockedTreePersistenceModule(async ({ createTreeStatePersistence }) => {
		const expandEvent = new FakeEvent<{ element: any }>();
		const collapseEvent = new FakeEvent<{ element: any }>();
		const selectionEvent = new FakeEvent<{ selection: readonly any[] }>();
		const changeEvent = new FakeEvent<void>();
		const revealCalls: Array<{ nodeId: string; options: Record<string, unknown> }> = [];
		const updates: Array<{ expanded: string[]; selected?: string }> = [];

		const rootNode = {
			kind: 'brick',
			brickId: 'brick-1',
			displayName: 'EV3 A',
			role: 'standalone',
			transport: 'tcp',
			status: 'READY',
			isActive: true,
			rootPath: '/home/root/lms2012/prjs/'
		};
		const dirNode = {
			kind: 'directory',
			brickId: 'brick-1',
			name: 'docs',
			remotePath: '/home/root/lms2012/prjs/docs'
		};
		const fileNode = {
			kind: 'file',
			brickId: 'brick-1',
			name: 'main.rbf',
			remotePath: '/home/root/lms2012/prjs/docs/main.rbf',
			size: 123
		};

		const nodesById = new Map<string, any>([
			['brick:brick-1', rootNode],
			['dir:brick-1:/home/root/lms2012/prjs/docs', dirNode],
			['file:brick-1:/home/root/lms2012/prjs/docs/main.rbf', fileNode]
		]);

		const handle = createTreeStatePersistence(
			{
				getExpandedNodeIds: () => ['brick:brick-1', 'dir:brick-1:/home/root/lms2012/prjs/docs'],
				getSelectedNodeId: () => 'file:brick-1:/home/root/lms2012/prjs/docs/main.rbf',
				update: async (expandedNodeIds: Iterable<string>, selectedNodeId: string | undefined) => {
					updates.push({
						expanded: [...expandedNodeIds].sort(),
						selected: selectedNodeId
					});
				}
			} as Parameters<typeof createTreeStatePersistence>[0],
			{
				getNodeById: (nodeId: string) => nodesById.get(nodeId),
				onDidChangeTreeData: (listener: () => void) => changeEvent.subscribe(listener)
			} as unknown as Parameters<typeof createTreeStatePersistence>[1],
			{
				onDidExpandElement: (listener: (event: { element: any }) => void) => expandEvent.subscribe(listener),
				onDidCollapseElement: (listener: (event: { element: any }) => void) => collapseEvent.subscribe(listener),
				onDidChangeSelection: (listener: (event: { selection: readonly any[] }) => void) => selectionEvent.subscribe(listener),
				reveal: async (element: any, options: Record<string, unknown>) => {
					const nodeId =
						element.kind === 'brick'
							? 'brick:brick-1'
							: element.kind === 'directory'
							? 'dir:brick-1:/home/root/lms2012/prjs/docs'
							: 'file:brick-1:/home/root/lms2012/prjs/docs/main.rbf';
					revealCalls.push({ nodeId, options });
				}
			} as unknown as Parameters<typeof createTreeStatePersistence>[2]
		);

		changeEvent.fire();
		await sleep(130);
		assert.ok(revealCalls.some((call) => call.nodeId === 'brick:brick-1'));
		assert.ok(revealCalls.some((call) => call.nodeId === 'dir:brick-1:/home/root/lms2012/prjs/docs'));
		assert.ok(revealCalls.some((call) => call.nodeId === 'file:brick-1:/home/root/lms2012/prjs/docs/main.rbf'));

		expandEvent.fire({ element: rootNode });
		expandEvent.fire({ element: dirNode });
		selectionEvent.fire({ selection: [fileNode] });
		await sleep(160);
		assert.ok(updates.length > 0);
		const latest = updates[updates.length - 1];
		assert.deepEqual(latest.expanded, ['brick:brick-1', 'dir:brick-1:/home/root/lms2012/prjs/docs']);
		assert.equal(latest.selected, 'file:brick-1:/home/root/lms2012/prjs/docs/main.rbf');

		collapseEvent.fire({ element: dirNode });
		await sleep(160);
		const afterCollapse = updates[updates.length - 1];
		assert.deepEqual(afterCollapse.expanded, ['brick:brick-1']);

		selectionEvent.fire({ selection: [] });
		await sleep(160);
		const afterClearSelection = updates[updates.length - 1];
		assert.equal(afterClearSelection.selected, undefined);

		handle.dispose();
	});
});
