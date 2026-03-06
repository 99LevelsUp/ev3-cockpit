import type { BrickConnectionProfile, BrickConnectionProfileStore } from '../device/brickConnectionProfiles';
import type { BrickRegistry } from '../device/brickRegistry';
import type { Logger } from '../diagnostics/logger';
import type { BrickPanelDiscoveryCandidate } from '../ui/brickPanelProvider';
import { isMockBrickId } from '../mock/mockCatalog';
import { TransportMode } from '../types/enums';
import type { PresenceRecord, PresenceSource } from './presenceSource';

export interface GoneTtlConfig {
	usb: number;
	bt: number;
	tcp: number;
	mock: number;
}

export interface PresenceAggregatorOptions {
	goneTtl: GoneTtlConfig;
	reaperIntervalMs: number;
	defaultRootPath: string;
}

export interface PresenceAggregatorDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	logger: Logger;
	toSafeIdentifier: (value: string) => string;
}

type CandidatesChangedCallback = () => void;

function normalizeBrickNameCandidate(value: string | undefined): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 12) {
		return undefined;
	}
	return trimmed;
}

const TRANSPORT_RANK: Record<string, number> = {
	usb: 0,
	bt: 1,
	tcp: 2,
	mock: 3,
	unknown: 4
};

export class PresenceAggregator {
	private readonly deps: PresenceAggregatorDeps;
	private readonly options: PresenceAggregatorOptions;
	private readonly sources: PresenceSource[] = [];
	private readonly masterMap = new Map<string, PresenceRecord>();
	private readonly discoveredProfiles = new Map<string, BrickConnectionProfile>();
	private readonly nonConnectableCandidates = new Map<string, string>();
	private readonly candidatesListeners: CandidatesChangedCallback[] = [];
	private reaperTimer: ReturnType<typeof setInterval> | undefined;
	private started = false;

	constructor(deps: PresenceAggregatorDeps, options: PresenceAggregatorOptions) {
		this.deps = deps;
		this.options = options;
	}

	public addSource(source: PresenceSource): void {
		this.sources.push(source);
		source.onChange(() => {
			this.mergeFromSource(source);
		});
	}

