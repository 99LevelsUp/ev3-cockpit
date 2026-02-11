import { CapabilityProfile } from '../compat/capabilityProfile';
import { FsConfigSnapshot } from '../config/featureConfig';
import { Logger, NoopLogger } from '../diagnostics/logger';
import { ExtensionError } from '../errors/ExtensionError';
import { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { concatBytes, cString, gv0, lc0, lc2, lcs, readUint32le, uint16le, uint32le } from '../protocol/ev3Bytecode';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { evaluateFsAccess, PathPolicyError } from './pathPolicy';

const SYSTEM_STATUS = {
	OK: 0x00,
	UNKNOWN_HANDLE: 0x01,
	HANDLE_NOT_READY: 0x02,
	CORRUPT_FILE: 0x03,
	NO_HANDLES_AVAILABLE: 0x04,
	NO_PERMISSION: 0x05,
	ILLEGAL_PATH: 0x06,
	FILE_EXISTS: 0x07,
	END_OF_FILE: 0x08,
	SIZE_ERROR: 0x09,
	UNKNOWN_ERROR: 0x0a,
	ILLEGAL_FILENAME: 0x0b,
	ILLEGAL_CONNECTION: 0x0c
} as const;

const SYSTEM_CMD = {
	BEGIN_DOWNLOAD: 0x92,
	CONTINUE_DOWNLOAD: 0x93,
	BEGIN_UPLOAD: 0x94,
	CONTINUE_UPLOAD: 0x95,
	CLOSE_FILEHANDLE: 0x98,
	LIST_FILES: 0x99,
	CONTINUE_LIST_FILES: 0x9a,
	CREATE_DIR: 0x9b,
	DELETE_FILE: 0x9c
} as const;

const DIRECT_OP = {
	PROGRAM_START: 0x03,
	FILE: 0xc0
} as const;

const DIRECT_FILE_SUBCMD = {
	LOAD_IMAGE: 0x08
} as const;

const DIRECT_VM_SLOT = {
	USER: 0x01
} as const;

/** Maximum payload for the first LIST_FILES system command (1024 − header overhead). */
const LIST_CHUNK_FIRST = 1012;
/** Maximum payload for CONTINUE_LIST_FILES (1024 − continue header overhead). */
const LIST_CHUNK_CONTINUE = 1016;
/** Maximum payload for the first BEGIN_UPLOAD system command (1024 − header overhead). */
const UPLOAD_CHUNK_FIRST = 1012;
/** Maximum payload for CONTINUE_UPLOAD (1024 − continue header overhead). */
const UPLOAD_CHUNK_CONTINUE = 1016;
/** Maximum payload bytes returned in a BEGIN_DOWNLOAD reply. */
const DOWNLOAD_CHUNK_MAX = 1017;

const SYSTEM_STATUS_TEXT: Record<number, string> = {
	[SYSTEM_STATUS.OK]: 'OK',
	[SYSTEM_STATUS.UNKNOWN_HANDLE]: 'UNKNOWN_HANDLE',
	[SYSTEM_STATUS.HANDLE_NOT_READY]: 'HANDLE_NOT_READY',
	[SYSTEM_STATUS.CORRUPT_FILE]: 'CORRUPT_FILE',
	[SYSTEM_STATUS.NO_HANDLES_AVAILABLE]: 'NO_HANDLES_AVAILABLE',
	[SYSTEM_STATUS.NO_PERMISSION]: 'NO_PERMISSION',
	[SYSTEM_STATUS.ILLEGAL_PATH]: 'ILLEGAL_PATH',
	[SYSTEM_STATUS.FILE_EXISTS]: 'FILE_EXISTS',
	[SYSTEM_STATUS.END_OF_FILE]: 'END_OF_FILE',
	[SYSTEM_STATUS.SIZE_ERROR]: 'SIZE_ERROR',
	[SYSTEM_STATUS.UNKNOWN_ERROR]: 'UNKNOWN_ERROR',
	[SYSTEM_STATUS.ILLEGAL_FILENAME]: 'ILLEGAL_FILENAME',
	[SYSTEM_STATUS.ILLEGAL_CONNECTION]: 'ILLEGAL_CONNECTION'
};

export interface FsFileEntry {
	name: string;
	size: number;
	md5: string;
}

export interface FsListResult {
	path: string;
	folders: string[];
	files: FsFileEntry[];
	truncated: boolean;
	totalBytes: number;
}

export class Ev3SystemCommandError extends ExtensionError {
	public readonly command: number;
	public readonly status: number;
	public readonly statusText: string;

	public constructor(command: number, status: number, message: string) {
		super('EV3_SYSTEM_COMMAND', message);
		this.name = 'Ev3SystemCommandError';
		this.command = command;
		this.status = status;
		this.statusText = SYSTEM_STATUS_TEXT[status] ?? `0x${status.toString(16)}`;
	}
}

interface RemoteFsServiceOptions {
	commandClient: Ev3CommandSendLike;
	capabilityProfile: CapabilityProfile;
	fsConfig: FsConfigSnapshot;
	defaultTimeoutMs?: number;
	logger?: Logger;
}

interface SystemCommandReply {
	status: number;
	data: Uint8Array;
}

interface SystemCommandSendOptions {
	idempotent: boolean;
}

function parseListPayload(data: Uint8Array): { folders: string[]; files: FsFileEntry[] } {
	const folders: string[] = [];
	const files: FsFileEntry[] = [];
	const lines = Buffer.from(data).toString('utf8').split('\n');

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0) {
			continue;
		}

		if (line.endsWith('/')) {
			folders.push(line.slice(0, -1));
			continue;
		}

		const parts = line.split(/\s+/, 3);
		if (parts.length < 3) {
			continue;
		}

		const md5 = parts[0];
		const size = Number.parseInt(parts[1], 16);
		const name = parts[2];
		if (!Number.isFinite(size)) {
			continue;
		}

		files.push({ name, size, md5 });
	}

	return { folders, files };
}

