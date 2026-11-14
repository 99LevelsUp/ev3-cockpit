/**
 * The extension's side of owner decision D4 (step-7 plan, U8 review #11): when BlueZ refuses this
 * user, ask, run the fix on a yes, then offer to check again; show the command where it cannot run.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import type { BluetoothAccessFix, GroupFixResult } from '../transports/bluezAccess';
import { createBluetoothAccessOffer, type BluetoothAccessUi } from '../ui/bluetoothAccess';

const quiet = { info: () => {}, warn: () => {} };

function fixThatEnds(result: GroupFixResult, calls: string[]): BluetoothAccessFix {
	return {
		command: 'sudo usermod -aG bluetooth someone',
		offer: async (confirm) => {
			calls.push('offer');
			const yes = await confirm({ message: 'BlueZ refused this user. Add someone?', command: 'pkexec usermod -aG bluetooth someone' });
			calls.push(`confirm:${yes}`);
			return yes ? result : { kind: 'declined' };
		},
		checkAgain: async () => { calls.push('checkAgain'); },
	};
}

function ui(answers: { confirm: boolean; checkAgain: boolean }, calls: string[]): BluetoothAccessUi {
	return {
		confirm: async (message, command) => { calls.push(`ask:${command}`); return answers.confirm; },
		added: async (message) => { calls.push(`added:${message}`); return answers.checkAgain; },
		manual: async (command, reason) => { calls.push(`manual:${command} (${reason})`); },
	};
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('D4 in the extension: the bluetooth group (U8 review #11)', () => {
	it('asks, runs the fix on a yes, and checks again when the user asks to', async () => {
		const calls: string[] = [];
		const offer = createBluetoothAccessOffer(ui({ confirm: true, checkAgain: true }, calls), quiet);
		offer(fixThatEnds({ kind: 'added', message: 'someone is now in the "bluetooth" group. Log out and in.' }, calls));
		await tick(); await tick(); await tick();
		assert.deepEqual(calls, [
			'offer', 'ask:pkexec usermod -aG bluetooth someone', 'confirm:true',
			'added:someone is now in the "bluetooth" group. Log out and in.', 'checkAgain',
		]);
	});

	it('does not check again when the user dismisses the offer to', async () => {
		const calls: string[] = [];
		const offer = createBluetoothAccessOffer(ui({ confirm: true, checkAgain: false }, calls), quiet);
		offer(fixThatEnds({ kind: 'added', message: 'added' }, calls));
		await tick(); await tick(); await tick();
		assert.ok(!calls.includes('checkAgain'));
	});

	it('shows the command when it cannot run here', async () => {
		const calls: string[] = [];
		const offer = createBluetoothAccessOffer(ui({ confirm: true, checkAgain: false }, calls), quiet);
		offer(fixThatEnds({ kind: 'manual', command: 'sudo usermod -aG bluetooth someone', reason: 'pkexec is not installed' }, calls));
		await tick(); await tick(); await tick();
		assert.equal(calls.at(-1), 'manual:sudo usermod -aG bluetooth someone (pkexec is not installed)');
	});

	it('asks once while an offer is open, and not again after a no until the user checks again', async () => {
		const calls: string[] = [];
		const offer = createBluetoothAccessOffer(ui({ confirm: false, checkAgain: false }, calls), quiet);
		const fix = fixThatEnds({ kind: 'added', message: 'added' }, calls);
		offer(fix); offer(fix);   // the bus refused twice while the first question was open
		await tick(); await tick(); await tick();
		offer(fix);               // refused again later, after the user said no
		await tick(); await tick(); await tick();
		assert.equal(calls.filter((c) => c === 'offer').length, 1, `asked ${JSON.stringify(calls)}`);
	});

	it('never opens a second question while one is open, even when a check ends under it (wiring review)', async () => {
		const calls: string[] = [];
		let releaseSecond = (): void => { /* set below */ };
		let asks = 0;
		const offer = createBluetoothAccessOffer({
			// The first question answers at once; the second stays open until released.
			confirm: () => { asks += 1; return asks === 1 ? Promise.resolve(true) : new Promise((resolve) => { releaseSecond = () => resolve(false); }); },
			added: async () => true,
			manual: async () => { /* not reached */ },
		}, quiet);
		const fix: BluetoothAccessFix = {
			...fixThatEnds({ kind: 'added', message: 'added' }, calls),
			// The refusal comes back during the check, and the check ends while that question is open.
			checkAgain: async () => { offer(fix); await tick(); },
		};
		offer(fix);
		for (let i = 0; i < 8; i += 1) { await tick(); }
		offer(fix);   // refused again while the second question is still open
		for (let i = 0; i < 8; i += 1) { await tick(); }
		assert.equal(asks, 2, 'a third question opened beside the second');
		releaseSecond();
		for (let i = 0; i < 4; i += 1) { await tick(); }
	});

	it('asks again when BlueZ still refuses during the check the user asked for', async () => {
		const calls: string[] = [];
		let rechecks = 0;
		const offer = createBluetoothAccessOffer({
			confirm: async () => true,
			added: async () => rechecks === 0,   // checks again the first time only
			manual: async () => { /* not reached */ },
		}, quiet);
		const fix: BluetoothAccessFix = {
			...fixThatEnds({ kind: 'added', message: 'added' }, calls),
			// As the runtime's: Bluetooth starts over, and the bus refuses again before the check ends.
			checkAgain: async () => { rechecks += 1; offer(fix); await tick(); },
		};
		offer(fix);
		for (let i = 0; i < 8; i += 1) { await tick(); }
		assert.equal(calls.filter((c) => c === 'offer').length, 2, `asked ${JSON.stringify(calls)}`);
		assert.equal(rechecks, 1);
	});
});
