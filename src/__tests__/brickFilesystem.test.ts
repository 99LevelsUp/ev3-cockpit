/**
 * The transport-to-packet-size decision, which is easy to get silently wrong.
 *
 * Every probe hardcoded this figure before it lived in one place, and the consequence of
 * getting it wrong is not an error but silent truncation: the brick advances its file
 * pointer by the length the host declared, so an over-sized chunk lands padding and
 * reports success.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickKey, BrickResponse, Transport, makeBrickKey } from '../contracts';
import { createBrickFilesystem, maxPacketBytesFor } from '../fs/brickFilesystem';
import { USB } from '../transports/transportConstants';

describe('maxPacketBytesFor', () => {
	it('falls back to what a HID write delivers when nothing knows better', () => {
		// The floor, not the truth: a USB session over libusb carries the full 1024 bytes.
		// This figure applies only when no live link has said which backend is in force, and
		// it errs tight on purpose — chunking small is slow, chunking large is silent
		// truncation.
		assert.equal(maxPacketBytesFor(Transport.USB), USB.MAX_WRITE_PACKET_BYTES);
	});

	it('leaves the stream transports on the firmware default', () => {
		// TCP and Bluetooth reach the firmware's own 1024-byte buffer, so imposing USB's
		// 64-byte figure on them would cost about a sixteenth of the throughput.
		assert.equal(maxPacketBytesFor(Transport.TCP), undefined);
		assert.equal(maxPacketBytesFor(Transport.BT), undefined);
		assert.equal(maxPacketBytesFor(Transport.Mock), undefined);
		assert.equal(maxPacketBytesFor(undefined), undefined);
	});
});

describe('createBrickFilesystem', () => {
	it('addresses every command to the brick it was built for', async () => {
		// One service per brick, so a command must never reach a different session.
		const seen: BrickKey[] = [];
		const sender = {
			send: (brickKey: BrickKey, _command: BrickCommand): Promise<BrickResponse> => {
				seen.push(brickKey);
				return Promise.resolve({ kind: 'fs:exists', exists: true });
			},
		};

		const key = makeBrickKey(Transport.TCP, '001653aabbcc');
		const fs = createBrickFilesystem(sender, key);
		await fs.files.exists('/p/x');

		assert.deepEqual(seen, [key]);
	});

	it('derives the packet cap from the key when the sender cannot say', async () => {
		// A USB transfer must chunk to 64 bytes without anyone passing that in.
		const chunks: number[] = [];
		const sender = {
			send: (_brickKey: BrickKey, command: BrickCommand): Promise<BrickResponse> => {
				if (command.kind === 'fs:beginWrite') {
					chunks.push(command.chunk.length);
					return Promise.resolve({
						kind: 'fs:beginWrite', handle: 1,
						endOfFile: command.chunk.length >= command.totalBytes,
					});
				}
				if (command.kind === 'fs:continueWrite') {
					chunks.push(command.chunk.length);
					return Promise.resolve({ kind: 'fs:continueWrite', handle: 1, endOfFile: false });
				}
				return Promise.resolve({ kind: 'fs:closeHandle' });
			},
		};

		const usb = createBrickFilesystem(sender, makeBrickKey(Transport.USB, 'aabbcc'));
		await usb.transfer.writeFile('/p/x', new Uint8Array(200)).catch(() => { /* short-circuits */ });

		assert.ok(chunks.length > 1, 'a 200-byte file must not fit one USB packet');
		assert.ok(
			chunks.every((n) => n + 7 <= USB.MAX_WRITE_PACKET_BYTES),
			`every chunk must fit a 64-byte packet, got ${chunks.join(',')}`
		);
	});

	it('lets the live link overrule the transport floor', async () => {
		// The half that is easy to leave undone. Reaching a full frame closes `copy` and
		// `move` on its own, but transfers keep chunking to 64 bytes until the figure the
		// session actually negotiated arrives here — slow, and nothing looks wrong.
		const chunks: number[] = [];
		const sender = {
			send: (_brickKey: BrickKey, command: BrickCommand): Promise<BrickResponse> => {
				if (command.kind === 'fs:beginWrite') {
					chunks.push(command.chunk.length);
					return Promise.resolve({
						kind: 'fs:beginWrite', handle: 1,
						endOfFile: command.chunk.length >= command.totalBytes,
					});
				}
				return Promise.resolve({ kind: 'fs:closeHandle' });
			},
			maxPacketBytes: (): number | undefined => 1024,
		};

		const usb = createBrickFilesystem(sender, makeBrickKey(Transport.USB, 'aabbcc'));
		await usb.transfer.writeFile('/p/x', new Uint8Array(600));

		assert.equal(chunks.length, 1, 'a 600-byte file fits one 1024-byte frame');
		assert.equal(chunks[0], 600);
	});
});
