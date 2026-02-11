import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrickRootPath, normalizeRemotePathForReveal, toSafeIdentifier } from '../activation/helpers';

// --- normalizeBrickRootPath edge cases ---

test('normalizeBrickRootPath handles double slashes in middle', () => {
	assert.equal(normalizeBrickRootPath('/home//root/'), '/home//root/');
});

test('normalizeBrickRootPath handles whitespace-only input', () => {
	assert.equal(normalizeBrickRootPath('   '), '/');
});

test('normalizeBrickRootPath handles deep nested path', () => {
	assert.equal(normalizeBrickRootPath('home/root/lms2012/prjs/myproject'), '/home/root/lms2012/prjs/myproject/');
});

// --- normalizeRemotePathForReveal edge cases ---

test('normalizeRemotePathForReveal handles multiple parent references', () => {
	assert.equal(normalizeRemotePathForReveal('/a/b/c/../../d'), '/a/d');
});

test('normalizeRemotePathForReveal handles mixed separators', () => {
	assert.equal(normalizeRemotePathForReveal('\\home/root\\test/file.rbf'), '/home/root/test/file.rbf');
});

test('normalizeRemotePathForReveal preserves trailing slash after normalization', () => {
	const result = normalizeRemotePathForReveal('/home/root/');
	assert.equal(result, '/home/root/');
});

test('normalizeRemotePathForReveal handles single segment', () => {
	assert.equal(normalizeRemotePathForReveal('folder'), '/folder');
});

// --- toSafeIdentifier edge cases ---

test('toSafeIdentifier preserves digits with letters', () => {
	assert.equal(toSafeIdentifier('EV3-brick-01'), 'ev3-brick-01');
});

test('toSafeIdentifier handles unicode characters', () => {
	const result = toSafeIdentifier('brick-ěšč');
	assert.equal(typeof result, 'string');
	assert.ok(result.length > 0);
});

test('toSafeIdentifier handles single character', () => {
	assert.equal(toSafeIdentifier('A'), 'a');
});

test('toSafeIdentifier handles spaces between words', () => {
	assert.equal(toSafeIdentifier('my   new   brick'), 'my-new-brick');
});
