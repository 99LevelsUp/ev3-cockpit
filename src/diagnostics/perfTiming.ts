import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { Logger } from './logger';

const PERF_ENABLED = process.env.EXT_PERF === '1';

let correlationCounter = 0;

export interface EventLoopMonitorOptions {
	resolutionMs?: number;
	sampleIntervalMs?: number;
	warnThresholdMs?: number;
}

export function isPerfEnabled(): boolean {
	return PERF_ENABLED;
}

export function nextCorrelationId(): string {
	correlationCounter += 1;
	return `perf-${Date.now().toString(36)}-${correlationCounter.toString(36)}`;
}

function normalizeMeta(meta: Record<string, unknown> | undefined, correlationId: string): Record<string, unknown> {
	return {
		correlationId,
		...(meta ?? {})
	};
}

function getCorrelationId(meta: Record<string, unknown> | undefined): string {
	const candidate = meta?.correlationId;
	if (typeof candidate === 'string' && candidate.trim().length > 0) {
		return candidate;
	}
	return nextCorrelationId();
}

export function withTimingSync<T>(
	logger: Logger,
	stepName: string,
	fn: () => T,
	meta?: Record<string, unknown>
): T {
	if (!PERF_ENABLED) {
		return fn();
	}
	const correlationId = getCorrelationId(meta);
	const startedAt = performance.now();
	try {
		const result = fn();
		logger.info(`[perf] ${stepName}`, {
			...normalizeMeta(meta, correlationId),
			durationMs: Number((performance.now() - startedAt).toFixed(1))
		});
		return result;
	} catch (error) {
		logger.warn(`[perf] ${stepName} failed`, {
			...normalizeMeta(meta, correlationId),
			durationMs: Number((performance.now() - startedAt).toFixed(1)),
			error: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
}

export async function withTiming<T>(
	logger: Logger,
	stepName: string,
	fn: () => PromiseLike<T> | T,
	meta?: Record<string, unknown>
): Promise<T> {
	if (!PERF_ENABLED) {
		return await Promise.resolve(fn());
	}
	const correlationId = getCorrelationId(meta);
	const startedAt = performance.now();
	try {
		const result = await Promise.resolve(fn());
		logger.info(`[perf] ${stepName}`, {
			...normalizeMeta(meta, correlationId),
			durationMs: Number((performance.now() - startedAt).toFixed(1))
		});
		return result;
	} catch (error) {
		logger.warn(`[perf] ${stepName} failed`, {
			...normalizeMeta(meta, correlationId),
			durationMs: Number((performance.now() - startedAt).toFixed(1)),
			error: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
}

/** Minimum allowed event-loop sample interval (ms) to avoid excessive overhead. */
const MIN_SAMPLE_INTERVAL_MS = 250;
/** Default event-loop sample interval (ms) between histogram snapshots. */
const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;

export interface EventLoopLagSnapshot {
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
}

export interface EventLoopMonitorHandle {
	/** Stops the event-loop delay monitor and releases resources. */
	stop: () => void;
	/** Returns a point-in-time snapshot of event-loop delay percentiles (ms). */
	snapshot: () => EventLoopLagSnapshot;
}

export function startEventLoopMonitor(logger: Logger, options: EventLoopMonitorOptions = {}): EventLoopMonitorHandle {
	const noopHandle: EventLoopMonitorHandle = {
		stop: () => undefined,
		snapshot: () => ({ p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 })
	};

	if (!PERF_ENABLED) {
		return noopHandle;
	}
	const resolutionMs = Math.max(1, options.resolutionMs ?? 10);
	const sampleIntervalMs = Math.max(MIN_SAMPLE_INTERVAL_MS, options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
	const warnThresholdMs = Math.max(1, options.warnThresholdMs ?? 50);

	const histogram = monitorEventLoopDelay({
		resolution: resolutionMs
	});
	histogram.enable();

	const readSnapshot = (): EventLoopLagSnapshot => ({
		p50Ms: Number((histogram.percentile(50) / 1e6).toFixed(1)),
		p95Ms: Number((histogram.percentile(95) / 1e6).toFixed(1)),
		p99Ms: Number((histogram.percentile(99) / 1e6).toFixed(1)),
		maxMs: Number((histogram.max / 1e6).toFixed(1))
	});

	const timer = setInterval(() => {
		const snap = readSnapshot();
		if (snap.maxMs >= warnThresholdMs) {
			logger.warn('[perf] event-loop-delay', { ...snap });
		}
		histogram.reset();
	}, sampleIntervalMs);
	timer.unref?.();

	return {
		stop: () => {
			clearInterval(timer);
			histogram.disable();
		},
		snapshot: readSnapshot
	};
}
