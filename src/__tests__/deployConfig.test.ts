import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_DEPLOY_EXCLUDE_DIRECTORIES,
	DEFAULT_DEPLOY_EXCLUDE_EXTENSIONS,
	DEFAULT_DEPLOY_INCLUDE_GLOBS,
	DEFAULT_DEPLOY_EXCLUDE_GLOBS,
	DEFAULT_DEPLOY_CLEANUP_ENABLED,
	DEFAULT_DEPLOY_CLEANUP_CONFIRM_BEFORE_DELETE,
	DEFAULT_DEPLOY_CLEANUP_DRY_RUN,
	DEFAULT_DEPLOY_ATOMIC_ENABLED,
	DEFAULT_DEPLOY_VERIFY_AFTER_UPLOAD,
	DEFAULT_DEPLOY_CONFLICT_POLICY,
	DEFAULT_DEPLOY_CONFLICT_ASK_FALLBACK,
	DEFAULT_DEPLOY_RESILIENCE_ENABLED,
	DEFAULT_DEPLOY_RESILIENCE_MAX_RETRIES,
	DEFAULT_DEPLOY_RESILIENCE_RETRY_DELAY_MS,
	DEFAULT_DEPLOY_RESILIENCE_REOPEN_CONNECTION,
	DEFAULT_DEPLOY_INCREMENTAL_ENABLED,
	DEFAULT_DEPLOY_MAX_FILE_BYTES,
	sanitizeDeployAtomicEnabled,
	sanitizeDeployCleanupEnabled,
	sanitizeDeployCleanupConfirmBeforeDelete,
	sanitizeDeployCleanupDryRun,
	sanitizeDeployExcludeDirectories,
	sanitizeDeployExcludeExtensions,
	sanitizeDeployIncludeGlobs,
	sanitizeDeployExcludeGlobs,
	sanitizeDeployIncrementalEnabled,
	sanitizeDeployMaxFileBytes,
	sanitizeDeployVerifyAfterUpload,
	sanitizeDeployConflictPolicy,
	sanitizeDeployConflictAskFallback,
	sanitizeDeployResilienceEnabled,
	sanitizeDeployResilienceMaxRetries,
	sanitizeDeployResilienceRetryDelayMs,
	sanitizeDeployResilienceReopenConnection
} from '../config/deployConfig';

test('deployConfig uses defaults for invalid exclude directories', () => {
	assert.deepEqual(sanitizeDeployExcludeDirectories(undefined), DEFAULT_DEPLOY_EXCLUDE_DIRECTORIES);
	assert.deepEqual(sanitizeDeployExcludeDirectories([]), DEFAULT_DEPLOY_EXCLUDE_DIRECTORIES);
});

test('deployConfig sanitizes and deduplicates exclude directories', () => {
	assert.deepEqual(
		sanitizeDeployExcludeDirectories([' Node_Modules ', '.GIT', 'node_modules', '', 123]),
		['node_modules', '.git']
	);
});

test('deployConfig uses defaults for invalid exclude extensions', () => {
	assert.deepEqual(sanitizeDeployExcludeExtensions(undefined), DEFAULT_DEPLOY_EXCLUDE_EXTENSIONS);
	assert.deepEqual(sanitizeDeployExcludeExtensions([]), DEFAULT_DEPLOY_EXCLUDE_EXTENSIONS);
});

test('deployConfig sanitizes and deduplicates exclude extensions', () => {
	assert.deepEqual(
		sanitizeDeployExcludeExtensions(['map', '.tmp', '.MAP', '', 123]),
		['.map', '.tmp']
	);
});

test('deployConfig uses defaults for invalid include globs', () => {
	assert.deepEqual(sanitizeDeployIncludeGlobs(undefined), DEFAULT_DEPLOY_INCLUDE_GLOBS);
	assert.deepEqual(sanitizeDeployIncludeGlobs([]), DEFAULT_DEPLOY_INCLUDE_GLOBS);
});

test('deployConfig sanitizes and deduplicates include globs', () => {
	assert.deepEqual(sanitizeDeployIncludeGlobs(['**/*.rbf', './src/**/*.ts', '**/*.rbf']), ['**/*.rbf', 'src/**/*.ts']);
});

test('deployConfig uses defaults for invalid exclude globs', () => {
	assert.deepEqual(sanitizeDeployExcludeGlobs(undefined), DEFAULT_DEPLOY_EXCLUDE_GLOBS);
	assert.deepEqual(sanitizeDeployExcludeGlobs([]), DEFAULT_DEPLOY_EXCLUDE_GLOBS);
});

test('deployConfig sanitizes and deduplicates exclude globs', () => {
	assert.deepEqual(sanitizeDeployExcludeGlobs(['**/*.tmp', '.\\dist\\**', '**/*.tmp']), ['**/*.tmp', 'dist/**']);
});

test('deployConfig sanitizes max file bytes', () => {
	assert.equal(sanitizeDeployMaxFileBytes(undefined), DEFAULT_DEPLOY_MAX_FILE_BYTES);
	assert.equal(sanitizeDeployMaxFileBytes(NaN), DEFAULT_DEPLOY_MAX_FILE_BYTES);
	assert.equal(sanitizeDeployMaxFileBytes(-100), 1);
	assert.equal(sanitizeDeployMaxFileBytes(1234.7), 1234);
});

