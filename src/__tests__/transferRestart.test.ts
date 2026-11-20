/**
 * An upload whose reply is lost starts again from its first chunk within its budget. The chunk
 * whose reply was lost is never sent again on its own: the brick may have taken it, and its slot
 * is abandoned — owed in the ledger and settled before the upload starts again.
 *
 * Over a fake brick that keeps a slot table and assembles what each slot receives, with packets
 * small enough that a file takes several chunks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickResponse } from '../core/contracts';
import { LinkLostError, TimeoutError } from '../core/errors/CockpitError';
import { FileTransferService } from '../core/fs/fileTransferService';
import { TransferLedger } from '../core/fs/transferLedger';

const PATH = '/home/root/lms2012/prjs/Robot/a.rbf';

/** A brick's slot table; `lose` decides, per command, whether its reply is lost after it ran. */
function fakeBrick() {
	const log: string[] = [];
	const files = new Map<string, Uint8Array>();
	const slots = new Map<number, { path: string; total: number; parts: number[] }>();
	let nextHandle = 1;
	const rules = {
		/** The reply to this command is lost after the brick ran it. */
		lose: (_command: BrickCommand, _index: number): boolean => false,
		/** This command is refused before it leaves: the route is gone. */
		refuse: (_command: BrickCommand): boolean => false,
	};
	const take = (handle: number, chunk: Uint8Array): boolean => {
		const slot = slots.get(handle);
		if (!slot) { throw new Error(`no slot ${handle}`); }
		slot.parts.push(...chunk);
		if (slot.parts.length < slot.total) { return false; }
		files.set(slot.path, Uint8Array.from(slot.parts));
		slots.delete(handle);
		return true;
	};
	const send = async (command: BrickCommand): Promise<BrickResponse> => {
		if (rules.refuse(command)) { throw new LinkLostError('the link is lost; the command was not sent'); }
		const index = log.length;
		let reply: BrickResponse;
		switch (command.kind) {
		case 'fs:beginWrite': {
			const handle = nextHandle++;
			slots.set(handle, { path: command.path, total: command.totalBytes, parts: [] });
			log.push(`begin ${handle}`);
			reply = { kind: 'fs:beginWrite', handle, endOfFile: take(handle, command.chunk) };
			break;
		}
		case 'fs:continueWrite':
			log.push(`chunk ${command.handle}`);
			reply = { kind: 'fs:continueWrite', handle: command.handle, endOfFile: take(command.handle, command.chunk) };
			break;
		case 'fs:closeHandle':
			log.push(`close ${command.handle}`);
			slots.delete(command.handle);
			reply = { kind: 'fs:closeHandle' };
			break;
		case 'fs:delete':
			log.push(`delete ${command.path}`);
			reply = { kind: 'fs:delete', deleted: files.delete(command.path) };
			break;
		default:
			throw new Error(`not expected here: ${command.kind}`);
		}
		if (rules.lose(command, index)) { throw new TimeoutError(`no reply to ${command.kind} within its budget`); }
		return reply;
	};
	return { send, log, files, slots, rules };
}

const content = Uint8Array.from({ length: 200 }, (_, i) => i);

describe('An upload whose reply is lost', () => {
	it('starts again from its first chunk within its budget, and does not send the lost chunk again', async () => {
		const brick = fakeBrick();
		const ledger = new TransferLedger();
		const service = new FileTransferService(brick.send, { maxPacketBytes: 64, ledger });
		let chunks = 0;
		let refused = false;
		// The second chunk's reply is lost, and the link with it: the slot's close that follows is
		// refused before it leaves, so the slot is owed.
		brick.rules.lose = (command) => command.kind === 'fs:continueWrite' && ++chunks === 2;
		brick.rules.refuse = (command) => command.kind === 'fs:closeHandle' && !refused && (refused = true);

		await service.writeFile(PATH, content, { deadline: Date.now() + 2000 });

		assert.deepEqual(brick.files.get(PATH), content, 'the file on the brick is not the file sent');
		const lostAt = brick.log.indexOf('chunk 1', brick.log.indexOf('chunk 1') + 1);
		const next = brick.log.slice(lostAt + 1).find((line) => line.startsWith('chunk') || line.startsWith('begin'));
		assert.equal(next, 'begin 2', `something other than a new start followed the lost chunk: ${brick.log.join(', ')}`);
		assert.ok(brick.log.indexOf('close 1') < brick.log.indexOf('begin 2'), 'the abandoned slot was not released first');
		assert.ok(brick.log.indexOf(`delete ${PATH}`) < brick.log.indexOf('begin 2'), 'the partial file was not deleted first');
		assert.equal(ledger.pending(), 0);
		assert.equal(brick.slots.size, 0, 'a slot is still held on the brick');
	});

	it('fails with the lost reply\'s error when it has no budget, as an upload always has', async () => {
		const brick = fakeBrick();
		const service = new FileTransferService(brick.send, { maxPacketBytes: 64, ledger: new TransferLedger() });
		let chunks = 0;
		brick.rules.lose = (command) => command.kind === 'fs:continueWrite' && ++chunks === 2;

		await assert.rejects(service.writeFile(PATH, content), TimeoutError);
		assert.equal(brick.log.filter((line) => line.startsWith('begin')).length, 1, 'it started again without a budget');
	});
});
