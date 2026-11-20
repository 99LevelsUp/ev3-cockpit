/**
 * Write leases: one writer per brick at a time, for exactly the length of one request.
 *
 * Reads never take a lease. A second writer is refused with `brick_busy` naming the holder. When a
 * client's connection closes, its requests are aborted and each lease is released only once the
 * aborted request has settled, so a dead client's upload never interleaves with the next writer.
 * Stop and emergency stop never take a lease.
 */

import { ContractError } from '../client/connection';
import { WireErrorCode } from '../contract/errors';

export interface LeaseOwner {
	readonly clientId: string;
	readonly name: string;
}

interface Held {
	readonly owner: LeaseOwner;
	readonly controller: AbortController;
}

export class Leases {
	private readonly held = new Map<string, Held>();

	/** Who holds a brick's lease now. */
	holder(brickId: string): string | undefined {
		return this.held.get(brickId)?.owner.name;
	}

	/** True while any brick's lease is held: the daemon is busy, not idle. */
	busy(): boolean {
		return this.held.size > 0;
	}

	/**
	 * Runs `work` under the brick's lease. Throws `brick_busy` at once when another request holds it.
	 * The signal aborts when the caller cancels or its client goes.
	 */
	async run<T>(brickId: string, owner: LeaseOwner, work: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
		const current = this.held.get(brickId);
		if (current) {
			throw new ContractError(WireErrorCode.BrickBusy,
				`The brick is busy: ${current.owner.name} is writing to it. Try again when it finishes.`,
				{ holder: current.owner.name, kind: 'BrickBusyError' });
		}
		const controller = new AbortController();
		const forward = (): void => controller.abort(callerSignal?.reason);
		if (callerSignal?.aborted) { controller.abort(callerSignal.reason); } else { callerSignal?.addEventListener('abort', forward, { once: true }); }
		const entry: Held = { owner, controller };
		this.held.set(brickId, entry);
		try {
			return await work(controller.signal);
		} finally {
			callerSignal?.removeEventListener('abort', forward);
			if (this.held.get(brickId) === entry) { this.held.delete(brickId); }
		}
	}

	/** A client left: abort what it is doing; its leases end as those requests settle. */
	clientLeft(clientId: string): void {
		for (const entry of this.held.values()) {
			if (entry.owner.clientId === clientId) { entry.controller.abort(new Error('the client left')); }
		}
	}

	/** Status for `ev3 daemon status`. */
	snapshot(): Readonly<Record<string, string>> {
		return Object.fromEntries([...this.held].map(([brickId, entry]) => [brickId, entry.owner.name]));
	}
}
