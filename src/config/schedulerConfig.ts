import * as vscode from 'vscode';
import { LogLevel } from '../diagnostics/logger';
import { RetryPolicy, SchedulerErrorCode } from '../scheduler/types';

const RETRYABLE_CODES: readonly SchedulerErrorCode[] = [
	'TIMEOUT',
	'EXECUTION_FAILED',
	'CANCELLED',
	'ORPHAN_RISK'
];

export interface SchedulerConfigSnapshot {
	timeoutMs: number;
	logLevel: LogLevel;
	defaultRetryPolicy: RetryPolicy;
}

function sanitizeNumber(value: unknown, fallback: number, min: number): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return fallback;
	}
	return Math.max(min, Math.floor(value));
}

function sanitizeLogLevel(value: unknown): LogLevel {
	if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug' || value === 'trace') {
		return value;
	}
	return 'info';
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

export function readSchedulerConfig(): SchedulerConfigSnapshot {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');

	const timeoutMs = sanitizeNumber(cfg.get('transport.timeoutMs'), 2_000, 50);
	const logLevel = sanitizeLogLevel(cfg.get('logging.level'));
	const maxRetries = sanitizeNumber(cfg.get('scheduler.retry.maxRetries'), 0, 0);
	const initialBackoffMs = sanitizeNumber(cfg.get('scheduler.retry.initialBackoffMs'), 25, 0);
	const backoffFactorRaw = cfg.get('scheduler.retry.backoffFactor');
	const backoffFactor =
		typeof backoffFactorRaw === 'number' && !Number.isNaN(backoffFactorRaw)
			? Math.max(1, backoffFactorRaw)
			: 2;
	const maxBackoffMs = sanitizeNumber(cfg.get('scheduler.retry.maxBackoffMs'), 500, initialBackoffMs);
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

