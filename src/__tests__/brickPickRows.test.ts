/**
 * The "Connect a Brick" picker's rows (step-2 plan, R18): every brick once, in D5 order, with
 * its name and each channel's state. The QuickPick around them is checked by hand (U10).
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { BrickEntry, BrickId, ChannelState, Transport, makeBrickKey } from '../contracts';
import { brickPickRows } from '../ui/brickPickRows';

function brick(
	id: string,
	name: string,
	options: { usb?: ChannelState; bt?: ChannelState; paired?: boolean; confirmed?: boolean } = {},
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
		name: { value: name, source: options.confirmed === false ? 'usb-descriptor' : 'brick', confirmed: options.confirmed ?? true },
		channels,
		paired: options.paired ?? false,
		remembered: false,
		favorite: false,
		lastSeenAt: 0,
	};
}

const nobodySignedIn = (): boolean => false;

describe('Connect a Brick rows (R18)', () => {
	const ccc = brick('00165342D9F2', 'CCC', { usb: ChannelState.Available, bt: ChannelState.Available, paired: true });
	const aaa = brick('0016535D7E2D', 'AAA', { bt: ChannelState.Lost, paired: true });
	const zed = brick('001653AAAAAA', 'Zed', { bt: ChannelState.Available });

	it('lists each brick once, in D5 order, with its name and id', () => {
		const rows = brickPickRows([zed, aaa, ccc], nobodySignedIn);
		assert.deepEqual(rows.map((row) => [row.label, row.detail]), [
			['CCC', '00165342D9F2'],
			['AAA', '0016535D7E2D'],
			['Zed', '001653AAAAAA'],
		]);
	});

	it('gives every channel of a brick with its state', () => {
		const rows = brickPickRows([zed, aaa, ccc], nobodySignedIn);
		assert.deepEqual(rows.map((row) => row.description), [
			'USB available · BT available',
			'BT not heard',
			'BT available · new',
		]);
	});

	it('says a lost cable is lost and a connected channel is connected', () => {
		const rows = brickPickRows(
			[brick('00165342D9F2', 'CCC', { usb: ChannelState.Lost, bt: ChannelState.Connected, paired: true })],
			nobodySignedIn);
		assert.equal(rows[0].description, 'USB lost · BT connected');
	});

	it('marks a name only the USB descriptor has given', () => {
		const rows = brickPickRows([brick('00165342D9F2', 'EV3', { usb: ChannelState.Available, confirmed: false })], nobodySignedIn);
		assert.equal(rows[0].description, '(name unconfirmed) USB available');
	});

	it('ticks a brick that is signed in', () => {
		const rows = brickPickRows([aaa, ccc], (brickId) => brickId === ccc.brickId);
		assert.deepEqual(rows.map((row) => row.label), ['$(check) CCC', 'AAA']);
	});
});
