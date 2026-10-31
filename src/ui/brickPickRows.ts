/**
 * The rows of the "Connect a Brick" picker (step-2 plan, R18): one row per brick, whatever
 * reaches it, in the owner's order (D5), with the brick's name, whether that name is
 * confirmed, and every channel with its state.
 *
 * Free of `vscode`, so the rows can be tested; `connectBrick.ts` keeps them current while the
 * picker is open.
 */

import { BrickEntry, BrickId, ChannelState, Transport } from '../contracts';
import { compareBricks } from './brickOrder';

/** A picker row; it has the shape of a QuickPick item. */
export interface BrickPickRow {
	readonly label: string;
	readonly description: string;
	readonly detail: string;
	readonly brickId: BrickId;
}

/** How a channel reads in a list row. The panel (Phase 5) shows the same as coloured icons. */
export function describeChannels(brick: BrickEntry): string {
	return brick.channels.map((channel) => {
		const transport = channel.transport.toUpperCase();
		switch (channel.state) {
		case ChannelState.Connected: return `${transport} connected`;
		case ChannelState.Available: return `${transport} available`;
		// A paired Bluetooth brick that stopped answering is "not heard": it may be off, or
		// out of range; Windows lists it either way.
		default: return channel.transport === Transport.BT ? `${transport} not heard` : `${transport} lost`;
		}
	}).join(' · ');
}

/**
 * The picker's rows for the bricks in the list, in D5 order.
 *
 * A signed-in brick is ticked; a Bluetooth brick nobody has paired is marked new, because
 * picking it pairs it first.
 */
export function brickPickRows(
	bricks: readonly BrickEntry[],
	isSignedIn: (brickId: BrickId) => boolean,
): BrickPickRow[] {
	return [...bricks]
		.sort(compareBricks)
		.map((brick) => ({
			label: `${isSignedIn(brick.brickId) ? '$(check) ' : ''}${brick.name.value}`,
			description: `${brick.name.confirmed ? '' : '(name unconfirmed) '}${describeChannels(brick)}`
				+ `${brick.channels.some((c) => c.transport === Transport.BT) && !brick.paired ? ' · new' : ''}`,
			detail: brick.brickId,
			brickId: brick.brickId,
		}));
}
