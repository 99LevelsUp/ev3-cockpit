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
				tooltip?: string;
				command?: { command: string };
			};
			refreshDirectory: (brickId: string, remotePath: string) => void;
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
					tooltip?: string;
					command?: { command: string };
				};
				refreshDirectory: (brickId: string, remotePath: string) => void;
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
				getBrickSnapshot: (brickId: string) =>
					brickId === 'usb-auto'
						? {
								brickId: 'usb-auto',
								displayName: 'EV3 USB',
								role: 'standalone',
								transport: 'usb',
								status: 'READY',
								isActive: true,
								rootPath: '/home/root/lms2012/prjs/'
							}
						: {
								brickId: 'tcp-active',
								displayName: 'EV3 TCP',
								role: 'standalone',
								transport: 'tcp',
								status: 'UNAVAILABLE',
								isActive: false,
								rootPath: '/home/root/lms2012/prjs/',
								lastError: 'offline'
							},
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
		assert.equal(readyItem.contextValue, 'ev3BrickRootReadyActive');
		assert.equal(readyItem.command, undefined);
		assert.match(readyItem.description ?? '', /ACTIVE/);

		const readyChildren = await provider.getChildren(readyRoot);
		assert.equal(readyChildren.length, 2);
		assert.equal((readyChildren[0] as { kind: string }).kind, 'directory');
		assert.equal((readyChildren[1] as { kind: string }).kind, 'file');

		const unavailableRoot = roots[1];
		const unavailableItem = provider.getTreeItem(unavailableRoot);
		assert.equal(unavailableItem.command, undefined);
		const unavailableChildren = await provider.getChildren(unavailableRoot);
		assert.equal(unavailableChildren.length, 1);
		assert.equal((unavailableChildren[0] as { kind: string }).kind, 'message');
		const unavailableMessageItem = provider.getTreeItem(unavailableChildren[0]);
		assert.equal(unavailableMessageItem.contextValue, 'ev3BrickMessageConnect');
		assert.equal(unavailableMessageItem.command?.command, 'ev3-cockpit.connectEV3');
	});
});

test('BrickTreeProvider filters roots and descendants by query', async () => {
	await withMockedProvider(async ({ BrickTreeProvider }) => {
		let query = '';
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
					}
				],
				getBrickSnapshot: () => ({
					brickId: 'usb-auto',
					displayName: 'EV3 USB',
					role: 'standalone',
					transport: 'usb',
					status: 'READY',
					isActive: true,
					rootPath: '/home/root/lms2012/prjs/'
				}),
				resolveFsService: async () => ({
					listDirectory: async (remotePath: string) => {
						if (remotePath === '/home/root/lms2012/prjs' || remotePath === '/home/root/lms2012/prjs/') {
							return {
								folders: ['docs', 'bin'],
								files: [{ name: 'main.rbf', size: 42 }]
							};
						}
						if (remotePath === '/home/root/lms2012/prjs/docs') {
							return {
								folders: ['examples'],
								files: [{ name: 'readme.txt', size: 12 }]
							};
						}
						if (remotePath === '/home/root/lms2012/prjs/docs/examples') {
							return {
								folders: [],
								files: [{ name: 'lesson.txt', size: 8 }]
							};
						}
						if (remotePath === '/home/root/lms2012/prjs/bin') {
							return {
								folders: [],
								files: [{ name: 'tool.bin', size: 6 }]
							};
						}
						return {
							folders: [],
							files: []
						};
					}
				})
			},
			getFilterQuery: () => query
		});

		query = 'lesson';
		const roots = await provider.getChildren();
		assert.equal(roots.length, 1);
		const rootChildren = await provider.getChildren(roots[0]);
		assert.equal(rootChildren.length, 1);
		assert.equal((rootChildren[0] as { kind: string; name: string }).kind, 'directory');
		assert.equal((rootChildren[0] as { kind: string; name: string }).name, 'docs');

		const docsChildren = await provider.getChildren(rootChildren[0]);
		assert.equal(docsChildren.length, 1);
		assert.equal((docsChildren[0] as { kind: string; name: string }).name, 'examples');

		query = 'ev3 usb';
		assert.equal((await provider.getChildren()).length, 1);

		query = 'missing-entry';
		assert.equal((await provider.getChildren()).length, 0);
	});
});

