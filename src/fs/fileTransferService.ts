/**
 * Chunked file transfer, sequenced above the command layer.
 *
 * The command layer stays one-command-one-reply; multi-command protocols live here.
 * That split is deliberate: a transport should move one packet, not own a loop that
 * spans a thousand of them.
 *
 * Chunk size has two ceilings and the lower one wins. The firmware's own buffers are
 * 1024 bytes on every channel (`c_com.c` sets both RX and TX unconditionally), which
 * caps a `CONTINUE_DOWNLOAD` payload at 1017. But the host transport can be tighter:
 * a HID write on Windows delivers 64 bytes however large a report it is handed, so USB
 * is the most constrained transport here rather than the least. The caller passes the
 * cap; this service does not guess it.
 */

import { BrickCommand, BrickResponse } from '../contracts';
import {
	FIRMWARE_BUFFER_BYTES,
	MAX_WRITE_CHUNK_BYTES,
	SYSTEM_ENVELOPE_BYTES,
	maxFirstChunkBytes,
} from '../protocol/ev3Commands';
import { ProtocolError, TimeoutError, TransportError } from '../errors/CockpitError';

/** How the service reaches a brick. Narrower than a provider on purpose. */
export type SendCommand = (command: BrickCommand) => Promise<BrickResponse>;

/** Progress of an in-flight transfer. */
export interface TransferProgress {
	/** Bytes moved so far. */
	readonly transferred: number;
	/**
	 * Total bytes expected, when known.
	 *
	 * A read learns the total from the brick's first reply, so the very first progress
	 * event of a read may not carry one.
	 */
	readonly total?: number;
}

/**
 * One channel a transfer holds for its whole length.
 *
 * A transfer is a run of commands against one brick-side file handle, sized to one link's
 * packets. When a brick is reached over several channels and traffic moves between them --
 * a cable plugged back in moves it from Bluetooth to USB -- a transfer that followed would
 * send chunks sized for one link over another, and address its handle over a link nobody
 * has measured it on. So it keeps the channel it started on, and fails when that channel is
 * lost rather than when a better one appears (step-2 plan, KD9).
 */
export interface PinnedLink {
	readonly send: SendCommand;
	/** Largest packet this channel carries; the firmware's buffer when omitted. */
	readonly maxPacketBytes?: number;
}

export interface TransferServiceOptions {
	/**
	 * Largest EV3 packet the transport delivers, in bytes.
	 *
	 * Defaults to the firmware's buffer, which is right for TCP and Bluetooth. USB HID
	 * must pass its own, much smaller, figure.
	 */
	readonly maxPacketBytes?: number;
	/**
	 * Takes a channel at the start of each transfer, to send every step of it over.
	 *
	 * When given, it decides both where the transfer goes and the packet size; neither
	 * `maxPacketBytes` nor the service's own `send` is used for transfers.
	 */
	readonly pin?: () => PinnedLink;
}

/** Chunk sizes for one link's packet size. */
interface LinkSizes {
	readonly maxPacketBytes: number;
	/** Room for a CONTINUE_DOWNLOAD payload: the packet less its header and the handle. */
	readonly maxChunkBytes: number;
	/** Room for a BEGIN_UPLOAD reply's payload, which carries a 4-byte size as well. */
	readonly maxReadBytes: number;
}

/** The link a transfer runs over: where it sends, and how large its chunks are. */
interface TransferLink extends LinkSizes {
	readonly send: SendCommand;
}

function sizesFor(maxPacketBytes: number): LinkSizes {
	const maxChunkBytes = Math.min(
		MAX_WRITE_CHUNK_BYTES,
		maxPacketBytes - SYSTEM_ENVELOPE_BYTES - 1,
	);
	// Replies are bounded by the same packet size as sends. BEGIN_UPLOAD's reply header is
	// the largest -- echo, status, a 4-byte size and the handle on top of the 6-byte
	// envelope -- so size the request against that and every later chunk fits too.
	const maxReadBytes = Math.min(
		MAX_WRITE_CHUNK_BYTES - 4,
		maxPacketBytes - SYSTEM_ENVELOPE_BYTES - 1 - 4 - 1,
	);
	if (maxReadBytes < 1) {
		throw new ProtocolError(`A ${maxPacketBytes}-byte packet leaves no room for a read payload.`);
	}
	if (maxChunkBytes < 1) {
		throw new ProtocolError(`A ${maxPacketBytes}-byte packet leaves no room for a transfer payload.`);
	}
	return { maxPacketBytes, maxChunkBytes, maxReadBytes };
}

