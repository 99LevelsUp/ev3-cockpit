import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../diagnostics/logger';
import { sanitizeBoolean, sanitizeNumber } from './sanitizers';

const RELATIVE_TELEMETRY_CONFIG_PATH = path.join('config', 'brick-telemetry.json');

const DEFAULT_ENABLED = true;
const DEFAULT_FAST_DEVICE_MS = 500;
const DEFAULT_FAST_VALUES_MS = 500;
const DEFAULT_MEDIUM_MS = 2_000;
const DEFAULT_SLOW_MS = 15_000;
const DEFAULT_EXTRA_SLOW_MS = 60_000;
const DEFAULT_STATIC_MS = 0;
const MIN_FAST_DEVICE_MS = 150;
const MIN_FAST_VALUES_MS = 150;
const MIN_MEDIUM_MS = 500;
const MIN_SLOW_MS = 2_000;
const MIN_EXTRA_SLOW_MS = 5_000;
const MIN_STATIC_MS = 0;

const DEFAULT_FS_DEPTH = 1;
const DEFAULT_FS_MAX_ENTRIES = 250;
const DEFAULT_FS_BATCH_SIZE = 25;
const MIN_FS_DEPTH = 0;
const MIN_FS_MAX_ENTRIES = 0;
const MIN_FS_BATCH_SIZE = 1;

const DEFAULT_QUEUE_LIMIT_SLOW = 10;
const DEFAULT_QUEUE_LIMIT_MEDIUM = 20;
const DEFAULT_QUEUE_LIMIT_INACTIVE_FAST = 35;
const MIN_QUEUE_LIMIT = 0;

interface BrickTelemetryConfigJson {
	enabled?: unknown;
	fastDeviceIntervalMs?: unknown;
	fastValuesIntervalMs?: unknown;
	mediumIntervalMs?: unknown;
	slowIntervalMs?: unknown;
	extraSlowIntervalMs?: unknown;
	staticIntervalMs?: unknown;
	fsDepth?: unknown;
	fsMaxEntries?: unknown;
	fsBatchSize?: unknown;
	queueLimitSlow?: unknown;
	queueLimitMedium?: unknown;
	queueLimitInactiveFast?: unknown;
}

export interface BrickTelemetryConfigSnapshot {
	enabled: boolean;
	fastDeviceIntervalMs: number;
	fastValuesIntervalMs: number;
	mediumIntervalMs: number;
	slowIntervalMs: number;
	extraSlowIntervalMs: number;
	staticIntervalMs: number;
	fsDepth: number;
	fsMaxEntries: number;
	fsBatchSize: number;
	queueLimitSlow: number;
	queueLimitMedium: number;
	queueLimitInactiveFast: number;
}

function normalizeTelemetryConfig(raw: BrickTelemetryConfigJson): BrickTelemetryConfigSnapshot {
	return {
		enabled: sanitizeBoolean(raw.enabled, DEFAULT_ENABLED),
		fastDeviceIntervalMs: sanitizeNumber(raw.fastDeviceIntervalMs, DEFAULT_FAST_DEVICE_MS, MIN_FAST_DEVICE_MS),
		fastValuesIntervalMs: sanitizeNumber(raw.fastValuesIntervalMs, DEFAULT_FAST_VALUES_MS, MIN_FAST_VALUES_MS),
		mediumIntervalMs: sanitizeNumber(raw.mediumIntervalMs, DEFAULT_MEDIUM_MS, MIN_MEDIUM_MS),
		slowIntervalMs: sanitizeNumber(raw.slowIntervalMs, DEFAULT_SLOW_MS, MIN_SLOW_MS),
		extraSlowIntervalMs: sanitizeNumber(raw.extraSlowIntervalMs, DEFAULT_EXTRA_SLOW_MS, MIN_EXTRA_SLOW_MS),
		staticIntervalMs: sanitizeNumber(raw.staticIntervalMs, DEFAULT_STATIC_MS, MIN_STATIC_MS),
		fsDepth: sanitizeNumber(raw.fsDepth, DEFAULT_FS_DEPTH, MIN_FS_DEPTH),
		fsMaxEntries: sanitizeNumber(raw.fsMaxEntries, DEFAULT_FS_MAX_ENTRIES, MIN_FS_MAX_ENTRIES),
		fsBatchSize: sanitizeNumber(raw.fsBatchSize, DEFAULT_FS_BATCH_SIZE, MIN_FS_BATCH_SIZE),
		queueLimitSlow: sanitizeNumber(raw.queueLimitSlow, DEFAULT_QUEUE_LIMIT_SLOW, MIN_QUEUE_LIMIT),
		queueLimitMedium: sanitizeNumber(raw.queueLimitMedium, DEFAULT_QUEUE_LIMIT_MEDIUM, MIN_QUEUE_LIMIT),
		queueLimitInactiveFast: sanitizeNumber(raw.queueLimitInactiveFast, DEFAULT_QUEUE_LIMIT_INACTIVE_FAST, MIN_QUEUE_LIMIT)
	};
}

export function readBrickTelemetryConfig(
	extensionRootPath: string,
	logger?: Logger
): BrickTelemetryConfigSnapshot {
	const configPath = path.join(extensionRootPath, RELATIVE_TELEMETRY_CONFIG_PATH);
	try {
		const rawText = fs.readFileSync(configPath, 'utf8');
		const parsed = JSON.parse(rawText) as BrickTelemetryConfigJson;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('JSON root must be an object.');
		}
		return normalizeTelemetryConfig(parsed);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger?.warn('Brick telemetry config fallback to defaults.', {
			configPath,
			reason
		});
		return normalizeTelemetryConfig({});
	}
}
