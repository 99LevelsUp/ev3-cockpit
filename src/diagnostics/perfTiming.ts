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

export function startEventLoopMonitor(logger: Logger, options: EventLoopMonitorOptions = {}): () => void {
	if (!PERF_ENABLED) {
		return () => undefined;
	}
	const resolutionMs = Math.max(1, options.resolutionMs ?? 10);
	const sampleIntervalMs = Math.max(250, options.sampleIntervalMs ?? 10_000);
	const warnThresholdMs = Math.max(1, options.warnThresholdMs ?? 50);

	const histogram = monitorEventLoopDelay({
		resolution: resolutionMs
	});
	histogram.enable();

	const timer = setInterval(() => {
		const maxMs = histogram.max / 1e6;
		if (maxMs >= warnThresholdMs) {
			logger.warn('[perf] event-loop-delay', {
				p50Ms: Number((histogram.percentile(50) / 1e6).toFixed(1)),
				p95Ms: Number((histogram.percentile(95) / 1e6).toFixed(1)),
				p99Ms: Number((histogram.percentile(99) / 1e6).toFixed(1)),
				maxMs: Number(maxMs.toFixed(1))
			});
		}
		histogram.reset();
	}, sampleIntervalMs);
	timer.unref?.();

	return () => {
		clearInterval(timer);
		histogram.disable();
	};
}
