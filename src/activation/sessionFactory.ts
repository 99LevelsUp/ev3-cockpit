import { BrickConnectionProfile } from '../device/brickConnectionProfiles';
import { BrickRuntimeSession } from '../device/brickSessionManager';
import { OutputChannelLogger } from '../diagnostics/logger';
import { Ev3CommandClient } from '../protocol/ev3CommandClient';
import { CommandScheduler } from '../scheduler/commandScheduler';
import { RetryPolicy } from '../scheduler/types';
import { createProbeTransportFromWorkspace } from '../transport/transportFactory';
import { LoggingOrphanRecoveryStrategy } from './helpers';
import { toTransportOverrides } from './runtimeHelpers';

export interface SchedulerRuntimeConfig {
	timeoutMs: number;
	defaultRetryPolicy?: RetryPolicy;
}

export interface BrickSessionFactoryOptions {
	getLogger: () => OutputChannelLogger;
	readSchedulerConfig: () => SchedulerRuntimeConfig;
}

export function createBrickSessionFactory(
	options: BrickSessionFactoryOptions
): (brickId: string, profile?: BrickConnectionProfile) => BrickRuntimeSession<CommandScheduler, Ev3CommandClient> {
	return (brickId, profile) => {
		const logger = options.getLogger();
		const config = options.readSchedulerConfig();
		const scheduler = new CommandScheduler({
			defaultTimeoutMs: config.timeoutMs,
			logger,
			defaultRetryPolicy: config.defaultRetryPolicy,
			orphanRecoveryStrategy: new LoggingOrphanRecoveryStrategy((message, meta) => logger.info(message, meta))
		});
		const overrides = toTransportOverrides(profile);
		const commandClient = new Ev3CommandClient({
			scheduler,
			transport: createProbeTransportFromWorkspace(logger, config.timeoutMs, overrides ? { ...overrides, mockBrickId: brickId } : { mockBrickId: brickId }),
			logger
		});
		return {
			brickId,
			scheduler,
			commandClient
		};
	};
}
