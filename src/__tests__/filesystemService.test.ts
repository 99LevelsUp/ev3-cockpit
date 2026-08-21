/**
 * These pin the behaviours that hardware caught, not the ones that were obvious.
 *
 * Every assertion here corresponds to something that was wrong when first run against a
 * brick: `exists` answering true unconditionally because its parser was not moved with its
 * builder, `size` reporting kilobytes where the contract said bytes, `files` being zero
 * for a plain file, and `move` needing two commands because the protocol has no rename.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickResponse } from '../contracts';
import { FilesystemService } from '../fs/filesystemService';
import { TransportError } from '../errors/CockpitError';

/** Records commands and answers them from a table. */
function fakeBrick(answers: Partial<Record<string, (c: BrickCommand) => BrickResponse>>) {
	const sent: BrickCommand[] = [];
	const send = (command: BrickCommand): Promise<BrickResponse> => {
		sent.push(command);
		const answer = answers[command.kind];
		if (!answer) {
			return Promise.reject(new TransportError(`no fake answer for ${command.kind}`));
		}
		return Promise.resolve(answer(command));
	};
	return { send, sent, kinds: () => sent.map((c) => c.kind) };
}

describe('FilesystemService — listing', () => {
	it('drops the . and .. entries a brick really returns', async () => {
		// Left in, a caller walking a tree recurses into its own parent forever.
		const brick = fakeBrick({
			'fs:list': () => ({
				kind: 'fs:list',
				complete: true,
				entries: [
					{ name: '.', kind: 'directory' },
					{ name: '..', kind: 'directory' },
					{ name: 'Proj', kind: 'directory' },
					{ name: 'a.rbf', kind: 'file', bytes: 12 },
				],
			}),
		});

		const entries = await new FilesystemService(brick.send).list('/p');

		assert.deepEqual(entries.map((e) => e.name), ['Proj', 'a.rbf']);
	});

	it('follows the continuation until the brick reports completion', async () => {
		let page = 0;
		const brick = fakeBrick({
			'fs:list': () => ({
				kind: 'fs:list',
				complete: false,
				handle: 7,
				entries: [{ name: 'one', kind: 'file' }],
			}),
			'fs:listContinue': () => {
				page += 1;
				return {
					kind: 'fs:listContinue',
					complete: page === 2,
					handle: 7,
					entries: [{ name: `page${page}`, kind: 'file' }],
				};
			},
		});

		const entries = await new FilesystemService(brick.send).list('/p');

		assert.deepEqual(entries.map((e) => e.name), ['one', 'page1', 'page2']);
		assert.equal(brick.kinds().filter((k) => k === 'fs:listContinue').length, 2);
	});

	it('stops when a continuation returns nothing, rather than looping', async () => {
		const brick = fakeBrick({
			'fs:list': () => ({
				kind: 'fs:list', complete: false, handle: 1,
				entries: [{ name: 'one', kind: 'file' }],
			}),
			// A brick that never says complete and never adds anything would spin forever.
			'fs:listContinue': () => ({
				kind: 'fs:listContinue', complete: false, handle: 1, entries: [],
			}),
		});

		const entries = await new FilesystemService(brick.send).list('/p');

		assert.deepEqual(entries.map((e) => e.name), ['one']);
	});
});

describe('FilesystemService — metadata', () => {
	it('reports existence from the reply, not from the call succeeding', async () => {
		// The regression this replaces returned true whenever the command did not throw,
		// so it claimed a file was present in a directory created empty a moment earlier.
		const absent = fakeBrick({ 'fs:exists': () => ({ kind: 'fs:exists', exists: false }) });
		assert.equal(await new FilesystemService(absent.send).exists('/p/x'), false);

		const present = fakeBrick({ 'fs:exists': () => ({ kind: 'fs:exists', exists: true }) });
		assert.equal(await new FilesystemService(present.send).exists('/p/x'), true);
	});

	it('passes through kilobytes and a zero file count for a plain file', async () => {
		// Both surprising, both what the firmware does: the size is rounded up to whole
		// kilobytes, and the file counter only advances while walking a directory.
		const brick = fakeBrick({
			'fs:size': () => ({ kind: 'fs:size', kilobytes: 1, files: 0 }),
		});

		const size = await new FilesystemService(brick.send).size('/p/x');

		assert.deepEqual(size, { kilobytes: 1, files: 0 });
	});
});

describe('FilesystemService — structure', () => {
	it('fails when the brick says the directory does not exist afterwards', async () => {
		const brick = fakeBrick({
			'fs:makeDirectory': () => ({ kind: 'fs:makeDirectory', exists: false }),
		});

		await assert.rejects(
			() => new FilesystemService(brick.send).makeDirectory('/p/d'),
			/did not create/
		);
	});

	it('explains a populated-directory refusal instead of passing NO_PERMISSION on', async () => {
		// The firmware reports ENOTEMPTY as NO_PERMISSION, which sends the reader looking
		// for a permissions problem that is not there.
		const brick = fakeBrick({});
		const send = (): Promise<BrickResponse> =>
			Promise.reject(new TransportError("EV3 system command error for 'fs:delete': NO_PERMISSION"));

		await assert.rejects(
			() => new FilesystemService(send).remove('/p/d'),
			/not empty|removeTree/
		);
		void brick;
	});

	it('renames as a copy followed by a delete, in that order', async () => {
		// The protocol has no rename: opFILE/MOVE runs cp -r and leaves the source.
		const brick = fakeBrick({
			'fs:copy': () => ({ kind: 'fs:copy' }),
			'fs:removeTree': () => ({ kind: 'fs:removeTree' }),
		});

		await new FilesystemService(brick.send).move('/p/a', '/p/b');

		assert.deepEqual(brick.kinds(), ['fs:copy', 'fs:removeTree']);
	});

	it('says both copies exist when the delete half of a rename fails', async () => {
		// Silence here would leave a duplicate the caller does not know about.
		const send = (command: BrickCommand): Promise<BrickResponse> =>
			command.kind === 'fs:copy'
				? Promise.resolve({ kind: 'fs:copy' })
				: Promise.reject(new TransportError('brick refused'));

		await assert.rejects(
			() => new FilesystemService(send).move('/p/a', '/p/b'),
			/both now exist/
		);
	});
});

describe('FilesystemService — path guard', () => {
	it('refuses a path the firmware would truncate, before sending anything', async () => {
		const brick = fakeBrick({});
		const tooLong = `/home/root/lms2012/prjs/${'d'.repeat(40)}`;

		await assert.rejects(
			() => new FilesystemService(brick.send).exists(tooLong),
			/truncates silently/
		);
		assert.equal(brick.sent.length, 0);
	});
});
