/**
 * The "Connect a Brick" picker's rows: every brick once, in the owner's order, with its name and
 * each channel's state. The picker around them is in `connectBrick.test.ts`.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { brickPickRows } from '../vscode/ui/brickPickRows';
import { contractBrick as brick } from './contractBricks';

describe('Connect a Brick rows', () => {
	const ccc = brick('001653F00C0C', 'CCC', { usb: 'available', bt: 'available', paired: true });
	const aaa = brick('001653F00A0A', 'AAA', { bt: 'lost', paired: true });
	const zed = brick('001653AAAAAA', 'Zed', { bt: 'available' });

	it('lists each brick once, in the owner\'s order, with its name and id', () => {
		const rows = brickPickRows([zed, aaa, ccc]);
		assert.deepEqual(rows.map((row) => [row.label, row.detail]), [
			['CCC', '001653F00C0C'],
			['AAA', '001653F00A0A'],
			['Zed', '001653AAAAAA'],
		]);
	});

	it('gives every channel of a brick with its state', () => {
		const rows = brickPickRows([zed, aaa, ccc]);
		assert.deepEqual(rows.map((row) => row.description), [
			'USB available · BT available',
			'BT not heard',
			'BT available · new',
		]);
	});

	it('says a lost cable is lost and a connected channel is connected', () => {
		const rows = brickPickRows([brick('001653F00C0C', 'CCC', { usb: 'lost', bt: 'connected', paired: true })]);
		assert.equal(rows[0].description, 'USB lost · BT connected');
	});

	it('gives the channels USB first, Bluetooth next and TCP last, whatever order the daemon sent', () => {
		const tcpFirst = { ...brick('001653F00C0C', 'CCC'), channels: [
			{ transport: 'tcp' as const, state: 'available' as const },
			{ transport: 'bt' as const, state: 'available' as const },
			{ transport: 'usb' as const, state: 'available' as const },
		], paired: true };
		assert.equal(brickPickRows([tcpFirst])[0].description, 'USB available · BT available · TCP available');
	});

	it('marks a name the brick itself has not reported', () => {
		const rows = brickPickRows([brick('001653F00C0C', 'EV3', { usb: 'available', confirmed: false })]);
		assert.equal(rows[0].description, '(name unconfirmed) USB available');
	});

	it('ticks a brick that is connected', () => {
		const rows = brickPickRows([aaa, brick('001653F00C0C', 'CCC', { usb: 'connected', paired: true })]);
		assert.deepEqual(rows.map((row) => row.label), ['$(check) CCC', 'AAA']);
	});
});