export interface TransferOptions {
	/** Called at least once per chunk. */
	readonly onProgress?: (progress: TransferProgress) => void;
	/** Cancels the transfer; it stops within one chunk. */
	readonly signal?: AbortSignal;
	/**
	 * Fail if no chunk completes within this many milliseconds.
	 *
	 * A stall detector, not a total-duration budget. A 1 MB file over Bluetooth takes
	 * about 90 seconds by the link's own bandwidth, so a cap on total time would reject
	 * transfers that are working exactly as fast as they can.
	 */
	readonly stallTimeoutMs?: number;
}

/** Default stall window. Generous: it should only ever fire on a real stall. */
const DEFAULT_STALL_TIMEOUT_MS = 10_000;

/**
 * The firmware truncates a path into a 60-byte buffer with `snprintf` rather than
 * rejecting it, so an over-long path would have the brick act on a different file than
 * the caller named. Refuse before anything reaches the wire.
 */
export const MAX_PATH_BYTES = 60;

function assertPathFits(path: string): void {
	const bytes = Buffer.byteLength(path, 'utf8');
	if (bytes >= MAX_PATH_BYTES) {
		throw new ProtocolError(
			`Path is ${bytes} bytes; the brick truncates silently at ${MAX_PATH_BYTES - 1}. `
			+ 'Refusing rather than acting on a different path than you named.'
		);
	}
}

/** Races one step against the stall window, so a silent brick cannot hang a transfer. */
async function withStallTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
	transferred: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stalled = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new TimeoutError(
				`Transfer stalled: no chunk completed within ${timeoutMs} ms `
				+ `after ${transferred} bytes.`
			)),
			timeoutMs
		);
		timer.unref?.();
	});
	try {
		return await Promise.race([work, stalled]);
	} finally {
		if (timer) { clearTimeout(timer); }
	}
}

/**
 * Sequences chunked reads and writes over a single brick session.
 *
 * One instance per session; it holds no state between calls, so concurrent transfers on
 * the same brick are the caller's business — the command queue below already serialises
 * them, and the brick's handle table is what would run out.
 */
export class FileTransferService {
	private readonly sizes?: LinkSizes;
	private readonly pin?: () => PinnedLink;

	constructor(private readonly send: SendCommand, options?: TransferServiceOptions) {
		this.pin = options?.pin;
		// Checked here when the size is fixed, so a link too small to carry a transfer fails
		// at construction rather than at the first file.
		if (!this.pin) {
			this.sizes = sizesFor(options?.maxPacketBytes ?? FIRMWARE_BUFFER_BYTES);
		}
	}

	/** The link this transfer runs over, taken once at its start. */
	private openLink(): TransferLink {
		if (this.pin) {
			const link = this.pin();
			return { send: link.send, ...sizesFor(link.maxPacketBytes ?? FIRMWARE_BUFFER_BYTES) };
		}
		return { send: this.send, ...this.sizes! };
	}

