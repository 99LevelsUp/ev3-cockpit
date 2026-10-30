/**
 * Binds the filesystem services to one connected brick.
 *
 * The two services need the same thing — a way to send a command to a specific brick —
 * and one thing they cannot work out for themselves: how large a packet that brick's
 * transport actually delivers. That figure lives here so it is decided once rather than
 * at each call site, which is how the probes ended up hardcoding it.
 */

import { BrickCommand, BrickRef, BrickResponse, SendCommandOptions, Transport } from '../contracts';
import { brickKeyTransport } from '../contracts/brickKey';
import { USB } from '../transports/transportConstants';
import { FilesystemService } from './filesystemService';
import { FileTransferService } from './fileTransferService';

/** What this module needs of a session manager. Narrow, so a test can stand in for one. */
export interface BrickSender {
	send(
		brickKey: BrickRef,
		command: BrickCommand,
		options?: SendCommandOptions,
	): Promise<BrickResponse>;

	/**
	 * Largest packet the live link carries, when the sender knows.
	 *
	 * Optional so a test double need not implement it; absent, the transport's own
	 * conservative figure applies.
	 */
	maxPacketBytes?(brickKey: BrickRef): number | undefined;
}

export interface BrickFilesystem {
	/** Metadata and structure operations. */
	readonly files: FilesystemService;
	/** Chunked reads and writes, with progress and cancellation. */
	readonly transfer: FileTransferService;
}

/**
 * Fallback packet size for a transport whose live link has not said, or `undefined` to
 * use the firmware's own 1024-byte buffer.
 *
 * This is the floor, not the truth. A USB brick reached over libusb carries the full
 * 1024 bytes; the same brick over HID carries 64, because a HID write puts 64 bytes on
 * the wire whatever report length it is handed. When nothing can say which backend is in
 * force, assume the tighter one: chunking small is slow, and chunking large is silent
 * truncation.
 */
export function maxPacketBytesFor(transport: Transport | undefined): number | undefined {
	return transport === Transport.USB ? USB.MAX_WRITE_PACKET_BYTES : undefined;
}

/**
 * Builds the filesystem surface for one brick.
 *
 * Commands go through the session manager, so they share the session's queue and its
 * ordering rather than racing the heartbeat.
 */
export function createBrickFilesystem(
	sender: BrickSender,
	brickKey: BrickRef,
): BrickFilesystem {
	const send = (command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> =>
		sender.send(brickKey, command, options);

	// The live link first: a USB session over libusb carries sixteen times what the
	// transport's own floor assumes, and asking the transport instead would leave every
	// transfer chunked to 64 bytes with nothing visibly wrong.
	const maxPacketBytes = sender.maxPacketBytes?.(brickKey)
		?? maxPacketBytesFor(brickKeyTransport(brickKey));

	return {
		files: new FilesystemService(send),
		transfer: new FileTransferService(
			send,
			maxPacketBytes === undefined ? undefined : { maxPacketBytes },
		),
	};
}
