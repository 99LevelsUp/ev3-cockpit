/**
 * The transfer service is where a silent truncation is cheapest to introduce and most
 * expensive to notice: the brick advances its file pointer by the length the host
 * *declared*, so an under-delivered chunk still reports success and lands zero padding.
 * That is exactly what happened on real hardware, twice, in opposite directions.
 *
 * So these tests assert on what the brick received, not on whether the call resolved.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickResponse } from '../contracts';
import { FileTransferService } from '../fs/fileTransferService';
import { TimeoutError } from '../errors/CockpitError';

const HANDLE = 3;

/** A brick that honours the packet cap it is given, and records what it was sent. */
function fakeBrick(options?: { maxPacketBytes?: number; content?: Uint8Array }) {
	const cap = options?.maxPacketBytes ?? 1024;
	const written: number[] = [];
	let declared = 0;
	let stored = options?.content ? Buffer.from(options.content) : Buffer.alloc(0);
	let readOffset = 0;
	const commands: BrickCommand[] = [];

	const send = (command: BrickCommand): Promise<BrickResponse> => {
		commands.push(command);
		switch (command.kind) {
			case 'fs:beginWrite': {
				declared = command.totalBytes;
				stored = Buffer.from(command.chunk);
				written.push(command.chunk.length);
				return Promise.resolve({
					kind: 'fs:beginWrite',
					handle: HANDLE,
					endOfFile: stored.length >= declared,
				});
			}
			case 'fs:continueWrite': {
				// The wire packet is the 6-byte envelope plus the handle plus the payload.
				assert.ok(
					command.chunk.length + 7 <= cap,
					`chunk of ${command.chunk.length} exceeds the ${cap}-byte packet cap`
				);
				stored = Buffer.concat([stored, Buffer.from(command.chunk)]);
				written.push(command.chunk.length);
				return Promise.resolve({
					kind: 'fs:continueWrite',
					handle: HANDLE,
					endOfFile: stored.length >= declared,
				});
			}
			case 'fs:beginRead': {
				const chunk = stored.subarray(0, command.wantBytes);
				readOffset = chunk.length;
				return Promise.resolve({
					kind: 'fs:beginRead',
					handle: HANDLE,
					totalBytes: stored.length,
					endOfFile: readOffset >= stored.length,
					chunk: new Uint8Array(chunk),
				});
			}
			case 'fs:continueRead': {
				const chunk = stored.subarray(readOffset, readOffset + command.wantBytes);
				readOffset += chunk.length;
				return Promise.resolve({
					kind: 'fs:continueRead',
					handle: HANDLE,
					endOfFile: readOffset >= stored.length,
					chunk: new Uint8Array(chunk),
				});
			}
			case 'fs:closeHandle':
				return Promise.resolve({ kind: 'fs:closeHandle' });
			default:
				throw new Error(`unexpected command ${command.kind}`);
		}
	};

	return { send, written, commands, stored: () => stored };
}

function body(n: number): Uint8Array {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) { b[i] = 1 + ((i * 7) % 250); }
	return b;
}

describe('FileTransferService — writes', () => {
	it('delivers every byte of a file that spans many packets', async () => {
		const brick = fakeBrick();
		const svc = new FileTransferService(brick.send);
		const content = body(5000);

		await svc.writeFile('/x.raw', content);

		assert.equal(Buffer.compare(brick.stored(), Buffer.from(content)), 0);
		assert.ok(brick.written.length > 1, 'a 5000-byte file must take more than one packet');
	});

	it('honours a tighter packet cap, as USB HID requires', async () => {
		// USB delivers 64 bytes per HID write on this platform, so the service must chunk
		// to that and not to the firmware's roomier buffer. The fake asserts the cap.
		const brick = fakeBrick({ maxPacketBytes: 64 });
		const svc = new FileTransferService(brick.send, { maxPacketBytes: 64 });
		const content = body(300);

		await svc.writeFile('/x.raw', content);

		assert.equal(Buffer.compare(brick.stored(), Buffer.from(content)), 0);
		assert.ok(
			brick.written.every((n) => n + 7 <= 64),
			`every chunk must fit a 64-byte packet, got ${brick.written.join(',')}`
		);
	});

	it('reports progress that reaches the total', async () => {
		const brick = fakeBrick();
		const svc = new FileTransferService(brick.send);
		const seen: number[] = [];

		await svc.writeFile('/x.raw', body(3000), {
			onProgress: (p) => seen.push(p.transferred),
		});

		assert.ok(seen.length > 1, 'progress must be reported per chunk');
		assert.equal(seen[seen.length - 1], 3000);
		// Monotonic, so a consumer can drive a progress bar from it.
		for (let i = 1; i < seen.length; i++) {
			assert.ok(seen[i] > seen[i - 1], `progress went backwards: ${seen.join(',')}`);
		}
	});

	it('stops within one chunk of cancellation and releases the handle', async () => {
		const brick = fakeBrick();
		const controller = new AbortController();
		const svc = new FileTransferService(brick.send);

		await assert.rejects(
			() => svc.writeFile('/x.raw', body(5000), {
				signal: controller.signal,
				onProgress: () => controller.abort(),
			}),
			/cancelled/i
		);

		assert.ok(
			brick.commands.some((c) => c.kind === 'fs:closeHandle'),
			'an abandoned transfer must release the brick handle'
		);
	});

	it('refuses a path the firmware would truncate', async () => {
		const brick = fakeBrick();
		const svc = new FileTransferService(brick.send);
		// The firmware copies a path into a 60-byte buffer with snprintf, so a longer one
		// would have it act on a different file than the caller named.
		const tooLong = `/home/root/lms2012/prjs/${'d'.repeat(60)}.raw`;

		await assert.rejects(() => svc.writeFile(tooLong, body(10)), /truncates silently/);
		assert.equal(brick.commands.length, 0, 'nothing may reach the wire');
	});

	it('fails when the brick stalls instead of waiting forever', async () => {
		const svc = new FileTransferService(() => new Promise(() => { /* never settles */ }));
		await assert.rejects(
			() => svc.writeFile('/x.raw', body(10), { stallTimeoutMs: 40 }),
			(e: unknown) => e instanceof TimeoutError && /stalled/.test((e as Error).message)
		);
	});
});

describe('FileTransferService — reads', () => {
	it('reassembles a file that spans many packets', async () => {
		const content = body(5000);
		const brick = fakeBrick({ content });
		const svc = new FileTransferService(brick.send);

		const back = await svc.readFile('/x.raw');

		assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(content)), 0);
	});

	it('asks for no more than the packet cap allows', async () => {
		// A read reply carries the largest header of any transfer step, so requesting the
		// firmware's full chunk over USB overran the frame and silently truncated the tail.
		const content = body(400);
		const brick = fakeBrick({ maxPacketBytes: 64, content });
		const svc = new FileTransferService(brick.send, { maxPacketBytes: 64 });

		const back = await svc.readFile('/x.raw');

		assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(content)), 0);
		const wants = brick.commands
			.filter((c): c is Extract<BrickCommand, { kind: 'fs:beginRead' | 'fs:continueRead' }> =>
				c.kind === 'fs:beginRead' || c.kind === 'fs:continueRead')
			.map((c) => c.wantBytes);
		assert.ok(wants.length > 0);
		assert.ok(
			wants.every((w) => w + 12 <= 64),
			`every request must leave room for the reply header, got ${wants.join(',')}`
		);
	});
});
