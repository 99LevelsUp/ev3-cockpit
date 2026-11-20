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
import { ChannelChangedError, LinkLostError, NotConnectedError, ProtocolError } from '../errors/CockpitError';
import { FILE_HANDLE_SLOTS } from '../protocol/ev3Commands';

type SendCommand = (command: BrickCommand) => Promise<BrickResponse>;

/**
 * One thing owed: a slot to close (and a file to delete), a file only, or a slot never learned.
 *
 * A slot is `uncertain` when the brick may already have freed it: the link went with the reply to
 * a command that frees it, the last chunk or a close. The firmware hands a freed number to the next
 * transfer, another computer's too, so such a slot is closed only when the user agrees (owner
 * decision 17.11.2026, IMPLEMENTATION_PLAN 4.6.17); every other known slot is closed at once.
 */
export type TransferDebt =
	| { readonly kind: 'slot'; readonly handle: number; readonly deletePath?: string; readonly uncertain?: true }
	| { readonly kind: 'delete'; readonly path: string }
	| { readonly kind: 'unknown'; readonly deletePath?: string };

/**
 * What the user is asked to release: `all`, a sweep of every slot, for a slot never learned; `one`,
 * a slot whose number is known but which the brick may already have handed to someone else.
 */
export type ReleaseScope = 'all' | 'one';

export interface TransferLedgerOptions {
	/** Asks the user whether to release; absent, a slot never learned or uncertain waits. */
	readonly confirmSweep?: (scope: ReleaseScope) => Promise<boolean>;
	/** Told the debts whenever they change, so they can outlive the process. */
	readonly persist?: (debts: readonly TransferDebt[]) => void;
}

/** Where a brick layer's debts are kept between runs: the daemon's state file. */
export interface LedgerStore {
	load(brickKey: BrickRef): readonly TransferDebt[];
	save(brickKey: BrickRef, debts: readonly TransferDebt[]): void;
}

/** A failure the brick itself answered: the command reached it. Anything else may not have. */
function brickAnswered(error: unknown): boolean {
	return error instanceof ProtocolError;
}

/**
 * A failure that does not prove the command stayed on this side: it may have reached the brick and
 * run, with only its reply lost. Four settle it: an answer from the brick, a session's refusal
 * before it left (2.8.14), a pinned channel's refusal before it left (`BrickManager.pin`), and no
 * route to send it over (`BrickManager.send`, once its wait for one is over).
 */
export function mayHaveRun(error: unknown): boolean {
	return !(error instanceof LinkLostError) && !(error instanceof ChannelChangedError)
		&& !(error instanceof NotConnectedError) && !brickAnswered(error);
}

export class TransferLedger {
	private debts: TransferDebt[] = [];
	private active = 0;
	/** Settles when the last begin() let in has been admitted (or refused). */
	private gate: Promise<void> = Promise.resolve();

	constructor(private options: TransferLedgerOptions = {}) {}

	/** Who to ask before a sweep. */
	setConfirmSweep(confirmSweep: ((scope: ReleaseScope) => Promise<boolean>) | undefined): void {
		this.options = { ...this.options, confirmSweep };
	}

	/** How many debts wait. */
	pending(): number {
		return this.debts.length;
	}

	/** What is owed now. */
	snapshot(): readonly TransferDebt[] {
		return [...this.debts];
	}

	/** Takes over debts a previous run left; they are settled before the next transfer. */
	restore(debts: readonly TransferDebt[]): void {
		this.debts = [...debts, ...this.debts];
	}

	owe(debt: TransferDebt): void {
		this.debts.push(debt);
		this.saved();
	}

	private saved(): void {
		this.options.persist?.(this.snapshot());
	}

