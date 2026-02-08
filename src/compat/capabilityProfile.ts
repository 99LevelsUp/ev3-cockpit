import { CapabilityProbeResult } from '../protocol/capabilityProbe';

export type CompatProfileMode = 'auto' | 'stock-strict';

export type CapabilityProfileId = 'stock-default' | 'stock-legacy' | 'stock-strict' | 'compat-conservative';

export interface CapabilityProfile {
	id: CapabilityProfileId;
	firmwareFamily: 'stock' | 'unknown';
	supportsContinueList: boolean;
	uploadChunkBytes: number;
	minPollingUsbMs: number;
	minPollingBtTcpMs: number;
	recommendedTimeoutMs: number;
}

interface ParsedFirmwareVersion {
	major: number;
	minor: number;
	suffix: string;
}

function parseFirmwareVersion(raw: string): ParsedFirmwareVersion | undefined {
	const normalized = raw.trim();
	const match = /^V(\d+)\.(\d+)([A-Za-z]?)$/.exec(normalized);
	if (!match) {
		return undefined;
	}

	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		suffix: match[3].toUpperCase()
	};
}

function makeStockDefault(): CapabilityProfile {
	return {
		id: 'stock-default',
		firmwareFamily: 'stock',
		supportsContinueList: true,
		uploadChunkBytes: 1000,
		minPollingUsbMs: 100,
		minPollingBtTcpMs: 250,
		recommendedTimeoutMs: 2000
	};
}

function makeStockLegacy(): CapabilityProfile {
	return {
		id: 'stock-legacy',
		firmwareFamily: 'stock',
		supportsContinueList: false,
		uploadChunkBytes: 900,
		minPollingUsbMs: 120,
		minPollingBtTcpMs: 300,
		recommendedTimeoutMs: 2500
	};
}

function makeStockStrict(): CapabilityProfile {
	return {
		id: 'stock-strict',
		firmwareFamily: 'stock',
		supportsContinueList: false,
		uploadChunkBytes: 900,
		minPollingUsbMs: 120,
		minPollingBtTcpMs: 300,
		recommendedTimeoutMs: 3000
	};
}

function makeCompatConservative(): CapabilityProfile {
	return {
		id: 'compat-conservative',
		firmwareFamily: 'unknown',
		supportsContinueList: false,
		uploadChunkBytes: 768,
		minPollingUsbMs: 150,
		minPollingBtTcpMs: 350,
		recommendedTimeoutMs: 3500
	};
}

function looksLikeStockFirmware(capability: CapabilityProbeResult): boolean {
	return (
		capability.osVersion.toLowerCase().includes('linux') &&
		capability.hwVersion.startsWith('V') &&
		capability.fwVersion.startsWith('V')
	);
}

export function buildCapabilityProfile(
	capability: CapabilityProbeResult,
	mode: CompatProfileMode = 'auto'
): CapabilityProfile {
	if (mode === 'stock-strict') {
		return makeStockStrict();
	}

	const parsed = parseFirmwareVersion(capability.fwVersion);
	if (!parsed) {
		return makeCompatConservative();
	}

	if (!looksLikeStockFirmware(capability)) {
		return makeCompatConservative();
	}

	if (parsed.major === 1 && parsed.minor >= 10) {
		return makeStockDefault();
	}

	if (parsed.major === 1 && parsed.minor === 9) {
		return makeStockLegacy();
	}

	return makeCompatConservative();
}
