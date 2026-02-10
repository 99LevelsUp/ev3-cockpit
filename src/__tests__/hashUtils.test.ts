import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { computeFileMd5Hex, computeMd5Hex } from '../fs/hashUtils';

test('hashUtils computes correct MD5 for ASCII bytes', () => {
	// MD5("abc") = 900150983cd24fb0d6963f7d28e17f72
	assert.equal(computeMd5Hex(new Uint8Array([0x61, 0x62, 0x63])), '900150983cd24fb0d6963f7d28e17f72');
});

test('hashUtils computes correct MD5 for empty input', () => {
	// MD5("") = d41d8cd98f00b204e9800998ecf8427e
	assert.equal(computeMd5Hex(new Uint8Array([])), 'd41d8cd98f00b204e9800998ecf8427e');
});

test('hashUtils computes correct MD5 for single byte', () => {
	// MD5("\x00") = 93b885adfe0da089cdf634904fd59f71
	assert.equal(computeMd5Hex(new Uint8Array([0x00])), '93b885adfe0da089cdf634904fd59f71');
});

test('hashUtils returns lowercase hex string', () => {
	const result = computeMd5Hex(new Uint8Array([0xff]));
	assert.equal(result, result.toLowerCase());
	assert.equal(result.length, 32);
});

test('hashUtils produces different hashes for different inputs', () => {
	const hash1 = computeMd5Hex(new Uint8Array([1, 2, 3]));
	const hash2 = computeMd5Hex(new Uint8Array([3, 2, 1]));
	assert.notEqual(hash1, hash2);
});

test('hashUtils produces consistent results for same input', () => {
	const input = new Uint8Array([10, 20, 30, 40, 50]);
	assert.equal(computeMd5Hex(input), computeMd5Hex(input));
});

test('hashUtils computes MD5 from file stream', async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-hash-'));
	const tempFile = path.join(tempDir, 'sample.bin');
	try {
		await fs.writeFile(tempFile, Buffer.from([0x61, 0x62, 0x63]));
		const md5 = await computeFileMd5Hex(tempFile);
		assert.equal(md5, '900150983cd24fb0d6963f7d28e17f72');
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
