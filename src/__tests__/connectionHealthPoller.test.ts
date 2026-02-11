import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { BrickRegistry } from '../device/brickRegistry';

class FakeDisposable {
	private readonly disposeFn: () => void;

	public constructor(disposeFn: () => void) {
		this.disposeFn = disposeFn;
	}

	public dispose(): void {
		this.disposeFn();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withMockedConnectionHealthModule<T>(
	run: (mod: {
		createConnectionHealthPoller: typeof import('../ui/connectionHealthPoller').createConnectionHealthPoller;
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
		const mod = require('../ui/connectionHealthPoller') as {
			createConnectionHealthPoller: typeof import('../ui/connectionHealthPoller').createConnectionHealthPoller;
		};
		return await run(mod);
	} finally {
		moduleAny._load = originalLoad;
	}
}

const mockFs = { listDirectory: async () => ({ folders: [], files: [], path: '/', truncated: false, totalBytes: 0 }) } as never;
const mockControl = { emergencyStopAll: async () => undefined } as never;

test('connectionHealthPoller marks Brick unavailable when probe fails', async () => {
	await withMockedConnectionHealthModule(async ({ createConnectionHealthPoller }) => {
		const registry = new BrickRegistry();
		registry.upsertReady({
			brickId: 'usb-1',
			displayName: 'EV3 USB',
			role: 'standalone',
			transport: 'usb',
			rootPath: '/home/root/lms2012/prjs/',
			fsService: mockFs,
			controlService: mockControl
		});

		let closeCalls = 0;
		let refreshedBrickId = '';
		let disconnectedBrickId = '';
		const disposable = createConnectionHealthPoller(
			registry,
			{
				listSessionBrickIds: () => ['usb-1'],
				getSession: () => ({
					commandClient: {
						send: async () => {
							throw new Error('USB transport is not open.');
						}
					}
				}),
				closeSession: async () => {
					closeCalls += 1;
				},
				getRuntimeSnapshot: () => ({
					busyCommandCount: 0,
					schedulerState: 'idle'
				})
			},
			{
				refreshBrick: (brickId: string) => {
					refreshedBrickId = brickId;
				}
			} as never,
			{
				activeIntervalMs: 20,
				idleIntervalMs: 20,
				probeTimeoutMs: 20,
				onDisconnected: (brickId) => {
					disconnectedBrickId = brickId;
				}
			}
		);

		await sleep(80);
		disposable.dispose();

		const snapshot = registry.getSnapshot('usb-1');
		assert.equal(snapshot?.status, 'UNAVAILABLE');
		assert.match(snapshot?.lastError ?? '', /Connection lost:/i);
		assert.equal(closeCalls >= 1, true);
		assert.equal(refreshedBrickId, 'usb-1');
		assert.equal(disconnectedBrickId, 'usb-1');
	});
});

test('connectionHealthPoller requests reconnect for recoverable unavailable Brick', async () => {
	await withMockedConnectionHealthModule(async ({ createConnectionHealthPoller }) => {
		const registry = new BrickRegistry();
		registry.upsertReady({
			brickId: 'usb-2',
			displayName: 'EV3 USB 2',
			role: 'standalone',
			transport: 'usb',
			rootPath: '/home/root/lms2012/prjs/',
			fsService: mockFs,
			controlService: mockControl
		});
		registry.markUnavailable('usb-2', 'Connection lost: USB transport is not open.');

		let reconnectCalls = 0;
		const disposable = createConnectionHealthPoller(
			registry,
			{
				listSessionBrickIds: () => [],
				getSession: () => undefined,
				closeSession: async () => undefined,
				getRuntimeSnapshot: () => undefined
			},
			{
				refreshBrick: () => undefined
			} as never,
			{
				activeIntervalMs: 20,
				idleIntervalMs: 20,
				reconnectIntervalMs: 20,
				onReconnectRequested: async (brickId) => {
					reconnectCalls += 1;
					registry.upsertReady({
						brickId,
						displayName: 'EV3 USB 2',
						role: 'standalone',
						transport: 'usb',
						rootPath: '/home/root/lms2012/prjs/',
						fsService: mockFs,
						controlService: mockControl
					});
				}
			}
		);

		await sleep(100);
		disposable.dispose();

		assert.equal(reconnectCalls >= 1, true);
		assert.equal(registry.getSnapshot('usb-2')?.status, 'READY');
	});
});

test('connectionHealthPoller does not request reconnect for user-disconnected Brick', async () => {
	await withMockedConnectionHealthModule(async ({ createConnectionHealthPoller }) => {
		const registry = new BrickRegistry();
		registry.upsertReady({
			brickId: 'usb-3',
			displayName: 'EV3 USB 3',
			role: 'standalone',
			transport: 'usb',
			rootPath: '/home/root/lms2012/prjs/',
			fsService: mockFs,
			controlService: mockControl
		});
		registry.markUnavailable('usb-3', 'Disconnected by user.');

		let reconnectCalls = 0;
		const disposable = createConnectionHealthPoller(
			registry,
			{
				listSessionBrickIds: () => [],
				getSession: () => undefined,
				closeSession: async () => undefined,
				getRuntimeSnapshot: () => undefined
			},
			{
				refreshBrick: () => undefined
			} as never,
			{
				activeIntervalMs: 20,
				idleIntervalMs: 20,
				reconnectIntervalMs: 20,
				onReconnectRequested: async () => {
					reconnectCalls += 1;
				}
			}
		);

		await sleep(100);
		disposable.dispose();

		assert.equal(reconnectCalls, 0);
		assert.equal(registry.getSnapshot('usb-3')?.status, 'UNAVAILABLE');
	});
});
