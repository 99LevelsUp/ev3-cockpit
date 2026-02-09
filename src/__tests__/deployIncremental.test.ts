import assert from 'node:assert/strict';
import test from 'node:test';
import { computeMd5Hex } from '../fs/hashUtils';
import { shouldUploadByRemoteSnapshot } from '../fs/deployIncremental';

test('deployIncremental computes deterministic MD5 hex', () => {
	const md5 = computeMd5Hex(new Uint8Array([0x61, 0x62, 0x63]));
	assert.equal(md5, '900150983cd24fb0d6963f7d28e17f72');
});

test('deployIncremental uploads when remote snapshot is missing', () => {
	const result = shouldUploadByRemoteSnapshot(new Uint8Array([0x01, 0x02]), undefined);
	assert.equal(result.upload, true);
});

test('deployIncremental skips upload when size and md5 match', () => {
	const bytes = new Uint8Array([0x10, 0x20, 0x30]);
	const md5 = computeMd5Hex(bytes);
	const result = shouldUploadByRemoteSnapshot(bytes, {
		sizeBytes: bytes.length,
		md5
	});
	assert.equal(result.upload, false);
});

test('deployIncremental uploads when size differs', () => {
	const bytes = new Uint8Array([0x10, 0x20, 0x30]);
	const result = shouldUploadByRemoteSnapshot(bytes, {
		sizeBytes: 99,
		md5: computeMd5Hex(bytes)
	});
	assert.equal(result.upload, true);
});

test('deployIncremental uploads when md5 differs', () => {
	const bytes = new Uint8Array([0x10, 0x20, 0x30]);
	const result = shouldUploadByRemoteSnapshot(bytes, {
		sizeBytes: bytes.length,
		md5: '00000000000000000000000000000000'
	});
	assert.equal(result.upload, true);
});
