/**
 * Deploy flow resolution: maps user intent to a concrete deploy pipeline.
 *
 * @packageDocumentation
 */

import { DeployVerifyMode } from '../config/deployConfig';

/**
 * Input parameters for resolving deploy flow settings.
 *
 * @remarks
 * Captures the raw user/config preferences before any mode conflicts
 * are resolved. Passed to {@link resolveDeployFlow} for normalisation.
 */
export interface ResolveDeployFlowInput {
	/** Whether incremental (diff-based) uploads are requested. */
	incrementalEnabled: boolean;
	/** Whether stale-entry cleanup on the brick is requested. */
	cleanupEnabled: boolean;
	/** Whether atomic staging/swap deploy is requested. */
	atomicEnabled: boolean;
	/** When `true`, no files are actually uploaded — only a plan is generated. */
	previewOnly: boolean;
	/** Post-upload verification strategy (e.g. `'size'`, `'md5'`, `'none'`). */
	verifyAfterUpload: DeployVerifyMode;
}

/**
 * Resolved deploy flow parameters with override flags.
 *
 * @remarks
 * Returned by {@link resolveDeployFlow}. When atomic deploy is active (and not
 * preview-only), incremental and cleanup are force-disabled because the atomic
 * swap replaces the entire remote root in one operation. The `atomicDisabled*`
 * flags indicate which modes were overridden so callers can log a diagnostic.
 */
export interface ResolveDeployFlowOutput {
	/** Effective incremental flag after atomic override. */
	incrementalEnabled: boolean;
	/** Effective cleanup flag after atomic override. */
	cleanupEnabled: boolean;
	/** Whether atomic deploy is active. */
	atomicEnabled: boolean;
	/** Post-upload verification strategy (passed through unchanged). */
	verifyAfterUpload: DeployVerifyMode;
	/** `true` when incremental was requested but disabled by atomic deploy. */
	atomicDisabledIncremental: boolean;
	/** `true` when cleanup was requested but disabled by atomic deploy. */
	atomicDisabledCleanup: boolean;
}

/**
 * Resolves the effective deploy flow settings by applying mode-conflict rules.
 *
 * @remarks
 * Atomic deploy performs a full staging → swap → delete cycle, so incremental
 * diff-checks and stale-entry cleanup are meaningless and are force-disabled.
 * Preview mode is excluded from the atomic override because previews never
 * write to the brick and benefit from the incremental/cleanup planning data.
 *
 * @param input - Raw flow preferences from configuration and command options.
 * @returns Resolved flow settings with diagnostic override flags.
 *
 * @example
 * ```ts
 * const flow = resolveDeployFlow({
 *   incrementalEnabled: true,
 *   cleanupEnabled: true,
 *   atomicEnabled: true,
 *   previewOnly: false,
 *   verifyAfterUpload: 'size'
 * });
 * // flow.incrementalEnabled === false  (overridden by atomic)
 * // flow.atomicDisabledIncremental === true
 * ```
 *
 * @see {@link ResolveDeployFlowInput}
 * @see {@link ResolveDeployFlowOutput}
 */
export function resolveDeployFlow(input: ResolveDeployFlowInput): ResolveDeployFlowOutput {
	// Atomic deploy replaces the entire root; incremental/cleanup are redundant.
	// Preview mode is excluded so the planning pipeline can still show diffs.
	const atomicAffectsModes = input.atomicEnabled && !input.previewOnly;
	const incrementalEnabled = atomicAffectsModes ? false : input.incrementalEnabled;
	const cleanupEnabled = atomicAffectsModes ? false : input.cleanupEnabled;

	return {
		incrementalEnabled,
		cleanupEnabled,
		atomicEnabled: input.atomicEnabled,
		verifyAfterUpload: input.verifyAfterUpload,
		// Diagnostic flags: tell callers which modes were force-disabled
		atomicDisabledIncremental: atomicAffectsModes && input.incrementalEnabled,
		atomicDisabledCleanup: atomicAffectsModes && input.cleanupEnabled
	};
}
