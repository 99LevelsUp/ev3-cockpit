/**
 * What forgetting a brick did, part by part (step-3 plan, R10, KTD1).
 *
 * `BrickManager.forget` returns this and shows nothing itself; the command builds the message
 * from it (KTD8), and so will the panel's trash action later (KD5). Every part has its own
 * outcome because a forget runs every part even when one fails: a brick that is half
 * forgotten and says so is better than one whose pairing survived because the brick side
 * timed out (U4).
 *
 * Outcomes carry codes and the raw error text, not sentences: the wording belongs to the
 * message builder.
 */

import type { BrickId, BrickKey, ForgetResidue } from '../contracts';

/**
 * How one removal from a brick's Bluetooth list ended (R9).
 *
 * Only a list read back afterwards proves anything: the firmware's handler sets no status
 * (`c_com.c` 5567–5606), so its reply says only that the brick answered.
 */
export type PeerRemoval =
	/** The list read back afterwards no longer holds the entry. */
	| { readonly status: 'confirmed'; readonly name: string; readonly over: BrickKey }
	/**
	 * Sent, and nothing shows whether it took: the removal cut the Bluetooth link it went
	 * over before any reply (`c_bt.c` 3609–3612), the reply timed out, or the list could not
	 * be read back. `detail` is the error that ended it.
	 */
	| { readonly status: 'sent'; readonly name: string; readonly over: BrickKey; readonly detail: string }
	/**
	 * The list read back still holds the entry — the firmware runs a removal only while its
	 * Bluetooth is on and idle (`c_bt.c` 3594–3656) — or the brick rejected the command.
	 */
	| { readonly status: 'failed'; readonly name: string; readonly over: BrickKey; readonly detail: string };

/** Why nothing was removed from the brick's list (R8). */
export type BrickSideSkip =
	/** This computer's Bluetooth name is unknown, and it is the only key to its entry (KTD3). */
	| 'radio-name-unknown'
	/** No channel to the brick was connected, and none could be opened. */
	| 'not-reachable'
	/** The brick's list could not be read. */
	| 'list-unreadable'
	/** The list holds no entry named exactly as this computer; the report's `peers` has the names. */
	| 'no-match'
	/** Something failed that none of the above covers; `detail` has the error. The other parts still ran. */
	| 'error';

export type BrickSideOutcome =
	| PeerRemoval
	| { readonly status: 'skipped'; readonly reason: BrickSideSkip; readonly detail?: string };

/**
 * One channel's operating-system pairing (R5). Only channels whose provider can forget get one,
 * so a brick known over USB alone has none.
 */
export type PairingOutcome =
	/** Removed, or already gone, which counts as removed. */
	| { readonly status: 'removed'; readonly channel: BrickKey }
	/** The provider refused; `reason` carries the operating system's own words. */
	| { readonly status: 'refused'; readonly channel: BrickKey; readonly reason: string };

export type MemoryOutcome =
	| { readonly status: 'cleared' }
	/** A layer failed to forget; the others still did. */
	| { readonly status: 'failed'; readonly detail: string };

export interface ForgetReport {
	readonly brickId: BrickId;
	/** This computer's entry on the brick's own Bluetooth list (R7–R9). */
	readonly brickSide: BrickSideOutcome;
	/**
	 * The names on the brick's Bluetooth list as read before any removal, untrimmed; absent
	 * when the list was not read (R8).
	 */
	readonly peers?: readonly string[];
	/** The pairing of every channel whose provider can forget (R5). */
	readonly pairing: readonly PairingOutcome[];
	/** The cockpit's own memory of the brick: the list, discovery, Bluetooth presence (R4). */
	readonly memory: MemoryOutcome;
	/**
	 * What the providers said they left behind, exactly as they returned it (KTD6, R11): the
	 * brick layer never knows which operating system a record belongs to (R12).
	 */
	readonly residue: readonly ForgetResidue[];
}
