/** Who holds a brick, and when it is signed out. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HolderSets } from '../daemon/holders';

function sets() {
	const signedOut: string[] = [];
	const holders = new HolderSets({ signOut: (brickId) => { signedOut.push(brickId); } });
	return { holders, signedOut };
}

const windowA = { kind: 'client' as const, clientId: 'a', name: 'VS Code (window A)' };
const windowB = { kind: 'client' as const, clientId: 'b', name: 'VS Code (window B)' };

describe('brick holders', () => {
	it('keeps a brick while either of two clients holds it, and signs it out when the last leaves', async () => {
		const { holders, signedOut } = sets();
		holders.add('CCC', windowA);
		holders.add('CCC', windowB);
		await holders.clientLeft('a');
		assert.deepEqual(signedOut, []);
		assert.deepEqual(holders.holdersOf('CCC'), [{ kind: 'client', client: 'VS Code (window B)' }]);
		await holders.clientLeft('b');
		assert.deepEqual(signedOut, ['CCC']);
		assert.equal(holders.isHeld('CCC'), false);
	});

	it('drops only the caller\'s hold on a disconnect, and says who still holds the brick', async () => {
		const { holders, signedOut } = sets();
		holders.add('CCC', windowA);
		holders.add('CCC', { kind: 'hold' });
		const still = await holders.drop('CCC', windowA);
		assert.deepEqual(still, [{ kind: 'hold' }]);
		assert.deepEqual(signedOut, []);
		assert.equal(holders.holdCount(), 1);
	});

	it('signs a brick out for everyone on request', async () => {
		const { holders, signedOut } = sets();
		holders.add('CCC', windowA);
		holders.add('CCC', { kind: 'hold' });
		await holders.dropAll('CCC');
		assert.deepEqual(signedOut, ['CCC']);
		assert.equal(holders.holdCount(), 0);
	});

	it('counts one hold per brick however many times it is added', () => {
		const { holders } = sets();
		holders.add('CCC', { kind: 'hold' });
		holders.add('CCC', { kind: 'hold' });
		holders.add('BBB', { kind: 'hold' });
		assert.equal(holders.holdCount(), 2);
	});

	it('releases remembered bricks when the long-lived clients are gone', async () => {
		const { holders, signedOut } = sets();
		holders.add('AAA', { kind: 'remembered' });
		holders.add('BBB', { kind: 'remembered' });
		holders.add('BBB', { kind: 'hold' });
		await holders.rememberedReleased();
		assert.deepEqual(signedOut, ['AAA']);
		assert.deepEqual(holders.holdersOf('BBB'), [{ kind: 'hold' }]);
	});

	it('saves and restores its holders as plain data, and a reconnected client takes its holds back', async () => {
		const { holders } = sets();
		holders.add('CCC', windowA);
		holders.add('CCC', { kind: 'hold' });
		const saved = JSON.parse(JSON.stringify(holders.snapshot())) as ReturnType<typeof holders.snapshot>;
		const { holders: successor, signedOut } = sets();
		successor.restore(saved);
		assert.deepEqual(successor.snapshot(), holders.snapshot());
		successor.reclaim('VS Code (window A)', 'a2');
		await successor.clientLeft('a2');
		assert.deepEqual(signedOut, []);
		assert.deepEqual(successor.holdersOf('CCC'), [{ kind: 'hold' }]);
	});
});
