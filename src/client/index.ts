/**
 * The cockpit client library: what the VS Code extension, the `ev3` command, MCP servers and
 * add-ons use to work with bricks through the user's native daemon, `ev3-cockpitd`.
 *
 * - It finds this user's daemon or starts a verified copy of it, and proves both sides hold the
 *   user's key.
 * - It keeps the bricks, the settings and the access mode current from the daemon's notifications,
 *   so reading them needs no round trip.
 * - When the daemon goes, it connects again and renews every subscription, each with a fresh
 *   snapshot first. Nothing is handed over between daemons.
 * - Questions for a person go to the handler the caller set; without one it answers `keep`.
 *
 * The contract is the one generated from the JSON Schema in `contract/`; `docs/api-for-consumers.md`
 * describes what an add-on uses.
 */

export * from '../contract/generated';
export { WireErrorCode } from '../contract/errors';
export { ContractError } from './connection';
export { CockpitClient, SUCCESSOR_WAIT_MS } from './nativeClient';
export type { CockpitClientOptions, QuestionContext, QuestionHandler } from './nativeClient';
export { EXIT_ANSWER_MS, NATIVE_READINESS_MS, decideOnDaemon, ensureNativeDaemon } from './nativeDaemon';
export type { LaunchDecision, LaunchingClient, NativeDaemonConnection, NativeDaemonOptions } from './nativeDaemon';
export {
	DAEMON_MANIFEST, DaemonStartError, daemonBinaryName, developmentDaemon, installedNativeLaunch, nativeInstallFile, packagedDaemon,
	recordNativeInstall,
} from './nativeLaunch';
export type { CargoProfile, StartFailure } from './nativeLaunch';
export { nativeChannelFiles, nativeStateRoot } from './locate';
export type { NativeChannelFiles } from './locate';
export type { DaemonIdentity } from './hello';
