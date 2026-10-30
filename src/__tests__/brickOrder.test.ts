import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { BrickEntry, BrickId, ChannelState, Transport, makeBrickKey } from '../contracts';
import { compareBricks, orderGroup } from '../ui/brickOrder';

function brick(
	id: string,
	name: string,
	options: { usb?: ChannelState; bt?: ChannelState; paired?: boolean } = {},
): BrickEntry {
	const channels = [];
	if (options.usb) {
		channels.push({ brickKey: makeBrickKey(Transport.USB, id), transport: Transport.USB, priority: 30, state: options.usb, lastSeenAt: 0 });
	}
	if (options.bt) {
		channels.push({ brickKey: makeBrickKey(Transport.BT, id), transport: Transport.BT, priority: 20, state: options.bt, lastSeenAt: 0 });
	}
	return {
		brickId: id as BrickId,
		name: { value: name, source: 'brick', confirmed: true },
		channels,
		paired: options.paired ?? false,
		remembered: false,
		favorite: false,
		lastSeenAt: 0,
	};
}

const sorted = (bricks: BrickEntry[]) => [...bricks].sort(compareBricks).map((b) => b.name.value);

describe('brick list order (D5)', () => {
	it('puts a brick on USB first, even when it is also paired', () => {
		assert.deepEqual(sorted([
			brick('00165300000B', 'AAA', { bt: ChannelState.Available, paired: true }),
			brick('00165300000A', 'ZZZ', { usb: ChannelState.Connected, bt: ChannelState.Available, paired: true }),
		]), ['ZZZ', 'AAA']);
	});

	it('puts a paired brick nobody has heard above an unpaired one in range', () => {
		assert.deepEqual(sorted([
			brick('00165300000C', 'AAA', { bt: ChannelState.Available }),
			brick('00165300000D', 'ZZZ', { bt: ChannelState.Lost, paired: true }),
		]), ['ZZZ', 'AAA']);
	});

	it('keeps two bricks with the same name in the same order every time', () => {
		const a = brick('00165300000E', 'EV3', { bt: ChannelState.Available });
		const b = brick('00165300000F', 'EV3', { bt: ChannelState.Available });
		assert.deepEqual([b, a].sort(compareBricks).map((x) => x.brickId), [a, b].sort(compareBricks).map((x) => x.brickId));
	});

	it('moves a brick whose cable comes out from the USB group to the paired group', () => {
		assert.equal(orderGroup(brick('00165300000A', 'CCC', { usb: ChannelState.Connected, paired: true })), 1);
		assert.equal(orderGroup(brick('00165300000A', 'CCC', { usb: ChannelState.Lost, paired: true })), 2);
	});

	it('orders by name within a group, ignoring case', () => {
		assert.deepEqual(sorted([
			brick('00165300000B', 'bbb', { bt: ChannelState.Available }),
			brick('00165300000A', 'AAA', { bt: ChannelState.Available }),
			brick('00165300000C', 'Ccc', { bt: ChannelState.Available }),
		]), ['AAA', 'bbb', 'Ccc']);
	});
});
