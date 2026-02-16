import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { TreeCache } from '../ui/TreeCache';

const originalDateNow = Date.now;

afterEach(() => {
	Date.now = originalDateNow;
});

test('get returns undefined for missing key', () => {
	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 60_000 });
	assert.equal(cache.get('missing'), undefined);
});

test('set and get round-trip', () => {
	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 60_000 });
	cache.set('a', 42);
	assert.equal(cache.get('a'), 42);
});

test('set overwrites existing entry', () => {
	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 60_000 });
	cache.set('a', 1);
	cache.set('a', 2);
	assert.equal(cache.get('a'), 2);
	assert.equal(cache.size, 1);
});

test('delete removes entry', () => {
	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 60_000 });
	cache.set('a', 1);
	assert.equal(cache.delete('a'), true);
	assert.equal(cache.get('a'), undefined);
	assert.equal(cache.delete('a'), false);
});

test('clear removes all entries', () => {
	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 60_000 });
	cache.set('a', 1);
	cache.set('b', 2);
	cache.clear();
	assert.equal(cache.size, 0);
	assert.equal(cache.get('a'), undefined);
});

test('has returns true for present key and false for missing', () => {
	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 60_000 });
	cache.set('a', 1);
	assert.equal(cache.has('a'), true);
	assert.equal(cache.has('b'), false);
});

test('size tracks entries', () => {
	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 60_000 });
	assert.equal(cache.size, 0);
	cache.set('a', 1);
	assert.equal(cache.size, 1);
	cache.set('b', 2);
	assert.equal(cache.size, 2);
	cache.delete('a');
	assert.equal(cache.size, 1);
});

test('LRU eviction when maxEntries exceeded', () => {
	const cache = new TreeCache<string, number>({ maxEntries: 2, ttlMs: 60_000 });
	cache.set('a', 1);
	cache.set('b', 2);
	cache.set('c', 3);
	assert.equal(cache.size, 2);
	assert.equal(cache.get('a'), undefined);
	assert.equal(cache.get('b'), 2);
	assert.equal(cache.get('c'), 3);
});

test('TTL expiration returns undefined and deletes entry', () => {
	let now = 1000;
	Date.now = () => now;

	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 100 });
	cache.set('a', 1);
	assert.equal(cache.get('a'), 1);

	now = 1100;
	assert.equal(cache.get('a'), undefined);
	assert.equal(cache.size, 0);
});

test('has returns false for expired entry', () => {
	let now = 1000;
	Date.now = () => now;

	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 50 });
	cache.set('a', 1);
	assert.equal(cache.has('a'), true);

	now = 1050;
	assert.equal(cache.has('a'), false);
});

test('keys iterator returns stored keys', () => {
	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 60_000 });
	cache.set('x', 1);
	cache.set('y', 2);
	const keys = [...cache.keys()];
	assert.deepEqual(keys, ['x', 'y']);
});

test('custom per-entry TTL overrides default', () => {
	let now = 1000;
	Date.now = () => now;

	const cache = new TreeCache<string, number>({ maxEntries: 10, ttlMs: 200 });
	cache.set('short', 1, 50);
	cache.set('default', 2);

	now = 1060;
	assert.equal(cache.get('short'), undefined);
	assert.equal(cache.get('default'), 2);
});
