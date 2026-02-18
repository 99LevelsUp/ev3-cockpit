import type { BrickConnectionProfile } from './brickConnectionProfiles';
import type { BrickConnectionProfileStore } from './brickConnectionProfiles';
import type { BrickRegistry } from './brickRegistry';
import type { BrickPanelDiscoveryCandidate } from '../ui/brickPanelProvider';
import type { Logger } from '../diagnostics/logger';
import { isMockBrickId, type MockBrickDefinition } from '../mock/mockCatalog';
import { TransportMode } from '../types/enums';

export interface DiscoveryTransportScanners {
	listUsbHidCandidates: () => Promise<Array<{ path: string; serialNumber?: string }>>;
	listTcpDiscoveryCandidates: (port: number, timeoutMs: number) => Promise<Array<{
		ip: string;
		port: number;
		name?: string;
		serialNumber?: string;
	}>>;
	listBluetoothCandidates?: () => Promise<Array<{
		path: string;
		mac?: string;
		displayName?: string;
		hasLegoPrefix: boolean;
	}>>;
}

export interface DiscoveryConfig {
	showMockBricks: boolean;
	mockBricks: MockBrickDefinition[];
	tcpDiscoveryPort: number;
	tcpDiscoveryTimeoutMs: number;
	defaultRootPath: string;
}

export interface BrickDiscoveryServiceDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	scanners: DiscoveryTransportScanners;
	logger: Logger;
	toSafeIdentifier: (value: string) => string;
}

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

export class BrickDiscoveryService {
	private readonly deps: BrickDiscoveryServiceDeps;
	private readonly discoveredProfiles = new Map<string, BrickConnectionProfile>();
	private readonly nonConnectableCandidates = new Map<string, string>();

	constructor(deps: BrickDiscoveryServiceDeps) {
		this.deps = deps;
	}

	public getDiscoveredProfile(candidateId: string): BrickConnectionProfile | undefined {
		return this.discoveredProfiles.get(candidateId);
	}

	public updateDiscoveredProfile(brickId: string, profile: BrickConnectionProfile): void {
		if (this.discoveredProfiles.has(brickId)) {
			this.discoveredProfiles.set(brickId, profile);
		}
	}

	public listDiscoveredProfiles(): ReadonlyMap<string, BrickConnectionProfile> {
		return this.discoveredProfiles;
	}

