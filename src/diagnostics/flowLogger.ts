import type { Logger } from './logger';

/**
 * Metadata attached to flow log entries.
 *
 * @remarks
 * Extends the standard metadata record with an optional `correlationId`
 * for tracing a single operation across multiple log lines.
 */
export interface FlowLogMeta extends Record<string, unknown> {
	/** Optional correlation ID linking related log entries. */
	correlationId?: string;
}

/**
 * Structured logger for multi-step operational flows (connect, deploy, etc.).
 *
 * @remarks
 * Each method emits a log entry prefixed with the flow name (e.g.
 * `"deploy started"`, `"deploy completed"`). This eliminates repetitive
 * string formatting across command handlers.
 */
export interface FlowLogger {
	/** Logs that the flow has started. */
	started(meta?: FlowLogMeta): void;
	/** Logs that the flow completed successfully. */
	completed(meta?: FlowLogMeta): void;
	/** Logs that the flow was cancelled by the user. */
	cancelled(meta?: FlowLogMeta): void;
	/** Logs that the flow failed with an error. */
	failed(error: unknown, meta?: FlowLogMeta): void;
	/** Logs an informational event within the flow. */
	info(event: string, meta?: FlowLogMeta): void;
	/** Logs a warning event within the flow. */
	warn(event: string, meta?: FlowLogMeta): void;
	/** Logs a debug event within the flow. */
	debug(event: string, meta?: FlowLogMeta): void;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function mergeMeta(flow: string, baseMeta: FlowLogMeta | undefined, meta: FlowLogMeta | undefined): FlowLogMeta {
	return {
		flow,
		...(baseMeta ?? {}),
		...(meta ?? {})
	};
}

/**
 * Creates a new {@link FlowLogger} bound to a specific flow name.
 *
 * @param logger - Underlying logger to write to
 * @param flow - Human-readable flow name (e.g. `"deploy"`, `"connect"`)
 * @param baseMeta - Optional metadata merged into every log entry
 * @returns A FlowLogger instance with all methods bound to the flow name
 *
 * @example
 * ```typescript
 * const log = createFlowLogger(logger, 'deploy', { brickId: 'usb-001' });
 * log.started();
 * log.info('uploading file', { path: '/home/robot/app.rbf' });
 * log.completed();
 * ```
 */
export function createFlowLogger(
	logger: Logger,
	flow: string,
	baseMeta?: FlowLogMeta
): FlowLogger {
	return {
		started(meta) {
			logger.info(`${flow} started`, mergeMeta(flow, baseMeta, meta));
		},
		completed(meta) {
			logger.info(`${flow} completed`, mergeMeta(flow, baseMeta, meta));
		},
		cancelled(meta) {
			logger.info(`${flow} cancelled`, mergeMeta(flow, baseMeta, meta));
		},
		failed(error, meta) {
			logger.warn(`${flow} failed`, {
				...mergeMeta(flow, baseMeta, meta),
				error: toErrorMessage(error)
			});
		},
		info(event, meta) {
			logger.info(`${flow} ${event}`, mergeMeta(flow, baseMeta, meta));
		},
		warn(event, meta) {
			logger.warn(`${flow} ${event}`, mergeMeta(flow, baseMeta, meta));
		},
		debug(event, meta) {
			logger.debug(`${flow} ${event}`, mergeMeta(flow, baseMeta, meta));
		}
	};
}

