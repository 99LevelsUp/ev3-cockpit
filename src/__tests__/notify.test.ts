/**
 * Every notification the person sees is written to the log too (owner, U10 hardware session,
 * 09.11.2026): the person watches the brick's display, not the screen, and the log has to say
 * what they were told.
 */

import assert from 'assert/strict';
import { describe, it } from 'node:test';

import { createNotifier } from '../ui/notify';

function fakes() {
	const logged: string[] = [];
	const shown: string[] = [];
	const log = {
		info: (message: string) => { logged.push(`info ${message}`); },
		warn: (message: string) => { logged.push(`warn ${message}`); },
		error: (message: string) => { logged.push(`error ${message}`); },
	};
	const window = {
		showInformationMessage: async (message: string, ...items: string[]) => {
			shown.push(`info ${message}`);
			return items[0];
		},
		showWarningMessage: async (message: string) => { shown.push(`warn ${message}`); return undefined; },
		showErrorMessage: async (message: string) => { shown.push(`error ${message}`); return undefined; },
	};
	return { logged, shown, notify: createNotifier(log, window) };
}

describe('Notifications are logged as they are shown', () => {
	it('logs an information, a warning and an error at their own levels, with the text shown', () => {
		const f = fakes();

		f.notify.info('EVƎ Cockpit: connected to BBB.');
		f.notify.warn('EVƎ Cockpit: the pairing still looks one-sided.');
		f.notify.error('EVƎ Cockpit: BBB did not answer.');

		assert.deepEqual(f.shown, [
			'info EVƎ Cockpit: connected to BBB.',
			'warn EVƎ Cockpit: the pairing still looks one-sided.',
			'error EVƎ Cockpit: BBB did not answer.',
		]);
		assert.deepEqual(f.logged, [
			'info Shown: EVƎ Cockpit: connected to BBB.',
			'warn Shown: EVƎ Cockpit: the pairing still looks one-sided.',
			'error Shown: EVƎ Cockpit: BBB did not answer.',
		]);
	});

	it('logs an information with a button, and passes the choice back', async () => {
		const f = fakes();

		const choice = await f.notify.info('EVƎ Cockpit: forgot BBB.', 'Show details');

		assert.equal(choice, 'Show details');
		assert.deepEqual(f.logged, ['info Shown: EVƎ Cockpit: forgot BBB.']);
	});

	it('logs a progress title when it is shown', () => {
		const f = fakes();

		f.notify.progressShown('EVƎ Cockpit: pairing BBB');

		assert.deepEqual(f.logged, ['info Shown: EVƎ Cockpit: pairing BBB']);
	});
});
