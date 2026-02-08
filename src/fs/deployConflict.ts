import { DeployConflictPolicy } from '../config/deployConfig';

export type DeployConflictDecision = 'overwrite' | 'skip';
export type DeployConflictBulkDecision = DeployConflictDecision | undefined;
export type DeployConflictPromptChoice = 'Overwrite' | 'Skip' | 'Overwrite All' | 'Skip All' | undefined;

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
	if (args.policy === 'overwrite') {
		return {
			decision: 'overwrite',
			nextBulkDecision: args.bulkDecision
		};
	}

	if (args.policy === 'skip') {
		return {
			decision: 'skip',
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
			return { decision: 'overwrite' };
		case 'Overwrite All':
			return {
				decision: 'overwrite',
				nextBulkDecision: 'overwrite'
			};
		case 'Skip All':
			return {
				decision: 'skip',
				nextBulkDecision: 'skip'
			};
		case 'Skip':
		default:
			return { decision: 'skip' };
	}
}

