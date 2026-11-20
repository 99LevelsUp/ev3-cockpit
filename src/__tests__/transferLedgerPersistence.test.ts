/** Transfer debts outlive the daemon that recorded them, and the next one pays them first. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import type { BrickCommand, BrickRef, BrickResponse } from '../core/contracts';
import { ledgerFor, setLedgerStore } from '../core/fs/transferLedger';
import { fileLedgerStore } from '../daemon/stateStore';

const BRICK = 'usb:0016530AAAAA' as BrickRef;

describe('transfer debts across daemons', () => {
	it('are kept in the state file and paid before the next transfer of a new daemon', async () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-ledger-')), 'ledger.json');

		// The first daemon's brick layer records a debt and ends.
		const firstOwner = {};
		setLedgerStore(firstOwner, fileLedgerStore(file));
		ledgerFor(firstOwner, BRICK).owe({ kind: 'slot', handle: 7, deletePath: '/home/root/lms2012/prjs/a.rbf' });
		assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[BRICK], [
			{ kind: 'slot', handle: 7, deletePath: '/home/root/lms2012/prjs/a.rbf' },
		]);

		// The next daemon starts, and its first transfer on that brick pays the debt.
		const nextOwner = {};
		setLedgerStore(nextOwner, fileLedgerStore(file));
		const ledger = ledgerFor(nextOwner, BRICK);
		assert.equal(ledger.pending(), 1);
		const sent: BrickCommand[] = [];
		const send = (command: BrickCommand): Promise<BrickResponse> => {
			sent.push(command);
			return Promise.resolve({ kind: command.kind } as unknown as BrickResponse);
		};
		const done = await ledger.begin(send);
		done();
		assert.deepEqual(sent.map((c) => c.kind), ['fs:closeHandle', 'fs:delete']);
		assert.equal(ledger.pending(), 0);
		assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[BRICK], undefined);
	});
});
