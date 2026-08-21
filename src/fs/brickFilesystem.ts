/**
 * Binds the filesystem services to one connected brick.
 *
 * The two services need the same thing — a way to send a command to a specific brick —
 * and one thing they cannot work out for themselves: how large a packet that brick's
 * transport actually delivers. That figure lives here so it is decided once rather than
 * at each call site, which is how the probes ended up hardcoding it.
 */

import { BrickCommand, BrickKey, BrickResponse, SendCommandOptions, Transport } from '../contracts';
import { brickKeyTransport } from '../contracts/brickKey';
import { USB } from '../transports/transportConstants';
import { FilesystemService } from './filesystemService';
import { FileTransferService } from './fileTransferService';

/** What this module needs of a session manager. Narrow, so a test can stand in for one. */
export interface BrickSender {
	send(
		brickKey: BrickKey,
		command: BrickCommand,
		options?: SendCommandOptions,
	): Promise<BrickResponse>;
}

export interface BrickFilesystem {
	/** Metadata and structure operations. */
	readonly files: FilesystemService;
	/** Chunked reads and writes, with progress and cancellation. */
	readonly transfer: FileTransferService;
}

/**
 * Largest EV3 packet a transport delivers, or `undefined` to use the firmware's own
 * 1024-byte buffer.
 *
 * Only USB is tighter, and by a lot: a HID write puts 64 bytes on the wire whatever
 * report length it is handed. That caps transfer chunks and, less obviously, the size of
 * any single command — which is why `copy` and `move`, carrying two paths each, cannot be
 * sent over USB at all.
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
	brickKey: BrickKey,
): BrickFilesystem {
	const send = (command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> =>
		sender.send(brickKey, command, options);

	const maxPacketBytes = maxPacketBytesFor(brickKeyTransport(brickKey));

	return {
		files: new FilesystemService(send),
		transfer: new FileTransferService(
			send,
			maxPacketBytes === undefined ? undefined : { maxPacketBytes },
		),
	};
}
