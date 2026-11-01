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
	/**
	 * The list read back afterwards holds one entry of that name fewer. The firmware removes only
	 * the first entry whose name matches (`c_bt.c` 2215, 3603–3622), so a brick that held the name
	 * twice still holds it once: `remaining` counts those left, and is absent when none is.
	 */
	| { readonly status: 'confirmed'; readonly name: string; readonly over: BrickKey; readonly remaining?: number }
	/**
	 * Sent, and nothing shows whether it took: the removal cut the Bluetooth link it went
	 * over before any reply (`c_bt.c` 3609–3612), the reply timed out, or the list could not
	 * be read back. `detail` is the error that ended it.
	 */
	| { readonly status: 'sent'; readonly name: string; readonly over: BrickKey; readonly detail: string }
	/**
	 * The list read back holds as many entries of that name as before — the firmware runs a
	 * removal only while its Bluetooth is on and idle (`c_bt.c` 3594–3656) — or the brick
	 * rejected the command.
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

// ── Clearing a brick's list ─────────────────────────────────────────

/**
 * How one entry of the brick's list ended when the list was cleared (KTD9, R17), one per entry
 * read, in the list's order. Entries are told apart only by name, so of two entries named alike
 * the first confirmed removal counts for the first of them.
 */
export type ClearedEntry =
	/** The list read back after its removal held one entry of that name fewer. */
	| { readonly status: 'confirmed'; readonly name: string }
	/**
	 * Sent, and nothing shows whether it took: the link it went over was lost — over Bluetooth,
	 * cut by this computer's own entry going (`c_bt.c` 3609–3612) — or the list could not be
	 * read back. `detail` is the error that ended it.
	 */
	| { readonly status: 'sent'; readonly name: string; readonly detail: string }
	/** Still on the brick: the list read back still holds it, the brick rejected it, or it was never sent. */
	| { readonly status: 'failed'; readonly name: string; readonly detail: string }
	/**
	 * Its name is empty or blank, and a removal is addressed only by name; the firmware reads an
	 * empty one as "the first entry with a name" (`c_bt.c` 2205–2211), so none is sent (KTD2).
	 */
	| { readonly status: 'not-removable'; readonly name: string; readonly reason: 'blank-name' };

/** Why nothing was removed from the brick's list. */
export type ClearSkip =
	/** No channel to the brick was connected, and none could be opened. */
	| 'not-reachable'
	/** The brick's list could not be read. */
	| 'list-unreadable'
	/** The list was empty, or held only entries without a name. */
	| 'nothing-to-remove'
	/**
	 * Only Bluetooth reaches the brick, this computer's Bluetooth name is unknown, and the list
	 * does not mark exactly one entry connected: removing this computer's entry cuts the link, so
	 * it has to go last, and nothing tells which entry it is.
	 */
	| 'radio-name-unknown'
	/**
	 * Only Bluetooth reaches the brick, no entry carries this computer's Bluetooth name, and the
	 * list does not mark exactly one entry connected: nothing tells which entry is this computer's,
	 * so a removal of another computer's entry could pass for it and leave the pairing one-sided.
	 */
	| 'link-entry-unknown'
	/**
	 * Only Bluetooth reaches the brick, and the name of this computer's entry (its Bluetooth name,
	 * or the name of the entry marked connected) is held more than once. The brick removes the
	 * first entry a name matches, which may be the one holding the link: the link is cut before
	 * the other copy is sent.
	 */
	| 'duplicate-link-entry';

/** Why this computer's pairing with the brick was left alone (KTD10). */
export type ClearPairingSkip =
	/**
	 * This computer's Bluetooth name is unknown and no entry marked connected stood in for it,
	 * so nothing tells whether its entry was on the brick.
	 */
	| 'radio-name-unknown'
	/**
	 * No entry on the brick carried this computer's exact Bluetooth name. Only a list read over USB
	 * or Wi-Fi ends here: there an entry marked connected may be another computer's link, so it
	 * does not stand in for the name.
	 */
	| 'not-on-brick'
	/** This computer's entry was on the brick and was not removed. */
	| 'not-removed'
	/** This computer's entry went, and Windows did not list the brick as paired. */
	| 'not-paired';

/**
 * What clearing a brick's Bluetooth list did (step-3 plan, KTD9, KTD10, R15–R19): the same
 * family as {@link ForgetReport}, so the message reuses its builders.
 */
export interface ClearListReport {
	readonly brickId: BrickId;
	/** The channel the list was read and changed over; absent when none was reached. */
	readonly over?: BrickKey;
	/** This computer's Bluetooth name, the key to its own entry (KTD3); absent when unknown. */
	readonly thisComputer?: string;
	/** Whether this computer was paired with the brick over Bluetooth when the clear began. */
	readonly paired: boolean;
	/** Set when nothing was removed, with why. */
	readonly skipped?: { readonly reason: ClearSkip; readonly detail?: string };
	/** The names on the brick's list as read before any removal, untrimmed; absent when not read. */
	readonly peers?: readonly string[];
	/** One outcome per entry read, in the list's order. */
	readonly entries: readonly ClearedEntry[];
	/**
	 * The names on the brick's list as last read back after the removals, less the one whose
	 * removal counts as sent; absent when the clear stopped before removing anything.
	 */
	readonly left?: readonly string[];
	/** This computer's pairing with the brick, when its entry went and the brick was paired (KTD10). */
	readonly pairing: readonly PairingOutcome[];
	/** Why the pairing was left alone; absent when it was acted on. */
	readonly pairingLeft?: ClearPairingSkip;
	/** The cockpit's memory of the brick's Bluetooth channel; present only when the pairing was acted on. */
	readonly memory?: MemoryOutcome;
	/** What the provider said it left behind, exactly as it returned it (KTD6). */
	readonly residue: readonly ForgetResidue[];
}
