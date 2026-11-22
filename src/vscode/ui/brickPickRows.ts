/**
 * The rows of the "Connect a Brick" picker: one row per brick, whatever reaches it, in the
 * owner's order, with the brick's name, whether that name is confirmed, and every channel with
 * its state.
 *
 * Free of `vscode`, so the rows can be tested; `connectBrick.ts` keeps them current while the
 * picker is open.
 */

import type { ContractBrick } from '../../contract/generated';
import { preferredOrder } from './brickLabels';
import { compareBricks } from './brickOrder';

/** A picker row; it has the shape of a QuickPick item. */
export interface BrickPickRow {
	readonly label: string;
	readonly description: string;
	readonly detail: string;
	readonly brickId: string;
}

/** How a brick's channels read in a list row, USB first. */
export function describeChannels(brick: ContractBrick): string {
	return preferredOrder(brick.channels).map((channel) => {
		const transport = channel.transport.toUpperCase();
		switch (channel.state) {
		case 'connected': return `${transport} connected`;
		case 'available': return `${transport} available`;
		// A paired Bluetooth brick that stopped answering is "not heard": it may be off, or
		// out of range; the operating system lists it either way.
		default: return channel.transport === 'bt' ? `${transport} not heard` : `${transport} lost`;
		}
	}).join(' · ');
}

/** A row with the brick's name, ticked when it is connected, and its channels. */
export function plainPickRow(brick: ContractBrick): BrickPickRow {
	return {
		label: `${brick.connected ? '$(check) ' : ''}${brick.name}`,
		description: `${brick.nameConfirmed ? '' : '(name unconfirmed) '}${describeChannels(brick)}`,
		detail: brick.brickId,
		brickId: brick.brickId,
	};
}

/**
 * The picker's rows for the bricks in the list, in the owner's order.
 *
 * A connected brick is ticked; a Bluetooth brick nobody has paired is marked new, because
 * picking it pairs it first.
 */
export function brickPickRows(bricks: readonly ContractBrick[]): BrickPickRow[] {
	return [...bricks]
		.sort(compareBricks)
		.map((brick) => {
			const row = plainPickRow(brick);
			const isNew = brick.channels.some((c) => c.transport === 'bt') && !brick.paired;
			return isNew ? { ...row, description: `${row.description} · new` } : row;
		});
}
