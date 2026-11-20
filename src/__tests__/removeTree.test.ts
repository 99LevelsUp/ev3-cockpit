/**
 * A recursive remove deletes the whole tree on the brick, or says what it left behind.
 *
 * The firmware's own remove is one level deep: it removes a directory's entries and then the
 * directory, so a subdirectory with anything in it stays, and the directory with it. The mock
 * brick removes the same way, so a remove that trusted it would leave a three-level tree here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickResponse, makeBrickKey, Transport } from '../core/contracts';
import { ProtocolError } from '../core/errors/CockpitError';
import { FilesystemService } from '../core/fs/filesystemService';
import { MockTransportProvider } from '../core/mock/mockTransportProvider';

const KEY = makeBrickKey(Transport.Mock, 'M1');
const PRJS = '/home/root/lms2012/prjs';
const TREE = `${PRJS}/Tree`;

async function world() {
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'M1', displayName: 'M1', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
			filesystem: [
				{ path: `${TREE}/a.txt`, content: 'a' },
				{ path: `${TREE}/sub/b.txt`, content: 'b' },
				{ path: `${TREE}/sub/deep/c.txt`, content: 'c' },
				{ path: `${PRJS}/Other/d.txt`, content: 'd' },
				{ path: `${PRJS}/keep.txt`, content: 'keep' },
			],
		}],
	} as never);
	await mock.connect(KEY);
	mock.getFilesystem(KEY)?.makeDirectory(`${TREE}/sub/deep/empty`);
	const sent: BrickCommand[] = [];
	let refuse: ((command: BrickCommand) => boolean) | undefined;
	const send = async (command: BrickCommand): Promise<BrickResponse> => {
		sent.push(command);
		// What the firmware answers a delete it will not do: a system command error.
		if (refuse?.(command)) { throw new ProtocolError(`EV3 system command error for '${command.kind}': NO_PERMISSION`); }
		return mock.executeCommand(KEY, command);
	};
	const fs = new FilesystemService(send);
	return {
		fs, sent, mock,
		refuseWith: (f: typeof refuse) => { refuse = f; },
		exists: (path: string) => mock.getFilesystem(KEY)?.exists(path) ?? false,
		done: () => mock.dispose(),
	};
}

describe('Removing a tree', () => {
	it('deletes a three-level tree with everything in it, and reports nothing left', async () => {
		const w = await world();

		const report = await w.fs.removeTree(TREE);

		assert.deepEqual(report.leftBehind, []);
		for (const path of [TREE, `${TREE}/a.txt`, `${TREE}/sub`, `${TREE}/sub/b.txt`, `${TREE}/sub/deep`, `${TREE}/sub/deep/c.txt`,
			`${TREE}/sub/deep/empty`]) {
			assert.equal(w.exists(path), false, `${path} is still on the brick`);
		}
		assert.ok(w.exists(`${PRJS}/keep.txt`) && w.exists(`${PRJS}/Other/d.txt`), 'it removed beside the tree');
		w.done();
	});

	it('returns the paths it left behind, and removes the rest', async () => {
		const w = await world();
		w.refuseWith((command) => command.kind === 'fs:delete' && command.path === `${TREE}/sub/b.txt`);

		const report = await w.fs.removeTree(TREE);

		assert.deepEqual(report.leftBehind, [`${TREE}/sub/b.txt`]);
		assert.equal(w.exists(`${TREE}/sub/b.txt`), true);
		assert.equal(w.exists(`${TREE}/a.txt`), false);
		assert.equal(w.exists(`${TREE}/sub/deep`), false, 'a branch beside the refused file was left');
		w.done();
	});

	it('removes a list of paths in one operation, each with everything in it when asked', async () => {
		const w = await world();

		const report = await w.fs.removePaths([TREE, `${PRJS}/Other`, `${PRJS}/keep.txt`], { recursive: true });

		assert.deepEqual(report.leftBehind, []);
		assert.equal(w.exists(TREE), false);
		assert.equal(w.exists(`${PRJS}/Other`), false);
		assert.equal(w.exists(`${PRJS}/keep.txt`), false);
		w.done();
	});

	it('leaves a directory with something in it when not asked to remove it whole, and says so', async () => {
		const w = await world();

		const report = await w.fs.removePaths([`${PRJS}/keep.txt`, TREE]);

		assert.deepEqual(report.leftBehind, [TREE]);
		assert.equal(w.exists(`${PRJS}/keep.txt`), false);
		assert.equal(w.exists(`${TREE}/sub/deep/c.txt`), true);
		w.done();
	});
});
