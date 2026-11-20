/**
 * Chunked file transfer, sequenced above the command layer.
 *
 * The command layer stays one-command-one-reply; multi-command protocols live here.
 * That split is deliberate: a transport should move one packet, not own a loop that
 * spans a thousand of them.
 *
 * Chunk size follows one packet size, which the caller passes; this service does not guess it.
 * The stock firmware's buffers are 1024 bytes on every channel (`c_com.c` sets both RX and TX
 * unconditionally), which caps a `CONTINUE_DOWNLOAD` payload at 1017, and that is the default.
 * The host transport can be tighter: a HID write on Windows delivers 64 bytes however large a
 * report it is handed. And over TCP or Bluetooth the user may set a larger packet for a
 * firmware that takes one (IMPLEMENTATION_PLAN 4.6.4), so the stock 1024 is not a ceiling here.
 */

import { BrickCommand, BrickResponse } from '../contracts';
import {
	FIRMWARE_BUFFER_BYTES,
	MAX_PROTOCOL_PACKET_BYTES,
	SYSTEM_ENVELOPE_BYTES,
	maxFirstChunkBytes,
} from '../protocol/ev3Commands';
import { ChannelChangedError, ConnectionError, ProtocolError, TimeoutError, TransportError } from '../errors/CockpitError';
import { TransferLedger, mayHaveRun } from './transferLedger';

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
	/**
	 * Waits until the brick has a route again, until a transfer's deadline; called before each
	 * channel is taken. Absent, a transfer takes the channel there is, or fails without one.
	 */
	readonly waitForRoute?: (options: { readonly deadline?: number; readonly signal?: AbortSignal }) => Promise<unknown>;
	/**
	 * Where a slot this service could not release is owed, and settled before the next transfer
	 * (4.6.17). Absent, nothing is owed: a slot the link took with it waits for the brick's reboot.
	 */
	readonly ledger?: TransferLedger;
}

/** A failure the brick answered: the command reached it. Anything else, it may not have. */
function brickAnswered(error: unknown): boolean {
	return error instanceof ProtocolError;
}

/**
 * Whether an upload that failed with `error` starts again: the route or a reply was lost — a
 * channel gone, a link fault, a reply that never came — and its deadline is not spent. Not when
 * the brick answered, nor when the caller cancelled.
 */
