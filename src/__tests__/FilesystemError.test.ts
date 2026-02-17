import assert from 'node:assert/strict';
import test from 'node:test';
import { FilesystemError, FilesystemErrorCode, FILESYSTEM_ERROR_MESSAGES } from '../errors/FilesystemError.js';

test('FilesystemError extends Error', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.NOT_FOUND,
		message: 'File not found',
		operation: 'read'
	});

	assert.ok(error instanceof Error);
	assert.ok(error instanceof FilesystemError);
	assert.equal(error.name, 'FilesystemError');
});

test('FilesystemError includes code and message', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.PERMISSION_DENIED,
		message: 'Permission denied',
		operation: 'write'
	});

	assert.equal(error.code, FilesystemErrorCode.PERMISSION_DENIED);
	assert.equal(error.message, 'Permission denied');
});

test('FilesystemError includes operation', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.READ_FAILED,
		message: 'Read failed',
		operation: 'read'
	});

	assert.equal(error.operation, 'read');
});

test('FilesystemError includes path when provided', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.NOT_FOUND,
		message: 'File not found',
		operation: 'read',
		path: '/home/robot/test.txt'
	});

	assert.equal(error.path, '/home/robot/test.txt');
});

test('FilesystemError infers recovery action from code', () => {
	const checkPathError = new FilesystemError({
		code: FilesystemErrorCode.NOT_FOUND,
		message: 'Not found',
		operation: 'read'
	});
	assert.equal(checkPathError.recommendedAction, 'check-path');

	const freeSpaceError = new FilesystemError({
		code: FilesystemErrorCode.NO_SPACE,
		message: 'No space',
		operation: 'write'
	});
	assert.equal(freeSpaceError.recommendedAction, 'free-space');

	const permissionsError = new FilesystemError({
		code: FilesystemErrorCode.PERMISSION_DENIED,
		message: 'Permission denied',
		operation: 'delete'
	});
	assert.equal(permissionsError.recommendedAction, 'check-permissions');

	const retryError = new FilesystemError({
		code: FilesystemErrorCode.TIMEOUT,
		message: 'Timeout',
		operation: 'upload'
	});
	assert.equal(retryError.recommendedAction, 'retry');
});

test('FilesystemError allows explicit recovery action', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.UNKNOWN,
		message: 'Unknown error',
		operation: 'read',
		recommendedAction: 'retry'
	});

	assert.equal(error.recommendedAction, 'retry');
});

test('FilesystemError supports cause chaining', () => {
	const cause = new Error('Network error');
	const error = new FilesystemError({
		code: FilesystemErrorCode.TRANSFER_FAILED,
		message: 'Transfer failed',
		operation: 'upload',
		cause
	});

	assert.equal(error.cause, cause);
});

test('FILESYSTEM_ERROR_MESSAGES includes all error codes', () => {
	for (const code of Object.values(FilesystemErrorCode)) {
		assert.ok(
			FILESYSTEM_ERROR_MESSAGES[code],
			`Missing message for ${code}`
		);
		assert.ok(
			typeof FILESYSTEM_ERROR_MESSAGES[code] === 'string',
			`Message for ${code} should be a string`
		);
	}
});

test('FilesystemError handles read operations', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.READ_FAILED,
		message: 'Read failed',
		operation: 'read',
		path: '/test.txt'
	});

	assert.equal(error.operation, 'read');
	assert.equal(error.path, '/test.txt');
});

test('FilesystemError handles write operations', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.WRITE_FAILED,
		message: 'Write failed',
		operation: 'write',
		path: '/output.txt'
	});

	assert.equal(error.operation, 'write');
	assert.equal(error.path, '/output.txt');
});

test('FilesystemError handles delete operations', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.DELETE_FAILED,
		message: 'Delete failed',
		operation: 'delete',
		path: '/temp.txt'
	});

	assert.equal(error.operation, 'delete');
	assert.equal(error.path, '/temp.txt');
});

test('FilesystemError handles list operations', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.LIST_FAILED,
		message: 'List failed',
		operation: 'list',
		path: '/home'
	});

	assert.equal(error.operation, 'list');
	assert.equal(error.path, '/home');
});

test('FilesystemError handles mkdir operations', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.MKDIR_FAILED,
		message: 'Mkdir failed',
		operation: 'mkdir',
		path: '/newdir'
	});

	assert.equal(error.operation, 'mkdir');
	assert.equal(error.path, '/newdir');
});

test('FilesystemError handles upload operations', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.TRANSFER_FAILED,
		message: 'Upload failed',
		operation: 'upload',
		path: '/remote/file.txt'
	});

	assert.equal(error.operation, 'upload');
	assert.equal(error.path, '/remote/file.txt');
});

test('FilesystemError handles download operations', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.TRANSFER_FAILED,
		message: 'Download failed',
		operation: 'download',
		path: '/remote/data.bin'
	});

	assert.equal(error.operation, 'download');
	assert.equal(error.path, '/remote/data.bin');
});

test('FilesystemError handles path policy violations', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.PATH_POLICY_VIOLATION,
		message: 'Path outside allowed roots',
		operation: 'read',
		path: '/etc/passwd'
	});

	assert.equal(error.code, FilesystemErrorCode.PATH_POLICY_VIOLATION);
	assert.equal(error.recommendedAction, 'check-path');
});

test('FilesystemError handles file too large', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.FILE_TOO_LARGE,
		message: 'File exceeds size limit',
		operation: 'upload',
		path: '/huge.bin'
	});

	assert.equal(error.code, FilesystemErrorCode.FILE_TOO_LARGE);
});

test('FilesystemError handles already exists', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.ALREADY_EXISTS,
		message: 'File already exists',
		operation: 'write',
		path: '/existing.txt'
	});

	assert.equal(error.code, FilesystemErrorCode.ALREADY_EXISTS);
});

test('FilesystemError handles directory not empty', () => {
	const error = new FilesystemError({
		code: FilesystemErrorCode.NOT_EMPTY,
		message: 'Directory not empty',
		operation: 'delete',
		path: '/dir'
	});

	assert.equal(error.code, FilesystemErrorCode.NOT_EMPTY);
});
