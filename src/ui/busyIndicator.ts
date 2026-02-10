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
	intervalMs = 250
): vscode.Disposable {
	const busyStateByBrickId = new Map<string, string>();

	const refresh = (): void => {
		const snapshots = brickRegistry.listSnapshots();
		if (snapshots.length === 0) {
			return;
		}
		const knownBrickIds = new Set<string>();
		for (const snapshot of snapshots) {
			knownBrickIds.add(snapshot.brickId);
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
	};

	// Initial tick
	refresh();

	const timer = setInterval(refresh, intervalMs);
	return new vscode.Disposable(() => {
		clearInterval(timer);
	});
}
