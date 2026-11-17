/**
 * How a brick and its channels read in the log.
 *
 * By name, because that is how people know their bricks; with the id beside it, because two
 * bricks can share a name and the log is where somebody goes to tell them apart. The id is the
 * brick's, twelve digits without separators as its own display shows them, whichever channel
 * the line is about: a raw channel key printed the USB serial bare and the Bluetooth address
 * with colons, so one brick looked like two.
 */

import { BrickEntry, BrickId, BrickKey, brickIdOf, brickKeyTransport } from '../contracts';

/** What a label needs to look up: the discovery list. */
export interface BrickNames {
	getBrick(brickId: BrickId): BrickEntry | undefined;
}

/** The last name each brick was labelled with, per list: a brick keeps it after the list forgets it. */
const lastNames = new WeakMap<BrickNames, Map<BrickId, string>>();

/**
 * `CCC [001653F00C0C]`, or the id alone while the brick has no name yet.
 *
 * A name once seen stays in the labels: the Bluetooth channel of a brick whose USB record went
 * first has no name of its own, and its "removed" line came out as the bare id (HOSTD, 16.11.2026).
 */
export function brickLabel(names: BrickNames, brickId: BrickId): string {
	let last = lastNames.get(names);
	if (!last) { last = new Map(); lastNames.set(names, last); }
	const current = names.getBrick(brickId)?.name.value;
	if (current && current !== brickId) { last.set(brickId, current); }
	const name = last.get(brickId);
	return name ? `${name} [${brickId}]` : brickId;
}

/** `USB`, `BT`, `TCP` — the transport of a channel key. */
export function transportLabel(key: BrickKey): string {
	return (brickKeyTransport(key) ?? 'unknown').toUpperCase();
}

/** `CCC [001653F00C0C] BT` — one channel of a brick. */
export function channelLabel(names: BrickNames, key: BrickKey): string {
	return `${brickLabel(names, brickIdOf(key))} ${transportLabel(key)}`;
}
