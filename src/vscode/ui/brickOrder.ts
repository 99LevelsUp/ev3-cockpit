/**
 * The order the brick list is shown in (the owner's decision on the list order).
 *
 *  1. Bricks on USB, whatever else they are reachable over: a cable means the brick is on
 *     this desk.
 *  2. Bricks without USB that are paired with this computer: the user's own.
 *  3. Everything else — at a competition, the hundred bricks that belong to other people.
 *
 * Within a group, by name, so the list holds still while someone reads it, with the brick id
 * breaking ties so two bricks both called `EV3` never swap. Ordering group 3 by smoothed
 * signal strength is planned once it is measured.
 *
 * Lives with the views, not in the daemon: what belongs at the top is a question about the
 * person reading the list.
 */

import type { ContractBrick } from '../../contract/generated';

/** Which of the three groups a brick falls in; lower comes first. */
export function orderGroup(brick: ContractBrick): 1 | 2 | 3 {
	if (brick.channels.some((c) => c.transport === 'usb' && (c.state === 'available' || c.state === 'connected'))) { return 1; }
	if (brick.paired) { return 2; }
	return 3;
}

/** Comparator for `Array.prototype.sort`: group, then name, then brick id. */
export function compareBricks(a: ContractBrick, b: ContractBrick): number {
	return orderGroup(a) - orderGroup(b)
		|| a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
		|| (a.brickId < b.brickId ? -1 : a.brickId > b.brickId ? 1 : 0);
}
