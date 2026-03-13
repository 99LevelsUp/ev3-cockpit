/**
 * Error class for remote filesystem operations on the EV3 brick.
 *
 * @packageDocumentation
 */

import { ExtensionError } from './ExtensionError';

/**
 * Error codes for filesystem operations on the EV3 brick.
 */
export enum FilesystemErrorCode {
	/** File or directory not found */
	NOT_FOUND = 'NOT_FOUND',
	/** File or directory already exists */
	ALREADY_EXISTS = 'ALREADY_EXISTS',
	/** Permission denied */
	PERMISSION_DENIED = 'PERMISSION_DENIED',
	/** Directory is not empty */
	NOT_EMPTY = 'NOT_EMPTY',
	/** Invalid path (malformed or contains invalid characters) */
	INVALID_PATH = 'INVALID_PATH',
	/** Path is outside allowed roots */
	PATH_POLICY_VIOLATION = 'PATH_POLICY_VIOLATION',
	/** Disk full or no space left */
	NO_SPACE = 'NO_SPACE',
	/** Path is too long */
	PATH_TOO_LONG = 'PATH_TOO_LONG',
	/** File is too large to transfer */
	FILE_TOO_LARGE = 'FILE_TOO_LARGE',
	/** Read operation failed */
	READ_FAILED = 'READ_FAILED',
	/** Write operation failed */
	WRITE_FAILED = 'WRITE_FAILED',
	/** Delete operation failed */
	DELETE_FAILED = 'DELETE_FAILED',
	/** List directory operation failed */
	LIST_FAILED = 'LIST_FAILED',
	/** Create directory operation failed */
	MKDIR_FAILED = 'MKDIR_FAILED',
	/** File transfer failed */
	TRANSFER_FAILED = 'TRANSFER_FAILED',
	/** File content validation failed */
	VALIDATION_FAILED = 'VALIDATION_FAILED',
	/** Operation timed out */
	TIMEOUT = 'TIMEOUT',
	/** Unknown filesystem error */
	UNKNOWN = 'UNKNOWN'
}

/**
 * Filesystem operation type.
 */
export type FilesystemOperation =
	| 'read'
	| 'write'
	| 'delete'
	| 'list'
	| 'mkdir'
	| 'upload'
	| 'download'
	| 'exists'
	| 'stat';

/**
 * Recovery action recommendation for filesystem errors.
 */
export type FilesystemRecoveryAction =
	| 'retry'
	| 'check-path'
	| 'free-space'
	| 'check-permissions'
	| 'none';

/**
 * Specialized error for filesystem operations on the EV3 brick.
 * Used when file operations (read, write, list, delete) fail.
 */
export class FilesystemError extends ExtensionError {
	public readonly operation: FilesystemOperation;
	public readonly path?: string;
	public readonly recommendedAction: FilesystemRecoveryAction;

	public constructor(options: {
		code: FilesystemErrorCode;
		message: string;
		operation: FilesystemOperation;
		path?: string;
		recommendedAction?: FilesystemRecoveryAction;
		cause?: unknown;
	}) {
		super(options.code, options.message, options.cause);
		this.name = 'FilesystemError';
		this.operation = options.operation;
		this.path = options.path;
		this.recommendedAction = options.recommendedAction ?? inferRecoveryAction(options.code);
	}
}

/**
 * Infer recovery action from error code.
 */
function inferRecoveryAction(code: FilesystemErrorCode): FilesystemRecoveryAction {
	switch (code) {
		case FilesystemErrorCode.NOT_FOUND:
		case FilesystemErrorCode.INVALID_PATH:
		case FilesystemErrorCode.PATH_POLICY_VIOLATION:
			return 'check-path';
		case FilesystemErrorCode.NO_SPACE:
			return 'free-space';
		case FilesystemErrorCode.PERMISSION_DENIED:
			return 'check-permissions';
		case FilesystemErrorCode.TIMEOUT:
		case FilesystemErrorCode.TRANSFER_FAILED:
			return 'retry';
		default:
			return 'none';
	}
}

/**
 * User-facing error messages for filesystem errors.
 */
export const FILESYSTEM_ERROR_MESSAGES: Record<FilesystemErrorCode, string> = {
	[FilesystemErrorCode.NOT_FOUND]: 'File or directory not found.',
	[FilesystemErrorCode.ALREADY_EXISTS]: 'File or directory already exists.',
	[FilesystemErrorCode.PERMISSION_DENIED]: 'Permission denied.',
	[FilesystemErrorCode.NOT_EMPTY]: 'Directory is not empty.',
	[FilesystemErrorCode.INVALID_PATH]: 'Invalid file path.',
	[FilesystemErrorCode.PATH_POLICY_VIOLATION]: 'Path is outside allowed directories.',
	[FilesystemErrorCode.NO_SPACE]: 'No space left on device.',
	[FilesystemErrorCode.PATH_TOO_LONG]: 'File path is too long.',
	[FilesystemErrorCode.FILE_TOO_LARGE]: 'File is too large to transfer.',
	[FilesystemErrorCode.READ_FAILED]: 'Failed to read file.',
	[FilesystemErrorCode.WRITE_FAILED]: 'Failed to write file.',
	[FilesystemErrorCode.DELETE_FAILED]: 'Failed to delete file or directory.',
	[FilesystemErrorCode.LIST_FAILED]: 'Failed to list directory contents.',
	[FilesystemErrorCode.MKDIR_FAILED]: 'Failed to create directory.',
	[FilesystemErrorCode.TRANSFER_FAILED]: 'File transfer failed.',
	[FilesystemErrorCode.VALIDATION_FAILED]: 'File validation failed.',
	[FilesystemErrorCode.TIMEOUT]: 'Operation timed out.',
	[FilesystemErrorCode.UNKNOWN]: 'Unknown filesystem error occurred.'
};
