import type { BrickConnectionProfile, BrickConnectionProfileStore } from '../device/brickConnectionProfiles';
import type { BrickRegistry } from '../device/brickRegistry';
import type { Logger } from '../diagnostics/logger';
import type { BrickPanelDiscoveryCandidate } from '../ui/brickPanelProvider';
import { TransportMode } from '../types/enums';
import {
	buildDiscoveredProfile,
	resolveDiscoveryDetail,
	resolveDiscoveryTransport,
	resolveLiveCandidateStatus,
	resolveNonConnectableReason,
	resolvePreferredDiscoveryDisplayName,
	resolveStoredCandidateStatus,
	shouldIncludeDiscoveryCandidate,
	sortDiscoveryCandidates
} from './presenceCandidateHelpers';
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
	candidateChangeCoalesceMs?: number;
}

export interface PresenceAggregatorDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	logger: Logger;
	toSafeIdentifier: (value: string) => string;
}

type CandidatesChangedCallback = () => void;

export class PresenceAggregator {
	private readonly deps: PresenceAggregatorDeps;
	private readonly options: PresenceAggregatorOptions;
	private readonly sources: PresenceSource[] = [];
	private readonly masterMap = new Map<string, PresenceRecord>();
	private readonly discoveredProfiles = new Map<string, BrickConnectionProfile>();
	private readonly nonConnectableCandidates = new Map<string, string>();
	private readonly candidatesListeners: CandidatesChangedCallback[] = [];
	private reaperTimer: ReturnType<typeof setInterval> | undefined;
	private candidateChangeTimer: ReturnType<typeof setTimeout> | undefined;
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
		if (this.candidateChangeTimer) {
			clearTimeout(this.candidateChangeTimer);
			this.candidateChangeTimer = undefined;
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
			if (!shouldIncludeDiscoveryCandidate(candidate.candidateId, config.showMockBricks)) {
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

		// Live presence records from all sources
		for (const [candidateId, record] of this.masterMap) {
			const snapshot = brickRegistry.getSnapshot(candidateId);
			const displayName = resolvePreferredDiscoveryDisplayName({
				connectedDisplayName: brickRegistry.getSnapshot(candidateId)?.displayName,
				rememberedDisplayName: profileStore.get(candidateId)?.displayName,
				liveDisplayName: record.displayName,
				fallbackDisplayName: record.displayName
			});

			const profile = buildDiscoveredProfile(record, displayName, defaultRoot, nowIso);
			const nonConnectableReason = resolveNonConnectableReason(record);
			const status = resolveLiveCandidateStatus(snapshot, record);
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
			const displayName = resolvePreferredDiscoveryDisplayName({
				connectedDisplayName: snapshot?.displayName,
				rememberedDisplayName: profileStore.get(brickId)?.displayName,
				fallbackDisplayName
			});
			registerCandidate({
				candidateId: brickId,
				displayName,
				transport: resolveDiscoveryTransport(brickId, profile),
				detail: resolveDiscoveryDetail(profile),
				status: resolveStoredCandidateStatus(snapshot, 'UNAVAILABLE'),
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
				displayName: resolvePreferredDiscoveryDisplayName({
					connectedDisplayName: snapshot.displayName,
					rememberedDisplayName: rememberedProfile?.displayName,
					fallbackDisplayName: snapshot.displayName
				}),
				transport,
				detail: resolveDiscoveryDetail(rememberedProfile),
				status: resolveStoredCandidateStatus(snapshot, 'UNAVAILABLE'),
				alreadyConnected: snapshot.status === 'READY' || snapshot.status === 'CONNECTING'
			}, rememberedProfile);
		}

		return sortDiscoveryCandidates(candidates);
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
			} else if (
				existing.displayName !== record.displayName
				|| existing.detail !== record.detail
				|| existing.connectable !== record.connectable
			) {
				changed = true;
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
		let added = false;

		// Refresh records from all sources to get latest lastSeenMs.
		// Also re-add entries that were previously reaped but are still
		// fresh in the source (device reappeared).
		for (const source of this.sources) {
			for (const [candidateId, record] of source.getPresent()) {
				if (this.masterMap.has(candidateId)) {
					this.masterMap.set(candidateId, record);
				} else {
					// Entry was reaped or never merged — re-add only if still fresh
					const ttl = this.getTtlForTransport(record.transport, goneTtl);
					const age = now - record.lastSeenMs;
					if (age <= ttl) {
						this.masterMap.set(candidateId, record);
						added = true;
					}
				}
			}
		}

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

		if (reaped.length > 0 || added) {
			if (reaped.length > 0) {
				this.deps.logger.debug('Presence reaper removed stale entries', { reaped });
			}
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

	private fireCandidatesChanged(): void {
		const delayMs = Math.max(0, this.options.candidateChangeCoalesceMs ?? 0);
		if (delayMs <= 0) {
			this.notifyCandidatesChanged();
			return;
		}
		if (this.candidateChangeTimer) {
			return;
		}
		this.candidateChangeTimer = setTimeout(() => {
			this.candidateChangeTimer = undefined;
			this.notifyCandidatesChanged();
		}, delayMs);
		this.candidateChangeTimer.unref?.();
	}

	private notifyCandidatesChanged(): void {
		for (const listener of this.candidatesListeners) {
			try {
				listener();
			} catch {
				// swallow
			}
		}
	}
}
