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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withMockedBusyIndicatorModule<T>(
	run: (mod: { createBusyIndicatorPoller: typeof import('../ui/busyIndicator').createBusyIndicatorPoller }) => Promise<T>
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
		const mod = require('../ui/busyIndicator') as {
			createBusyIndicatorPoller: typeof import('../ui/busyIndicator').createBusyIndicatorPoller;
		};
		return await run(mod);
	} finally {
		moduleAny._load = originalLoad;
	}
}

test('busyIndicator poller updates metrics only when runtime signature changes', async () => {
	await withMockedBusyIndicatorModule(async ({ createBusyIndicatorPoller }) => {
		const snapshots = [{ brickId: 'brick-1' }];
		let runtime = { busyCommandCount: 1, schedulerState: 'running' };
		const updates: Array<{ brickId: string; busyCommandCount: number; schedulerState?: string }> = [];
		const refreshes: string[] = [];
		const prunedSets: string[][] = [];

		const disposable = createBusyIndicatorPoller(
			{
				listSnapshots: () => snapshots,
				updateRuntimeMetrics: (brickId: string, metrics: { busyCommandCount?: number; schedulerState?: string }) => {
					updates.push({
						brickId,
						busyCommandCount: metrics.busyCommandCount ?? 0,
						schedulerState: metrics.schedulerState
					});
				}
			} as unknown as Parameters<typeof createBusyIndicatorPoller>[0],
			{
				getRuntimeSnapshot: () => runtime
			},
			{
				refreshBrick: (brickId: string) => {
					refreshes.push(brickId);
				}
			} as unknown as Parameters<typeof createBusyIndicatorPoller>[2],
			{
				pruneMissing: async (knownBrickIds: Set<string>) => {
					prunedSets.push([...knownBrickIds].sort());
				}
			} as unknown as Parameters<typeof createBusyIndicatorPoller>[3],
			15
		);

		assert.equal(updates.length, 1);
		assert.equal(refreshes.length, 1);
		assert.deepEqual(prunedSets[0], ['brick-1']);

		await sleep(40);
		assert.equal(updates.length, 1);
		assert.equal(refreshes.length, 1);

		runtime = { busyCommandCount: 2, schedulerState: 'running' };
		await sleep(40);
		assert.equal(updates.length, 2);
		assert.equal(refreshes.length, 2);
		assert.deepEqual(updates[1], {
			brickId: 'brick-1',
			busyCommandCount: 2,
			schedulerState: 'running'
		});

		disposable.dispose();
		runtime = { busyCommandCount: 3, schedulerState: 'running' };
		await sleep(40);
		assert.equal(updates.length, 2);
	});
});
