/**
 * A condition reported on every scan is logged once, and again only when it changes.
 *
 * Found on Linux (HOSTC, 11.11.2026): the Bluetooth device cache is Windows-only, discovery asks
 * it every scan, and the log got the same warning every three seconds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { logOnChange, onChangePerKey } from '../runtime/logOnChange';

describe('logOnChange', () => {
	it('logs a repeated message once, a different one again, and the first again after it', () => {
		const lines: string[] = [];
		const warn = logOnChange((message) => lines.push(message));

		warn('cache is Windows-only');
		warn('cache is Windows-only');
		warn('cache is Windows-only');
		warn('access denied');
		warn('cache is Windows-only');

		assert.deepEqual(lines, ['cache is Windows-only', 'access denied', 'cache is Windows-only']);
	});
});

describe('onChangePerKey', () => {
	it('says a channel\'s "not heard" once until it is heard again, each channel on its own (HOSTD, 16.11.2026)', () => {
		const lines: string[] = [];
		const say = onChangePerKey<string, boolean>((key, heard) => lines.push(`${key} ${heard ? 'heard' : 'not heard'}`));

		say('CCC', false);
		say('CCC', false);          // relisted after a Bluetooth restart, missed again: no news
		say('BBB', false);
		say('CCC', true);
		say('CCC', false);

		assert.deepEqual(lines, ['CCC not heard', 'BBB not heard', 'CCC heard', 'CCC not heard']);
	});
});
