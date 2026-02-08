import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

function createVscodeMock() {
	class Disposable {
		public constructor(private readonly disposer: () => void) {}
		public dispose(): void {
			this.disposer();
		}
	}

	class EventEmitter<T> {
		public readonly event = (_listener: (event: T) => unknown) => new Disposable(() => undefined);
		public fire(_event: T): void {}
	}

	class TreeItem {
		public id?: string;
		public description?: string;
		public tooltip?: string;
		public contextValue?: string;
		public iconPath?: unknown;
		public resourceUri?: { toString: () => string };
		public command?: { command: string; title: string; arguments?: unknown[] };
		public constructor(public label: string, public collapsibleState: number) {}
	}

	class ThemeIcon {
		public constructor(public readonly id: string) {}
	}

	const TreeItemCollapsibleState = {
		None: 0,
		Collapsed: 1,
		Expanded: 2
	};

	const Uri = {
		parse: (value: string) => ({
			toString: () => value
		})
	};

	return {
		Disposable,
		EventEmitter,
		TreeItem,
		ThemeIcon,
		TreeItemCollapsibleState,
		Uri
	};
}

async function withMockedProvider<T>(
	run: (mod: {
		BrickTreeProvider: new (options: unknown) => {
			getChildren: (element?: unknown) => Promise<unknown[]>;
			getTreeItem: (element: unknown) => {
				contextValue?: string;
				collapsibleState?: number;
				description?: string;
			};
		};
	}) => Promise<T>
): Promise<T> {
	const moduleAny = Module as unknown as {
		_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
	};
	const originalLoad = moduleAny._load;
	const vscodeMock = createVscodeMock();

	moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
		if (request === 'vscode') {
			return vscodeMock;
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const providerModule = require('../ui/brickTreeProvider') as {
			BrickTreeProvider: new (options: unknown) => {
				getChildren: (element?: unknown) => Promise<unknown[]>;
				getTreeItem: (element: unknown) => {
					contextValue?: string;
					collapsibleState?: number;
					description?: string;
				};
			};
		};
		return await run(providerModule);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('BrickTreeProvider exposes brick roots and directory children', async () => {
	await withMockedProvider(async ({ BrickTreeProvider }) => {
		const provider = new BrickTreeProvider({
			dataSource: {
				listBricks: () => [
					{
						brickId: 'usb-auto',
						displayName: 'EV3 USB',
						role: 'standalone',
						transport: 'usb',
						status: 'READY',
						isActive: true,
						rootPath: '/home/root/lms2012/prjs/'
					},
					{
						brickId: 'tcp-active',
						displayName: 'EV3 TCP',
						role: 'standalone',
						transport: 'tcp',
						status: 'UNAVAILABLE',
						isActive: false,
						rootPath: '/home/root/lms2012/prjs/',
						lastError: 'offline'
					}
				],
				resolveFsService: async () => ({
					listDirectory: async () => ({
						folders: ['Demo'],
						files: [{ name: 'main.rbf', size: 42 }]
					})
				})
			}
		});

		const roots = await provider.getChildren();
		assert.equal(roots.length, 2);
		const readyRoot = roots[0] as { kind: string; brickId: string };
		assert.equal(readyRoot.kind, 'brick');
		assert.equal(readyRoot.brickId, 'usb-auto');

		const readyItem = provider.getTreeItem(readyRoot);
		assert.equal(readyItem.contextValue, 'ev3BrickRootReady');

		const readyChildren = await provider.getChildren(readyRoot);
		assert.equal(readyChildren.length, 2);
		assert.equal((readyChildren[0] as { kind: string }).kind, 'directory');
		assert.equal((readyChildren[1] as { kind: string }).kind, 'file');

		const unavailableRoot = roots[1];
		const unavailableChildren = await provider.getChildren(unavailableRoot);
		assert.equal(unavailableChildren.length, 1);
		assert.equal((unavailableChildren[0] as { kind: string }).kind, 'message');
	});
});
