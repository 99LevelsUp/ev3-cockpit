/**
 * Files put on a brick and a program started there, as one operation: the work a client would
 * otherwise do in several calls, holding the brick between them.
 *
 * In this order: nothing may run on the brick (a start into a running slot is refused by the
 * firmware in silence), then each file goes up — one whose MD5 on the brick already matches is
 * left, checked here so the answer cannot go stale between calls — then the program starts and
 * its start is confirmed. The operation ends where it reports how the start went, so whatever
 * holds the brick for it can let go there.
 *
 * A stop or emergency stop on the brick, from anyone, before the start ends the operation with a
 * {@link CancelledError} naming who stopped, and nothing starts: a stop pressed during an upload is
 * never followed by a start.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { operationDeadline } from '../contracts';
import { CancelledError, ErrorCode, ProgramError, ProtocolError } from '../errors/CockpitError';
import type { FilesystemService } from '../fs/filesystemService';
import { MAX_PATH_BYTES, type FileTransferService } from '../fs/fileTransferService';
import type { ProgramService, StartOutcome } from './programService';

/** Inline content larger than this is refused: a larger file is named by its local path. */
export const MAX_INLINE_BYTES = 4096;

/** One file to put on the brick: its content read from a local path, or given inline. */
export interface DeployFile {
	/** Where it goes on the brick. */
	readonly path: string;
	/** A file on this computer to read. */
	readonly localPath?: string;
	/** The content itself, at most {@link MAX_INLINE_BYTES}. */
	readonly content?: Uint8Array;
	/** Leave the brick's copy when its MD5 matches, checked within this operation. */
	readonly skipIfSame?: boolean;
}

export interface DeployAndRunRequest {
	readonly files: readonly DeployFile[];
	/** The program to start once the files are on the brick. */
	readonly program: string;
	/** Until when a lost route is waited out and an upload started again; the operation's own default otherwise. */
	readonly deadline?: number;
	readonly signal?: AbortSignal;
}

export interface DeployAndRunResult {
	/** How the start ended: the operation is over here, at the start it verified or could not. */
	readonly outcome: StartOutcome;
	/** The files put on the brick, in order. */
	readonly uploaded: readonly string[];
	/** The files left because the brick's copy matched. */
	readonly skipped: readonly string[];
}

/** One brick's services; the program service must be the one every client's stop goes through. */
export interface DeployAndRunServices {
	readonly programs: ProgramService;
	readonly files: FilesystemService;
	readonly transfer: FileTransferService;
}

export async function deployAndRun(services: DeployAndRunServices, request: DeployAndRunRequest): Promise<DeployAndRunResult> {
	const { programs, files, transfer } = services;
	// From here on, a stop from anyone ends this operation before its start.
	const since = programs.stopMark();
	const options = { deadline: request.deadline ?? operationDeadline('deployAndRun'), signal: request.signal };

	// Every file is checked and read before anything reaches the brick.
	for (const file of request.files) { check(file); }
	const contents = await Promise.all(request.files.map((file) => file.content ?? readFile(file.localPath as string)));

	const cancelled = (): void => {
		const { stopped, stoppedBy } = programs.stoppedSince(since);
		if (stopped) {
			throw new CancelledError(`${stoppedBy ?? 'Someone'} stopped the brick: nothing more was put on it and the program was not started.`,
				stoppedBy);
		}
	};

	if (await programs.isRunning(options)) {
		throw new ProgramError(ErrorCode.ProgramRunning, 'A program is running on the brick: stop it first. Nothing was put on the brick.');
	}
	const uploaded: string[] = [];
	const skipped: string[] = [];
	for (const [index, file] of request.files.entries()) {
		cancelled();
		const content = contents[index];
		if (file.skipIfSame && await sameOnBrick(files, file.path, content, options)) {
			skipped.push(file.path);
			continue;
		}
		cancelled();
		await transfer.writeFile(file.path, content, options);
		uploaded.push(file.path);
	}
	// The start itself refuses to go out after a stop since `since`, with nothing awaited between.
	const outcome = await programs.start(request.program, { since, ...options });
	return { outcome, uploaded, skipped };
}

function check(file: DeployFile): void {
	if ((file.localPath === undefined) === (file.content === undefined)) {
		throw new ProtocolError(`${file.path}: give either a local path or the content, not ${file.content ? 'both' : 'neither'}.`);
	}
	if (file.content && file.content.length > MAX_INLINE_BYTES) {
		throw new ProtocolError(`${file.path}: inline content is ${file.content.length} bytes; at most ${MAX_INLINE_BYTES} may be given inline, `
			+ 'a larger file by its local path.');
	}
	if (Buffer.byteLength(file.path, 'utf8') >= MAX_PATH_BYTES) {
		throw new ProtocolError(`${file.path}: the brick truncates a path at ${MAX_PATH_BYTES - 1} bytes.`);
	}
}

/** Whether the brick holds `path` with this content already, by the MD5 and size its listing gives. */
async function sameOnBrick(
	files: FilesystemService, path: string, content: Uint8Array, options: { deadline: number; signal?: AbortSignal },
): Promise<boolean> {
	const slash = path.lastIndexOf('/');
	const folder = slash > 0 ? path.slice(0, slash) : '/';
	const name = path.slice(slash + 1);
	let entries;
	try {
		entries = await files.list(folder, options);
	} catch (error) {
		// No such folder on the brick: nothing there to match.
		if (error instanceof ProtocolError) { return false; }
		throw error;
	}
	const entry = entries.find((e) => e.name === name && e.kind === 'file');
	if (!entry?.md5 || (entry.bytes !== undefined && entry.bytes !== content.length)) { return false; }
	return entry.md5 === createHash('md5').update(content).digest('hex');
}
