import type { BrickConnectionProfile } from '../device/brickConnectionProfiles';
import type { BrickPanelDiscoveryCandidate } from '../ui/brickPanelProvider';
import { isMockBrickId } from '../mock/mockCatalog';
import { TransportMode } from '../types/enums';
import type { PresenceRecord } from './presenceSource';

const TRANSPORT_RANK: Record<string, number> = {
	usb: 0,
	bt: 1,
	tcp: 2,
	mock: 3,
	unknown: 4
};

export function normalizeBrickNameCandidate(value: string | undefined): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 12) {
		return undefined;
	}
	return trimmed;
}

export function resolvePreferredDiscoveryDisplayName(input: {
	connectedDisplayName?: string;
	rememberedDisplayName?: string;
	liveDisplayName?: string;
	fallbackDisplayName: string;
}): string {
	const connectedName = normalizeBrickNameCandidate(input.connectedDisplayName);
	if (connectedName) {
		return connectedName;
	}
	const rememberedName = normalizeBrickNameCandidate(input.rememberedDisplayName);
	if (rememberedName) {
		return rememberedName;
	}
	const liveName = normalizeBrickNameCandidate(input.liveDisplayName);
	if (liveName) {
		return liveName;
	}
	return input.fallbackDisplayName;
}

export function resolveDiscoveryTransport(
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

export function resolveStoredCandidateStatus(
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

export function resolveLiveCandidateStatus(
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
	if (record.transport === TransportMode.USB && !record.connectable) {
		return 'ERROR';
	}
	if (record.transport === TransportMode.BT && !record.connectable) {
		return snapshot ? resolveStoredCandidateStatus(snapshot, 'UNKNOWN') : 'AVAILABLE';
	}
	return 'AVAILABLE';
}

export function resolveNonConnectableReason(record: PresenceRecord): string | undefined {
	if (record.connectable) {
		return undefined;
	}
	return record.transport === TransportMode.USB
		? 'USB brick detected but cannot communicate — name probe failed.'
		: 'Brick is visible over Bluetooth, but Windows currently has no COM mapping for connection.';
}

export function shouldIncludeDiscoveryCandidate(candidateId: string, showMockBricks: boolean): boolean {
	if (!showMockBricks && isMockBrickId(candidateId)) {
		return false;
	}
	return candidateId.trim().toLowerCase() !== 'active';
}

export function sortDiscoveryCandidates(
	candidates: BrickPanelDiscoveryCandidate[]
): BrickPanelDiscoveryCandidate[] {
	candidates.sort((left, right) => {
		const rank = (TRANSPORT_RANK[left.transport] ?? 4) - (TRANSPORT_RANK[right.transport] ?? 4);
		if (rank !== 0) {
			return rank;
		}
		return left.displayName.localeCompare(right.displayName);
	});
	return candidates;
}

export function buildDiscoveredProfile(
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

