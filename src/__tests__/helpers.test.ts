import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrickRootPath, normalizeRemotePathForReveal, toSafeIdentifier } from '../activation/helpers';

// --- normalizeBrickRootPath ---

test('normalizeBrickRootPath adds leading and trailing slash', () => {
	assert.equal(normalizeBrickRootPath('home/root'), '/home/root/');
});

test('normalizeBrickRootPath preserves existing slashes', () => {
	assert.equal(normalizeBrickRootPath('/home/root/'), '/home/root/');
});

test('normalizeBrickRootPath adds trailing slash only', () => {
	assert.equal(normalizeBrickRootPath('/home/root'), '/home/root/');
});

test('normalizeBrickRootPath adds leading slash only', () => {
	assert.equal(normalizeBrickRootPath('home/root/'), '/home/root/');
});

test('normalizeBrickRootPath trims whitespace', () => {
	assert.equal(normalizeBrickRootPath('  /home/root  '), '/home/root/');
});

test('normalizeBrickRootPath handles bare slash', () => {
	assert.equal(normalizeBrickRootPath('/'), '/');
});

test('normalizeBrickRootPath handles empty string', () => {
	assert.equal(normalizeBrickRootPath(''), '/');
});

// --- normalizeRemotePathForReveal ---

test('normalizeRemotePathForReveal normalizes POSIX path', () => {
	assert.equal(normalizeRemotePathForReveal('/home/root/../root/test'), '/home/root/test');
});

test('normalizeRemotePathForReveal converts backslashes', () => {
	assert.equal(normalizeRemotePathForReveal('\\home\\root\\test'), '/home/root/test');
});

test('normalizeRemotePathForReveal adds leading slash', () => {
	assert.equal(normalizeRemotePathForReveal('home/root'), '/home/root');
});

test('normalizeRemotePathForReveal handles dot path', () => {
	assert.equal(normalizeRemotePathForReveal('.'), '/');
});

test('normalizeRemotePathForReveal handles empty string', () => {
	assert.equal(normalizeRemotePathForReveal(''), '/');
});

test('normalizeRemotePathForReveal collapses duplicate slashes', () => {
	assert.equal(normalizeRemotePathForReveal('/home//root///test'), '/home/root/test');
});

// --- toSafeIdentifier ---

test('toSafeIdentifier converts to lowercase kebab-case', () => {
	assert.equal(toSafeIdentifier('My Brick Name'), 'my-brick-name');
});

test('toSafeIdentifier strips non-alphanumeric characters', () => {
	assert.equal(toSafeIdentifier('EV3@Home!#$'), 'ev3-home');
});

test('toSafeIdentifier removes leading and trailing dashes', () => {
	assert.equal(toSafeIdentifier('---brick---'), 'brick');
});

test('toSafeIdentifier collapses consecutive special characters', () => {
	assert.equal(toSafeIdentifier('a   b___c'), 'a-b-c');
});

test('toSafeIdentifier returns active for empty input', () => {
	assert.equal(toSafeIdentifier(''), 'active');
});

test('toSafeIdentifier returns active for non-alphanumeric only', () => {
	assert.equal(toSafeIdentifier('!@#$%'), 'active');
});

test('toSafeIdentifier handles numeric-only input', () => {
	assert.equal(toSafeIdentifier('12345'), '12345');
});
