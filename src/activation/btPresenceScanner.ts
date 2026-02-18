import { TransportMode } from '../types/enums';
import * as vscode from 'vscode';
import type { BrickConnectionProfileStore } from '../device/brickConnectionProfiles';
import type { BrickRegistry } from '../device/brickRegistry';
import type { Logger } from '../diagnostics/logger';
import type { BluetoothCandidate } from '../transport/discovery';

export interface BtPresenceScannerOptions {
	listBluetoothCandidates: () => Promise<BluetoothCandidate[]>;
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	logger: Logger;
	fastIntervalMs: number;
	slowIntervalMs: number;
	resolveDefaultRootPath: () => string;
	toSafeIdentifier: (value: string) => string;
	resolveActivateOnConnect: () => boolean;
	connectBrick: (brickId: string, activateOnSuccess: boolean) => Promise<void>;
	disconnectBrick: (brickId: string, reason: string) => Promise<void>;
}

export function createBtPresenceScanner(options: BtPresenceScannerOptions): vscode.Disposable {
	const {
		listBluetoothCandidates,
		brickRegistry,
		profileStore,
		logger,
		fastIntervalMs,
		slowIntervalMs,
		resolveDefaultRootPath,
		toSafeIdentifier,
		resolveActivateOnConnect,
		connectBrick,
		disconnectBrick
	} = options;

	let disposed = false;
	let timer: NodeJS.Timeout | undefined;
	let scanning = false;

	const tick = async (): Promise<void> => {
		if (disposed || scanning) {
			return;
		}
		scanning = true;

		let candidates: BluetoothCandidate[] = [];
		try {
			candidates = await listBluetoothCandidates();
		} catch (error) {
			logger.warn('BT presence scan failed', {
				error: error instanceof Error ? error.message : String(error)
			});
			scanning = false;
			scheduleNext(false);
			return;
		}

		const defaultRoot = resolveDefaultRootPath();
		const nowIso = new Date().toISOString();
		const activeCandidateIds = new Set<string>();
		const hasBtCandidates = candidates.length > 0;

		for (const bt of candidates) {
			const comPath = bt.path?.trim();
			if (!comPath) {
				continue;
			}
			const idSuffix = bt.mac ?? toSafeIdentifier(comPath);
			const brickId = `bt-${idSuffix}`;
			activeCandidateIds.add(brickId);
			const snapshot = brickRegistry.getSnapshot(brickId);
			if (snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING') {
				continue;
			}

			const displayName = bt.displayName
				?? (bt.mac ? `EV3 BT (${bt.mac.slice(-4).toUpperCase()})` : `EV3 BT (${comPath})`);
			await profileStore.upsert({
				brickId,
				displayName,
				savedAtIso: nowIso,
				rootPath: defaultRoot,
				transport: {
					mode: TransportMode.BT,
					btPortPath: comPath
				}
			});
			logger.info('BT presence: connecting detected brick', { brickId, comPath });
			const activateOnSuccess = resolveActivateOnConnect();
			await connectBrick(brickId, activateOnSuccess);
		}

		for (const snapshot of brickRegistry.listSnapshots()) {
			if (snapshot.transport !== 'bt') {
				continue;
			}
			if (!activeCandidateIds.has(snapshot.brickId)) {
				if (snapshot.status === 'READY' || snapshot.status === 'CONNECTING') {
					logger.info('BT presence: disconnecting removed brick', { brickId: snapshot.brickId });
					await disconnectBrick(snapshot.brickId, 'BT device removed.');
				}
			}
		}

		scanning = false;
		scheduleNext(hasBtCandidates);
	};

	const scheduleNext = (fast: boolean): void => {
		if (disposed) {
			return;
		}
		const intervalMs = fast ? fastIntervalMs : slowIntervalMs;
		timer = setTimeout(() => {
			void tick();
		}, intervalMs);
		timer.unref?.();
	};

	void tick();

	return new vscode.Disposable(() => {
		disposed = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	});
}