export class RemoteFsService {
	private readonly commandClient: Ev3CommandSendLike;
	private readonly capabilityProfile: CapabilityProfile;
	private readonly fsConfig: FsConfigSnapshot;
	private readonly defaultTimeoutMs: number;
	private readonly logger: Logger;
	private requestSeq = 0;

	public constructor(options: RemoteFsServiceOptions) {
		this.commandClient = options.commandClient;
		this.capabilityProfile = options.capabilityProfile;
		this.fsConfig = options.fsConfig;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? options.capabilityProfile.recommendedTimeoutMs;
		this.logger = options.logger ?? new NoopLogger();
	}

	public async listDirectory(path: string): Promise<FsListResult> {
		const normalizedPath = this.guardPath(path);
		const begin = await this.sendSystemCommand(
			SYSTEM_CMD.LIST_FILES,
			concatBytes(uint16le(LIST_CHUNK_FIRST), cString(normalizedPath)),
			[SYSTEM_STATUS.OK, SYSTEM_STATUS.END_OF_FILE],
			{ idempotent: true }
		);

		if (begin.data.length < 5) {
			throw new Error('LIST_FILES reply payload is too short.');
		}

		const totalBytes = readUint32le(begin.data, 0);
		let handle = begin.data[4];
		let raw = begin.data.subarray(5);
		let rest = Math.max(0, totalBytes - raw.length);
		let truncated = false;

		while (rest > 0) {
			if (!this.capabilityProfile.supportsContinueList) {
				truncated = true;
				break;
			}

			const partSize = Math.min(LIST_CHUNK_CONTINUE, rest);
			const next = await this.sendSystemCommand(
				SYSTEM_CMD.CONTINUE_LIST_FILES,
				concatBytes(new Uint8Array([handle]), uint16le(partSize)),
				[SYSTEM_STATUS.OK, SYSTEM_STATUS.END_OF_FILE],
				{ idempotent: true }
			);
			if (next.data.length < 1) {
				throw new Error('CONTINUE_LIST_FILES reply payload is too short.');
			}

			handle = next.data[0];
			const part = next.data.subarray(1);
			raw = concatBytes(raw, part);
			rest = Math.max(0, rest - part.length);

			if (next.status === SYSTEM_STATUS.END_OF_FILE) {
				break;
			}
		}

		await this.closeHandleBestEffort(handle);

		const parsed = parseListPayload(raw);
		return {
			path: normalizedPath,
			folders: parsed.folders,
			files: parsed.files,
			truncated,
			totalBytes
		};
	}