test('BrickTreeProvider returns unavailable message for expanded directory after disconnect', async () => {
	await withMockedProvider(async ({ BrickTreeProvider }) => {
		let unavailable = false;
		const provider = new BrickTreeProvider({
			dataSource: {
				listBricks: () => [
					{
						brickId: 'usb-auto',
						displayName: 'EV3 USB',
						role: 'standalone',
						transport: 'usb',
						status: unavailable ? 'UNAVAILABLE' : 'READY',
						isActive: true,
						rootPath: '/home/root/lms2012/prjs/',
						lastError: unavailable ? 'Disconnected' : undefined
					}
				],
				getBrickSnapshot: () => ({
					brickId: 'usb-auto',
					displayName: 'EV3 USB',
					role: 'standalone',
					transport: 'usb',
					status: unavailable ? 'UNAVAILABLE' : 'READY',
					isActive: true,
					rootPath: '/home/root/lms2012/prjs/',
					lastError: unavailable ? 'Disconnected' : undefined
				}),
				resolveFsService: async () => ({
					listDirectory: async () => ({
						folders: ['Demo'],
						files: []
					})
				})
			}
		});

		const roots = await provider.getChildren();
		const root = roots[0];
		const children = await provider.getChildren(root);
		assert.equal((children[0] as { kind: string }).kind, 'directory');

		unavailable = true;
		const afterDisconnect = await provider.getChildren(children[0]);
		assert.equal(afterDisconnect.length, 1);
		assert.equal((afterDisconnect[0] as { kind: string }).kind, 'message');
		assert.match((afterDisconnect[0] as { label: string }).label, /Brick unavailable/);
	});
});

test('BrickTreeProvider exposes retry action for directory listing errors', async () => {
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
					}
				],
				getBrickSnapshot: () => ({
					brickId: 'usb-auto',
					displayName: 'EV3 USB',
					role: 'standalone',
					transport: 'usb',
					status: 'READY',
					isActive: true,
					rootPath: '/home/root/lms2012/prjs/'
				}),
				resolveFsService: async () => ({
					listDirectory: async () => {
						throw new Error('simulated listing failure');
					}
				})
			}
		});

		const roots = await provider.getChildren();
		const children = await provider.getChildren(roots[0]);
		assert.equal(children.length, 1);
		const errorNode = children[0];
		const errorItem = provider.getTreeItem(errorNode);
		assert.equal(errorItem.contextValue, 'ev3RemoteDirectoryError');
		assert.equal(errorItem.command?.command, 'ev3-cockpit.retryDirectoryFromTree');
	});
});

test('BrickTreeProvider renders empty-folder message for empty listing', async () => {
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
					}
				],
				getBrickSnapshot: () => ({
					brickId: 'usb-auto',
					displayName: 'EV3 USB',
					role: 'standalone',
					transport: 'usb',
					status: 'READY',
					isActive: true,
					rootPath: '/home/root/lms2012/prjs/'
				}),
				resolveFsService: async () => ({
					listDirectory: async () => ({
						folders: [],
						files: []
					})
				})
			}
		});

		const roots = await provider.getChildren();
		const children = await provider.getChildren(roots[0]);
		assert.equal(children.length, 1);
		assert.equal((children[0] as { kind: string }).kind, 'message');
		const emptyMessageItem = provider.getTreeItem(children[0]);
		assert.equal(emptyMessageItem.contextValue, 'ev3RemoteDirectoryEmpty');
		assert.equal(emptyMessageItem.command, undefined);
	});
});

