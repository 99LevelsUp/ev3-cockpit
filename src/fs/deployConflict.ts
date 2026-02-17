import { DeployConflictPolicy, DeployConflictDecision } from '../types/enums';

export type DeployConflictBulkDecision = DeployConflictDecision | undefined;
export type DeployConflictPromptChoice = 'Overwrite' | 'Skip' | 'Overwrite All' | 'Skip All' | undefined;

// Re-export for backward compatibility
export { DeployConflictDecision };

export interface ResolveDeployConflictDecisionArgs {
	policy: DeployConflictPolicy;
	bulkDecision?: DeployConflictBulkDecision;
	promptChoice?: DeployConflictPromptChoice;
}

export interface ResolveDeployConflictDecisionResult {
	decision: DeployConflictDecision;
	nextBulkDecision?: DeployConflictBulkDecision;
}

export function resolveDeployConflictDecision(
	args: ResolveDeployConflictDecisionArgs
): ResolveDeployConflictDecisionResult {
	if (args.policy === DeployConflictPolicy.OVERWRITE) {
		return {
			decision: DeployConflictDecision.OVERWRITE,
			nextBulkDecision: args.bulkDecision
		};
	}

	if (args.policy === DeployConflictPolicy.SKIP) {
		return {
			decision: DeployConflictDecision.SKIP,
			nextBulkDecision: args.bulkDecision
		};
	}

	if (args.bulkDecision) {
		return {
			decision: args.bulkDecision,
			nextBulkDecision: args.bulkDecision
		};
	}

	switch (args.promptChoice) {
		case 'Overwrite':
			return { decision: DeployConflictDecision.OVERWRITE };
		case 'Overwrite All':
			return {
				decision: DeployConflictDecision.OVERWRITE,
				nextBulkDecision: DeployConflictDecision.OVERWRITE
			};
		case 'Skip All':
			return {
				decision: DeployConflictDecision.SKIP,
				nextBulkDecision: DeployConflictDecision.SKIP
			};
		case 'Skip':
		default:
			return { decision: DeployConflictDecision.SKIP };
	}
}

