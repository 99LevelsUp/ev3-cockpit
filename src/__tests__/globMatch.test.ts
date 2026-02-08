import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlobMatcher } from '../fs/globMatch';

test('globMatch supports recursive ** matching', () => {
	const match = createGlobMatcher(['**/*.rbf']);
	assert.equal(match('main.rbf'), true);
	assert.equal(match('prjs/demo/main.rbf'), true);
	assert.equal(match('prjs/demo/main.rbfx'), false);
});

test('globMatch supports single-level * matching', () => {
	const match = createGlobMatcher(['*.rbf']);
	assert.equal(match('main.rbf'), true);
	assert.equal(match('demo/main.rbf'), false);
});

test('globMatch supports ? wildcard and windows separators', () => {
	const match = createGlobMatcher(['src/file?.ts']);
	assert.equal(match('src/file1.ts'), true);
	assert.equal(match('src\\fileA.ts'), true);
	assert.equal(match('src/file10.ts'), false);
});

test('globMatch supports **/ prefix and empty pattern list', () => {
	const match = createGlobMatcher(['**/build/*.rbf']);
	assert.equal(match('build/a.rbf'), true);
	assert.equal(match('prjs/build/a.rbf'), true);
	assert.equal(match('prjs/build/deep/a.rbf'), false);

	const noMatch = createGlobMatcher([]);
	assert.equal(noMatch('anything.txt'), false);
});
