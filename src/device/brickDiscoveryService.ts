import type { BrickConnectionProfile } from './brickConnectionProfiles';
import type { BrickConnectionProfileStore } from './brickConnectionProfiles';
import type { BrickRegistry } from './brickRegistry';
import type { BrickPanelDiscoveryCandidate } from '../ui/brickPanelProvider';
import {
	extractBluetoothAddressFromPnpId,
	type WindowsBluetoothPairedDevice,
	type SerialCandidate,
	type WindowsBluetoothLiveDevice
} from '../transport/discovery';
import type { Logger } from '../diagnostics/logger';
import { isMockBrickId, type MockBrickDefinition } from '../mock/mockCatalog';
import { TransportMode } from '../types/enums';

const BT_PAIRED_FALLBACK_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

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
	probeBtCandidatePresence?: (port: string) => Promise<boolean>;
	isBtAddressPresent?: (address: string) => Promise<boolean>;
	listBtLiveDevices?: () => Promise<WindowsBluetoothLiveDevice[]>;
	listBtPairedDevices?: () => Promise<WindowsBluetoothPairedDevice[]>;
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

function resolveBluetoothFriendlyDisplayName(candidate: SerialCandidate): string | undefined {
	const raw = candidate.friendlyName?.trim();
	if (!raw) {
		return undefined;
	}
	const normalized = raw.replace(/\u0000/g, '').replace(/\(COM\d+\)/i, '').trim();
	if (!normalized) {
		return undefined;
	}
	if (
		/BLUETOOTH|SERIOVA|SERI[ÁA]LN[IÍ]|PROTOKOL|PORT|COM\d+/i.test(normalized)
		&& !/EV3|LEGO|MINDSTORMS/i.test(normalized)
	) {
		return undefined;
	}
	return normalizeBrickNameCandidate(normalized);
}

