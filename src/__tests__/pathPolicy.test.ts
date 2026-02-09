import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeEv3Path, evaluateFsAccess, isAsciiSafePath } from '../fs/pathPolicy';

test('canonicalizeEv3Path normalizes separators and dot segments', () => {
	const normalized = canonicalizeEv3Path('\\home\\root\\lms2012\\prjs\\..\\prjs\\demo.rbf');
	assert.equal(normalized, '/home/root/lms2012/prjs/demo.rbf');
});

test('canonicalizeEv3Path rejects traversal above root', () => {
	assert.throws(() => canonicalizeEv3Path('/../../etc/passwd'));
});

test('evaluateFsAccess allows safe mode paths inside allowed roots', () => {
	const decision = evaluateFsAccess('/home/root/lms2012/prjs/demo/program.rbf', {
		mode: 'safe',
		safeRoots: ['/home/root/lms2012/prjs/', '/media/card/']
	});

	assert.equal(decision.allowed, true);
	assert.equal(decision.normalizedPath, '/home/root/lms2012/prjs/demo/program.rbf');
});

test('evaluateFsAccess blocks system path in safe mode', () => {
	const decision = evaluateFsAccess('/etc/passwd', {
		mode: 'safe',
		safeRoots: ['/home/root/lms2012/prjs/', '/media/card/']
	});

	assert.equal(decision.allowed, false);
	assert.match(decision.reason ?? '', /safe mode/i);
});

test('evaluateFsAccess blocks hard pseudo-fs path in full mode', () => {
	const decision = evaluateFsAccess('/proc/meminfo', {
		mode: 'full',
		safeRoots: ['/']
	});

	assert.equal(decision.allowed, false);
	assert.match(decision.reason ?? '', /blocked/i);
});

test('evaluateFsAccess allows broad path in full mode outside safe roots', () => {
	const decision = evaluateFsAccess('/home/root/other/location.bin', {
		mode: 'full',
		safeRoots: ['/home/root/lms2012/prjs/']
	});

	assert.equal(decision.allowed, true);
});

test('isAsciiSafePath returns false for non-ASCII path', () => {
	assert.equal(isAsciiSafePath('/home/root/lms2012/prjs/non-ascii-µ.rbf'), false);
	assert.equal(isAsciiSafePath('/home/root/lms2012/prjs/ascii.rbf'), true);
});
