import type { Lane } from '../scheduler/types';

export type TelemetryTaskKey = 'fastDevices' | 'fastValues' | 'medium' | 'slow' | 'extraSlow' | 'static';

export interface TelemetryTaskRuntimeConfig {
	fastDeviceIntervalMs: number;
	fastValuesIntervalMs: number;
	mediumIntervalMs: number;
	slowIntervalMs: number;
	extraSlowIntervalMs: number;
	staticIntervalMs: number;
	queueLimitSlow: number;
	queueLimitMedium: number;
	queueLimitInactiveFast: number;
}

export interface TelemetryTaskDefinition {
	key: TelemetryTaskKey;
	intervalMs: number;
	errorHandling: 'isolate';
	resolveLane: (isActive: boolean) => Lane;
	shouldSkip: (isActive: boolean, queueSize: number) => boolean;
}

export function createTelemetryTaskDefinitions(
	config: TelemetryTaskRuntimeConfig
): ReadonlyArray<TelemetryTaskDefinition> {
	return [
		{
			key: 'static',
			intervalMs: config.staticIntervalMs,
			errorHandling: 'isolate',
			resolveLane: () => 'low',
			shouldSkip: () => false
		},
		{
			key: 'fastDevices',
			intervalMs: config.fastDeviceIntervalMs,
			errorHandling: 'isolate',
			resolveLane: (isActive) => (isActive ? 'high' : 'normal'),
			shouldSkip: (isActive, queueSize) => !isActive && queueSize >= config.queueLimitInactiveFast
		},
		{
			key: 'fastValues',
			intervalMs: config.fastValuesIntervalMs,
			errorHandling: 'isolate',
			resolveLane: (isActive) => (isActive ? 'high' : 'normal'),
			shouldSkip: (isActive, queueSize) => !isActive && queueSize >= config.queueLimitInactiveFast
		},
		{
			key: 'medium',
			intervalMs: config.mediumIntervalMs,
			errorHandling: 'isolate',
			resolveLane: (isActive) => (isActive ? 'normal' : 'low'),
			shouldSkip: (_isActive, queueSize) => queueSize >= config.queueLimitMedium
		},
		{
			key: 'slow',
			intervalMs: config.slowIntervalMs,
			errorHandling: 'isolate',
			resolveLane: () => 'low',
			shouldSkip: (_isActive, queueSize) => queueSize >= config.queueLimitSlow
		},
		{
			key: 'extraSlow',
			intervalMs: config.extraSlowIntervalMs,
			errorHandling: 'isolate',
			resolveLane: () => 'low',
			shouldSkip: (_isActive, queueSize) => queueSize >= config.queueLimitSlow
		}
	];
}

