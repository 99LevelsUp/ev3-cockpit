import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRemoteChildPath, buildRemotePathFromLocal, isValidRemoteEntryName } from '../fs/browserActions';

test('browserActions validates remote entry names', () => {
	assert.equal(isValidRemoteEntryName('demo'), true);
	assert.equal(isValidRemoteEntryName(' folder '), true);
	assert.equal(isValidRemoteEntryName(''), false);
	assert.equal(isValidRemoteEntryName('..'), false);
	assert.equal(isValidRemoteEntryName('a/b'), false);
	assert.equal(isValidRemoteEntryName('a\\b'), false);
});

test('browserActions builds remote child paths', () => {
	assert.equal(buildRemoteChildPath('/home/root/lms2012/prjs/', 'Demo'), '/home/root/lms2012/prjs/Demo');
	assert.equal(buildRemoteChildPath('/home/root/lms2012/prjs', 'Demo'), '/home/root/lms2012/prjs/Demo');
});

test('browserActions maps local file path to remote path', () => {
	assert.equal(
		buildRemotePathFromLocal('/home/root/lms2012/prjs/', 'C:\\Users\\me\\Desktop\\program.rbf'),
		'/home/root/lms2012/prjs/program.rbf'
	);
});
