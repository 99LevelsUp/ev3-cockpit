import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildDeployRoots,
	createDeployStepRunner,
	describeDeployOperation,
	mapScannedFilesToDeployEntries,
	resolveRunTarget
} from '../commands/deployOrchestration';
import { Logger } from '../diagnostics/logger';

function createLogger(): Logger {
	return {
		error: () => undefined,
		warn: () => undefined,
		info: () => undefined,
		debug: () => undefined,
		trace: () => undefined
	};
}

test('describeDeployOperation resolves labels and status texts', () => {
	assert.deepEqual(describeDeployOperation({ previewOnly: true, runAfterDeploy: false }), {
		started: 'Deploy preview started',
		completed: 'Deploy preview completed',
		failed: 'Deploy project preview failed',
		progressTitle: 'Previewing EV3 deploy',
		openLabel: 'Preview Project Deploy Changes'
	});
	assert.deepEqual(describeDeployOperation({ previewOnly: false, runAfterDeploy: true }), {
		started: 'Deploy and run started',
		completed: 'Deploy and run completed',
		failed: 'Deploy project and run failed',
		progressTitle: 'Deploying EV3 project',
		openLabel: 'Deploy Project to EV3'
	});
});

test('buildDeployRoots produces deterministic atomic paths', () => {
	const roots = buildDeployRoots('C:\\workspace\\demo', '/home/root/lms2012/prjs/', true, 123456, () => 0.25);
	assert.equal(roots.remoteProjectRoot, '/home/root/lms2012/prjs/demo');
	assert.equal(roots.remoteProjectParent, '/home/root/lms2012/prjs');
	assert.equal(roots.remoteProjectName, 'demo');
	assert.equal(roots.atomicTag, '2n9c-1xg');
	assert.equal(roots.deployProjectRoot, roots.atomicStagingRoot);
	assert.match(roots.atomicStagingRoot, /\.demo\.ev3-cockpit-staging-/);
	assert.match(roots.atomicBackupRoot, /\.demo\.ev3-cockpit-backup-/);
});

test('mapScannedFilesToDeployEntries derives remote path and executable flag', () => {
	const entries = mapScannedFilesToDeployEntries(
		[
			{
				localUri: { fsPath: 'C:\\workspace\\demo\\main.rbf' } as never,
				relativePath: `src${process.platform === 'win32' ? '\\' : '/'}main.rbf`,
				sizeBytes: 10
			},
			{
				localUri: { fsPath: 'C:\\workspace\\demo\\notes.txt' } as never,
				relativePath: 'notes.txt',
				sizeBytes: 5
			}
		],
		'/home/root/lms2012/prjs/demo'
	);

	assert.equal(entries[0].remotePath, '/home/root/lms2012/prjs/demo/src/main.rbf');
	assert.equal(entries[0].isExecutable, true);
	assert.equal(entries[1].isExecutable, false);
});

test('resolveRunTarget chooses preferred executable candidate', () => {
	const target = resolveRunTarget(
		[
			{
				localUri: { fsPath: 'a.rbf' } as never,
				relativePath: 'nested/main.rbf',
				remotePath: '/ignored/nested/main.rbf',
				sizeBytes: 1,
				isExecutable: true
			},
			{
				localUri: { fsPath: 'b.rbf' } as never,
				relativePath: 'main.rbf',
				remotePath: '/ignored/main.rbf',
				sizeBytes: 1,
				isExecutable: true
			}
		],
		'/home/root/lms2012/prjs/demo'
	);

	assert.equal(target, '/home/root/lms2012/prjs/demo/main.rbf');
});

test('createDeployStepRunner retries transient errors and reopens transport when configured', async () => {
	let attempts = 0;
	let closeCalls = 0;
	let openCalls = 0;
	const run = createDeployStepRunner(
		{
			enabled: true,
			maxRetries: 1,
			retryDelayMs: 0,
			reopenConnection: true
		},
		{
			logger: createLogger(),
			isCancellationError: () => false,
			closeCommandClient: async () => {
				closeCalls += 1;
			},
			openCommandClient: async () => {
				openCalls += 1;
			}
		}
	);

	const result = await run('upload', async () => {
		attempts += 1;
		if (attempts === 1) {
			throw new Error('ECONNRESET');
		}
		return 'ok';
	});

	assert.equal(result, 'ok');
	assert.equal(attempts, 2);
	assert.equal(closeCalls, 1);
	assert.equal(openCalls, 1);
});

test('createDeployStepRunner does not retry cancellation errors', async () => {
	let attempts = 0;
	const expected = new Error('Canceled');
	const run = createDeployStepRunner(
		{
			enabled: true,
			maxRetries: 5,
			retryDelayMs: 0,
			reopenConnection: true
		},
		{
			logger: createLogger(),
			isCancellationError: (error) => error === expected,
			closeCommandClient: async () => undefined,
			openCommandClient: async () => undefined
		}
	);

	await assert.rejects(
		() => run('cancelled', async () => {
			attempts += 1;
			throw expected;
		}),
		expected
	);
	assert.equal(attempts, 1);
});
