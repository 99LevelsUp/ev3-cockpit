import { Lane } from './types';

export type OrphanRiskReason = 'timeout' | 'cancelled';

export interface OrphanRecoveryContext {
	requestId: string;
	lane: Lane;
	reason: OrphanRiskReason;
	error?: unknown;
}

export interface OrphanRecoveryStrategy {
	recover(context: OrphanRecoveryContext): Promise<void>;
}

export class NoopOrphanRecoveryStrategy implements OrphanRecoveryStrategy {
	public async recover(_context: OrphanRecoveryContext): Promise<void> {
		return;
	}
}