export function isLikelyEv3SerialCandidate(
	candidate: SerialCandidate,
	preferredPort?: string
): boolean {
	const normalizedPath = candidate.path.trim().toUpperCase();
	if (preferredPort && normalizedPath === preferredPort) {
		return true;
	}
	const fingerprint = `${candidate.manufacturer ?? ''} ${candidate.serialNumber ?? ''} ${candidate.pnpId ?? ''}`.toUpperCase();
	if (/EV3|LEGO|MINDSTORMS|_005D/.test(fingerprint)) {
		return true;
	}
	// Windows Bluetooth SPP ports for EV3 typically report LOCALMFG&005D and a LEGO MAC prefix 00:16:53.
	// Example pnpId: BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&005D\\...\\001653XXXXXX_...
	const isBluetoothSpp = /BTHENUM\\\{00001101-0000-1000-8000-00805F9B34FB\}/.test(fingerprint);
	if (!isBluetoothSpp) {
		return false;
	}
	// Accept EV3-specific hints when present.
	const btAddress = extractBluetoothAddressFromPnpId(candidate.pnpId);
	if (/LOCALMFG&005D/.test(fingerprint) || btAddress?.startsWith('001653')) {
		return true;
	}
	// Reject generic Bluetooth SPP ports (for example LOCALMFG&0000) that have no EV3 hint.
	return false;
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

		const [usbCandidates, serialCandidates, tcpCandidates] = await Promise.all([
			scanners.listUsbHidCandidates(),
			scanners.listSerialCandidates(),
			scanners.listTcpDiscoveryCandidates(config.tcpDiscoveryPort, config.tcpDiscoveryTimeoutMs)
		]);

		this.discoveredProfiles.clear();
		this.nonConnectableCandidates.clear();
		const candidates: BrickPanelDiscoveryCandidate[] = [];
		const seenCandidateIds = new Set<string>();
		const seenBtPorts = new Set<string>();

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
			discoveredName?: string,
			preferDiscoveredOverRemembered = false
		): string => {
			const connectedName = normalizeBrickNameCandidate(brickRegistry.getSnapshot(brickId)?.displayName);
			if (connectedName) {
				return connectedName;
			}
			const liveDiscoveredName = normalizeBrickNameCandidate(discoveredName);
			if (preferDiscoveredOverRemembered && liveDiscoveredName) {
				return liveDiscoveredName;
			}
			const rememberedName = normalizeBrickNameCandidate(profileStore.get(brickId)?.displayName);
			if (rememberedName) {
				return rememberedName;
			}
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

		// Bluetooth serial
		for (const serialCandidate of serialCandidates) {
			const rawPath = serialCandidate.path.trim();
			if (!rawPath || !/^COM\d+$/i.test(rawPath)) {
				continue;
			}
			const likelyEv3Candidate = isLikelyEv3SerialCandidate(serialCandidate, config.preferredBluetoothPort);
			const btPort = rawPath.toUpperCase();
			const brickId = resolveBtBrickId(serialCandidate, btPort, toSafeIdentifier);
			const snapshot = brickRegistry.getSnapshot(brickId);
			const alreadyConnected = snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING';
			let btPresenceConfirmed = alreadyConnected;
			if (!alreadyConnected && this.deps.probeBtCandidatePresence) {
				let present = false;
				try {
					present = await this.deps.probeBtCandidatePresence(btPort);
				} catch (error) {
					logger.debug('Bluetooth discovery probe failed', {
						port: btPort,
						brickId,
						error: error instanceof Error ? error.message : String(error)
					});
				}
				if (!present) {
					logger.debug('Bluetooth discovery probe rejected candidate', {
						port: btPort,
						brickId,
						pnpId: serialCandidate.pnpId,
						manufacturer: serialCandidate.manufacturer
					});
					continue;
				}
				btPresenceConfirmed = present;
			} else if (!alreadyConnected && !likelyEv3Candidate) {
				// Without active probe capability, keep strict fingerprint gating to avoid false positives.
				continue;
			}
			const fallbackDisplayName = `EV3 Bluetooth (${btPort})`;
			const btAddress = resolveBtAddress(serialCandidate);
			const portProfile = !btAddress
				? profileStore.list().find((profile) => (
					profile.transport.mode === 'bt'
					&& profile.transport.btPort?.trim().toUpperCase() === btPort
				))
				: undefined;
			const displayName = resolvePreferredDisplayName(
				brickId,
				fallbackDisplayName,
				resolveBluetoothFriendlyDisplayName(serialCandidate) ?? portProfile?.displayName,
				true
			);
			const manufacturer = serialCandidate.manufacturer?.trim();
			const detail = manufacturer
				? `${manufacturer} | ${btPort}`
				: btPort;
			const profile: BrickConnectionProfile = {
				brickId,
				displayName,
				savedAtIso: nowIso,
				rootPath: defaultRoot,
				transport: { mode: TransportMode.BT, btPort }
			};
			registerCandidate({
				candidateId: brickId,
				displayName,
				transport: TransportMode.BT,
				detail,
				status: resolveCandidateStatus(snapshot, btPresenceConfirmed ? 'AVAILABLE' : 'UNKNOWN'),
				alreadyConnected
			}, profile);
			seenBtPorts.add(btPort);
		}

		// Bluetooth live devices without COM mapping
		if (this.deps.listBtLiveDevices) {
			let liveDevices: WindowsBluetoothLiveDevice[] = [];
			try {
				liveDevices = await this.deps.listBtLiveDevices();
			} catch (error) {
				logger.debug('Bluetooth live-device scan failed', {
					error: error instanceof Error ? error.message : String(error)
				});
			}
			for (const device of liveDevices) {
				const address = device.address.trim().toUpperCase();
				if (!address || !address.startsWith('001653')) {
					continue;
				}
				const brickId = `bt-${toSafeIdentifier(address)}`;
				if (seenCandidateIds.has(brickId)) {
					continue;
				}
				const snapshot = brickRegistry.getSnapshot(brickId);
				const rememberedProfile = profileStore.get(brickId);
				const rememberedPort = rememberedProfile?.transport.mode === 'bt'
					? rememberedProfile.transport.btPort?.trim().toUpperCase()
					: undefined;
				const alreadyConnected = snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING';
				let rememberedPortConfirmed = alreadyConnected;
				if (rememberedPort && !alreadyConnected && this.deps.probeBtCandidatePresence) {
					try {
						rememberedPortConfirmed = await this.deps.probeBtCandidatePresence(rememberedPort);
					} catch (error) {
						logger.debug('Bluetooth live-device remembered-port probe failed', {
							brickId,
							address,
							rememberedPort,
							error: error instanceof Error ? error.message : String(error)
						});
					}
					if (!rememberedPortConfirmed) {
						logger.debug('Bluetooth live-device candidate ignored because remembered COM probe failed', {
							brickId,
							address,
							rememberedPort
						});
						continue;
					}
				}
				const hasConnectablePort = Boolean(rememberedPort)
					&& (!this.deps.probeBtCandidatePresence || rememberedPortConfirmed);
				const fallbackDisplayName = `EV3 Bluetooth (${address.slice(-4)})`;
				const displayName = resolvePreferredDisplayName(brickId, fallbackDisplayName, device.displayName, true);
				const detail = hasConnectablePort && rememberedPort
					? `${device.displayName ?? address} | ${rememberedPort}`
					: `${device.displayName ?? address} | no COM`;
				const nonConnectableReason = hasConnectablePort
					? undefined
					: 'Brick is visible over Bluetooth, but Windows did not expose an SPP COM port. Pair or enable Serial Port service first.';

				registerCandidate({
					candidateId: brickId,
					displayName,
					transport: TransportMode.BT,
					detail,
					status: resolveCandidateStatus(snapshot, hasConnectablePort && rememberedPortConfirmed ? 'AVAILABLE' : 'UNAVAILABLE'),
					alreadyConnected
				}, rememberedProfile, nonConnectableReason);
				if (hasConnectablePort && rememberedPort) {
					seenBtPorts.add(rememberedPort);
				}
			}
		}

		// Paired EV3 devices from Windows registry (fallback visibility)
		if (this.deps.listBtPairedDevices) {
			let pairedDevices: WindowsBluetoothPairedDevice[] = [];
			try {
				pairedDevices = await this.deps.listBtPairedDevices();
			} catch (error) {
				logger.debug('Bluetooth paired-device scan failed', {
					error: error instanceof Error ? error.message : String(error)
				});
			}
			for (const device of pairedDevices) {
				const address = device.address.trim().toUpperCase();
				if (!address || !address.startsWith('001653')) {
					continue;
				}
				if (!isPairedFallbackRecent(device, Date.now())) {
					logger.debug('Skipping stale paired Bluetooth fallback candidate', {
						address,
						lastSeenAtIso: device.lastSeenAtIso,
						lastConnectedAtIso: device.lastConnectedAtIso
					});
					continue;
				}
				const brickId = `bt-${toSafeIdentifier(address)}`;
				if (seenCandidateIds.has(brickId)) {
					continue;
				}
				const snapshot = brickRegistry.getSnapshot(brickId);
				const fallbackDisplayName = `EV3 Bluetooth (${address.slice(-4)})`;
				const displayName = resolvePreferredDisplayName(brickId, fallbackDisplayName, device.displayName, true);
				registerCandidate({
					candidateId: brickId,
					displayName,
					transport: TransportMode.BT,
					detail: `${device.displayName ?? address} | paired only`,
					status: resolveUnavailableUnlessConnected(snapshot),
					alreadyConnected: snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING'
				}, undefined, 'Brick is paired in Windows, but not currently reported as present by Bluetooth stack.');
			}
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

		// Stored profiles
		for (const profile of profileStore.list()) {
			const brickId = profile.brickId;
			if (!brickId || seenCandidateIds.has(brickId)) {
				continue;
			}
			if (
				profile.transport.mode === TransportMode.BT
				&& isLegacyBluetoothBrickId(brickId)
			) {
				const btPort = profile.transport.btPort?.trim().toUpperCase();
				if (btPort && seenBtPorts.has(btPort)) {
					// Legacy bt-comX profile collides with a MAC-based BT candidate on the same port.
					continue;
				}
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
			const rememberedProfile = profileStore.get(snapshot.brickId);
			const transport = resolveDiscoveryTransport(snapshot.brickId, rememberedProfile);
			const isConnected = snapshot.status === 'READY' || snapshot.status === 'CONNECTING';
			if (transport === TransportMode.BT && isLegacyBluetoothBrickId(snapshot.brickId) && !isConnected) {
				const btPort = rememberedProfile?.transport.mode === TransportMode.BT
					? rememberedProfile.transport.btPort?.trim().toUpperCase()
					: undefined;
				if (!btPort || seenBtPorts.has(btPort)) {
					// Drop stale legacy BT snapshot that is superseded by MAC-based discovery.
					continue;
				}
			}
			registerCandidate({
				candidateId: snapshot.brickId,
				displayName: resolvePreferredDisplayName(snapshot.brickId, snapshot.displayName),
				transport,
				detail: resolveDiscoveryDetail(rememberedProfile),
				status: resolveCandidateStatus(snapshot, 'UNAVAILABLE'),
				alreadyConnected: isConnected
			}, rememberedProfile);
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

function resolveUnavailableUnlessConnected(
	snapshot: { status: string } | undefined
): NonNullable<BrickPanelDiscoveryCandidate['status']> {
	if (snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING') {
		return snapshot.status;
	}
	return 'UNAVAILABLE';
}

function isLegacyBluetoothBrickId(brickId: string): boolean {
	const normalized = brickId.trim().toLowerCase();
	return normalized.startsWith('bt-') && !/^bt-[0-9a-f]{12}$/i.test(normalized);
}

function isPairedFallbackRecent(device: WindowsBluetoothPairedDevice, nowMs: number): boolean {
	const timestamps = [device.lastSeenAtIso, device.lastConnectedAtIso]
		.filter((value): value is string => typeof value === 'string');
	if (timestamps.length === 0) {
		return true;
	}
	let youngestAgeMs = Number.POSITIVE_INFINITY;
	for (const timestamp of timestamps) {
		const tsMs = Date.parse(timestamp);
		if (!Number.isFinite(tsMs) || tsMs <= 0) {
			continue;
		}
		const ageMs = Math.max(0, nowMs - tsMs);
		youngestAgeMs = Math.min(youngestAgeMs, ageMs);
	}
	if (!Number.isFinite(youngestAgeMs)) {
		return true;
	}
	return youngestAgeMs <= BT_PAIRED_FALLBACK_MAX_AGE_MS;
}

export function resolveDiscoveryTransport(
	brickId: string,
	profile?: BrickConnectionProfile
): BrickPanelDiscoveryCandidate['transport'] {
	const mode = profile?.transport.mode;
	if (mode === TransportMode.USB || mode === TransportMode.BT || mode === TransportMode.TCP || mode === TransportMode.MOCK) {
		return mode;
	}
	if (brickId.startsWith('usb-')) {
		return TransportMode.USB;
	}
	if (brickId.startsWith('bt-')) {
		return TransportMode.BT;
	}
	if (brickId.startsWith('tcp-')) {
		return TransportMode.TCP;
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
	if (transport.mode === TransportMode.BT) {
		return transport.btPort?.trim() || undefined;
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
	return undefined;
}
