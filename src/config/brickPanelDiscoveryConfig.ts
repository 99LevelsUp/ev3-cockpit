import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../diagnostics/logger';
import { sanitizeNumber } from './sanitizers';

const DEFAULT_DISCOVERY_REFRESH_FAST_MS = 2_500;
const DEFAULT_DISCOVERY_REFRESH_SLOW_MS = 15_000;
const MIN_DISCOVERY_REFRESH_FAST_MS = 500;
const MIN_DISCOVERY_REFRESH_SLOW_MS = 1_000;
const RELATIVE_DISCOVERY_CONFIG_PATH = path.join('config', 'brick-panel.scan.json');

interface BrickPanelDiscoveryConfigJson {
	discoveryRefreshFastMs?: unknown;
	discoveryRefreshSlowMs?: unknown;
}

export interface BrickPanelDiscoveryConfigSnapshot {
	discoveryRefreshFastMs: number;
	discoveryRefreshSlowMs: number;
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
	return {
		discoveryRefreshFastMs,
		discoveryRefreshSlowMs
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
			discoveryRefreshSlowMs: DEFAULT_DISCOVERY_REFRESH_SLOW_MS
		};
	}
}
