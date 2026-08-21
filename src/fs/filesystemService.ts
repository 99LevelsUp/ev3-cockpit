/**
 * The filesystem service: every operation the protocol offers, as one surface.
 *
 * Sits on the service tier with telemetry and program control (DESIGN §4.3b), above the
 * command layer and below the public API. Usable without registering as an API consumer,
 * which is what makes it testable and what makes the mock worth having.
 *
 * Transfers live in {@link FileTransferService}; this class owns the single-command
 * operations and the two that need composing because the firmware has no primitive for
 * them.
 */

import {
	BrickCommand,
	BrickResponse,
	FsEntry,
	SendCommandOptions,
} from '../contracts';
import { ProtocolError, TransportError } from '../errors/CockpitError';

/** How the service reaches a brick. The command layer supplies this. */
export type SendCommand = (
	command: BrickCommand,
	options?: SendCommandOptions,
) => Promise<BrickResponse>;

/**
 * The firmware copies a path into a 60-byte buffer with `snprintf` rather than rejecting
 * an over-long one, so it would act on a different path than the caller named.
 */
export const MAX_PATH_BYTES = 60;

export interface StorageUsage {
	/** Kilobytes, as the firmware reports them. */
	readonly totalKb: number;
	readonly freeKb: number;
}

export interface FileSize {
	/**
	 * Kilobytes, rounded up — what the firmware reports. A 3-byte file is 1.
	 *
	 * For an exact file size read it from {@link FilesystemService.list}, whose entries
	 * carry a byte count the brick computed per file.
	 */
	readonly kilobytes: number;
	/**
	 * Files the total covers. **Zero for a plain file** — the firmware only counts
	 * while walking a directory.
	 */
	readonly files: number;
}

export class FilesystemService {
	constructor(private readonly send: SendCommand) {}

	// ── Reading ─────────────────────────────────────────────────────

	/**
	 * Lists a directory, following the brick's continuation when the listing does not fit
	 * one packet.
	 *
	 * `.` and `..` are dropped: they are real entries in the brick's reply, but a caller
	 * walking a tree with them recurses forever.
	 */
	async list(path: string, options?: SendCommandOptions): Promise<FsEntry[]> {
		this.assertPathFits(path);
		const reply = await this.expect('fs:list', { kind: 'fs:list', path }, options);

		const entries = [...reply.entries];
		let complete = reply.complete;
		let handle = reply.handle;

		// The firmware's own header calls CONTINUE_LIST_FILES unimplemented, but the
		// implementation in c_com.c has it, so page while the brick says there is more.
		let guard = 0;
		while (!complete && handle !== undefined && guard < LIST_PAGE_LIMIT) {
			guard += 1;
			const next = await this.expect(
				'fs:listContinue',
				{ kind: 'fs:listContinue', handle, wantBytes: LIST_CHUNK_BYTES },
				options,
			);
			if (next.entries.length === 0) { break; }
			entries.push(...next.entries);
			complete = next.complete;
			handle = next.handle;
		}
		if (!complete && guard >= LIST_PAGE_LIMIT) {
			throw new ProtocolError(
				`Listing of ${path} did not finish within ${LIST_PAGE_LIMIT} continuations.`
			);
		}

		return entries.filter((e) => e.name !== '.' && e.name !== '..');
	}

	/** True when the path resolves on the brick, whether file or directory. */
	async exists(path: string, options?: SendCommandOptions): Promise<boolean> {
		this.assertPathFits(path);
		const reply = await this.expect('fs:exists', { kind: 'fs:exists', path }, options);
		return reply.exists;
	}

	/**
	 * Space a path occupies, without listing its parent. For a directory, its whole tree.
	 *
	 * Reported in kilobytes rounded up, so it answers “how much room does this take”
	 * rather than “how many bytes is this file”. Use {@link list} for the latter.
	 */
	async size(path: string, options?: SendCommandOptions): Promise<FileSize> {
		this.assertPathFits(path);
		const reply = await this.expect('fs:size', { kind: 'fs:size', path }, options);
		return { kilobytes: reply.kilobytes, files: reply.files };
	}

	/** The brick's storage totals. */
	async storage(options?: SendCommandOptions): Promise<StorageUsage> {
		const reply = await this.expect('fs:freeSpace', { kind: 'fs:freeSpace' }, options);
		return { totalKb: reply.totalKb, freeKb: reply.freeKb };
	}

	// ── Structure ───────────────────────────────────────────────────