	public start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		for (const source of this.sources) {
			source.start();
		}
		this.reaperTimer = setInterval(() => this.reap(), this.options.reaperIntervalMs);
		this.reaperTimer.unref?.();
	}

	public stop(): void {
		this.started = false;
		if (this.reaperTimer) {
			clearInterval(this.reaperTimer);
			this.reaperTimer = undefined;
		}
		for (const source of this.sources) {
			source.stop();
		}
	}

	public getPresent(): ReadonlyMap<string, PresenceRecord> {
		return this.masterMap;
	}

	public getDiscoveredProfile(candidateId: string): BrickConnectionProfile | undefined {
		return this.discoveredProfiles.get(candidateId);
	}

	public listDiscoveredProfiles(): ReadonlyMap<string, BrickConnectionProfile> {
		return this.discoveredProfiles;
	}

	public updateDiscoveredProfile(brickId: string, profile: BrickConnectionProfile): void {
		if (this.discoveredProfiles.has(brickId)) {
			this.discoveredProfiles.set(brickId, profile);
		}
	}

	public onCandidatesChanged(callback: CandidatesChangedCallback): void {
		this.candidatesListeners.push(callback);
	}

	public getCandidates(config: {
		showMockBricks: boolean;
		defaultRootPath?: string;
	}): BrickPanelDiscoveryCandidate[] {
		const { brickRegistry, profileStore } = this.deps;
		const defaultRoot = config.defaultRootPath ?? this.options.defaultRootPath;
		const nowIso = new Date().toISOString();
		const storedProfiles = profileStore.list();
		const candidates: BrickPanelDiscoveryCandidate[] = [];
		const seenCandidateIds = new Set<string>();

		this.discoveredProfiles.clear();
		this.nonConnectableCandidates.clear();

		const registerCandidate = (
			candidate: BrickPanelDiscoveryCandidate,
			profile?: BrickConnectionProfile,
			nonConnectableReason?: string
		): void => {
			if (!config.showMockBricks && isMockBrickId(candidate.candidateId)) {
				return;
			}
			const normalizedCandidateId = candidate.candidateId.trim().toLowerCase();
			if (normalizedCandidateId === 'active') {
				return;
			}
			if (seenCandidateIds.has(candidate.candidateId)) {
				return;
			}
			seenCandidateIds.add(candidate.candidateId);
			if (profile) {
				this.discoveredProfiles.set(profile.brickId, profile);
			}
			if (nonConnectableReason) {
				this.nonConnectableCandidates.set(candidate.candidateId, nonConnectableReason);
			}
			candidates.push(candidate);
		};

		const resolvePreferredDisplayName = (
			brickId: string,
			fallbackDisplayName: string,
			discoveredName?: string
		): string => {
			const connectedName = normalizeBrickNameCandidate(brickRegistry.getSnapshot(brickId)?.displayName);
			if (connectedName) {
				return connectedName;
			}
			const rememberedName = normalizeBrickNameCandidate(profileStore.get(brickId)?.displayName);
			if (rememberedName) {
				return rememberedName;
			}
			const liveDiscoveredName = normalizeBrickNameCandidate(discoveredName);
			if (liveDiscoveredName) {
				return liveDiscoveredName;
			}
			return fallbackDisplayName;
		};

		// Live presence records from all sources
		for (const [candidateId, record] of this.masterMap) {
			const snapshot = brickRegistry.getSnapshot(candidateId);
			const displayName = resolvePreferredDisplayName(
				candidateId,
				record.displayName,
				record.displayName
			);

			const profile = this.buildProfile(record, displayName, defaultRoot, nowIso);

			const nonConnectableReason = record.connectable
				? undefined
				: 'Brick is visible over Bluetooth, but Windows currently has no COM mapping for connection.';

			const status = this.resolveCandidateStatus(snapshot, record);
			registerCandidate({
				candidateId,
				displayName,
				transport: record.transport,
				detail: record.detail,
				status,
				alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
			}, profile, nonConnectableReason);
		}

		// Stored profiles (not seen live)
		for (const profile of storedProfiles) {
			const brickId = profile.brickId;
			if (!brickId || seenCandidateIds.has(brickId)) {
				continue;
			}
			const snapshot = brickRegistry.getSnapshot(brickId);
			const fallbackDisplayName = profile.displayName?.trim() || `EV3 (${brickId})`;
			const displayName = resolvePreferredDisplayName(brickId, fallbackDisplayName);
			registerCandidate({
				candidateId: brickId,
				displayName,
				transport: resolveDiscoveryTransport(brickId, profile),
				detail: resolveDiscoveryDetail(profile),
				status: resolveCandidateStatus(snapshot, 'UNAVAILABLE'),
				alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
			}, profile);
		}

		// Registry snapshots (not seen live, not in profiles)
		for (const snapshot of brickRegistry.listSnapshots()) {
			if (seenCandidateIds.has(snapshot.brickId)) {
				continue;
			}
			const rememberedProfile = profileStore.get(snapshot.brickId);
			const transport = resolveDiscoveryTransport(snapshot.brickId, rememberedProfile);
			registerCandidate({
				candidateId: snapshot.brickId,
				displayName: resolvePreferredDisplayName(snapshot.brickId, snapshot.displayName),
				transport,
				detail: resolveDiscoveryDetail(rememberedProfile),
				status: resolveCandidateStatus(snapshot, 'UNAVAILABLE'),
				alreadyConnected: snapshot.status === 'READY' || snapshot.status === 'CONNECTING'
			}, rememberedProfile);
		}

		// Sort: USB > BT > TCP > Mock
		candidates.sort((left, right) => {
			const rank = (TRANSPORT_RANK[left.transport] ?? 4) - (TRANSPORT_RANK[right.transport] ?? 4);
			if (rank !== 0) {
				return rank;
			}
			return left.displayName.localeCompare(right.displayName);
		});

		return candidates;
	}

	public async connectDiscoveredBrick(
		candidateId: string,
		profileStore: BrickConnectionProfileStore,
		executeConnect: (brickId: string) => Promise<void>
	): Promise<void> {
		const blockedReason = this.nonConnectableCandidates.get(candidateId);
		if (blockedReason && !candidateId.trim().toLowerCase().startsWith('bt-')) {
			throw new Error(blockedReason);
		}
		const profile = this.discoveredProfiles.get(candidateId) ?? profileStore.get(candidateId);
		if (!profile) {
			throw new Error('Selected Brick is no longer available. Scan again.');
		}
		await profileStore.upsert(profile);
		await executeConnect(profile.brickId);
	}

	/** Exposed for reconnect logic — check if a transport has a live candidate. */
	public hasLiveCandidate(candidateId: string): boolean {
		return this.masterMap.has(candidateId);
	}

	/** Exposed for reconnect — get a specific live record. */
	public getLiveRecord(candidateId: string): PresenceRecord | undefined {
		return this.masterMap.get(candidateId);
	}

	private mergeFromSource(source: PresenceSource): void {
		const sourceRecords = source.getPresent();
		let changed = false;

		for (const [candidateId, record] of sourceRecords) {
			const existing = this.masterMap.get(candidateId);
			this.masterMap.set(candidateId, record);
			if (!existing) {
				changed = true;
				this.deps.brickRegistry.upsertAvailable({
					brickId: candidateId,
					displayName: record.displayName,
					role: 'unknown',
					transport: record.transport,
					rootPath: this.options.defaultRootPath
				});
			}
		}

		if (changed) {
			this.fireCandidatesChanged();
		}
	}

	private reap(): void {
		const now = Date.now();
		const { brickRegistry } = this.deps;
		const goneTtl = this.options.goneTtl;
		const reaped: string[] = [];

		for (const [candidateId, record] of this.masterMap) {
			const ttl = this.getTtlForTransport(record.transport, goneTtl);
			if (!Number.isFinite(ttl)) {
				continue; // Infinity = never reap
			}

			const age = now - record.lastSeenMs;
			if (age <= ttl) {
				continue;
			}

			// Don't reap bricks that are connected
			const snapshot = brickRegistry.getSnapshot(candidateId);
			if (snapshot && (snapshot.status === 'READY' || snapshot.status === 'CONNECTING')) {
				continue;
			}

			this.masterMap.delete(candidateId);
			reaped.push(candidateId);
		}

		if (reaped.length > 0) {
			const activeIds = new Set(this.masterMap.keys());
			brickRegistry.removeStale(activeIds);
			this.deps.logger.debug('Presence reaper removed stale entries', { reaped });
			this.fireCandidatesChanged();
		}
	}

	private getTtlForTransport(transport: TransportMode, goneTtl: GoneTtlConfig): number {
		switch (transport) {
			case TransportMode.USB: return goneTtl.usb;
			case TransportMode.BT: return goneTtl.bt;
			case TransportMode.TCP: return goneTtl.tcp;
			case TransportMode.MOCK: return goneTtl.mock;
			default: return 10_000;
		}
	}

	private buildProfile(
		record: PresenceRecord,
		displayName: string,
		defaultRoot: string,
		nowIso: string
	): BrickConnectionProfile {
		const params = record.connectionParams;
		switch (params.mode) {
			case 'usb':
				return {
					brickId: record.candidateId,
					displayName,
					savedAtIso: nowIso,
					rootPath: defaultRoot,
					transport: { mode: TransportMode.USB, usbPath: params.usbPath }
				};
			case 'tcp':
				return {
					brickId: record.candidateId,
					displayName,
					savedAtIso: nowIso,
					rootPath: defaultRoot,
					transport: {
						mode: TransportMode.TCP,
						tcpHost: params.tcpHost,
						tcpPort: params.tcpPort,
						tcpUseDiscovery: false,
						tcpSerialNumber: params.tcpSerialNumber
					}
				};
			case 'bt':
				return {
					brickId: record.candidateId,
					displayName,
					savedAtIso: nowIso,
					rootPath: defaultRoot,
					transport: {
						mode: TransportMode.BT,
						btPortPath: params.btPortPath
					}
				};
			case 'mock':
				return {
					brickId: record.candidateId,
					displayName,
					savedAtIso: nowIso,
					rootPath: defaultRoot,
					transport: { mode: TransportMode.MOCK }
				};
		}
	}

	private resolveCandidateStatus(
		snapshot: { status: string } | undefined,
		record: PresenceRecord
	): NonNullable<BrickPanelDiscoveryCandidate['status']> {
		if (snapshot) {
			if (
				snapshot.status === 'READY'
				|| snapshot.status === 'CONNECTING'
				|| snapshot.status === 'ERROR'
			) {
				return snapshot.status;
			}
		}
		// Live presence = AVAILABLE
		if (record.transport === TransportMode.BT && !record.connectable) {
			return snapshot ? resolveCandidateStatus(snapshot, 'UNKNOWN') : 'AVAILABLE';
		}
		return 'AVAILABLE';
	}

	private fireCandidatesChanged(): void {
		for (const listener of this.candidatesListeners) {
			try {
				listener();
			} catch {
				// swallow
			}
		}
	}
}

