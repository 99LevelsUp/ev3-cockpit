/**
 * How bricks read in the log: by name, with one id whatever channel named them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickEntry, BrickId, Transport, makeBrickKey } from '../contracts';
import { brickLabel, channelLabel } from '../runtime/brickLabels';

const CCC = '00165342D9F2' as BrickId;

function names(entries: Record<string, string>) {
	return {
		getBrick: (id: BrickId) => (entries[id]
			? { brickId: id, name: { value: entries[id] } } as unknown as BrickEntry
			: undefined),
	};
}

describe('brick labels', () => {
	it('names the brick and gives its id as the brick shows it', () => {
		assert.equal(brickLabel(names({ [CCC]: 'CCC' }), CCC), 'CCC [00165342D9F2]');
	});

	it('labels the USB and Bluetooth channels of one brick with the same id', () => {
		const known = names({ [CCC]: 'CCC' });
		assert.equal(channelLabel(known, makeBrickKey(Transport.USB, '00165342D9F2')), 'CCC [00165342D9F2] USB');
		assert.equal(channelLabel(known, makeBrickKey(Transport.BT, '00:16:53:42:D9:F2')), 'CCC [00165342D9F2] BT');
	});

	it('falls back to the id while the brick has no name', () => {
		assert.equal(brickLabel(names({}), CCC), '00165342D9F2');
	});
});
