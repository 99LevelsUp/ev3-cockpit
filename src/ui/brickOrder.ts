/**
 * The order the brick list is shown in (owner's decision D5, step-1 plan §6).
 *
 *  1. Bricks on USB, whatever else they are reachable over: a cable means the brick is on
 *     this desk.
 *  2. Bricks without USB that are paired with this computer: the user's own.
 *  3. Everything else — at a competition, the hundred bricks that belong to other people.
 *
 * Within a group, by name, so the list holds still while someone reads it, with the brick id
 * breaking ties so two bricks both called `EV3` never swap. Ordering group 3 by smoothed
 * signal strength is planned once it is measured (post-release list, step-1 plan §8).
 *
 * Lives with the views, not in discovery: what belongs at the top is a question about the
 * person reading the list.
 */

import { BrickEntry, ChannelState, Transport } from '../contracts';

const USB_STATES: ReadonlySet<ChannelState> = new Set([ChannelState.Available, ChannelState.Connected]);

/** Which of the three D5 groups a brick falls in; lower comes first. */
export function orderGroup(brick: BrickEntry): 1 | 2 | 3 {
	if (brick.channels.some((c) => c.transport === Transport.USB && USB_STATES.has(c.state))) { return 1; }
	if (brick.paired) { return 2; }
	return 3;
}

/** Comparator for `Array.prototype.sort`: D5 group, then name, then brick id. */
export function compareBricks(a: BrickEntry, b: BrickEntry): number {
	return orderGroup(a) - orderGroup(b)
		|| a.name.value.localeCompare(b.name.value, undefined, { sensitivity: 'base' })
		|| (a.brickId < b.brickId ? -1 : a.brickId > b.brickId ? 1 : 0);
}
