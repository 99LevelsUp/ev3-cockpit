/**
 * Bluetooth COM port selection — two-tier ranking for EV3 discovery.
 *
 * Strategy 1 — **ev3-priority**: ranks ports by EV3-specific hints
 * (serial number match, pnpId `_005D` hint, LEGO MAC OUI prefix).
 *
 * Strategy 2 — **legacy-order**: simple ascending COM port number.
 */

import type { SerialCandidate } from './discovery';

/** LEGO Bluetooth OUI prefix (00:16:53). */
export const LEGO_MAC_OUI_PREFIX = '001653';

/** pnpId substring indicating the EV3 LOCALMFG BT profile. */
export const EV3_PNP_HINT = '_005D';

/** Strategy used to order COM port candidates. */
export type BluetoothPortStrategy = 'ev3-priority' | 'legacy-order';

/** A ranked COM port ready for probe attempts. */
export interface RankedBluetoothPort {
	/** COM port path, e.g. "COM5". */
	path: string;
	/** Numeric score — lower is better. */
	score: number;
	/** Strategy that produced this ranking. */
	strategy: BluetoothPortStrategy;
	/** Original serial candidate metadata. */
	candidate: SerialCandidate;
}

/**
 * Build an ordered list of COM ports for BT EV3 probing.
 *
 * Returns two tiers: first `ev3-priority` (best EV3 hints first),
 * then `legacy-order` (by COM number) — with duplicates removed from
 * the second tier.
 *
 * @param candidates - Serial port candidates from `listSerialCandidates()`.
 * @param targetSerialNumber - Optional known brick serial number for exact match.
 */
export function buildBluetoothPortPlans(
	candidates: readonly SerialCandidate[],
	targetSerialNumber?: string
): RankedBluetoothPort[] {
	const btCandidates = candidates.filter(isBtSerialCandidate);

	const ev3Plan = buildEv3PriorityPlan(btCandidates, targetSerialNumber);
	const legacyPlan = buildLegacyOrderPlan(btCandidates);

	// Deduplicate: remove from legacy any paths already in ev3-priority.
	const ev3Paths = new Set(ev3Plan.map((p) => p.path));
	const uniqueLegacy = legacyPlan.filter((p) => !ev3Paths.has(p.path));

	return [...ev3Plan, ...uniqueLegacy];
}

/**
 * Returns `true` when the candidate looks like a Bluetooth serial port
 * (based on pnpId containing BTHENUM or manufacturer hint).
 */
export function isBtSerialCandidate(candidate: SerialCandidate): boolean {
	const pnp = candidate.pnpId ?? '';
	if (/BTHENUM/i.test(pnp)) {
		return true;
	}
	// Some adapters expose BT COM ports without BTHENUM — allow any COM candidate.
	return /^COM\d+$/i.test(candidate.path);
}

/**
 * Extract a MAC address (12 hex chars) from the serialport pnpId string.
 * Returns lowercase hex string or undefined.
 */
export function extractMacFromPnpId(pnpId: string | undefined): string | undefined {
	if (!pnpId) {
		return undefined;
	}
	// Pattern: \00AABBCCDDEE or _00AABBCCDDEE embedded in the pnpId
	const match = /[\\/_]([\dA-Fa-f]{12})(?:[_\\]|$)/.exec(pnpId);
	return match ? match[1].toLowerCase() : undefined;
}

/**
 * Check whether a pnpId indicates the LEGO Bluetooth OUI (00:16:53).
 */
export function hasLegoMacPrefix(pnpId: string | undefined): boolean {
	const mac = extractMacFromPnpId(pnpId);
	return mac !== undefined && mac.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase());
}

// ── internal ────────────────────────────────────────────────────────

function buildEv3PriorityPlan(
	candidates: SerialCandidate[],
	targetSerialNumber?: string
): RankedBluetoothPort[] {
	return candidates
		.map((c) => ({
			path: c.path,
			score: ev3PriorityScore(c, targetSerialNumber),
			strategy: 'ev3-priority' as BluetoothPortStrategy,
			candidate: c,
		}))
		.sort((a, b) => a.score - b.score || compareComNumber(a.path, b.path));
}

function buildLegacyOrderPlan(candidates: SerialCandidate[]): RankedBluetoothPort[] {
	return candidates
		.map((c, index) => ({
			path: c.path,
			score: index,
			strategy: 'legacy-order' as BluetoothPortStrategy,
			candidate: c,
		}))
		.sort((a, b) => compareComNumber(a.path, b.path));
}

/**
 * Score a serial candidate for EV3-priority ranking.
 * Lower is better: 0 = exact serial match, 1 = EV3 hint, 2 = LEGO MAC, 3 = other.
 */
function ev3PriorityScore(candidate: SerialCandidate, targetSerialNumber?: string): number {
	if (targetSerialNumber && candidate.serialNumber === targetSerialNumber) {
		return 0;
	}
	const pnp = candidate.pnpId ?? '';
	if (pnp.includes(EV3_PNP_HINT)) {
		return 1;
	}
	if (hasLegoMacPrefix(candidate.pnpId)) {
		return 2;
	}
	return 3;
}

/** Compare two COM port paths by numeric suffix (ascending). */
function compareComNumber(a: string, b: string): number {
	return extractComNumber(a) - extractComNumber(b);
}

function extractComNumber(path: string): number {
	const match = /(\d+)$/.exec(path);
	return match ? Number(match[1]) : 9999;
}
