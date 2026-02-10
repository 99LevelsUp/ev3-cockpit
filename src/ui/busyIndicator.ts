import * as vscode from 'vscode';
import { BrickRegistry } from '../device/brickRegistry';
import { BrickTreeProvider } from './brickTreeProvider';
import { BrickUiStateStore } from './brickUiStateStore';

export interface BusyIndicatorRuntimeSource {
	getRuntimeSnapshot(brickId: string): { busyCommandCount: number; schedulerState?: string } | undefined;
}

export function createBusyIndicatorPoller(
	brickRegistry: BrickRegistry,
	sessionManager: BusyIndicatorRuntimeSource,
	treeProvider: BrickTreeProvider,
	brickUiStateStore: BrickUiStateStore,
	intervalMs = 250,
	idleIntervalMs = 2_000
): vscode.Disposable {
	const busyStateByBrickId = new Map<string, string>();
	let disposed = false;
	let timer: NodeJS.Timeout | undefined;

	const refresh = (): boolean => {
		const snapshots = brickRegistry.listSnapshots();
		if (snapshots.length === 0) {
			void brickUiStateStore.pruneMissing(new Set<string>());
			return false;
		}
		const knownBrickIds = new Set<string>();
		let hasConnectedSnapshot = false;
		for (const snapshot of snapshots) {
			knownBrickIds.add(snapshot.brickId);
			if (
				!('status' in snapshot) ||
				snapshot.status === 'READY' ||
				snapshot.status === 'CONNECTING'
			) {
				hasConnectedSnapshot = true;
			}
			const runtime = sessionManager.getRuntimeSnapshot(snapshot.brickId);
			const busyCount = runtime?.busyCommandCount ?? 0;
			const schedulerState = runtime?.schedulerState;
			const nextSignature = `${busyCount}|${schedulerState ?? 'none'}`;
			if (busyStateByBrickId.get(snapshot.brickId) === nextSignature) {
				continue;
			}
			busyStateByBrickId.set(snapshot.brickId, nextSignature);
			brickRegistry.updateRuntimeMetrics(snapshot.brickId, {
				busyCommandCount: busyCount,
				schedulerState
			});
			treeProvider.refreshBrick(snapshot.brickId);
		}

		for (const brickId of [...busyStateByBrickId.keys()]) {
			if (!knownBrickIds.has(brickId)) {
				busyStateByBrickId.delete(brickId);
			}
		}
		void brickUiStateStore.pruneMissing(knownBrickIds);
		return hasConnectedSnapshot;
	};

	const scheduleNextTick = (hasConnectedSnapshot: boolean): void => {
		if (disposed) {
			return;
		}
		const nextDelay = hasConnectedSnapshot ? intervalMs : Math.max(idleIntervalMs, intervalMs);
		timer = setTimeout(() => {
			const active = refresh();
			scheduleNextTick(active);
		}, nextDelay);
		timer.unref?.();
	};

	// Initial tick
	const active = refresh();
	scheduleNextTick(active);
	return new vscode.Disposable(() => {
		disposed = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	});
}
