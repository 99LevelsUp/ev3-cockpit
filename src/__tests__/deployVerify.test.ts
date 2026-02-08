import assert from 'node:assert/strict';
import test from 'node:test';
import { computeMd5Hex, verifyUploadedFile, DeployVerifyRemoteFsLike } from '../fs/deployVerify';

class FakeVerifyFs implements DeployVerifyRemoteFsLike {
	public constructor(
		private readonly entries: Array<{ name: string; size: number; md5: string }>,
		private readonly remoteBytes: Uint8Array,
		private readonly truncated = false
	) {}

	public async listDirectory(_remotePath: string): Promise<{
		files: Array<{ name: string; size: number; md5: string }>;
		truncated: boolean;
	}> {
		return {
			files: this.entries,
			truncated: this.truncated
		};
	}

	public async readFile(_remotePath: string): Promise<Uint8Array> {
		return new Uint8Array(this.remoteBytes);
	}
}

test('deployVerify computes md5 hex', () => {
	assert.equal(computeMd5Hex(new Uint8Array([0x61, 0x62, 0x63])), '900150983cd24fb0d6963f7d28e17f72');
});

test('deployVerify validates upload by size from non-truncated listing', async () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const fs = new FakeVerifyFs([{ name: 'demo.rbf', size: 3, md5: 'ignored' }], new Uint8Array([9]));
	await verifyUploadedFile(fs, '/home/root/lms2012/prjs/demo.rbf', bytes, 'size');
});

test('deployVerify fails on size mismatch from listing snapshot', async () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const fs = new FakeVerifyFs([{ name: 'demo.rbf', size: 4, md5: 'ignored' }], new Uint8Array([1, 2, 3, 4]));
	await assert.rejects(
		verifyUploadedFile(fs, '/home/root/lms2012/prjs/demo.rbf', bytes, 'size'),
		/size mismatch/i
	);
});

test('deployVerify validates upload by md5 from non-truncated listing', async () => {
	const bytes = new Uint8Array([5, 6, 7]);
	const fs = new FakeVerifyFs([{ name: 'demo.rbf', size: 3, md5: computeMd5Hex(bytes) }], new Uint8Array([9]));
	await verifyUploadedFile(fs, '/home/root/lms2012/prjs/demo.rbf', bytes, 'md5');
});

test('deployVerify falls back to readFile when listing is truncated', async () => {
	const bytes = new Uint8Array([7, 7, 7, 7]);
	const fs = new FakeVerifyFs([{ name: 'demo.rbf', size: 4, md5: 'stale' }], bytes, true);
	await verifyUploadedFile(fs, '/home/root/lms2012/prjs/demo.rbf', bytes, 'md5');
});

test('deployVerify fails on md5 mismatch after readback fallback', async () => {
	const local = new Uint8Array([1, 1, 1, 1]);
	const remote = new Uint8Array([2, 2, 2, 2]);
	const fs = new FakeVerifyFs([], remote, true);
	await assert.rejects(verifyUploadedFile(fs, '/home/root/lms2012/prjs/demo.rbf', local, 'md5'), /md5 mismatch/i);
});