test('deployConfig sanitizes incremental enabled flag', () => {
	assert.equal(sanitizeDeployIncrementalEnabled(undefined), DEFAULT_DEPLOY_INCREMENTAL_ENABLED);
	assert.equal(sanitizeDeployIncrementalEnabled(true), true);
	assert.equal(sanitizeDeployIncrementalEnabled(false), false);
});

test('deployConfig sanitizes cleanup enabled flag', () => {
	assert.equal(sanitizeDeployCleanupEnabled(undefined), DEFAULT_DEPLOY_CLEANUP_ENABLED);
	assert.equal(sanitizeDeployCleanupEnabled(true), true);
	assert.equal(sanitizeDeployCleanupEnabled(false), false);
});

test('deployConfig sanitizes cleanup confirm-before-delete flag', () => {
	assert.equal(
		sanitizeDeployCleanupConfirmBeforeDelete(undefined),
		DEFAULT_DEPLOY_CLEANUP_CONFIRM_BEFORE_DELETE
	);
	assert.equal(sanitizeDeployCleanupConfirmBeforeDelete(true), true);
	assert.equal(sanitizeDeployCleanupConfirmBeforeDelete(false), false);
});

test('deployConfig sanitizes cleanup dry-run flag', () => {
	assert.equal(sanitizeDeployCleanupDryRun(undefined), DEFAULT_DEPLOY_CLEANUP_DRY_RUN);
	assert.equal(sanitizeDeployCleanupDryRun(true), true);
	assert.equal(sanitizeDeployCleanupDryRun(false), false);
});

test('deployConfig sanitizes atomic enabled flag', () => {
	assert.equal(sanitizeDeployAtomicEnabled(undefined), DEFAULT_DEPLOY_ATOMIC_ENABLED);
	assert.equal(sanitizeDeployAtomicEnabled(true), true);
	assert.equal(sanitizeDeployAtomicEnabled(false), false);
});

test('deployConfig sanitizes verify-after-upload mode', () => {
	assert.equal(sanitizeDeployVerifyAfterUpload(undefined), DEFAULT_DEPLOY_VERIFY_AFTER_UPLOAD);
	assert.equal(sanitizeDeployVerifyAfterUpload('none'), 'none');
	assert.equal(sanitizeDeployVerifyAfterUpload('size'), 'size');
	assert.equal(sanitizeDeployVerifyAfterUpload('md5'), 'md5');
	assert.equal(sanitizeDeployVerifyAfterUpload('invalid'), DEFAULT_DEPLOY_VERIFY_AFTER_UPLOAD);
});

test('deployConfig sanitizes conflict policy', () => {
	assert.equal(sanitizeDeployConflictPolicy(undefined), DEFAULT_DEPLOY_CONFLICT_POLICY);
	assert.equal(sanitizeDeployConflictPolicy('overwrite'), 'overwrite');
	assert.equal(sanitizeDeployConflictPolicy('skip'), 'skip');
	assert.equal(sanitizeDeployConflictPolicy('ask'), 'ask');
	assert.equal(sanitizeDeployConflictPolicy('invalid'), DEFAULT_DEPLOY_CONFLICT_POLICY);
});

test('deployConfig sanitizes conflict ask fallback', () => {
	assert.equal(sanitizeDeployConflictAskFallback(undefined), DEFAULT_DEPLOY_CONFLICT_ASK_FALLBACK);
	assert.equal(sanitizeDeployConflictAskFallback('prompt'), 'prompt');
	assert.equal(sanitizeDeployConflictAskFallback('skip'), 'skip');
	assert.equal(sanitizeDeployConflictAskFallback('overwrite'), 'overwrite');
	assert.equal(sanitizeDeployConflictAskFallback('invalid'), DEFAULT_DEPLOY_CONFLICT_ASK_FALLBACK);
});

test('deployConfig sanitizes resilience enabled flag', () => {
	assert.equal(sanitizeDeployResilienceEnabled(undefined), DEFAULT_DEPLOY_RESILIENCE_ENABLED);
	assert.equal(sanitizeDeployResilienceEnabled(true), true);
	assert.equal(sanitizeDeployResilienceEnabled(false), false);
});

test('deployConfig sanitizes resilience max retries', () => {
	assert.equal(sanitizeDeployResilienceMaxRetries(undefined), DEFAULT_DEPLOY_RESILIENCE_MAX_RETRIES);
	assert.equal(sanitizeDeployResilienceMaxRetries(NaN), DEFAULT_DEPLOY_RESILIENCE_MAX_RETRIES);
	assert.equal(sanitizeDeployResilienceMaxRetries(-3), 0);
	assert.equal(sanitizeDeployResilienceMaxRetries(2.9), 2);
});

test('deployConfig sanitizes resilience retry delay', () => {
	assert.equal(sanitizeDeployResilienceRetryDelayMs(undefined), DEFAULT_DEPLOY_RESILIENCE_RETRY_DELAY_MS);
	assert.equal(sanitizeDeployResilienceRetryDelayMs(NaN), DEFAULT_DEPLOY_RESILIENCE_RETRY_DELAY_MS);
	assert.equal(sanitizeDeployResilienceRetryDelayMs(-100), 0);
	assert.equal(sanitizeDeployResilienceRetryDelayMs(123.7), 123);
});

test('deployConfig sanitizes resilience reopen connection flag', () => {
	assert.equal(sanitizeDeployResilienceReopenConnection(undefined), DEFAULT_DEPLOY_RESILIENCE_REOPEN_CONNECTION);
	assert.equal(sanitizeDeployResilienceReopenConnection(true), true);
	assert.equal(sanitizeDeployResilienceReopenConnection(false), false);
});