	public async readFile(path: string): Promise<Uint8Array> {
		const normalizedPath = this.guardPath(path);
		let lastError: unknown;

		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await this.readFileOnce(normalizedPath);
			} catch (error) {
				lastError = error;
				const recoverable =
					error instanceof Ev3SystemCommandError &&
					error.command === SYSTEM_CMD.CONTINUE_UPLOAD &&
					error.status === SYSTEM_STATUS.UNKNOWN_HANDLE &&
					attempt === 0;

				if (!recoverable) {
					throw error;
				}

				this.logger.info('Retrying readFile after CONTINUE_UPLOAD UNKNOWN_HANDLE', {
					path: normalizedPath
				});
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	public async writeFile(path: string, contents: Uint8Array): Promise<void> {
		const normalizedPath = this.guardPath(path);
		const begin = await this.sendSystemCommand(
			SYSTEM_CMD.BEGIN_DOWNLOAD,
			concatBytes(uint32le(contents.length), cString(normalizedPath)),
			[SYSTEM_STATUS.OK],
			{ idempotent: false }
		);

		if (begin.data.length < 1) {
			throw new Error('BEGIN_DOWNLOAD reply payload is too short.');
		}

		let handle = begin.data[0];
		let offset = 0;
		let completed = false;

		try {
			const chunkSize = Math.max(1, Math.min(DOWNLOAD_CHUNK_MAX, this.capabilityProfile.uploadChunkBytes));
			while (offset < contents.length) {
				const end = Math.min(contents.length, offset + chunkSize);
				const chunk = contents.subarray(offset, end);
				const isFinalChunk = end >= contents.length;
				const reply = await this.sendSystemCommand(
					SYSTEM_CMD.CONTINUE_DOWNLOAD,
					concatBytes(new Uint8Array([handle]), chunk),
					isFinalChunk ? [SYSTEM_STATUS.OK, SYSTEM_STATUS.END_OF_FILE] : [SYSTEM_STATUS.OK],
					{ idempotent: false }
				);

				if (reply.data.length < 1) {
					throw new Error('CONTINUE_DOWNLOAD reply payload is too short.');
				}
				handle = reply.data[0];
				offset = end;
				if (isFinalChunk && (reply.status === SYSTEM_STATUS.END_OF_FILE || reply.status === SYSTEM_STATUS.OK)) {
					completed = true;
				}
			}

			if (contents.length === 0) {
				completed = true;
			}
		} finally {
			if (!completed) {
				await this.closeHandleBestEffort(handle);
			}
		}
	}

	public async createDirectory(path: string): Promise<void> {
		const normalizedPath = this.guardPath(path);
		await this.sendSystemCommand(SYSTEM_CMD.CREATE_DIR, cString(normalizedPath), [SYSTEM_STATUS.OK], {
			idempotent: false
		});
	}

	public async deleteFile(path: string): Promise<void> {
		const normalizedPath = this.guardPath(path);
		await this.sendSystemCommand(SYSTEM_CMD.DELETE_FILE, cString(normalizedPath), [SYSTEM_STATUS.OK], {
			idempotent: false
		});
	}

	public async runBytecodeProgram(path: string): Promise<void> {
		const normalizedPath = this.guardPath(path);

		// Compound direct command:
		// opFILE(LOAD_IMAGE, USER_SLOT, LCS(path), GV0(0), GV0(4)),
		// opPROGRAM_START(USER_SLOT, GV0(0), GV0(4), LC0(0))
		const globalsAlloc = uint16le(8);
		const payload = concatBytes(
			globalsAlloc,
			new Uint8Array([DIRECT_OP.FILE]),
			lc0(DIRECT_FILE_SUBCMD.LOAD_IMAGE),
			lc2(DIRECT_VM_SLOT.USER),
			lcs(normalizedPath),
			gv0(0),
			gv0(4),
			new Uint8Array([DIRECT_OP.PROGRAM_START]),
			lc0(DIRECT_VM_SLOT.USER),
			gv0(0),
			gv0(4),
			lc0(0)
		);

		const requestId = `fs-run-${this.nextRequestSeq()}`;
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'high',
			idempotent: false,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.DIRECT_COMMAND_REPLY,
			payload
		});