	/**
	 * Called before a transfer: settles the debts when no other transfer of ours runs, then counts
	 * this one in. Throws, starting nothing, when settling found the link gone. Returns the call that
	 * counts it out again.
	 */
	async begin(send: SendCommand): Promise<() => void> {
		// Admission goes through one gate, and a settlement runs inside it: no transfer is let in
		// while one runs, and each is counted active before the next is admitted, so a settlement
		// starts only with nothing of ours running (review of 6188670, rounds 1 and 2). One
		// settlement per begin at most, so debts that wait for the user do not spin.
		const previous = this.gate;
		let open: () => void = () => { /* set below */ };
		this.gate = new Promise<void>((resolve) => { open = resolve; });
		try {
			await previous;
			if (this.active === 0 && this.debts.length > 0) { await this.settle(send); }
			this.active += 1;
		} finally {
			open();
		}
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

		/** What only the user may release: slots never learned, and slots the brick may have handed on. */
		const asking: TransferDebt[] = [];
		for (const debt of debts) {
			if (linkError !== undefined) { keep(debt); continue; }
			if (debt.kind === 'unknown' || (debt.kind === 'slot' && debt.uncertain)) { asking.push(debt); continue; }
			let closed = debt.kind !== 'slot';
			try {
				if (debt.kind === 'slot') { await close(debt.handle); closed = true; }
				const path = debt.kind === 'slot' ? debt.deletePath : debt.path;
				if (path !== undefined) { await remove(path); }
			} catch (error) {
				linkError = error;
				// A close that may have run freed the slot for someone else: asked about from now on.
				if (!closed) { keep(debt.kind === 'slot' && mayHaveRun(error) ? { ...debt, uncertain: true } : debt); } else {
					const path = debt.kind === 'slot' ? debt.deletePath : debt.kind === 'delete' ? debt.path : undefined;
					if (path !== undefined) { keep({ kind: 'delete', path }); }
				}
			}
		}

		// A slot never learned needs every slot closed, one question for them all; otherwise each
		// uncertain slot is its own question, so a yes releases that slot alone (owner, 17.11.2026).
		const groups: { scope: ReleaseScope; debts: TransferDebt[]; handles: number[] }[] = [];
		if (asking.some((debt) => debt.kind === 'unknown')) {
			groups.push({ scope: 'all', debts: asking, handles: Array.from({ length: FILE_HANDLE_SLOTS }, (_, i) => i) });
		} else {
			for (const debt of asking) {
				if (debt.kind !== 'slot') { continue; }
				const group = groups.find((g) => g.handles[0] === debt.handle);
				if (group) { group.debts.push(debt); } else { groups.push({ scope: 'one', debts: [debt], handles: [debt.handle] }); }
			}
		}
		for (const group of groups) {
			let agreed: boolean | undefined;
			if (linkError === undefined && this.options.confirmSweep) {
				try {
					agreed = await this.options.confirmSweep(group.scope);
				} catch {
					// Not an answer: the question failed. Kept, to be asked again (review of 6188670).
					agreed = undefined;
				}
			}
			if (agreed === undefined) {
				kept.push(...group.debts);
			} else if (agreed) {
				try {
					for (const handle of group.handles) { await close(handle); }
					for (const debt of group.debts) {
						if (debt.kind !== 'delete' && debt.deletePath !== undefined) { await remove(debt.deletePath); }
					}
				} catch (error) {
					linkError = error;
					kept.push(...group.debts);
				}
			}
			// Declined: dropped, and not offered again; a reboot frees the slot too.
		}

		this.debts = [...kept, ...this.debts];
		this.saved();
		if (linkError !== undefined) { throw linkError; }
	}

	/**
	 * A write to `path` completed: no debt may delete what is now a whole file. A debt to delete
	 * the path goes, and a slot owed keeps its slot but no longer deletes (review of 6188670).
	 */
	written(path: string): void {
		this.debts = this.debts.flatMap((debt): TransferDebt[] => {
			if (debt.kind === 'delete') { return debt.path === path ? [] : [debt]; }
			if (debt.deletePath !== path) { return [debt]; }
			if (debt.kind === 'unknown') { return [{ kind: 'unknown' }]; }
			return [debt.uncertain ? { kind: 'slot', handle: debt.handle, uncertain: true } : { kind: 'slot', handle: debt.handle }];
		});
		this.saved();
	}
}

/** The ledgers, per brick layer and brick: they outlive the transfer services built per call. */
const ledgers = new WeakMap<object, Map<BrickRef, TransferLedger>>();
const confirmations = new WeakMap<object, (scope: ReleaseScope) => Promise<boolean>>();
const stores = new WeakMap<object, LedgerStore>();

/** The ledger of one brick, for a brick layer (the extension and the API share one). */
export function ledgerFor(owner: object, brickKey: BrickRef): TransferLedger {
	let byBrick = ledgers.get(owner);
	if (!byBrick) { byBrick = new Map(); ledgers.set(owner, byBrick); }
	let ledger = byBrick.get(brickKey);
	if (!ledger) {
		const store = stores.get(owner);
		ledger = new TransferLedger({
			confirmSweep: confirmations.get(owner),
			...(store ? { persist: (debts: readonly TransferDebt[]) => store.save(brickKey, debts) } : {}),
		});
		if (store) { ledger.restore(store.load(brickKey)); }
		byBrick.set(brickKey, ledger);
	}
	return ledger;
}

/**
 * Keeps a brick layer's debts in a store, so a daemon that ends with debts unpaid leaves them to the
 * next one. Set before the first transfer.
 */
export function setLedgerStore(owner: object, store: LedgerStore): void {
	stores.set(owner, store);
}

/** Who to ask before a sweep, for every brick of a brick layer: the extension sets a notification. */
export function setSweepConfirmation(owner: object, confirm: (scope: ReleaseScope) => Promise<boolean>): void {
	confirmations.set(owner, confirm);
	for (const ledger of ledgers.get(owner)?.values() ?? []) { ledger.setConfirmSweep(confirm); }
}
