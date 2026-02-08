import assert from 'node:assert/strict';
import test from 'node:test';
import type { RemoteFsService } from '../fs/remoteFsService';
import {
	assertRemoteExecutablePath,
	isRemoteExecutablePath,
	runRemoteExecutable,
	supportedExecutableExtensions
} from '../fs/remoteExecutable';

test('remoteExecutable resolves supported executable extensions', () => {
	assert.deepEqual(supportedExecutableExtensions(), ['.rbf']);
	assert.equal(isRemoteExecutablePath('/home/root/lms2012/prjs/Empty/Empty.rbf'), true);
	assert.equal(isRemoteExecutablePath('/home/root/lms2012/prjs/README.txt'), false);
});

test('remoteExecutable assert returns executable type id', () => {
	const spec = assertRemoteExecutablePath('/home/root/lms2012/prjs/Empty/Empty.rbf');
	assert.equal(spec.typeId, 'rbf');
});

test('remoteExecutable run delegates to the type-specific runner', async () => {
	let calledPath = '';
	const fsService = {
		runBytecodeProgram: async (remotePath: string) => {
			calledPath = remotePath;
		}
	};

	const spec = await runRemoteExecutable(
		fsService as unknown as RemoteFsService,
		'/home/root/lms2012/prjs/Empty/Empty.rbf'
	);

	assert.equal(spec.typeId, 'rbf');
	assert.equal(calledPath, '/home/root/lms2012/prjs/Empty/Empty.rbf');
});

test('remoteExecutable rejects unsupported executable types', async () => {
	await assert.rejects(
		async () =>
			runRemoteExecutable(
				{
					runBytecodeProgram: async () => undefined
				} as unknown as RemoteFsService,
				'/home/root/lms2012/prjs/Empty/Empty.bin'
			),
		/unsupported executable file type/i
	);
});
