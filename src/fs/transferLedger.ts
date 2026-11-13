/**
 * What an interrupted transfer still owes a brick, and paying it (IMPLEMENTATION_PLAN 4.6.17; owner
 * decision 13.11.2026).
 *
 * The firmware keeps every system-command transfer's slot, with its open file, in one global table
 * of 64 (`c_com.h` 1471–1482, 1541) that nothing clears on a disconnect or a timeout. Deleting a
 * file only unlinks it (`c_com.c` 2195–2228), so a download cut short leaves its blocks taken until
 * the brick restarts — measured at 496 KB free where a reboot gave 4600. `CLOSE_FILEHANDLE` closes a
 * slot and its file from any channel, after any reconnect (`c_com.c` 2116–2150).
 *
 * So a transfer that could not release its slot — the link went before it could — leaves a debt
 * here, and the next transfer settles it before it starts: the slot closed, then a partial upload's
 * file deleted. A slot whose number was never learned — the reply to the first command lost — can
 * only be swept, 0..63; a sweep can close another host's live transfer, so it runs only when the
 * user agrees (owner decision), and is not offered again once declined.
 *
 * Nothing is settled while another transfer of ours runs on the brick: its slot is one of those a
 * sweep would close. The ledger lives with the brick, not with a transfer service, which is built
 * afresh per call: {@link ledgerFor}.
 */

import { BrickCommand, BrickRef, BrickResponse } from '../contracts';
import { ProtocolError } from '../errors/CockpitError';
import { FILE_HANDLE_SLOTS } from '../protocol/ev3Commands';

type SendCommand = (command: BrickCommand) => Promise<BrickResponse>;

/** One thing owed: a slot to close (and a file to delete), a file only, or a slot never learned. */
export type TransferDebt =
	| { readonly kind: 'slot'; readonly handle: number; readonly deletePath?: string }
	| { readonly kind: 'delete'; readonly path: string }
	| { readonly kind: 'unknown'; readonly deletePath?: string };

export interface TransferLedgerOptions {
	/** Asks the user whether to sweep the slots; absent, a slot never learned waits. */
	readonly confirmSweep?: () => Promise<boolean>;
}

/** A failure the brick itself answered: the command reached it. Anything else may not have. */
function brickAnswered(error: unknown): boolean {
	return error instanceof ProtocolError;
}

export class TransferLedger {
	private debts: TransferDebt[] = [];
	private active = 0;
	private settling: Promise<void> | undefined;

	constructor(private options: TransferLedgerOptions = {}) {}

	/** Who to ask before a sweep. */
	setConfirmSweep(confirmSweep: (() => Promise<boolean>) | undefined): void {
		this.options = { ...this.options, confirmSweep };
	}

	/** How many debts wait. */
	pending(): number {
		return this.debts.length;
	}

	owe(debt: TransferDebt): void {
		this.debts.push(debt);
	}

	/**
	 * Called before a transfer: settles the debts when no other transfer of ours runs, then counts
	 * this one in. Throws, starting nothing, when settling found the link gone. Returns the call that
	 * counts it out again.
	 */
	async begin(send: SendCommand): Promise<() => void> {
		if (this.active === 0 && this.debts.length > 0) {
			this.settling ??= this.settle(send).finally(() => { this.settling = undefined; });
			await this.settling;
		}
		this.active += 1;
		let ended = false;
		return () => {
			if (!ended) { ended = true; this.active -= 1; }
		};
	}

	/** Pays what it can; stops at the first sign the link is gone and keeps the rest. */
	private async settle(send: SendCommand): Promise<void> {
		const debts = this.debts;
		this.debts = [];
		const kept: TransferDebt[] = [];
		const keep = (debt: TransferDebt): void => { kept.push(debt); };
		let linkError: unknown;

		const close = async (handle: number): Promise<void> => {
			try {
				await send({ kind: 'fs:closeHandle', handle });
			} catch (error) {
				// "Unknown handle" is the brick saying the slot is already free.
				if (!brickAnswered(error)) { throw error; }
			}
		};
		const remove = async (path: string): Promise<void> => {
			try {
				await send({ kind: 'fs:delete', path });
			} catch (error) {
				if (!brickAnswered(error)) { throw error; }
			}
		};

		const unknown: TransferDebt[] = [];
		for (const debt of debts) {
			if (linkError !== undefined) { keep(debt); continue; }
			if (debt.kind === 'unknown') { unknown.push(debt); continue; }
			let closed = debt.kind !== 'slot';
			try {
				if (debt.kind === 'slot') { await close(debt.handle); closed = true; }
				const path = debt.kind === 'slot' ? debt.deletePath : debt.path;
				if (path !== undefined) { await remove(path); }
			} catch (error) {
				linkError = error;
				if (!closed) { keep(debt); } else {
					const path = debt.kind === 'slot' ? debt.deletePath : debt.kind === 'delete' ? debt.path : undefined;
					if (path !== undefined) { keep({ kind: 'delete', path }); }
				}
			}
		}

		if (unknown.length > 0) {
			if (linkError !== undefined || !this.options.confirmSweep) {
				kept.push(...unknown);
			} else if (await this.options.confirmSweep()) {
				try {
					for (let handle = 0; handle < FILE_HANDLE_SLOTS; handle += 1) { await close(handle); }
					for (const debt of unknown) {
						if (debt.kind === 'unknown' && debt.deletePath !== undefined) { await remove(debt.deletePath); }
					}
				} catch (error) {
					linkError = error;
					kept.push(...unknown);
				}
			}
			// Declined: dropped, and not offered again; a reboot frees the slot too.
		}

		this.debts = [...kept, ...this.debts];
		if (linkError !== undefined) { throw linkError; }
	}
}

/** The ledgers, per brick layer and brick: they outlive the transfer services built per call. */
const ledgers = new WeakMap<object, Map<BrickRef, TransferLedger>>();
const confirmations = new WeakMap<object, () => Promise<boolean>>();

/** The ledger of one brick, for a brick layer (the extension and the API share one). */
export function ledgerFor(owner: object, brickKey: BrickRef): TransferLedger {
	let byBrick = ledgers.get(owner);
	if (!byBrick) { byBrick = new Map(); ledgers.set(owner, byBrick); }
	let ledger = byBrick.get(brickKey);
	if (!ledger) {
		ledger = new TransferLedger({ confirmSweep: confirmations.get(owner) });
		byBrick.set(brickKey, ledger);
	}
	return ledger;
}

/** Who to ask before a sweep, for every brick of a brick layer: the extension sets a notification. */
export function setSweepConfirmation(owner: object, confirm: () => Promise<boolean>): void {
	confirmations.set(owner, confirm);
	for (const ledger of ledgers.get(owner)?.values() ?? []) { ledger.setConfirmSweep(confirm); }
}
