import type { BrickConnectionProfile } from './brickConnectionProfiles';
import type { BrickConnectionProfileStore } from './brickConnectionProfiles';
import type { BrickRegistry } from './brickRegistry';
import type { BrickPanelDiscoveryCandidate } from '../ui/brickPanelProvider';
import type { SerialCandidate } from '../transport/discovery';
import type { Logger } from '../diagnostics/logger';
import { isMockBrickId, type MockBrickDefinition } from '../mock/mockCatalog';

export interface DiscoveryTransportScanners {
	listUsbHidCandidates: () => Promise<Array<{ path: string; serialNumber?: string }>>;
	listSerialCandidates: () => Promise<SerialCandidate[]>;
	listTcpDiscoveryCandidates: (port: number, timeoutMs: number) => Promise<Array<{
		ip: string;
		port: number;
		name?: string;
		serialNumber?: string;
	}>>;
}

export interface DiscoveryConfig {
	showMockBricks: boolean;
	mockBricks: MockBrickDefinition[];
	tcpDiscoveryPort: number;
	tcpDiscoveryTimeoutMs: number;
	preferredBluetoothPort?: string;
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

function isLikelyEv3SerialCandidate(
	candidate: SerialCandidate,
	preferredPort?: string
): boolean {
	const normalizedPath = candidate.path.trim().toUpperCase();
	if (preferredPort && normalizedPath === preferredPort) {
		return true;
	}
	const fingerprint = `${candidate.manufacturer ?? ''} ${candidate.serialNumber ?? ''} ${candidate.pnpId ?? ''}`.toUpperCase();
	return /EV3|LEGO|MINDSTORMS|_005D/.test(fingerprint);
}

export class BrickDiscoveryService {
	private readonly deps: BrickDiscoveryServiceDeps;
	private readonly discoveredProfiles = new Map<string, BrickConnectionProfile>();

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

		const [usbCandidates, serialCandidates, tcpCandidates] = await Promise.all([
			scanners.listUsbHidCandidates(),
			scanners.listSerialCandidates(),
			scanners.listTcpDiscoveryCandidates(config.tcpDiscoveryPort, config.tcpDiscoveryTimeoutMs)
		]);

		this.discoveredProfiles.clear();
		const candidates: BrickPanelDiscoveryCandidate[] = [];
		const seenCandidateIds = new Set<string>();

		const registerCandidate = (
			candidate: BrickPanelDiscoveryCandidate,
			profile?: BrickConnectionProfile
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

		// USB
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
				transport: { mode: 'usb', usbPath }
			};
			registerCandidate({
				candidateId: brickId,
				displayName,
				transport: 'usb',
				detail: usbPath,
				status: resolveCandidateStatus(snapshot, 'UNKNOWN'),
				alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
			}, profile);
		}

		// Bluetooth serial
		for (const serialCandidate of serialCandidates) {
			const rawPath = serialCandidate.path.trim();
			if (!rawPath || !/^COM\d+$/i.test(rawPath)) {
				continue;
			}
			if (!isLikelyEv3SerialCandidate(serialCandidate, config.preferredBluetoothPort)) {
				continue;
			}
			const btPort = rawPath.toUpperCase();
			const brickId = `bt-${toSafeIdentifier(btPort)}`;
			const snapshot = brickRegistry.getSnapshot(brickId);
			const manufacturer = serialCandidate.manufacturer?.trim();
			const fallbackDisplayName = `EV3 Bluetooth (${btPort})`;
			const displayName = resolvePreferredDisplayName(brickId, fallbackDisplayName);
			const detail = manufacturer
				? `${manufacturer} | ${btPort}`
				: btPort;
			const profile: BrickConnectionProfile = {
				brickId,
				displayName,
				savedAtIso: nowIso,
				rootPath: defaultRoot,
				transport: { mode: 'bt', btPort }
			};
			registerCandidate({
				candidateId: brickId,
				displayName,
				transport: 'bt',
				detail,
				status: resolveCandidateStatus(snapshot, 'UNKNOWN'),
				alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
			}, profile);
		}

		// TCP
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
					mode: 'tcp',
					tcpHost: tcpCandidate.ip,
					tcpPort: tcpCandidate.port,
					tcpUseDiscovery: false,
					tcpSerialNumber: tcpCandidate.serialNumber || undefined
				}
			};
			registerCandidate({
				candidateId: brickId,
				displayName,
				transport: 'tcp',
				detail,
				status: resolveCandidateStatus(snapshot, 'UNKNOWN'),
				alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
			}, profile);
		}

		// Stored profiles
		for (const profile of profileStore.list()) {
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

		// Active registry entries
		for (const snapshot of brickRegistry.listSnapshots()) {
			if (seenCandidateIds.has(snapshot.brickId)) {
				continue;
			}
			registerCandidate({
				candidateId: snapshot.brickId,
				displayName: resolvePreferredDisplayName(snapshot.brickId, snapshot.displayName),
				transport: resolveDiscoveryTransport(snapshot.brickId, profileStore.get(snapshot.brickId)),
				detail: resolveDiscoveryDetail(profileStore.get(snapshot.brickId)),
				status: resolveCandidateStatus(snapshot, 'UNAVAILABLE'),
				alreadyConnected: snapshot.status === 'READY' || snapshot.status === 'CONNECTING'
			}, profileStore.get(snapshot.brickId));
		}

		// Mock brick
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
					transport: { mode: 'mock' }
				};
				const detail = mock.role === 'master'
					? 'Mock | master'
					: mock.parentDisplayName
						? `Mock | slave of ${mock.parentDisplayName}`
						: 'Mock | slave';
				registerCandidate({
					candidateId: mock.brickId,
					displayName,
					transport: 'mock',
					detail,
					status: resolveCandidateStatus(snapshot, 'UNKNOWN'),
					alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
				}, profile);
			}
		}

		// Sort
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
			serialCandidates: serialCandidates.length,
			tcpCandidates: tcpCandidates.length,
			discovered: candidates.length
		});
		return candidates;
	}

	public async connectDiscoveredBrick(
		candidateId: string,
		profileStore: BrickConnectionProfileStore,
		executeConnect: (brickId: string) => Promise<void>
	): Promise<void> {
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
	fallback: 'UNKNOWN' | 'UNAVAILABLE'
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
	if (mode === 'usb' || mode === 'bt' || mode === 'tcp' || mode === 'mock') {
		return mode;
	}
	if (brickId.startsWith('usb-')) {
		return 'usb';
	}
	if (brickId.startsWith('bt-')) {
		return 'bt';
	}
	if (brickId.startsWith('tcp-')) {
		return 'tcp';
	}
	if (brickId.startsWith('mock-')) {
		return 'mock';
	}
	return 'unknown';
}

export function resolveDiscoveryDetail(profile?: BrickConnectionProfile): string | undefined {
	if (!profile) {
		return undefined;
	}
	const transport = profile.transport;
	if (transport.mode === 'usb') {
		return transport.usbPath?.trim() || undefined;
	}
	if (transport.mode === 'bt') {
		return transport.btPort?.trim() || undefined;
	}
	if (transport.mode === 'tcp') {
		const host = transport.tcpHost?.trim() || '';
		const port =
			typeof transport.tcpPort === 'number' && Number.isFinite(transport.tcpPort)
				? Math.max(1, Math.floor(transport.tcpPort))
				: undefined;
		const endpoint = host && port ? `${host}:${port}` : host || (port ? String(port) : '');
		return endpoint || transport.tcpSerialNumber?.trim() || undefined;
	}
	return undefined;
}
