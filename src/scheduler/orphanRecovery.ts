import { Lane } from './types';

/**
 * Reason why the scheduler entered orphan-risk state.
 *
 * @remarks
 * When a command times out or is cancelled while a reply may still be
 * in transit, the scheduler cannot safely reuse the message counter.
 * The orphan recovery strategy determines how to handle this state.
 */
export type OrphanRiskReason = 'timeout' | 'cancelled';

/**
 * Context passed to the {@link OrphanRecoveryStrategy} when entering orphan-risk state.
 */
export interface OrphanRecoveryContext {
	/** ID of the request that triggered the orphan risk. */
	requestId: string;
	/** Priority lane the request was assigned to. */
	lane: Lane;
	/** Why the orphan risk was triggered. */
	reason: OrphanRiskReason;
	/** The underlying error that caused the timeout/cancellation, if any. */
	error?: unknown;
}

/**
 * Strategy for recovering from orphan-risk state in the command scheduler.
 *
 * @remarks
 * Implementations may close and reopen the transport, flush pending replies,
 * or simply wait for a cooldown period. The {@link NoopOrphanRecoveryStrategy}
 * does nothing and is used when orphan recovery is disabled.
 *
 * @see {@link CommandScheduler}
 */
export interface OrphanRecoveryStrategy {
	/**
	 * Attempts to recover from orphan-risk state.
	 *
	 * @param context - Details about the orphaned command
	 */
	recover(context: OrphanRecoveryContext): Promise<void>;
}

/**
 * No-op implementation that immediately resolves without any recovery action.
 */
export class NoopOrphanRecoveryStrategy implements OrphanRecoveryStrategy {
	public async recover(_context: OrphanRecoveryContext): Promise<void> {
		return;
	}
}

