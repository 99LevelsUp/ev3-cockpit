import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDisplayName, hasSameDisplayName } from '../device/brickNameResolver';

test('normalizeDisplayName trims whitespace', () => {
	assert.equal(normalizeDisplayName('  EV3  '), 'EV3');
	assert.equal(normalizeDisplayName(undefined), '');
	assert.equal(normalizeDisplayName(''), '');
});

test('hasSameDisplayName compares case-insensitively', () => {
	assert.equal(hasSameDisplayName('EV3', 'ev3'), true);
	assert.equal(hasSameDisplayName('EV3', 'EV3'), true);
	assert.equal(hasSameDisplayName('EV3', 'NXT'), false);
	assert.equal(hasSameDisplayName('', ''), false);
	assert.equal(hasSameDisplayName(undefined, undefined), false);
});
