import { SerialCandidate } from './discovery';

export interface BluetoothPortSelectionPlan {
	name: 'ev3-priority' | 'legacy-order';
	ports: string[];
}

function normalizeComPort(port: string | undefined): string | undefined {
	if (!port) {
		return undefined;
	}
	const trimmed = port.trim();
	if (!trimmed) {
		return undefined;
	}
	if (!/^COM\d+$/i.test(trimmed)) {
		return undefined;
	}
	return trimmed.toUpperCase();
}

function comPortIndex(port: string): number {
	const match = /^COM(\d+)$/i.exec(port);
	if (!match) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(match[1], 10);
}

function withPreferredPort(preferredPort: string | undefined, rankedPorts: string[]): string[] {
	const ordered = new Set<string>();
	if (preferredPort) {
		ordered.add(preferredPort);
	}
	for (const port of rankedPorts) {
		ordered.add(port);
	}
	return Array.from(ordered.values());
}

function rankLegacySerialCandidates(candidates: SerialCandidate[]): string[] {
	const ordered = new Set<string>();
	for (const candidate of candidates) {
		const normalized = normalizeComPort(candidate.path);
		if (!normalized) {
			continue;
		}
		ordered.add(normalized);
	}
	return Array.from(ordered.values());
}

function rankEv3PrioritySerialCandidates(
	candidates: SerialCandidate[],
	preferredSerialNumber?: string
): Array<{
	path: string;
	serialMatchScore: number;
	ev3HintScore: number;
	portIndex: number;
}> {
	const normalizedSerial = preferredSerialNumber?.trim().toUpperCase() ?? '';
	return candidates
		.map((candidate) => {
			const normalizedPath = normalizeComPort(candidate.path);
			if (!normalizedPath) {
				return undefined;
			}
			const pnp = (candidate.pnpId ?? '').toUpperCase();
			const serialMatch = normalizedSerial.length > 0 && pnp.includes(normalizedSerial);
			const ev3Hint = /_005D/i.test(candidate.pnpId ?? '');
			return {
				path: normalizedPath,
				serialMatchScore: serialMatch ? 0 : 1,
				ev3HintScore: ev3Hint ? 0 : 1,
				portIndex: comPortIndex(normalizedPath)
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
		.sort((a, b) => {
			if (a.serialMatchScore !== b.serialMatchScore) {
				return a.serialMatchScore - b.serialMatchScore;
			}
			if (a.ev3HintScore !== b.ev3HintScore) {
				return a.ev3HintScore - b.ev3HintScore;
			}
			if (a.portIndex !== b.portIndex) {
				return a.portIndex - b.portIndex;
			}
			return a.path.localeCompare(b.path);
		})
		.filter((entry, index, source) => source.findIndex((item) => item.path === entry.path) === index);
}

export function buildBluetoothPortSelectionPlans(
	preferredPortRaw: string | undefined,
	serialCandidates: SerialCandidate[],
	preferredSerialNumber?: string
): BluetoothPortSelectionPlan[] {
	const preferredPort = normalizeComPort(preferredPortRaw);
	const ev3Ranked = rankEv3PrioritySerialCandidates(serialCandidates, preferredSerialNumber);
	const ev3Likely = ev3Ranked
		.filter((entry) => entry.serialMatchScore === 0 || entry.ev3HintScore === 0)
		.map((entry) => entry.path);
	const ev3Priority = withPreferredPort(
		preferredPort,
		(ev3Likely.length > 0 ? ev3Likely : ev3Ranked.map((entry) => entry.path))
	);
	const legacyOrder = withPreferredPort(preferredPort, rankLegacySerialCandidates(serialCandidates));

	const plans: BluetoothPortSelectionPlan[] = [];
	if (ev3Priority.length > 0) {
		plans.push({
			name: 'ev3-priority',
			ports: ev3Priority
		});
	}
	if (
		legacyOrder.length > 0 &&
		(plans.length === 0 || plans[0].ports.join(',') !== legacyOrder.join(','))
	) {
		plans.push({
			name: 'legacy-order',
			ports: legacyOrder
		});
	}

	return plans;
}
