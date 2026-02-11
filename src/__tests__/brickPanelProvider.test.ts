import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeWebviewView {
	webview: {
		options: Record<string, unknown>;
		html: string;
		onDidReceiveMessage: (handler: (msg: unknown) => void) => void;
		postMessage: (msg: unknown) => Promise<boolean>;
	};
	onDidDispose: (handler: () => void) => void;
	disposeHandler?: () => void;
}

function createFakeWebviewView(): FakeWebviewView {
	const view: FakeWebviewView = {
		webview: {
			options: {},
			html: '',
			onDidReceiveMessage: () => {},
			postMessage: async () => true
		},
		onDidDispose: (handler) => {
			view.disposeHandler = handler;
		}
	};
	return view;
}

async function withMockedBrickPanelModule<T>(
	run: (mod: { BrickPanelProvider: typeof import('../ui/brickPanelProvider').BrickPanelProvider }) => Promise<T>
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
		const mod = require('../ui/brickPanelProvider') as {
			BrickPanelProvider: typeof import('../ui/brickPanelProvider').BrickPanelProvider;
		};
		return await run(mod);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('BrickPanelProvider polls at active interval when bricks exist', async () => {
	await withMockedBrickPanelModule(async ({ BrickPanelProvider }) => {
		let refreshCount = 0;
		const bricks = [
			{ brickId: 'b1', displayName: 'EV3', status: 'READY', transport: 'usb', role: 'standalone', isActive: true }
		];

		const provider = new BrickPanelProvider(
			{} as never,
			{
				listBricks: () => bricks as never,
				setActiveBrick: () => true
			},
			{ activeIntervalMs: 50, idleIntervalMs: 200 }
		);

		const view = createFakeWebviewView();
		const messages: unknown[] = [];
		view.webview.postMessage = async (msg) => {
			messages.push(msg);
			refreshCount++;
			return true;
		};

		provider.resolveWebviewView(
			view as never,
			{} as never,
			{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as never
		);

		// Wait for polling ticks
		await sleep(180);

		// Should have at least 2 polling refreshes (at 50ms intervals)
		assert.ok(refreshCount >= 2, `Expected at least 2 refreshes, got ${refreshCount}`);

		// Dispose should stop polling
		view.disposeHandler?.();
		const countAfterDispose = refreshCount;
		await sleep(120);
		assert.equal(refreshCount, countAfterDispose, 'No more refreshes after dispose');
	});
});

test('BrickPanelProvider polls at idle interval when no bricks', async () => {
	await withMockedBrickPanelModule(async ({ BrickPanelProvider }) => {
		let refreshCount = 0;

		const provider = new BrickPanelProvider(
			{} as never,
			{
				listBricks: () => [],
				setActiveBrick: () => false
			},
			{ activeIntervalMs: 30, idleIntervalMs: 150 }
		);

		const view = createFakeWebviewView();
		view.webview.postMessage = async () => {
			refreshCount++;
			return true;
		};

		provider.resolveWebviewView(
			view as never,
			{} as never,
			{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as never
		);

		// Wait 200ms — with idleIntervalMs=150, should get only ~1 tick
		await sleep(200);
		assert.ok(refreshCount <= 2, `Expected at most 2 refreshes at idle rate, got ${refreshCount}`);

		view.disposeHandler?.();
	});
});

test('BrickPanelProvider.refresh sends updateBricks message', async () => {
	await withMockedBrickPanelModule(async ({ BrickPanelProvider }) => {
		const bricks = [
			{ brickId: 'b1', displayName: 'EV3', status: 'READY', transport: 'usb', role: 'standalone', isActive: true }
		];

		const provider = new BrickPanelProvider(
			{} as never,
			{
				listBricks: () => bricks as never,
				setActiveBrick: () => true
			},
			{ activeIntervalMs: 60_000, idleIntervalMs: 60_000 }
		);

		const view = createFakeWebviewView();
		const messages: unknown[] = [];
		view.webview.postMessage = async (msg) => {
			messages.push(msg);
			return true;
		};

		provider.resolveWebviewView(
			view as never,
			{} as never,
			{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as never
		);

		provider.refresh();

		assert.ok(messages.length >= 1, 'Should have sent at least one message');
		const last = messages[messages.length - 1] as { type: string; bricks: Array<{ brickId: string }> };
		assert.equal(last.type, 'updateBricks');
		assert.equal(last.bricks.length, 1);
		assert.equal(last.bricks[0].brickId, 'b1');

		view.disposeHandler?.();
	});
});

test('BrickPanelProvider.refresh includes lastError and lastOperation in payload', async () => {
	await withMockedBrickPanelModule(async ({ BrickPanelProvider }) => {
		const bricks = [
			{
				brickId: 'b1', displayName: 'EV3', status: 'ERROR', transport: 'usb',
				role: 'standalone', isActive: true, lastError: 'Connection lost', lastOperation: 'Deploy'
			}
		];

		const provider = new BrickPanelProvider(
			{} as never,
			{
				listBricks: () => bricks as never,
				setActiveBrick: () => true
			},
			{ activeIntervalMs: 60_000, idleIntervalMs: 60_000 }
		);

		const view = createFakeWebviewView();
		const messages: unknown[] = [];
		view.webview.postMessage = async (msg) => {
			messages.push(msg);
			return true;
		};

		provider.resolveWebviewView(
			view as never,
			{} as never,
			{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as never
		);

		provider.refresh();

		const last = messages[messages.length - 1] as {
			type: string;
			bricks: Array<{ lastError?: string; lastOperation?: string }>
		};
		assert.equal(last.bricks[0].lastError, 'Connection lost');
		assert.equal(last.bricks[0].lastOperation, 'Deploy');

		view.disposeHandler?.();
	});
});

test('BrickPanelProvider.refresh includes motor info for active brick', async () => {
	await withMockedBrickPanelModule(async ({ BrickPanelProvider }) => {
		const bricks = [
			{
				brickId: 'b1', displayName: 'EV3', status: 'READY', transport: 'usb',
				role: 'standalone', isActive: true
			}
		];
		const motorStates = [
			{ port: 'A', speed: 75, running: true },
			{ port: 'B', speed: 0, running: false }
		];

		const provider = new BrickPanelProvider(
			{} as never,
			{
				listBricks: () => bricks as never,
				setActiveBrick: () => true,
				getMotorInfo: () => motorStates as never
			},
			{ activeIntervalMs: 60_000, idleIntervalMs: 60_000 }
		);

		const view = createFakeWebviewView();
		const messages: unknown[] = [];
		view.webview.postMessage = async (msg) => {
			messages.push(msg);
			return true;
		};

		provider.resolveWebviewView(
			view as never,
			{} as never,
			{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as never
		);

		provider.refresh();

		const last = messages[messages.length - 1] as {
			type: string;
			motors: Array<{ port: string; speed: number; running: boolean }>
		};
		assert.ok(last.motors, 'Should include motors');
		assert.equal(last.motors.length, 2);
		assert.equal(last.motors[0].port, 'A');
		assert.equal(last.motors[0].speed, 75);
		assert.equal(last.motors[0].running, true);
		assert.equal(last.motors[1].running, false);

		view.disposeHandler?.();
	});
});
