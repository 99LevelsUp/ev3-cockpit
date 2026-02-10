import { DeployVerifyMode } from '../config/deployConfig';

export interface ResolveDeployFlowInput {
	incrementalEnabled: boolean;
	cleanupEnabled: boolean;
	atomicEnabled: boolean;
	previewOnly: boolean;
	verifyAfterUpload: DeployVerifyMode;
}

export interface ResolveDeployFlowOutput {
	incrementalEnabled: boolean;
	cleanupEnabled: boolean;
	atomicEnabled: boolean;
	verifyAfterUpload: DeployVerifyMode;
	atomicDisabledIncremental: boolean;
	atomicDisabledCleanup: boolean;
}

export function resolveDeployFlow(input: ResolveDeployFlowInput): ResolveDeployFlowOutput {
	const atomicAffectsModes = input.atomicEnabled && !input.previewOnly;
	const incrementalEnabled = atomicAffectsModes ? false : input.incrementalEnabled;
	const cleanupEnabled = atomicAffectsModes ? false : input.cleanupEnabled;

	return {
		incrementalEnabled,
		cleanupEnabled,
		atomicEnabled: input.atomicEnabled,
		verifyAfterUpload: input.verifyAfterUpload,
		atomicDisabledIncremental: atomicAffectsModes && input.incrementalEnabled,
		atomicDisabledCleanup: atomicAffectsModes && input.cleanupEnabled
	};
}
