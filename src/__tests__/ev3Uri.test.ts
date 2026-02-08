import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEv3UriParts } from '../fs/ev3Uri';

test('parseEv3UriParts parses authority and canonicalizes path', () => {
	const parsed = parseEv3UriParts('active', '\\home\\root\\lms2012\\prjs\\demo.rbf');
	assert.equal(parsed.brickId, 'active');
	assert.equal(parsed.remotePath, '/home/root/lms2012/prjs/demo.rbf');
});

test('parseEv3UriParts rejects empty authority', () => {
	assert.throws(() => parseEv3UriParts('', '/home/root/lms2012/prjs/demo.rbf'));
});
