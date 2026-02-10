import assert from 'node:assert/strict';
import test from 'node:test';
import {
	sanitizeBoolean,
	sanitizeNumber,
	sanitizeEnum,
	sanitizeStringList,
	sanitizeGlobList
} from '../config/sanitizers';

// --- sanitizeBoolean ---

test('sanitizeBoolean returns true for true', () => {
	assert.equal(sanitizeBoolean(true, false), true);
});

test('sanitizeBoolean returns false for false', () => {
	assert.equal(sanitizeBoolean(false, true), false);
});

test('sanitizeBoolean returns fallback for non-boolean', () => {
	assert.equal(sanitizeBoolean('true', false), false);
	assert.equal(sanitizeBoolean(1, false), false);
	assert.equal(sanitizeBoolean(undefined, true), true);
	assert.equal(sanitizeBoolean(null, true), true);
});

// --- sanitizeNumber ---

test('sanitizeNumber returns valid number clamped to min', () => {
	assert.equal(sanitizeNumber(50, 100, 0), 50);
	assert.equal(sanitizeNumber(-5, 100, 0), 0);
	assert.equal(sanitizeNumber(3.7, 100, 0), 3);
});

test('sanitizeNumber returns fallback for non-number', () => {
	assert.equal(sanitizeNumber('50', 100, 0), 100);
	assert.equal(sanitizeNumber(undefined, 100, 0), 100);
	assert.equal(sanitizeNumber(null, 100, 0), 100);
});

test('sanitizeNumber returns fallback for NaN and Infinity', () => {
	assert.equal(sanitizeNumber(NaN, 100, 0), 100);
	assert.equal(sanitizeNumber(Infinity, 100, 0), 100);
	assert.equal(sanitizeNumber(-Infinity, 100, 0), 100);
});

// --- sanitizeEnum ---

test('sanitizeEnum returns value when in allowed list', () => {
	assert.equal(sanitizeEnum('a', ['a', 'b', 'c'] as const, 'b'), 'a');
});

test('sanitizeEnum returns fallback for invalid value', () => {
	assert.equal(sanitizeEnum('x', ['a', 'b', 'c'] as const, 'b'), 'b');
	assert.equal(sanitizeEnum(42, ['a', 'b'] as const, 'a'), 'a');
	assert.equal(sanitizeEnum(undefined, ['a', 'b'] as const, 'a'), 'a');
});

// --- sanitizeStringList ---

test('sanitizeStringList filters and trims strings', () => {
	assert.deepEqual(sanitizeStringList([' hello ', 'world', '', 123, null, '  ok  ']), ['hello', 'world', 'ok']);
});

test('sanitizeStringList returns empty array for non-array', () => {
	assert.deepEqual(sanitizeStringList(undefined), []);
	assert.deepEqual(sanitizeStringList('string'), []);
	assert.deepEqual(sanitizeStringList(42), []);
});

test('sanitizeStringList returns empty array for empty array', () => {
	assert.deepEqual(sanitizeStringList([]), []);
});

// --- sanitizeGlobList ---

test('sanitizeGlobList normalizes backslashes to forward slashes', () => {
	assert.deepEqual(sanitizeGlobList(['src\\**\\*.ts']), ['src/**/*.ts']);
});

test('sanitizeGlobList removes ./ prefix', () => {
	assert.deepEqual(sanitizeGlobList(['./**/*.ts', './src/*.js']), ['**/*.ts', 'src/*.js']);
});

test('sanitizeGlobList deduplicates entries', () => {
	assert.deepEqual(sanitizeGlobList(['**/*.ts', '**/*.ts', '**/*.js']), ['**/*.ts', '**/*.js']);
});

test('sanitizeGlobList returns empty array for non-array', () => {
	assert.deepEqual(sanitizeGlobList(undefined), []);
});
