/**
 * Bricks as the daemon lists them, for the extension's command tests.
 */

import type { ContractBrick, ContractChannel } from '../contract/generated';

type ChannelState = ContractChannel['state'];

export interface BrickOptions {
	readonly usb?: ChannelState;
	readonly bt?: ChannelState;
	readonly tcp?: ChannelState;
	readonly paired?: boolean;
	readonly confirmed?: boolean;
	/** Connected; by default whenever a channel is. */
	readonly connected?: boolean;
}

/** A brick with the channels given, in the order USB, Bluetooth, TCP. */
export function contractBrick(brickId: string, name: string, options: BrickOptions = {}): ContractBrick {
	const channels: ContractChannel[] = [];
	if (options.usb) { channels.push({ transport: 'usb', state: options.usb }); }
	if (options.bt) { channels.push({ transport: 'bt', state: options.bt }); }
	if (options.tcp) { channels.push({ transport: 'tcp', state: options.tcp }); }
	return {
		brickId,
		name,
		nameConfirmed: options.confirmed ?? true,
		connected: options.connected ?? channels.some((c) => c.state === 'connected'),
		paired: options.paired ?? false,
		channels,
		holders: [],
	};
}

/** A brick list a command reads, over a mutable array. */
export function listOf(bricks: ContractBrick[]) {
	const listeners = new Set<() => void>();
	return {
		bricks: (): readonly ContractBrick[] => bricks,
		brick: (brickId: string): ContractBrick | undefined => bricks.find((b) => b.brickId === brickId),
		onListChanged: (listener: () => void) => {
			listeners.add(listener);
			return { dispose: () => { listeners.delete(listener); } };
		},
		/** Replaces the list and tells the listeners. */
		set(next: ContractBrick[]): void {
			bricks.splice(0, bricks.length, ...next);
			for (const l of [...listeners]) { l(); }
		},
		listening: (): number => listeners.size,
	};
}
