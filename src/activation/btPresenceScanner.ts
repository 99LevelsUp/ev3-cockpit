import * as vscode from 'vscode';
import type { BrickConnectionProfile, BrickConnectionProfileStore } from '../device/brickConnectionProfiles';
import type { BrickRegistry } from '../device/brickRegistry';
import type { BrickDiscoveryService } from '../device/brickDiscoveryService';
import { isLikelyEv3SerialCandidate } from '../device/brickDiscoveryService';
import type { SerialCandidate } from '../transport/discovery';
import type { Logger } from '../diagnostics/logger';

export interface BtPresenceScannerOptions {
	listSerialCandidates: () => Promise<SerialCandidate[]>;
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	discoveryService: BrickDiscoveryService;
	logger: Logger;
	fastIntervalMs: number;
	slowIntervalMs: number;
	resolveDefaultRootPath: () => string;
	resolvePreferredBluetoothPort: () => string | undefined;
	toSafeIdentifier: (value: string) => string;
	isBtScanEnabled: () => boolean;
	onPresenceChange: () => void;
}

function normalizeBtBrickName(candidate: SerialCandidate): string | undefined {
	const raw = candidate.manufacturer?.trim();
	if (!raw || raw.length > 12) {
		return undefined;
	}
	return raw;
}

export function createBtPresenceScanner(options: BtPresenceScannerOptions): vscode.Disposable {
	const {
		listSerialCandidates,
		brickRegistry,
		profileStore,
		discoveryService,
		logger,
		fastIntervalMs,
		slowIntervalMs,
		resolveDefaultRootPath,
		resolvePreferredBluetoothPort,
		toSafeIdentifier: safeId,
		isBtScanEnabled,
		onPresenceChange
	} = options;

	let disposed = false;
	let timer: NodeJS.Timeout | undefined;
	let previousBtBrickIds = new Set<string>();

	const tick = async (): Promise<void> => {
		if (disposed) {
			return;
		}
		if (!isBtScanEnabled()) {
			scheduleNext();
			return;
		}

		let serialCandidates: SerialCandidate[] = [];
		try {
			serialCandidates = await listSerialCandidates();
		} catch (error) {
			logger.warn('BT presence scan failed', {
				error: error instanceof Error ? error.message : String(error)
			});
			scheduleNext();
			return;
		}

		const preferredPort = resolvePreferredBluetoothPort();
		const defaultRoot = resolveDefaultRootPath();
		const nowIso = new Date().toISOString();
		const activeBtBrickIds = new Set<string>();

		for (const candidate of serialCandidates) {
			const rawPath = candidate.path.trim();
			if (!rawPath || !/^COM\d+$/i.test(rawPath)) {
				continue;
			}
			if (!isLikelyEv3SerialCandidate(candidate, preferredPort)) {
				continue;
			}
			const btPort = rawPath.toUpperCase();
			const brickId = `bt-${safeId(btPort)}`;
			activeBtBrickIds.add(brickId);

			const snapshot = brickRegistry.getSnapshot(brickId);
			if (snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING') {
				continue;
			}

			const manufacturer = normalizeBtBrickName(candidate);
			const rememberedProfile = profileStore.get(brickId);
			const displayName = rememberedProfile?.displayName?.trim()
				|| manufacturer
				|| `EV3 Bluetooth (${btPort})`;

			const profile: BrickConnectionProfile = rememberedProfile ?? {
				brickId,
				displayName,
				savedAtIso: nowIso,
				rootPath: defaultRoot,
				transport: { mode: 'bt', btPort }
			};

			// Ensure profile is stored so connectDiscoveredBrick can find it
			void profileStore.upsert(profile);
			discoveryService.updateDiscoveredProfile(brickId, profile);

			brickRegistry.upsertAvailable({
				brickId,
				displayName,
				role: 'unknown',
				transport: 'bt',
				rootPath: defaultRoot
			});
		}

		// Remove stale AVAILABLE BT bricks that are no longer present
		const removed = brickRegistry.removeStale(activeBtBrickIds);
		const btRemoved = removed.filter((id) => id.startsWith('bt-'));

		const changed = activeBtBrickIds.size !== previousBtBrickIds.size
			|| [...activeBtBrickIds].some((id) => !previousBtBrickIds.has(id))
			|| btRemoved.length > 0;

		if (changed) {
			logger.info('BT presence update', {
				found: activeBtBrickIds.size,
				removed: btRemoved.length,
				brickIds: [...activeBtBrickIds]
			});
			onPresenceChange();
		}
		previousBtBrickIds = activeBtBrickIds;

		scheduleNext();
	};

	const scheduleNext = (): void => {
		if (disposed) {
			return;
		}
		const hasBtBricks = previousBtBrickIds.size > 0;
		const delay = hasBtBricks ? fastIntervalMs : slowIntervalMs;
		timer = setTimeout(() => {
			void tick();
		}, delay);
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
