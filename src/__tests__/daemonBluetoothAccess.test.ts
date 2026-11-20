/**
 * The daemon asks a person once when BlueZ refuses this user (owner decision D4): one question for a
 * burst of refusals, none with nobody to ask, and a check again only after the person was added and
 * said so.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QuestionAnswer, QuestionKind } from '../contract/models';
import type { BluetoothAccessFix, GroupFixResult } from '../core/transports/bluezAccess';
import { createBluetoothAccessQuestion } from '../daemon/bluetoothAccess';
import { waitFor } from './waitFor';

function fakeFix(result: GroupFixResult) {
	const calls = { offers: 0, checks: 0 };
	const fix: BluetoothAccessFix = {
		command: 'sudo usermod -aG bluetooth someone',
		offer: async (confirm) => {
			calls.offers++;
			return (await confirm({ message: 'Join the bluetooth group?', command: fix.command })) ? result : { kind: 'declined' };
		},
		checkAgain: async () => { calls.checks++; },
	};
	return { fix, calls };
}

function setup(answers: Partial<Record<QuestionKind, QuestionAnswer>>, canAsk = () => true) {
	const asked: QuestionKind[] = [];
	const logged: string[] = [];
	const denied = createBluetoothAccessQuestion({
		canAsk,
		ask: async (q) => { asked.push(q.kind); return answers[q.kind] ?? 'keep'; },
		log: { info: (m) => logged.push(m), warn: (m) => logged.push(m) },
	});
	return { denied, asked, logged };
}

describe('the Bluetooth access question in the daemon', () => {
	it('asks once, adds the person on yes and checks again only when they say so', async () => {
		const { fix, calls } = fakeFix({ kind: 'added', message: 'Added to the bluetooth group.' });
		const { denied, asked } = setup({ bluetoothAccess: 'yes', bluetoothCheckAgain: 'yes' });
		denied(fix);
		denied(fix);
		await waitFor(() => calls.checks === 1, 2000);
		assert.deepEqual(asked, ['bluetoothAccess', 'bluetoothCheckAgain']);
		assert.equal(calls.offers, 1);
	});

	it('does not check again when the person keeps it for later, and does not ask again', async () => {
		const { fix, calls } = fakeFix({ kind: 'added', message: 'Added.' });
		const { denied, asked } = setup({ bluetoothAccess: 'yes' });
		denied(fix);
		await waitFor(() => asked.length === 2, 2000);
		denied(fix);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(calls.checks, 0);
		assert.deepEqual(asked, ['bluetoothAccess', 'bluetoothCheckAgain']);
	});

	it('only logs the fix with nobody to ask, and asks once somebody is there', async () => {
		const { fix, calls } = fakeFix({ kind: 'added', message: 'Added.' });
		let someone = false;
		const { denied, asked, logged } = setup({ bluetoothAccess: 'no' }, () => someone);
		denied(fix);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(calls.offers, 0);
		assert.ok(logged.some((m) => m.includes(fix.command)));
		someone = true;
		denied(fix);
		await waitFor(() => asked.length === 1, 2000);
		assert.equal(calls.checks, 0);
	});
});
