import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_DEPLOY_EXCLUDE_DIRECTORIES,
	DEFAULT_DEPLOY_EXCLUDE_EXTENSIONS,
	DEFAULT_DEPLOY_INCREMENTAL_ENABLED,
	DEFAULT_DEPLOY_MAX_FILE_BYTES,
	sanitizeDeployExcludeDirectories,
	sanitizeDeployExcludeExtensions,
	sanitizeDeployIncrementalEnabled,
	sanitizeDeployMaxFileBytes
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
