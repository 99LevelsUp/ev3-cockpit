import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalProjectLayout, planRemoteCleanup } from '../fs/deployCleanup';

test('deployCleanup builds local layout from relative file paths', () => {
	const layout = buildLocalProjectLayout(['main.rbf', 'sub/child/program.rbf']);

	assert.deepEqual([...layout.files].sort(), ['main.rbf', 'sub/child/program.rbf']);
	assert.deepEqual([...layout.directories].sort(), ['', 'sub', 'sub/child']);
});

test('deployCleanup plans stale files and stale directories for deletion', () => {
	const localLayout = buildLocalProjectLayout(['main.rbf', 'sub/current.rbf']);

	const plan = planRemoteCleanup({
		remoteProjectRoot: '/home/root/lms2012/prjs/MyProject',
		remoteFilePaths: [
			'/home/root/lms2012/prjs/MyProject/main.rbf',
			'/home/root/lms2012/prjs/MyProject/sub/current.rbf',
			'/home/root/lms2012/prjs/MyProject/sub/old.rbf',
			'/home/root/lms2012/prjs/MyProject/legacy/legacy.rbf'
		],
		remoteDirectoryPaths: [
			'/home/root/lms2012/prjs/MyProject',
			'/home/root/lms2012/prjs/MyProject/sub',
			'/home/root/lms2012/prjs/MyProject/legacy'
		],
		localLayout
	});

	assert.deepEqual(plan.filesToDelete, [
		'/home/root/lms2012/prjs/MyProject/legacy/legacy.rbf',
		'/home/root/lms2012/prjs/MyProject/sub/old.rbf'
	]);
	assert.deepEqual(plan.directoriesToDelete, ['/home/root/lms2012/prjs/MyProject/legacy']);
});

test('deployCleanup ignores paths outside project root and keeps project root', () => {
	const localLayout = buildLocalProjectLayout(['main.rbf']);

	const plan = planRemoteCleanup({
		remoteProjectRoot: '/home/root/lms2012/prjs/MyProject',
		remoteFilePaths: [
			'/home/root/lms2012/prjs/MyProject/main.rbf',
			'/home/root/lms2012/prjs/OtherProject/foreign.rbf'
		],
		remoteDirectoryPaths: [
			'/home/root/lms2012/prjs/MyProject',
			'/home/root/lms2012/prjs/OtherProject'
		],
		localLayout
	});

	assert.deepEqual(plan.filesToDelete, []);
	assert.deepEqual(plan.directoriesToDelete, []);
});
