import assert from 'assert/strict';
import { describe, it } from 'node:test';

import type { ContractBrick } from '../contract/generated';
import { compareBricks, orderGroup } from '../vscode/ui/brickOrder';
import { contractBrick as brick } from './contractBricks';

const sorted = (bricks: ContractBrick[]) => [...bricks].sort(compareBricks).map((b) => b.name);

describe('brick list order: USB, then paired, then the rest', () => {
	it('puts a brick on USB first, even when it is also paired', () => {
		assert.deepEqual(sorted([
			brick('00165300000B', 'AAA', { bt: 'available', paired: true }),
			brick('00165300000A', 'ZZZ', { usb: 'connected', bt: 'available', paired: true }),
		]), ['ZZZ', 'AAA']);
	});

	it('puts a paired brick nobody has heard above an unpaired one in range', () => {
		assert.deepEqual(sorted([
			brick('00165300000C', 'AAA', { bt: 'available' }),
			brick('00165300000D', 'ZZZ', { bt: 'lost', paired: true }),
		]), ['ZZZ', 'AAA']);
	});

	it('keeps two bricks with the same name in the same order every time', () => {
		const a = brick('00165300000E', 'EV3', { bt: 'available' });
		const b = brick('00165300000F', 'EV3', { bt: 'available' });
		assert.deepEqual([b, a].sort(compareBricks).map((x) => x.brickId), [a, b].sort(compareBricks).map((x) => x.brickId));
	});

	it('moves a brick whose cable comes out from the USB group to the paired group', () => {
		assert.equal(orderGroup(brick('00165300000A', 'CCC', { usb: 'connected', paired: true })), 1);
		assert.equal(orderGroup(brick('00165300000A', 'CCC', { usb: 'lost', paired: true })), 2);
	});

	it('orders by name within a group, ignoring case', () => {
		assert.deepEqual(sorted([
			brick('00165300000B', 'bbb', { bt: 'available' }),
			brick('00165300000A', 'AAA', { bt: 'available' }),
			brick('00165300000C', 'Ccc', { bt: 'available' }),
		]), ['AAA', 'bbb', 'Ccc']);
	});
});