test('BrickTreeProvider maps root status to context and action', async () => {
	await withMockedProvider(async ({ BrickTreeProvider }) => {
		const provider = new BrickTreeProvider({
			dataSource: {
				listBricks: () => [
					{
						brickId: 'connecting-1',
						displayName: 'Connecting EV3',
						role: 'standalone',
						transport: 'usb',
						status: 'CONNECTING',
						isActive: false,
						rootPath: '/home/root/lms2012/prjs/'
					},
					{
						brickId: 'error-1',
						displayName: 'Error EV3',
						role: 'standalone',
						transport: 'tcp',
						status: 'ERROR',
						isActive: false,
						rootPath: '/home/root/lms2012/prjs/',
						lastError: 'Probe failed'
					}
				],
				getBrickSnapshot: () => undefined,
				resolveFsService: async () => ({
					listDirectory: async () => ({
						folders: [],
						files: []
					})
				})
			}
		});

		const roots = await provider.getChildren();
		const connectingItem = provider.getTreeItem(roots[0]);
		assert.equal(connectingItem.contextValue, 'ev3BrickRootConnecting');
		assert.equal(connectingItem.command, undefined);

		const errorItem = provider.getTreeItem(roots[1]);
		assert.equal(errorItem.contextValue, 'ev3BrickRootError');
		assert.equal(errorItem.command, undefined);
		const errorChildren = await provider.getChildren(roots[1]);
		assert.equal(errorChildren.length, 1);
		const errorMessageItem = provider.getTreeItem(errorChildren[0]);
		assert.equal(errorMessageItem.contextValue, 'ev3BrickMessageConnect');
		assert.equal(errorMessageItem.command?.command, 'ev3-cockpit.connectEV3');
	});
});

test('BrickTreeProvider caches directory listing and refreshDirectory invalidates it', async () => {
	await withMockedProvider(async ({ BrickTreeProvider }) => {
		let listCalls = 0;
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
					}
				],
				getBrickSnapshot: () => ({
					brickId: 'usb-auto',
					displayName: 'EV3 USB',
					role: 'standalone',
					transport: 'usb',
					status: 'READY',
					isActive: true,
					rootPath: '/home/root/lms2012/prjs/'
				}),
				resolveFsService: async () => ({
					listDirectory: async () => {
						listCalls += 1;
						return {
							folders: ['Demo'],
							files: []
						};
					}
				})
			}
		});

		const roots = await provider.getChildren();
		const root = roots[0];

		await provider.getChildren(root);
		await provider.getChildren(root);
		assert.equal(listCalls, 1);

		provider.refreshDirectory('usb-auto', '/home/root/lms2012/prjs/');
		await provider.getChildren(root);
		assert.equal(listCalls, 2);
	});
});

test('BrickTreeProvider renders busy counter in root description when runtime is active', async () => {
	await withMockedProvider(async ({ BrickTreeProvider }) => {
		const provider = new BrickTreeProvider({
			dataSource: {
				listBricks: () => [
					{
						brickId: 'tcp-busy',
						displayName: 'EV3 TCP Busy',
						role: 'standalone',
						transport: 'tcp',
						status: 'READY',
						isActive: true,
						rootPath: '/home/root/lms2012/prjs/',
						busyCommandCount: 3,
						schedulerState: 'running'
					}
				],
				getBrickSnapshot: () => undefined,
				resolveFsService: async () => ({
					listDirectory: async () => ({
						folders: [],
						files: []
					})
				})
			}
		});

		const roots = await provider.getChildren();
		const item = provider.getTreeItem(roots[0]);
		assert.match(item.description ?? '', /busy:3/);
		assert.match(item.tooltip?.toString() ?? '', /Runtime: running, busy=3/);
	});
});

test('BrickTreeProvider renders PIN badge when brick is marked as favorite', async () => {
	await withMockedProvider(async ({ BrickTreeProvider }) => {
		const provider = new BrickTreeProvider({
			dataSource: {
				listBricks: () => [
					{
						brickId: 'usb-fav',
						displayName: 'EV3 Favorite',
						role: 'standalone',
						transport: 'usb',
						status: 'READY',
						isActive: true,
						rootPath: '/home/root/lms2012/prjs/'
					}
				],
				getBrickSnapshot: () => undefined,
				resolveFsService: async () => ({
					listDirectory: async () => ({
						folders: [],
						files: []
					})
				})
			},
			isFavoriteBrick: (brickId: string) => brickId === 'usb-fav'
		});

		const roots = await provider.getChildren();
		const item = provider.getTreeItem(roots[0]);
		assert.match(item.description ?? '', /PIN/);
	});
});