		if (result.reply.type !== EV3_REPLY.DIRECT_REPLY) {
			throw new Error(`Program start failed with direct reply type 0x${result.reply.type.toString(16)}.`);
		}
	}

	private guardPath(path: string): string {
		const decision = evaluateFsAccess(path, {
			mode: this.fsConfig.mode,
			safeRoots: this.fsConfig.defaultRoots
		});

		if (!decision.allowed) {
			throw new PathPolicyError(decision.reason ?? `Access denied for path "${path}".`);
		}

		if (!decision.asciiSafe) {
			this.logger.warn('Non-ASCII path requested; stock firmware compatibility may be limited.', {
				path: decision.normalizedPath
			});
		}

		return decision.normalizedPath;
	}

	private async sendSystemCommand(
		command: number,
		commandPayload: Uint8Array,
		allowedStatuses: readonly number[],
		options: SystemCommandSendOptions
	): Promise<SystemCommandReply> {
		const requestId = `fs-${command.toString(16)}-${this.nextRequestSeq()}`;
		const payload = concatBytes(new Uint8Array([command]), commandPayload);
		const result = await this.commandClient.send({
			id: requestId,
			lane: 'normal',
			idempotent: options.idempotent,
			retry: options.idempotent
				? {
						maxRetries: 1,
						initialBackoffMs: 5,
						backoffFactor: 1,
						maxBackoffMs: 5,
						retryOn: ['EXECUTION_FAILED', 'TIMEOUT']
					}
				: undefined,
			timeoutMs: this.defaultTimeoutMs,
			type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
			payload
		});

		if (result.reply.type !== EV3_REPLY.SYSTEM_REPLY && result.reply.type !== EV3_REPLY.SYSTEM_REPLY_ERROR) {
			throw new Error(`Unexpected system reply type 0x${result.reply.type.toString(16)}.`);
		}
		if (result.reply.payload.length < 2) {
			throw new Error('System reply payload too short.');
		}

		const echoed = result.reply.payload[0];
		const status = result.reply.payload[1];
		if (echoed !== command) {
			throw new Error(
				`System reply command mismatch: expected 0x${command.toString(16)}, got 0x${echoed.toString(16)}.`
			);
		}

		const statusAllowed = allowedStatuses.includes(status);
		if (result.reply.type === EV3_REPLY.SYSTEM_REPLY_ERROR || !statusAllowed) {
			const statusText = SYSTEM_STATUS_TEXT[status] ?? `0x${status.toString(16)}`;
			throw new Ev3SystemCommandError(
				command,
				status,
				`System command 0x${command.toString(16)} failed with status ${statusText}.`
			);
		}

		return {
			status,
			data: result.reply.payload.subarray(2)
		};
	}

	private async readFileOnce(normalizedPath: string): Promise<Uint8Array> {
		const begin = await this.sendSystemCommand(
			SYSTEM_CMD.BEGIN_UPLOAD,
			concatBytes(uint16le(UPLOAD_CHUNK_FIRST), cString(normalizedPath)),
			[SYSTEM_STATUS.OK, SYSTEM_STATUS.END_OF_FILE],
			{ idempotent: true }
		);

		if (begin.data.length < 5) {
			throw new Error('BEGIN_UPLOAD reply payload is too short.');
		}

		const totalBytes = readUint32le(begin.data, 0);
		let handle = begin.data[4];
		let data = begin.data.subarray(5);
		let rest = Math.max(0, totalBytes - data.length);

		try {
			if (begin.status === SYSTEM_STATUS.END_OF_FILE) {
				return data.subarray(0, totalBytes);
			}

			while (rest > 0) {
				const partSize = Math.min(UPLOAD_CHUNK_CONTINUE, rest);
				const next = await this.sendSystemCommand(
					SYSTEM_CMD.CONTINUE_UPLOAD,
					concatBytes(new Uint8Array([handle]), uint16le(partSize)),
					[SYSTEM_STATUS.OK, SYSTEM_STATUS.END_OF_FILE],
					{ idempotent: true }
				);

				if (next.data.length < 1) {
					throw new Error('CONTINUE_UPLOAD reply payload is too short.');
				}

				handle = next.data[0];
				const part = next.data.subarray(1);
				data = concatBytes(data, part);
				rest = Math.max(0, rest - part.length);
				if (next.status === SYSTEM_STATUS.END_OF_FILE) {
					break;
				}
			}
		} finally {
			await this.closeHandleBestEffort(handle);
		}

		return data.subarray(0, totalBytes);
	}

	private async closeHandleBestEffort(handle: number): Promise<void> {
		if (!Number.isFinite(handle) || handle <= 0) {
			return;
		}

		try {
			await this.sendSystemCommand(
				SYSTEM_CMD.CLOSE_FILEHANDLE,
				new Uint8Array([handle & 0xff]),
				[SYSTEM_STATUS.OK, SYSTEM_STATUS.UNKNOWN_HANDLE],
				{ idempotent: true }
			);
		} catch (error) {
			if (error instanceof Ev3SystemCommandError && error.status === SYSTEM_STATUS.UNKNOWN_HANDLE) {
				return;
			}

			this.logger.warn('Failed to close EV3 file handle', {
				handle,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	private nextRequestSeq(): number {
		this.requestSeq += 1;
		return this.requestSeq;
	}
}
