/**
 * Common enums used throughout the EV3 Cockpit extension.
 * Provides type safety, autocomplete support, and prevents typos.
 */

/**
 * Transport mode for communicating with EV3 brick.
 */
export enum TransportMode {
	USB = 'usb',
	TCP = 'tcp',
	MOCK = 'mock'
}

/**
 * Filesystem access mode.
 */
export enum FsMode {
	SAFE = 'safe',
	FULL = 'full'
}

/**
 * Deploy conflict resolution policy.
 */
export enum DeployConflictPolicy {
	OVERWRITE = 'overwrite',
	SKIP = 'skip',
	ASK = 'ask'
}

/**
 * Deploy conflict decision (result after resolving policy).
 */
export enum DeployConflictDecision {
	OVERWRITE = 'overwrite',
	SKIP = 'skip'
}

/**
 * Deploy verification mode after upload.
 */
export enum DeployVerifyMode {
	NONE = 'none',
	SIZE = 'size',
	MD5 = 'md5'
}

/**
 * Deploy conflict ask fallback strategy.
 */
export enum DeployConflictAskFallback {
	PROMPT = 'prompt',
	SKIP = 'skip',
	OVERWRITE = 'overwrite'
}

// Helper type for runtime validation
export type TransportModeValue = `${TransportMode}`;
export type FsModeValue = `${FsMode}`;
export type DeployConflictPolicyValue = `${DeployConflictPolicy}`;
export type DeployConflictDecisionValue = `${DeployConflictDecision}`;
export type DeployVerifyModeValue = `${DeployVerifyMode}`;
export type DeployConflictAskFallbackValue = `${DeployConflictAskFallback}`;

/**
 * Type guard to check if a string is a valid TransportMode.
 */
export function isTransportMode(value: unknown): value is TransportMode {
	return typeof value === 'string' && Object.values(TransportMode).includes(value as TransportMode);
}

/**
 * Type guard to check if a string is a valid FsMode.
 */
export function isFsMode(value: unknown): value is FsMode {
	return typeof value === 'string' && Object.values(FsMode).includes(value as FsMode);
}

/**
 * Type guard to check if a string is a valid DeployConflictPolicy.
 */
export function isDeployConflictPolicy(value: unknown): value is DeployConflictPolicy {
	return typeof value === 'string' && Object.values(DeployConflictPolicy).includes(value as DeployConflictPolicy);
}