function resolveCandidateStatus(
	snapshot: { status: string } | undefined,
	fallback: 'AVAILABLE' | 'UNKNOWN' | 'UNAVAILABLE'
): NonNullable<BrickPanelDiscoveryCandidate['status']> {
	if (!snapshot) {
		return fallback;
	}
	if (
		snapshot.status === 'AVAILABLE'
		|| snapshot.status === 'READY'
		|| snapshot.status === 'CONNECTING'
		|| snapshot.status === 'UNAVAILABLE'
		|| snapshot.status === 'ERROR'
	) {
		return snapshot.status;
	}
	return 'UNKNOWN';
}

function resolveDiscoveryTransport(
	brickId: string,
	profile?: BrickConnectionProfile
): BrickPanelDiscoveryCandidate['transport'] {
	const mode = profile?.transport.mode;
	if (mode === TransportMode.USB || mode === TransportMode.TCP || mode === TransportMode.BT || mode === TransportMode.MOCK) {
		return mode;
	}
	if (brickId.startsWith('usb-')) return TransportMode.USB;
	if (brickId.startsWith('tcp-')) return TransportMode.TCP;
	if (brickId.startsWith('bt-')) return TransportMode.BT;
	if (brickId.startsWith('mock-')) return TransportMode.MOCK;
	return 'unknown';
}

function resolveDiscoveryDetail(profile?: BrickConnectionProfile): string | undefined {
	if (!profile) {
		return undefined;
	}
	const transport = profile.transport;
	if (transport.mode === TransportMode.USB) {
		return transport.usbPath?.trim() || undefined;
	}
	if (transport.mode === TransportMode.TCP) {
		const host = transport.tcpHost?.trim() || '';
		const port =
			typeof transport.tcpPort === 'number' && Number.isFinite(transport.tcpPort)
				? Math.max(1, Math.floor(transport.tcpPort))
				: undefined;
		const endpoint = host && port ? `${host}:${port}` : host || (port ? String(port) : '');
		return endpoint || transport.tcpSerialNumber?.trim() || undefined;
	}
	if (transport.mode === TransportMode.BT) {
		return transport.btPortPath?.trim() || undefined;
	}
	return undefined;
}
