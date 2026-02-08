import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_DEPLOY_EXCLUDE_DIRECTORIES,
	DEFAULT_DEPLOY_EXCLUDE_EXTENSIONS,
	DEFAULT_DEPLOY_CLEANUP_ENABLED,
	DEFAULT_DEPLOY_CLEANUP_CONFIRM_BEFORE_DELETE,
	DEFAULT_DEPLOY_CLEANUP_DRY_RUN,
	DEFAULT_DEPLOY_ATOMIC_ENABLED,
	DEFAULT_DEPLOY_VERIFY_AFTER_UPLOAD,
	DEFAULT_DEPLOY_INCREMENTAL_ENABLED,
	DEFAULT_DEPLOY_MAX_FILE_BYTES,
	sanitizeDeployAtomicEnabled,
	sanitizeDeployCleanupEnabled,
	sanitizeDeployCleanupConfirmBeforeDelete,
	sanitizeDeployCleanupDryRun,
	sanitizeDeployExcludeDirectories,
	sanitizeDeployExcludeExtensions,
	sanitizeDeployIncrementalEnabled,
	sanitizeDeployMaxFileBytes,
	sanitizeDeployVerifyAfterUpload
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
