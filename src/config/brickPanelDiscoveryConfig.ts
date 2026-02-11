import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../diagnostics/logger';
import { sanitizeNumber } from './sanitizers';

const DEFAULT_DISCOVERY_REFRESH_FAST_MS = 2_500;
const DEFAULT_DISCOVERY_REFRESH_SLOW_MS = 15_000;
const MIN_DISCOVERY_REFRESH_FAST_MS = 500;
const MIN_DISCOVERY_REFRESH_SLOW_MS = 1_000;
const DEFAULT_CONNECTION_HEALTH_ACTIVE_MS = 500;
const DEFAULT_CONNECTION_HEALTH_IDLE_MS = 2_000;
const DEFAULT_CONNECTION_HEALTH_PROBE_TIMEOUT_MS = 700;
const MIN_CONNECTION_HEALTH_ACTIVE_MS = 150;
const MIN_CONNECTION_HEALTH_IDLE_MS = 500;
const MIN_CONNECTION_HEALTH_PROBE_TIMEOUT_MS = 100;
const RELATIVE_DISCOVERY_CONFIG_PATH = path.join('config', 'brick-panel.scan.json');

interface BrickPanelDiscoveryConfigJson {
	discoveryRefreshFastMs?: unknown;
	discoveryRefreshSlowMs?: unknown;
	connectionHealthActiveMs?: unknown;
	connectionHealthIdleMs?: unknown;
	connectionHealthProbeTimeoutMs?: unknown;
}

export interface BrickPanelDiscoveryConfigSnapshot {
	discoveryRefreshFastMs: number;
	discoveryRefreshSlowMs: number;
	connectionHealthActiveMs: number;
	connectionHealthIdleMs: number;
	connectionHealthProbeTimeoutMs: number;
}

function normalizeDiscoveryConfig(
	raw: BrickPanelDiscoveryConfigJson
): BrickPanelDiscoveryConfigSnapshot {
	const discoveryRefreshFastMs = sanitizeNumber(
		raw.discoveryRefreshFastMs,
		DEFAULT_DISCOVERY_REFRESH_FAST_MS,
		MIN_DISCOVERY_REFRESH_FAST_MS
	);
	const discoveryRefreshSlowMs = sanitizeNumber(
		raw.discoveryRefreshSlowMs,
		DEFAULT_DISCOVERY_REFRESH_SLOW_MS,
		Math.max(MIN_DISCOVERY_REFRESH_SLOW_MS, discoveryRefreshFastMs)
	);
	const connectionHealthActiveMs = sanitizeNumber(
		raw.connectionHealthActiveMs,
		DEFAULT_CONNECTION_HEALTH_ACTIVE_MS,
		MIN_CONNECTION_HEALTH_ACTIVE_MS
	);
	const connectionHealthIdleMs = sanitizeNumber(
		raw.connectionHealthIdleMs,
		DEFAULT_CONNECTION_HEALTH_IDLE_MS,
		Math.max(MIN_CONNECTION_HEALTH_IDLE_MS, connectionHealthActiveMs)
	);
	const connectionHealthProbeTimeoutMs = sanitizeNumber(
		raw.connectionHealthProbeTimeoutMs,
		DEFAULT_CONNECTION_HEALTH_PROBE_TIMEOUT_MS,
		MIN_CONNECTION_HEALTH_PROBE_TIMEOUT_MS
	);
	return {
		discoveryRefreshFastMs,
		discoveryRefreshSlowMs,
		connectionHealthActiveMs,
		connectionHealthIdleMs,
		connectionHealthProbeTimeoutMs
	};
}

export function readBrickPanelDiscoveryConfig(
	extensionRootPath: string,
	logger?: Logger
): BrickPanelDiscoveryConfigSnapshot {
	const configPath = path.join(extensionRootPath, RELATIVE_DISCOVERY_CONFIG_PATH);
	try {
		const rawText = fs.readFileSync(configPath, 'utf8');
		const parsed = JSON.parse(rawText) as BrickPanelDiscoveryConfigJson;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('JSON root must be an object.');
		}
		return normalizeDiscoveryConfig(parsed);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger?.warn('Brick panel discovery config fallback to defaults.', {
			configPath,
			reason
		});
		return {
			discoveryRefreshFastMs: DEFAULT_DISCOVERY_REFRESH_FAST_MS,
			discoveryRefreshSlowMs: DEFAULT_DISCOVERY_REFRESH_SLOW_MS,
			connectionHealthActiveMs: DEFAULT_CONNECTION_HEALTH_ACTIVE_MS,
			connectionHealthIdleMs: DEFAULT_CONNECTION_HEALTH_IDLE_MS,
			connectionHealthProbeTimeoutMs: DEFAULT_CONNECTION_HEALTH_PROBE_TIMEOUT_MS
		};
	}
}
