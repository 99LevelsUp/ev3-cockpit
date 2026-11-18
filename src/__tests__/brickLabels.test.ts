/**
 * How bricks read in the log: by name, with one id whatever channel named them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickEntry, BrickId, Transport, makeBrickKey } from '../core/contracts';
import { brickLabel, channelLabel } from '../core/runtime/brickLabels';

const CCC = '001653F00C0C' as BrickId;

function names(entries: Record<string, string>) {
	return {
		getBrick: (id: BrickId) => (entries[id]
			? { brickId: id, name: { value: entries[id] } } as unknown as BrickEntry
			: undefined),
	};
}

describe('brick labels', () => {
	it('names the brick and gives its id as the brick shows it', () => {
		assert.equal(brickLabel(names({ [CCC]: 'CCC' }), CCC), 'CCC [001653F00C0C]');
	});

	it('labels the USB and Bluetooth channels of one brick with the same id', () => {
		const known = names({ [CCC]: 'CCC' });
		assert.equal(channelLabel(known, makeBrickKey(Transport.USB, '001653F00C0C')), 'CCC [001653F00C0C] USB');
		assert.equal(channelLabel(known, makeBrickKey(Transport.BT, '00:16:53:F0:0C:0C')), 'CCC [001653F00C0C] BT');
	});

	it('falls back to the id while the brick has no name', () => {
		assert.equal(brickLabel(names({}), CCC), '001653F00C0C');
	});

	it('keeps a name once seen after the list forgets it (HOSTD: a Bluetooth line after the USB record went)', () => {
		const entries: Record<string, string> = { [CCC]: 'CCC' };
		const list = names(entries);
		assert.equal(brickLabel(list, CCC), 'CCC [001653F00C0C]');
		delete entries[CCC];
		assert.equal(channelLabel(list, makeBrickKey(Transport.BT, '00:16:53:F0:0C:0C')), 'CCC [001653F00C0C] BT');
	});

	it('takes a new name when the brick is renamed', () => {
		const entries: Record<string, string> = { [CCC]: 'CCC' };
		const list = names(entries);
		brickLabel(list, CCC);
		entries[CCC] = 'ROVER';
		assert.equal(brickLabel(list, CCC), 'ROVER [001653F00C0C]');
	});
});