	/** Creates a directory. Succeeds when it already exists, as the firmware does. */
	async makeDirectory(path: string, options?: SendCommandOptions): Promise<void> {
		this.assertPathFits(path);
		const reply = await this.expect(
			'fs:makeDirectory',
			{ kind: 'fs:makeDirectory', path },
			options,
		);
		if (!reply.exists) {
			throw new TransportError(`The brick did not create ${path}.`);
		}
	}

	/**
	 * Removes a file, or an empty directory.
	 *
	 * A populated directory fails: the firmware's delete is POSIX `remove()`, which
	 * refuses one. Use {@link removeTree} deliberately instead — the brick has no trash.
	 */
	async remove(path: string, options?: SendCommandOptions): Promise<void> {
		this.assertPathFits(path);
		try {
			await this.expect('fs:delete', { kind: 'fs:delete', path }, options);
		} catch (error) {
			// The firmware reports ENOTEMPTY as NO_PERMISSION, which reads like an access
			// problem and sends the caller looking in the wrong place.
			const message = error instanceof Error ? error.message : String(error);
			if (/NO_PERMISSION/.test(message)) {
				throw new TransportError(
					`Cannot remove ${path}: it is a directory that is not empty, or it is not `
					+ 'writable. Use removeTree to delete a directory with contents.',
					error,
				);
			}
			throw error;
		}
	}

	/** Removes a path and everything beneath it. No confirmation, no undo on the brick. */
	async removeTree(path: string, options?: SendCommandOptions): Promise<void> {
		this.assertPathFits(path);
		await this.expect('fs:removeTree', { kind: 'fs:removeTree', path }, options);
	}

	/**
	 * Copies a file or directory tree on the brick.
	 *
	 * The copy runs brick-side, so its cost does not scale with the link: a large tree
	 * costs one command whatever the transport.
	 *
	 * **Not available over USB HID.** The command carries both paths, and a stock EV3
	 * project path is already 25 characters, so two of them exceed the 64 bytes a HID
	 * write delivers. TCP and Bluetooth carry it inside their 1024-byte packets. The
	 * adapter rejects the oversized packet rather than truncating it.
	 */
	async copy(from: string, to: string, options?: SendCommandOptions): Promise<void> {
		this.assertPathFits(from);
		this.assertPathFits(to);
		await this.expect('fs:copy', { kind: 'fs:copy', from, to }, options);
	}

	/**
	 * Renames or relocates a path.
	 *
	 * **Not atomic, and it cannot be.** The protocol has no rename: `opFILE/MOVE` runs
	 * `cp -r` and leaves the source, so this copies and then deletes. A failure between
	 * the two leaves both copies, and the error says so rather than pretending otherwise.
	 */
	async move(from: string, to: string, options?: SendCommandOptions): Promise<void> {
		await this.copy(from, to, options);
		try {
			await this.removeTree(from, options);
		} catch (error) {
			throw new TransportError(
				`Copied ${from} to ${to} but could not remove the original, so both now exist. `
				+ 'The protocol has no atomic rename; remove the source manually.',
				error,
			);
		}
	}

	// ── Internal ────────────────────────────────────────────────────

	private assertPathFits(path: string): void {
		const bytes = Buffer.byteLength(path, 'utf8');
		if (bytes >= MAX_PATH_BYTES) {
			throw new ProtocolError(
				`Path is ${bytes} bytes; the brick truncates silently at ${MAX_PATH_BYTES - 1}. `
				+ 'Refusing rather than acting on a different path than you named.'
			);
		}
	}

	/**
	 * Sends a command and narrows the reply to the kind that was asked for.
	 *
	 * A mismatched kind means the command and response tables disagree, which is a bug
	 * here rather than anything the brick did — worth an error that says which pair.
	 */
	private async expect<K extends BrickResponse['kind']>(
		kind: K,
		command: BrickCommand,
		options?: SendCommandOptions,
	): Promise<Extract<BrickResponse, { kind: K }>> {
		const reply = await this.send(command, options);
		if (reply.kind !== kind) {
			throw new ProtocolError(`Sent ${command.kind} but got a ${reply.kind} reply.`);
		}
		return reply as Extract<BrickResponse, { kind: K }>;
	}
}

/**
 * Continuations allowed for one listing before giving up.
 *
 * A directory listing is bounded by the brick's storage, so this only fires if the brick
 * never reports completion — a loop guard, not a size limit.
 */
const LIST_PAGE_LIMIT = 256;

/**
 * Bytes to ask for per continuation.
 *
 * Bounded by the firmware's 1024-byte buffer less the reply header, not by the host
 * transport: a reply is read, and reads are not subject to the USB write ceiling.
 */
const LIST_CHUNK_BYTES = 1000;
