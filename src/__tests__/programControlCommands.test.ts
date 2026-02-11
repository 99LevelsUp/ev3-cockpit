import assert from 'node:assert/strict';
import test from 'node:test';
import {
	assertRemoteExecutablePath,
	isRemoteExecutablePath,
	supportedExecutableExtensions
} from '../fs/remoteExecutable';

// --- isRemoteExecutablePath edge cases ---

test('isRemoteExecutablePath accepts case-insensitive .RBF extension', () => {
	assert.equal(isRemoteExecutablePath('/home/root/lms2012/prjs/Test/Main.RBF'), true);
});

test('isRemoteExecutablePath accepts mixed case .Rbf extension', () => {
	assert.equal(isRemoteExecutablePath('/prjs/demo.Rbf'), true);
});

test('isRemoteExecutablePath rejects path without extension', () => {
	assert.equal(isRemoteExecutablePath('/home/root/lms2012/prjs/noext'), false);
});

test('isRemoteExecutablePath rejects directory-like path', () => {
	assert.equal(isRemoteExecutablePath('/home/root/lms2012/prjs/'), false);
});

test('isRemoteExecutablePath rejects hidden file', () => {
	assert.equal(isRemoteExecutablePath('/home/root/.hidden'), false);
});

test('isRemoteExecutablePath rejects .rbf in directory name but wrong extension', () => {
	assert.equal(isRemoteExecutablePath('/home/root/lms2012/prjs/rbf_project/readme.txt'), false);
});

// --- assertRemoteExecutablePath edge cases ---

test('assertRemoteExecutablePath returns spec with correct remotePath', () => {
	const spec = assertRemoteExecutablePath('/prjs/test/main.rbf');
	assert.equal(spec.remotePath, '/prjs/test/main.rbf');
	assert.equal(spec.typeId, 'rbf');
});

test('assertRemoteExecutablePath throws for .bin file', () => {
	assert.throws(
		() => assertRemoteExecutablePath('/prjs/test/firmware.bin'),
		/unsupported executable file type/i
	);
});

test('assertRemoteExecutablePath throws for .py file', () => {
	assert.throws(
		() => assertRemoteExecutablePath('/prjs/test/script.py'),
		/unsupported executable file type/i
	);
});

// --- supportedExecutableExtensions ---

test('supportedExecutableExtensions returns sorted array', () => {
	const extensions = supportedExecutableExtensions();
	const sorted = [...extensions].sort((a, b) => a.localeCompare(b));
	assert.deepEqual(extensions, sorted);
});

test('supportedExecutableExtensions includes .rbf', () => {
	const extensions = supportedExecutableExtensions();
	assert.ok(extensions.includes('.rbf'));
});

test('supportedExecutableExtensions returns no duplicates', () => {
	const extensions = supportedExecutableExtensions();
	const unique = [...new Set(extensions)];
	assert.equal(extensions.length, unique.length);
});