	/**
	 * Writes `content` to `path` on the brick.
	 *
	 * `BEGIN_DOWNLOAD` carries the first chunk itself, so a file that fits in one packet
	 * completes in a single command. Everything beyond it goes through
	 * `CONTINUE_DOWNLOAD` until the brick reports end-of-file.
	 */
	async writeFile(path: string, content: Uint8Array, options?: TransferOptions): Promise<void> {
		assertPathFits(path);
		const link = this.openLink();
		const stallMs = options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
		const total = content.length;

		const firstSize = Math.min(
			maxFirstChunkBytes(path, link.maxPacketBytes),
			total,
		);
		if (firstSize < 0) {
			throw new ProtocolError(
				`No room for payload after a ${path.length}-character path in BEGIN_DOWNLOAD.`
			);
		}

		let sent = 0;
		const begin = await withStallTimeout(
			link.send({
				kind: 'fs:beginWrite',
				path,
				totalBytes: total,
				chunk: content.subarray(0, firstSize),
			}),
			stallMs,
			0,
		);
		if (begin.kind !== 'fs:beginWrite') {
			throw new ProtocolError(`Expected a fs:beginWrite reply, got ${begin.kind}.`);
		}
		sent = firstSize;
		options?.onProgress?.({ transferred: sent, total });

		const handle = begin.handle;
		let endOfFile = begin.endOfFile;

		try {
			while (sent < total && !endOfFile) {
				this.assertNotAborted(options?.signal, handle);

				const size = Math.min(link.maxChunkBytes, total - sent);
				const step = await withStallTimeout(
					link.send({
						kind: 'fs:continueWrite',
						handle,
						chunk: content.subarray(sent, sent + size),
					}),
					stallMs,
					sent,
				);
				if (step.kind !== 'fs:continueWrite') {
					throw new ProtocolError(`Expected a fs:continueWrite reply, got ${step.kind}.`);
				}
				sent += size;
				endOfFile = step.endOfFile;
				options?.onProgress?.({ transferred: sent, total });
			}
		} catch (error) {
			// The firmware only frees the handle on end-of-file or its own error path, so an
			// abandoned transfer would otherwise hold one until the brick restarts.
			await this.releaseHandle(link, handle);
			throw error;
		}

		if (sent < total) {
			throw new ProtocolError(
				`Brick reported end of file after ${sent} of ${total} bytes.`
			);
		}
		// On end-of-file the firmware has already closed and freed the handle; closing
		// again would address a handle that no longer exists.
		if (!endOfFile) {
			await this.releaseHandle(link, handle);
		}
	}

	/**
	 * Reads `path` from the brick in full.
	 *
	 * The brick reports the total size in its first reply, so the buffer is sized once
	 * rather than grown per chunk.
	 */
	async readFile(path: string, options?: TransferOptions): Promise<Uint8Array> {
		assertPathFits(path);
		const link = this.openLink();
		const stallMs = options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
		const want = link.maxReadBytes;

		const begin = await withStallTimeout(
			link.send({ kind: 'fs:beginRead', path, wantBytes: want }),
			stallMs,
			0,
		);
		if (begin.kind !== 'fs:beginRead') {
			throw new ProtocolError(`Expected a fs:beginRead reply, got ${begin.kind}.`);
		}

		const total = begin.totalBytes;
		const parts: Uint8Array[] = [begin.chunk];
		let received = begin.chunk.length;
		let endOfFile = begin.endOfFile;
		const handle = begin.handle;
		options?.onProgress?.({ transferred: received, total });

		try {
			while (received < total && !endOfFile) {
				this.assertNotAborted(options?.signal, handle);

				const step = await withStallTimeout(
					link.send({
						kind: 'fs:continueRead',
						handle,
						wantBytes: Math.min(want, total - received),
					}),
					stallMs,
					received,
				);
				if (step.kind !== 'fs:continueRead') {
					throw new ProtocolError(`Expected a fs:continueRead reply, got ${step.kind}.`);
				}
				if (step.chunk.length === 0 && !step.endOfFile) {
					throw new ProtocolError(
						`Brick returned an empty chunk after ${received} of ${total} bytes `
						+ 'without reporting end of file.'
					);
				}
				parts.push(step.chunk);
				received += step.chunk.length;
				endOfFile = step.endOfFile;
				options?.onProgress?.({ transferred: received, total });
			}
		} catch (error) {
			await this.releaseHandle(link, handle);
			throw error;
		}

		if (received < total) {
			throw new ProtocolError(
				`Brick reported end of file after ${received} of ${total} bytes.`
			);
		}
		if (!endOfFile) {
			await this.releaseHandle(link, handle);
		}

		return Buffer.concat(parts.map((p) => Buffer.from(p)), total);
	}

	private assertNotAborted(signal: AbortSignal | undefined, handle: number): void {
		if (signal?.aborted) {
			// Thrown into the caller's try, which releases the handle before rethrowing.
			void handle;
			throw new TransportError('Transfer cancelled.');
		}
	}

	/** Best-effort handle release; a failure here must not mask the original error. */
	private async releaseHandle(link: TransferLink, handle: number): Promise<void> {
		try {
			await link.send({ kind: 'fs:closeHandle', handle });
		} catch {
			// The handle is unusable either way, and the brick frees it on restart.
		}
	}
}
