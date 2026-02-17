import { TransportMode } from '../types/enums';
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

const GENERIC_BT_TOKENS = new Set([
	'STANDARDNI',
	'STANDARDN',
	'SERIAL',
	'SERIOVA',
	'SERIOV',
	'LINKA',
	'LINK',
	'POMOCI',
	'POMOC',
	'BLUETOOTH',
	'PROTOKOLU',
	'PROTOCOL',
	'PORT',
	'COM',
	'SPP',
	'RFCOMM',
	'MICROSOFT'
]);

function resolveBtAddress(candidate: SerialCandidate): string | undefined {
	const pnpId = candidate.pnpId ?? '';
	const macMatch = pnpId.match(/\\([0-9A-F]{12})_/i);
	if (!macMatch) {
		return undefined;
	}
	const mac = macMatch[1].toUpperCase();
	if (mac === '000000000000') {
		return undefined;
	}
	return mac;
}

function resolveBtBrickId(candidate: SerialCandidate, btPort: string, safeId: (value: string) => string): string {
	const mac = resolveBtAddress(candidate);
	if (mac) {
		return `bt-${safeId(mac)}`;
	}
	return `bt-${safeId(btPort)}`;
}

function extractNameFromFriendlyName(value: string): string | undefined {
	const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	const cleaned = normalized.replace(/\(COM\d+\)/i, '').replace(/[()]/g, ' ').trim();
	if (!cleaned) {
		return undefined;
	}
	const tokens = cleaned.split(/[^A-Za-z0-9_-]+/).filter((token) => token.length > 0);
	for (const token of tokens) {
		const upper = token.toUpperCase();
		if (token.length < 3 || token.length > 12) {
			continue;
		}
		if (/^COM\d+$/i.test(token)) {
			continue;
		}
		if (/^\d+$/.test(token)) {
			continue;
		}
		if (GENERIC_BT_TOKENS.has(upper)) {
			continue;
		}
		return token;
	}
	return undefined;
}

function normalizeBtBrickName(candidate: SerialCandidate): string | undefined {
	const friendly = candidate.friendlyName?.trim();
	if (friendly) {
		const extracted = extractNameFromFriendlyName(friendly);
		if (extracted) {
			return extracted;
		}
		const upper = friendly.toUpperCase();
		if (friendly.length <= 12 && (!/BLUETOOTH/.test(upper) || /EV3|LEGO|MINDSTORMS/.test(upper))) {
			return friendly;
		}
	}
	const raw = candidate.manufacturer?.trim();
	if (raw && raw.length <= 12 && !/MICROSOFT/i.test(raw)) {
		return raw;
	}
	const pnpId = candidate.pnpId ?? '';
	const macMatch = pnpId.match(/\\([0-9A-F]{12})_/i);
	if (macMatch && macMatch[1] !== '000000000000') {
		const suffix = macMatch[1].slice(-4).toUpperCase();
		return `EV3-${suffix}`;
	}
	const tailMatch = pnpId.match(/_([0-9A-F]{8})$/i);
	if (tailMatch) {
		const suffix = tailMatch[1].slice(-4).toUpperCase();
		return `EV3-${suffix}`;
	}
	return undefined;
}

function isGenericBtDisplayName(value: string): boolean {
	const trimmed = value.trim();
	return /^EV3 Bluetooth \\(COM\\d+\\)$/i.test(trimmed) || /Bluetooth/i.test(trimmed);
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
			const brickId = resolveBtBrickId(candidate, btPort, safeId);
			activeBtBrickIds.add(brickId);

			const snapshot = brickRegistry.getSnapshot(brickId);
			if (snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING') {
				continue;
			}

			const manufacturer = normalizeBtBrickName(candidate);
			let rememberedProfile = profileStore.get(brickId);
			if (!rememberedProfile) {
				const matching = profileStore.list().find((profile) => (
					profile.transport.mode === 'bt'
					&& profile.transport.btPort?.trim().toUpperCase() === btPort
				));
				if (matching) {
					rememberedProfile = matching;
				}
			}
			const rememberedName = rememberedProfile?.displayName?.trim();
			const displayName = (rememberedName && !isGenericBtDisplayName(rememberedName))
				? rememberedName
				: (manufacturer || `EV3 Bluetooth (${btPort})`);

			const profile: BrickConnectionProfile = rememberedProfile
				? {
					...rememberedProfile,
					brickId,
					displayName,
					rootPath: rememberedProfile.rootPath || defaultRoot,
					transport: {
						...rememberedProfile.transport,
						mode: TransportMode.BT,
						btPort
					}
				}
				: {
					brickId,
					displayName,
					savedAtIso: nowIso,
					rootPath: defaultRoot,
					transport: { mode: TransportMode.BT, btPort }
				};

			// Ensure profile is stored so connectDiscoveredBrick can find it
			void profileStore.upsert(profile);
			discoveryService.updateDiscoveredProfile(brickId, profile);

			brickRegistry.upsertAvailable({
				brickId,
				displayName,
				role: 'unknown',
				transport: TransportMode.BT,
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