	public async scan(config: DiscoveryConfig): Promise<BrickPanelDiscoveryCandidate[]> {
		const { brickRegistry, profileStore, scanners, logger, toSafeIdentifier } = this.deps;
		const nowIso = new Date().toISOString();
		const defaultRoot = config.defaultRootPath;
		const storedProfiles = profileStore.list();
		const [usbCandidates, tcpCandidates, btCandidates] = await Promise.all([
			scanners.listUsbHidCandidates(),
			scanners.listTcpDiscoveryCandidates(config.tcpDiscoveryPort, config.tcpDiscoveryTimeoutMs),
			scanners.listBluetoothCandidates?.() ?? Promise.resolve([])
		]);

		this.discoveredProfiles.clear();
		this.nonConnectableCandidates.clear();
		const candidates: BrickPanelDiscoveryCandidate[] = [];
		const seenCandidateIds = new Set<string>();

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

		for (const usbCandidate of usbCandidates) {
			const usbPath = usbCandidate.path.trim();
			if (!usbPath) {
				continue;
			}
			const brickId = `usb-${toSafeIdentifier(usbPath)}`;
			const snapshot = brickRegistry.getSnapshot(brickId);
			const fallbackDisplayName = usbCandidate.serialNumber
				? `EV3 USB (${usbCandidate.serialNumber})`
				: `EV3 USB (${usbPath})`;
			const displayName = resolvePreferredDisplayName(brickId, fallbackDisplayName);
			const profile: BrickConnectionProfile = {
				brickId,
				displayName,
				savedAtIso: nowIso,
				rootPath: defaultRoot,
				transport: { mode: TransportMode.USB, usbPath }
			};
			registerCandidate({
				candidateId: brickId,
				displayName,
				transport: TransportMode.USB,
				detail: usbPath,
				status: resolveCandidateStatus(snapshot, 'UNKNOWN'),
				alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
			}, profile);
		}

		for (const tcpCandidate of tcpCandidates) {
			const endpoint = `${tcpCandidate.ip}:${tcpCandidate.port}`;
			const brickId = `tcp-${toSafeIdentifier(endpoint)}`;
			const snapshot = brickRegistry.getSnapshot(brickId);
			const fallbackDisplayName = `EV3 TCP (${endpoint})`;
			const displayName = resolvePreferredDisplayName(brickId, fallbackDisplayName, tcpCandidate.name);
			const serialPart = tcpCandidate.serialNumber ? `SN ${tcpCandidate.serialNumber}` : '';
			const namePart = tcpCandidate.name ? tcpCandidate.name : '';
			const detail = [namePart, serialPart].filter((part) => part.length > 0).join(' | ') || endpoint;
			const profile: BrickConnectionProfile = {
				brickId,
				displayName,
				savedAtIso: nowIso,
				rootPath: defaultRoot,
				transport: {
					mode: TransportMode.TCP,
					tcpHost: tcpCandidate.ip,
					tcpPort: tcpCandidate.port,
					tcpUseDiscovery: false,
					tcpSerialNumber: tcpCandidate.serialNumber || undefined
				}
			};
			registerCandidate({
				candidateId: brickId,
				displayName,
				transport: TransportMode.TCP,
				detail,
				status: resolveCandidateStatus(snapshot, 'UNKNOWN'),
				alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
			}, profile);
		}

		for (const btCandidate of btCandidates) {
			const comPath = btCandidate.path.trim();
			if (!comPath) {
				continue;
			}
			const idSuffix = btCandidate.mac ?? toSafeIdentifier(comPath);
			const brickId = `bt-${idSuffix}`;
			if (seenCandidateIds.has(brickId)) {
				continue;
			}
			const snapshot = brickRegistry.getSnapshot(brickId);
			const fallbackDisplayName = btCandidate.displayName
				?? (btCandidate.mac ? `EV3 BT (${btCandidate.mac.slice(-4).toUpperCase()})` : `EV3 BT (${comPath})`);
			const displayName = resolvePreferredDisplayName(brickId, fallbackDisplayName, btCandidate.displayName);
			const detail = btCandidate.mac
				? `${comPath} | ${btCandidate.mac.toUpperCase()}`
				: comPath;
			const profile: BrickConnectionProfile = {
				brickId,
				displayName,
				savedAtIso: nowIso,
				rootPath: defaultRoot,
				transport: { mode: TransportMode.BT, btPortPath: comPath }
			};
			registerCandidate({
				candidateId: brickId,
				displayName,
				transport: TransportMode.BT,
				detail,
				status: resolveCandidateStatus(snapshot, 'UNKNOWN'),
				alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
			}, profile);
		}

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

		if (config.showMockBricks) {
			for (const mock of config.mockBricks) {
				if (seenCandidateIds.has(mock.brickId)) {
					continue;
				}
				const snapshot = brickRegistry.getSnapshot(mock.brickId);
				const rememberedProfile = profileStore.get(mock.brickId);
				const fallbackDisplayName = mock.displayName;
				const displayName = resolvePreferredDisplayName(mock.brickId, fallbackDisplayName);
				const profile: BrickConnectionProfile = rememberedProfile ?? {
					brickId: mock.brickId,
					displayName,
					savedAtIso: nowIso,
					rootPath: defaultRoot,
					transport: { mode: TransportMode.MOCK }
				};
				const detail = mock.role === 'master'
					? 'Mock | master'
					: mock.parentDisplayName
						? `Mock | slave of ${mock.parentDisplayName}`
						: 'Mock | slave';
				registerCandidate({
					candidateId: mock.brickId,
					displayName,
					transport: TransportMode.MOCK,
					detail,
					status: resolveCandidateStatus(snapshot, 'UNKNOWN'),
					alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
				}, profile);
			}
		}

		const transportRank: Record<BrickPanelDiscoveryCandidate['transport'], number> = {
			usb: 0,
			bt: 1,
			tcp: 2,
			mock: 3,
			unknown: 4
		};
		candidates.sort((left, right) => {
			const rank = transportRank[left.transport] - transportRank[right.transport];
			if (rank !== 0) {
				return rank;
			}
			return left.displayName.localeCompare(right.displayName);
		});

		logger.info('Brick panel scan completed', {
			usbCandidates: usbCandidates.length,
			tcpCandidates: tcpCandidates.length,
			btCandidates: btCandidates.length,
			discovered: candidates.length
		});
		return candidates;
	}

	public async connectDiscoveredBrick(
		candidateId: string,
		profileStore: BrickConnectionProfileStore,
		executeConnect: (brickId: string) => Promise<void>
	): Promise<void> {
		const blockedReason = this.nonConnectableCandidates.get(candidateId);
		if (blockedReason) {
			throw new Error(blockedReason);
		}
		const profile = this.discoveredProfiles.get(candidateId) ?? profileStore.get(candidateId);
		if (!profile) {
			throw new Error('Selected Brick is no longer available. Scan again.');
		}
		await profileStore.upsert(profile);
		await executeConnect(profile.brickId);
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

export function resolveDiscoveryTransport(
	brickId: string,
	profile?: BrickConnectionProfile
): BrickPanelDiscoveryCandidate['transport'] {
	const mode = profile?.transport.mode;
	if (mode === TransportMode.USB || mode === TransportMode.TCP || mode === TransportMode.BT || mode === TransportMode.MOCK) {
		return mode;
	}
	if (brickId.startsWith('usb-')) {
		return TransportMode.USB;
	}
	if (brickId.startsWith('tcp-')) {
		return TransportMode.TCP;
	}
	if (brickId.startsWith('bt-')) {
		return TransportMode.BT;
	}
	if (brickId.startsWith('mock-')) {
		return TransportMode.MOCK;
	}
	return 'unknown';
}

export function resolveDiscoveryDetail(profile?: BrickConnectionProfile): string | undefined {
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
