import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildRemoteDeployPath,
	buildRemoteProjectFilePath,
	buildRemoteProjectRoot,
	choosePreferredRunCandidate,
	isRbfFileName,
	normalizeDeployRoot
} from '../fs/deployActions';

test('deployActions detects .rbf filename case-insensitively', () => {
	assert.equal(isRbfFileName('program.rbf'), true);
	assert.equal(isRbfFileName('PROGRAM.RBF'), true);
	assert.equal(isRbfFileName('program.rbF'), true);
	assert.equal(isRbfFileName('program.txt'), false);
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
		/\.rbf/i
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

test('deployActions chooses preferred run candidate by depth then name', () => {
	const chosen = choosePreferredRunCandidate([
		'/home/root/lms2012/prjs/LineFollower/bin/Main.rbf',
		'/home/root/lms2012/prjs/LineFollower/Auto.rbf',
		'/home/root/lms2012/prjs/LineFollower/a/Deep.rbf'
	]);
	assert.equal(chosen, '/home/root/lms2012/prjs/LineFollower/Auto.rbf');
});
