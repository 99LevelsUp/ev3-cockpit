import type { Logger } from './logger';

export interface FlowLogMeta extends Record<string, unknown> {
	correlationId?: string;
}

export interface FlowLogger {
	started(meta?: FlowLogMeta): void;
	completed(meta?: FlowLogMeta): void;
	cancelled(meta?: FlowLogMeta): void;
	failed(error: unknown, meta?: FlowLogMeta): void;
	info(event: string, meta?: FlowLogMeta): void;
	warn(event: string, meta?: FlowLogMeta): void;
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

