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

/** `CCC [00165342D9F2]`, or the id alone while the brick has no name yet. */
export function brickLabel(names: BrickNames, brickId: BrickId): string {
	const name = names.getBrick(brickId)?.name.value;
	return name && name !== brickId ? `${name} [${brickId}]` : brickId;
}

/** `USB`, `BT`, `TCP` — the transport of a channel key. */
export function transportLabel(key: BrickKey): string {
	return (brickKeyTransport(key) ?? 'unknown').toUpperCase();
}

/** `CCC [00165342D9F2] BT` — one channel of a brick. */
export function channelLabel(names: BrickNames, key: BrickKey): string {
	return `${brickLabel(names, brickIdOf(key))} ${transportLabel(key)}`;
}
