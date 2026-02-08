import assert from 'node:assert/strict';
import test from 'node:test';
import { isLikelyBinaryPath } from '../fs/fileKind';

test('isLikelyBinaryPath detects EV3 binary artifacts', () => {
	assert.equal(isLikelyBinaryPath('/home/root/lms2012/prjs/demo/program.rbf'), true);
	assert.equal(isLikelyBinaryPath('/home/root/lms2012/prjs/demo/icon.rgf'), true);
	assert.equal(isLikelyBinaryPath('/home/root/lms2012/prjs/demo/sound.rsf'), true);
});

test('isLikelyBinaryPath returns false for text-like files', () => {
	assert.equal(isLikelyBinaryPath('/home/root/lms2012/prjs/demo/readme.txt'), false);
	assert.equal(isLikelyBinaryPath('/home/root/lms2012/prjs/demo/config.json'), false);
	assert.equal(isLikelyBinaryPath('/home/root/lms2012/prjs/demo/script.py'), false);
});
