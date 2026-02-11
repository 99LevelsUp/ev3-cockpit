import * as vscode from 'vscode';
import { LogLevel } from '../diagnostics/logger';
import { RetryPolicy, SchedulerErrorCode } from '../scheduler/types';
import { sanitizeEnum, sanitizeNumber } from './sanitizers';

const RETRYABLE_CODES: readonly SchedulerErrorCode[] = [
	'TIMEOUT',
	'EXECUTION_FAILED',
	'CANCELLED',
	'ORPHAN_RISK'
];

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

export interface SchedulerConfigSnapshot {
	timeoutMs: number;
	logLevel: LogLevel;
	defaultRetryPolicy: RetryPolicy;
}

function sanitizeRetryCodes(value: unknown, fallback: readonly SchedulerErrorCode[]): SchedulerErrorCode[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}

	const filtered = value.filter((entry): entry is SchedulerErrorCode => {
		return typeof entry === 'string' && RETRYABLE_CODES.includes(entry as SchedulerErrorCode);
	});

	if (filtered.length === 0) {
		return [...fallback];
	}

	return filtered;
}

/** Default transport command timeout (ms) when no user configuration is set. */
const DEFAULT_TRANSPORT_TIMEOUT_MS = 2_000;

/** Default maximum backoff delay (ms) for retry jitter ceiling. */
const DEFAULT_MAX_BACKOFF_MS = 500;

export function readSchedulerConfig(): SchedulerConfigSnapshot {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');

	const timeoutMs = sanitizeNumber(cfg.get('transport.timeoutMs'), DEFAULT_TRANSPORT_TIMEOUT_MS, 50);
	const logLevel = sanitizeEnum(cfg.get('logging.level'), LOG_LEVELS, 'info');
	const maxRetries = sanitizeNumber(cfg.get('scheduler.retry.maxRetries'), 0, 0);
	const initialBackoffMs = sanitizeNumber(cfg.get('scheduler.retry.initialBackoffMs'), 25, 0);
	const backoffFactorRaw = cfg.get('scheduler.retry.backoffFactor');
	const backoffFactor =
		typeof backoffFactorRaw === 'number' && !Number.isNaN(backoffFactorRaw)
			? Math.max(1, backoffFactorRaw)
			: 2;
	const maxBackoffMs = sanitizeNumber(cfg.get('scheduler.retry.maxBackoffMs'), DEFAULT_MAX_BACKOFF_MS, initialBackoffMs);
	const retryOn = sanitizeRetryCodes(cfg.get('scheduler.retry.retryOn'), ['TIMEOUT', 'EXECUTION_FAILED']);

	return {
		timeoutMs,
		logLevel,
		defaultRetryPolicy: {
			maxRetries,
			initialBackoffMs,
			backoffFactor,
			maxBackoffMs,
			retryOn
		}
	};
}

