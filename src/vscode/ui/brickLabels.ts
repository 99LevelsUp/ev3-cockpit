/**
 * How a brick and its channels read in the log and in messages.
 *
 * By name, because that is how people know their bricks; with the id beside it, because two
 * bricks can share a name and the log is where somebody goes to tell them apart. The id is the
 * brick's, as the daemon gives it, whichever channel the line is about.
 */

import type { ContractBrick, Transport } from '../../contract/generated';

/** What a label needs to look up: the brick list. */
export interface BrickNames {
	brick(brickId: string): ContractBrick | undefined;
}

/** The last name each brick was labelled with, per list: a brick keeps it after the list forgets it. */
const lastNames = new WeakMap<BrickNames, Map<string, string>>();

/**
 * `CCC [001653F00C0C]`, or the id alone while the brick has no name yet.
 *
 * A name once seen stays in the labels: a forgotten brick leaves the list before the lines about
 * its forget are written, and they would otherwise name it by its bare id.
 */
export function brickLabel(names: BrickNames, brickId: string): string {
	let last = lastNames.get(names);
	if (!last) { last = new Map(); lastNames.set(names, last); }
	const current = names.brick(brickId)?.name;
	if (current && current !== brickId) { last.set(brickId, current); }
	const name = last.get(brickId);
	return name ? `${name} [${brickId}]` : brickId;
}

const TRANSPORTS: readonly Transport[] = ['usb', 'bt', 'tcp'];

/** `USB`, `BT`, `TCP`: a transport, or the transport of a channel key such as `bt:00:16:53:…`. */
export function transportLabel(transportOrKey: string): string {
	const transport = transportOrKey.split(':', 1)[0].toLowerCase();
	return (TRANSPORTS as readonly string[]).includes(transport) ? transport.toUpperCase() : 'unknown';
}

/** Channels in the order the cockpit prefers them: USB, then Bluetooth, then TCP. */
export function preferredOrder<C extends { readonly transport: Transport }>(channels: readonly C[]): C[] {
	return [...channels].sort((a, b) => TRANSPORTS.indexOf(a.transport) - TRANSPORTS.indexOf(b.transport));
}
