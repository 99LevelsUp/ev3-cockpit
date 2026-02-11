import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildRemoteDeployPath,
	buildRemoteProjectFilePath,
	buildRemoteProjectRoot,
	choosePreferredExecutableCandidate,
	isExecutableFileName,
	normalizeDeployRoot
} from '../fs/deployActions';

test('deployActions detects executable filename case-insensitively', () => {
	assert.equal(isExecutableFileName('program.rbf'), true);
	assert.equal(isExecutableFileName('PROGRAM.RBF'), true);
	assert.equal(isExecutableFileName('program.rbF'), true);
	assert.equal(isExecutableFileName('program.txt'), false);
});

test('deployActions normalizes deploy root with trailing slash', () => {
	assert.equal(normalizeDeployRoot('/home/root/lms2012/prjs'), '/home/root/lms2012/prjs/');
	assert.equal(normalizeDeployRoot('/home/root/lms2012/prjs/'), '/home/root/lms2012/prjs/');
});

test('deployActions builds remote deploy path from local path', () => {
	const remote = buildRemoteDeployPath('C:\\Users\\dev\\Desktop\\DemoProgram.rbf', '/home/root/lms2012/prjs/');
	assert.equal(remote, '/home/root/lms2012/prjs/DemoProgram.rbf');
});

test('deployActions rejects non-rbf local file', () => {
	assert.throws(
		() => buildRemoteDeployPath('C:\\Users\\dev\\Desktop\\notes.txt', '/home/root/lms2012/prjs/'),
		/executable files/i
	);
});

test('deployActions builds remote project root from local folder name', () => {
	const remote = buildRemoteProjectRoot('C:\\Users\\dev\\Projects\\LineFollower', '/home/root/lms2012/prjs/');
	assert.equal(remote, '/home/root/lms2012/prjs/LineFollower');
});

test('deployActions builds remote project file path preserving relative folders', () => {
	const remote = buildRemoteProjectFilePath(
		'C:\\Users\\dev\\Projects\\LineFollower',
		'C:\\Users\\dev\\Projects\\LineFollower\\bin\\Main.rbf',
		'/home/root/lms2012/prjs/'
	);
	assert.equal(remote, '/home/root/lms2012/prjs/LineFollower/bin/Main.rbf');
});

test('deployActions rejects project file outside project root', () => {
	assert.throws(
		() =>
			buildRemoteProjectFilePath(
				'C:\\Users\\dev\\Projects\\LineFollower',
				'C:\\Users\\dev\\Projects\\Other\\Main.rbf',
				'/home/root/lms2012/prjs/'
			),
		/outside project root/i
	);
});

test('deployActions chooses preferred executable candidate by depth then name', () => {
	const chosen = choosePreferredExecutableCandidate([
		'/home/root/lms2012/prjs/LineFollower/bin/Main.rbf',
		'/home/root/lms2012/prjs/LineFollower/Auto.rbf',
		'/home/root/lms2012/prjs/LineFollower/a/Deep.rbf'
	]);
	assert.equal(chosen, '/home/root/lms2012/prjs/LineFollower/Auto.rbf');
});

// --- Additional deployActions tests ---

test('deployActions normalizeDeployRoot handles empty string fallback', () => {
	assert.equal(normalizeDeployRoot('   '), '/home/root/lms2012/prjs/');
});

test('deployActions normalizeDeployRoot canonicalizes dotdot segments', () => {
	assert.equal(normalizeDeployRoot('/home/root/../root/lms2012/prjs'), '/home/root/lms2012/prjs/');
});

test('deployActions buildRemoteDeployPath uses default root when omitted', () => {
	const remote = buildRemoteDeployPath('C:\\Users\\dev\\Desktop\\Test.rbf');
	assert.equal(remote, '/home/root/lms2012/prjs/Test.rbf');
});

test('deployActions buildRemoteDeployPath strips leading/trailing spaces from filename', () => {
	const remote = buildRemoteDeployPath('C:\\Users\\dev\\Desktop\\  Main.rbf  ', '/data/');
	assert.match(remote, /Main\.rbf$/);
});

test('deployActions buildRemoteProjectRoot uses default root when omitted', () => {
	const remote = buildRemoteProjectRoot('C:\\Users\\dev\\Projects\\MyProject');
	assert.equal(remote, '/home/root/lms2012/prjs/MyProject');
});

test('deployActions buildRemoteProjectRoot rejects empty project name', () => {
	assert.throws(() => buildRemoteProjectRoot('C:\\'), /Cannot derive project name/i);
});

test('deployActions isExecutableFileName rejects empty string', () => {
	assert.equal(isExecutableFileName(''), false);
	assert.equal(isExecutableFileName('   '), false);
});

test('deployActions choosePreferredExecutableCandidate returns undefined for empty array', () => {
	assert.equal(choosePreferredExecutableCandidate([]), undefined);
});

test('deployActions choosePreferredExecutableCandidate returns single element', () => {
	const result = choosePreferredExecutableCandidate(['/prjs/Only.rbf']);
	assert.equal(result, '/prjs/Only.rbf');
});

test('deployActions choosePreferredExecutableCandidate sorts alphabetically at same depth', () => {
	const result = choosePreferredExecutableCandidate([
		'/prjs/Zebra.rbf',
		'/prjs/Alpha.rbf',
		'/prjs/Middle.rbf'
	]);
	assert.equal(result, '/prjs/Alpha.rbf');
});