function mayStartAgain(error: unknown, options: TransferOptions | undefined): boolean {
	if (options?.deadline === undefined || Date.now() >= options.deadline || options.signal?.aborted) { return false; }
	return error instanceof ChannelChangedError || error instanceof TransportError
		|| error instanceof TimeoutError || error instanceof ConnectionError;
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

/**
 * The chunks one packet size carries. The packet is the link's (the firmware's 1024, or USB's
 * report) or the size the user set for TCP or Bluetooth (4.6.4), so nothing here caps it at the
 * stock firmware's buffer: that cap is the default packet, not a ceiling of its own. Only the
 * protocol's 16-bit length bounds it.
 */
function sizesFor(packetBytes: number): LinkSizes {
	const maxPacketBytes = Math.min(packetBytes, MAX_PROTOCOL_PACKET_BYTES);
	const maxChunkBytes = maxPacketBytes - SYSTEM_ENVELOPE_BYTES - 1;
	// Replies are bounded by the same packet size as sends. BEGIN_UPLOAD's reply header is
	// the largest -- echo, status, a 4-byte size and the handle on top of the 6-byte
	// envelope -- so size the request against that and every later chunk fits too.
	const maxReadBytes = maxPacketBytes - SYSTEM_ENVELOPE_BYTES - 1 - 4 - 1;
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
	/**
	 * The operation's deadline (`Date.now()` ms). Until then an upload whose route is lost, or
	 * whose reply is lost, waits for the route and starts again from its first chunk; a chunk
	 * whose reply was lost is never sent again on its own. It bounds the waiting and the
	 * restarts, not a transfer that is moving. Absent, a lost route or reply fails the transfer.
	 */
	readonly deadline?: number;
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
	private readonly waitForRoute?: TransferServiceOptions['waitForRoute'];
	private readonly ledger?: TransferLedger;

	constructor(private readonly send: SendCommand, options?: TransferServiceOptions) {
		this.pin = options?.pin;
		this.waitForRoute = options?.waitForRoute;
		this.ledger = options?.ledger;
		// Checked here when the size is fixed, so a link too small to carry a transfer fails
		// at construction rather than at the first file.
		if (!this.pin) {
			this.sizes = sizesFor(options?.maxPacketBytes ?? FIRMWARE_BUFFER_BYTES);
		}
	}

	/**
	 * The link this transfer runs over, taken once at its start — after the route is back, when
	 * the transfer has a deadline and the brick has none now.
	 */
	private async openLink(options?: TransferOptions): Promise<TransferLink> {
		if (options?.deadline !== undefined) {
			await this.waitForRoute?.({ deadline: options.deadline, signal: options.signal });
		}
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
	 *
	 * With a deadline, an upload that loses its route or a reply starts again until then: its
	 * slot abandoned and owed, the route waited for, the debt settled, and the file written from
	 * its first chunk on whichever channel carries traffic then. A chunk whose reply was lost is
	 * never sent again on its own — the brick may have taken it.
	 */
	async writeFile(path: string, content: Uint8Array, options?: TransferOptions): Promise<void> {
		assertPathFits(path);
		for (;;) {
			let end: (() => void) | undefined;
			try {
				const link = await this.openLink(options);
				// What an earlier transfer could not release is released first (4.6.17).
				end = await this.ledger?.begin(link.send);
				await this.write(link, path, content, options);
				// A whole file now: nothing owed may delete it.
				this.ledger?.written(path);
				return;
			} catch (error) {
				if (!mayStartAgain(error, options)) { throw error; }
			} finally {
				// Counted out before the next attempt, so its begin can settle what this one owes.
				end?.();
			}
		}
	}

	private async write(link: TransferLink, path: string, content: Uint8Array, options?: TransferOptions): Promise<void> {
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
		const begin = await this.first(withStallTimeout(
			link.send({
				kind: 'fs:beginWrite',
				path,
				totalBytes: total,
				chunk: content.subarray(0, firstSize),
			}),
			stallMs,
			0,
		), path);
		if (begin.kind !== 'fs:beginWrite') {
			throw new ProtocolError(`Expected a fs:beginWrite reply, got ${begin.kind}.`);
		}
		sent = firstSize;
		const handle = begin.handle;
		let endOfFile = begin.endOfFile;

		// From here the slot is open until end-of-file, so everything that can throw, the
		// caller's progress callback included, is inside the release (review of 6188670).
		/** The chunk on its way completes the file: losing its reply leaves the slot uncertain. */
		let lastInFlight = false;
		try {
			options?.onProgress?.({ transferred: sent, total });
			while (sent < total && !endOfFile) {
				this.assertNotAborted(options?.signal, handle);

				const size = Math.min(link.maxChunkBytes, total - sent);
				lastInFlight = sent + size >= total;
				const step = await withStallTimeout(
					link.send({
						kind: 'fs:continueWrite',
						handle,
						chunk: content.subarray(sent, sent + size),
					}),
					stallMs,
					sent,
				);
				lastInFlight = false;
				if (step.kind !== 'fs:continueWrite') {
					throw new ProtocolError(`Expected a fs:continueWrite reply, got ${step.kind}.`);
				}
				sent += size;
				endOfFile = step.endOfFile;
				options?.onProgress?.({ transferred: sent, total });
			}
		} catch (error) {
			// The firmware only frees the handle on end-of-file or its own error path, so an
			// abandoned transfer would otherwise hold one, and the file's space, until the brick
			// restarts. The partial file goes too: it is not the file anyone sent (4.6.17). After
			// end-of-file the slot is the firmware's again and the file whole: nothing to undo.
			// A complete file whose last progress report threw is still a complete file.
			if (!endOfFile) {
				await this.abandon(link, handle, path, lastInFlight && mayHaveRun(error));
			} else {
				this.ledger?.written(path);
			}
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
		const link = await this.openLink(options);
		const end = await this.ledger?.begin(link.send);
		try {
			return await this.read(link, path, options);
		} finally {
			end?.();
		}
	}

	private async read(link: TransferLink, path: string, options?: TransferOptions): Promise<Uint8Array> {
		const stallMs = options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
		const want = link.maxReadBytes;

		const begin = await this.first(withStallTimeout(
			link.send({ kind: 'fs:beginRead', path, wantBytes: want }),
			stallMs,
			0,
		));
		if (begin.kind !== 'fs:beginRead') {
			throw new ProtocolError(`Expected a fs:beginRead reply, got ${begin.kind}.`);
		}

		const total = begin.totalBytes;
		const parts: Uint8Array[] = [begin.chunk];
		let received = begin.chunk.length;
		let endOfFile = begin.endOfFile;
		const handle = begin.handle;

		/** The read on its way reaches the end: the brick frees the slot with it (see write). */
		let lastInFlight = false;
		try {
			options?.onProgress?.({ transferred: received, total });
			while (received < total && !endOfFile) {
				this.assertNotAborted(options?.signal, handle);

				const wantBytes = Math.min(want, total - received);
				lastInFlight = received + wantBytes >= total;
				const step = await withStallTimeout(
					link.send({
						kind: 'fs:continueRead',
						handle,
						wantBytes,
					}),
					stallMs,
					received,
				);
				lastInFlight = false;
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
			if (!endOfFile) { await this.abandon(link, handle, undefined, lastInFlight && mayHaveRun(error)); }
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

	/**
	 * A transfer's first command. When it fails without the brick answering, the brick may have
	 * opened a slot whose number never arrived: owed as a slot never learned (4.6.17).
	 */
	private async first<T>(work: Promise<T>, deletePath?: string): Promise<T> {
		try {
			return await work;
		} catch (error) {
			// Refused before it left (2.8.14, a pinned channel lost): the brick opened nothing.
			if (mayHaveRun(error)) {
				this.ledger?.owe({ kind: 'unknown', ...(deletePath !== undefined ? { deletePath } : {}) });
			}
			throw error;
		}
	}

	/**
	 * Releases a failed transfer's slot and, for an upload, deletes its partial file. What the link
	 * took with it is owed, to be settled before the next transfer; a failure here must not mask the
	 * original error.
	 *
	 * `uncertain`: the command that frees the slot (the last chunk) may have run with its reply lost.
	 * Then the brick may have handed the number on, so nothing is closed or deleted now: it is owed
	 * for the user to release (owner decision 17.11.2026, 4.6.17).
	 */
	private async abandon(link: TransferLink, handle: number, deletePath?: string, uncertain = false): Promise<void> {
		const owe = (doubt: boolean): void => this.ledger?.owe({
			kind: 'slot', handle, ...(deletePath !== undefined ? { deletePath } : {}), ...(doubt ? { uncertain: true as const } : {}),
		});
		if (uncertain) { owe(true); return; }
		try {
			await link.send({ kind: 'fs:closeHandle', handle });
		} catch (error) {
			if (!brickAnswered(error)) {
				// A close that may have run frees the slot for someone else: uncertain from then on.
				owe(mayHaveRun(error));
				return;
			}
		}
		if (deletePath === undefined) { return; }
		try {
			await link.send({ kind: 'fs:delete', path: deletePath });
		} catch (error) {
			if (!brickAnswered(error)) { this.ledger?.owe({ kind: 'delete', path: deletePath }); }
		}
	}

	/**
	 * Closes a slot whose transfer moved every byte but saw no end-of-file. The file is whole, so
	 * only the slot is owed when the link takes the close with it (review of 6188670); the brick
	 * answering anything means the slot is free (`c_com.c` 2116–2150).
	 */
	private async releaseHandle(link: TransferLink, handle: number): Promise<void> {
		try {
			await link.send({ kind: 'fs:closeHandle', handle });
		} catch (error) {
			if (!brickAnswered(error)) {
				this.ledger?.owe(mayHaveRun(error) ? { kind: 'slot', handle, uncertain: true } : { kind: 'slot', handle });
			}
		}
	}
}
