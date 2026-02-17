import { TransportMode } from '../types/enums';
import * as vscode from 'vscode';
import type { BrickConnectionProfile, BrickConnectionProfileStore } from '../device/brickConnectionProfiles';
import type { BrickRegistry } from '../device/brickRegistry';
import type { BrickDiscoveryService } from '../device/brickDiscoveryService';
import { isLikelyEv3SerialCandidate } from '../device/brickDiscoveryService';
import {
	extractBluetoothAddressFromPnpId,
	isWindowsBluetoothDevicePresent,
	type SerialCandidate
} from '../transport/discovery';
import type { Logger } from '../diagnostics/logger';
import { BluetoothSppAdapter } from '../transport/bluetoothSppAdapter';
import { decodeEv3Packet, encodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';

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
	isBtAddressPresent?: (address: string) => Promise<boolean>;
	isDiscoveryTabActive: () => boolean;
	hasConnectedBtOrTcp: () => boolean;
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

const BT_PROBE_OPCODE = 0x9d;
const BT_PROBE_TIMEOUT_MS = 4_000;
const BT_POST_OPEN_DELAY_MS = 120;
const BT_BAUD_RATE = 115200;
const BT_PROBE_SUCCESS_CACHE_MS = 5_000;
const BT_PROBE_FAILURE_CACHE_MS = 750;
const BT_PROBE_ATTEMPTS = 2;
const BT_PROBE_RETRY_DELAY_MS = 100;

type BtPresenceScanMode = 'discovery-fast' | 'connected-fast' | 'slow';

const btProbeInFlight = new Map<string, Promise<boolean>>();
const btProbeCache = new Map<string, { present: boolean; at: number }>();
let btProbeQueue: Promise<void> = Promise.resolve();

function isBluetoothSppSerialCandidate(candidate: SerialCandidate): boolean {
	return /BTHENUM\\\{00001101-0000-1000-8000-00805F9B34FB\}/i.test(candidate.pnpId ?? '');
}

function resolveBtAddress(candidate: SerialCandidate): string | undefined {
	return extractBluetoothAddressFromPnpId(candidate.pnpId);
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
	const btAddress = resolveBtAddress(candidate);
	if (btAddress) {
		const suffix = btAddress.slice(-4).toUpperCase();
		return `EV3-${suffix}`;
	}
	const pnpId = candidate.pnpId ?? '';
	const tailMatch = pnpId.match(/_([0-9A-F]{8})$/i);
	if (tailMatch) {
		const suffix = tailMatch[1].slice(-4).toUpperCase();
		return `EV3-${suffix}`;
	}
	return undefined;
}

function isGenericBtDisplayName(value: string): boolean {
	const trimmed = value.trim();
	return /^EV3 Bluetooth \(COM\d+\)$/i.test(trimmed) || /Bluetooth/i.test(trimmed);
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) {
		return;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function enqueueBtProbe<T>(probe: () => Promise<T>): Promise<T> {
	const run = btProbeQueue.then(probe, probe);
	btProbeQueue = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

async function probeBtPort(port: string, dtr: boolean): Promise<boolean> {
	const adapter = new BluetoothSppAdapter({
		port,
		baudRate: BT_BAUD_RATE,
		dtr
	});
	try {
		await adapter.open();
		await sleep(BT_POST_OPEN_DELAY_MS);
		for (let attempt = 0; attempt < BT_PROBE_ATTEMPTS; attempt += 1) {
			const messageCounter = attempt;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), BT_PROBE_TIMEOUT_MS);
			try {
				const probePacket = encodeEv3Packet(
					messageCounter,
					EV3_COMMAND.SYSTEM_COMMAND_REPLY,
					new Uint8Array([BT_PROBE_OPCODE])
				);
				const replyBytes = await adapter.send(probePacket, {
					timeoutMs: BT_PROBE_TIMEOUT_MS,
					signal: controller.signal,
					expectedMessageCounter: messageCounter
				});
				const reply = decodeEv3Packet(replyBytes);
				if (reply.type !== EV3_REPLY.SYSTEM_REPLY && reply.type !== EV3_REPLY.SYSTEM_REPLY_ERROR) {
					continue;
				}
				if (reply.payload.length < 2) {
					continue;
				}
				if (reply.payload[0] === BT_PROBE_OPCODE && reply.payload[1] === 0x00) {
					return true;
				}
			} finally {
				clearTimeout(timeout);
			}
			if (attempt + 1 < BT_PROBE_ATTEMPTS) {
				await sleep(BT_PROBE_RETRY_DELAY_MS);
			}
		}
		return false;
	} catch {
		return false;
	} finally {
		await adapter.close().catch(() => undefined);
	}
}

export async function probeBtCandidatePresence(port: string): Promise<boolean> {
	const normalizedPort = port.trim().toUpperCase();
	if (!/^COM\d+$/i.test(normalizedPort)) {
		return false;
	}
	const cached = btProbeCache.get(normalizedPort);
	if (cached) {
		const ageMs = Date.now() - cached.at;
		const ttlMs = cached.present ? BT_PROBE_SUCCESS_CACHE_MS : BT_PROBE_FAILURE_CACHE_MS;
		if (ageMs >= 0 && ageMs <= ttlMs) {
			return cached.present;
		}
		btProbeCache.delete(normalizedPort);
	}
	const inFlight = btProbeInFlight.get(normalizedPort);
	if (inFlight) {
		return inFlight;
	}
	const runProbe = enqueueBtProbe(async () => {
		// Most EV3 SPP stacks work with dtr=false, but try both to avoid false negatives.
		const present = (await probeBtPort(normalizedPort, false)) || (await probeBtPort(normalizedPort, true));
		btProbeCache.set(normalizedPort, { present, at: Date.now() });
		return present;
	}).finally(() => {
		btProbeInFlight.delete(normalizedPort);
	});
	btProbeInFlight.set(normalizedPort, runProbe);
	return runProbe;
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
		isBtAddressPresent = isWindowsBluetoothDevicePresent,
		isDiscoveryTabActive,
		hasConnectedBtOrTcp,
		onPresenceChange
	} = options;

	let disposed = false;
	let timer: NodeJS.Timeout | undefined;
	let previousBtBrickIds = new Set<string>();

	const resolveScanMode = (): BtPresenceScanMode => {
		if (isDiscoveryTabActive()) {
			return 'discovery-fast';
		}
		if (hasConnectedBtOrTcp()) {
			return 'connected-fast';
		}
		return 'slow';
	};

	const tick = async (): Promise<void> => {
		if (disposed) {
			return;
		}
		if (!isBtScanEnabled()) {
			scheduleNext();
			return;
		}
		const scanMode = resolveScanMode();

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
		const connectedBtBrickIds = new Set(
			brickRegistry.listSnapshots()
				.filter((snapshot) => (
					snapshot.transport === TransportMode.BT
					&& (snapshot.status === 'READY' || snapshot.status === 'CONNECTING')
				))
				.map((snapshot) => snapshot.brickId)
		);

		for (const candidate of serialCandidates) {
			const rawPath = candidate.path.trim();
			if (!rawPath || !/^COM\d+$/i.test(rawPath)) {
				continue;
			}
			const likelyEv3Candidate = isLikelyEv3SerialCandidate(candidate, preferredPort);
			if (!likelyEv3Candidate && !isBluetoothSppSerialCandidate(candidate)) {
				continue;
			}
			const btPort = rawPath.toUpperCase();
			const brickId = resolveBtBrickId(candidate, btPort, safeId);
			if (scanMode === 'connected-fast' && !connectedBtBrickIds.has(brickId)) {
				continue;
			}

			const snapshot = brickRegistry.getSnapshot(brickId);
			if (snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING') {
				activeBtBrickIds.add(brickId);
				continue;
			}
			if (scanMode === 'connected-fast') {
				continue;
			}
			if (!likelyEv3Candidate) {
				logger.trace('BT presence scanner probing generic SPP candidate', {
					port: btPort,
					brickId,
					pnpId: candidate.pnpId
				});
			}
			let present = await probeBtCandidatePresence(btPort);
			if (!present) {
				const btAddress = resolveBtAddress(candidate);
				if (btAddress) {
					try {
						present = await isBtAddressPresent(btAddress);
					} catch (error) {
						logger.debug('BT live-address check failed', {
							port: btPort,
							address: btAddress,
							error: error instanceof Error ? error.message : String(error)
						});
					}
					if (present) {
						logger.info('BT candidate accepted via live Bluetooth address fallback', {
							port: btPort,
							address: btAddress,
							brickId
						});
					}
				}
			}
			if (!present) {
				logger.debug('BT presence probe rejected candidate', {
					port: btPort,
					brickId,
					pnpId: candidate.pnpId,
					manufacturer: candidate.manufacturer
				});
				continue;
			}
			activeBtBrickIds.add(brickId);

			const manufacturer = normalizeBtBrickName(candidate);
			let rememberedProfile = profileStore.get(brickId);
			if (!rememberedProfile && !resolveBtAddress(candidate)) {
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

		if (scanMode === 'connected-fast') {
			const missingConnectedBt = [...connectedBtBrickIds].filter((brickId) => !activeBtBrickIds.has(brickId));
			if (missingConnectedBt.length > 0) {
				logger.debug('BT connected-fast scan did not resolve currently connected IDs.', {
					missingConnectedBt
				});
			}
			scheduleNext();
			return;
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
		const mode = resolveScanMode();
		const delay = mode === 'slow' ? slowIntervalMs : fastIntervalMs;
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
