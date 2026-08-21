/**
 * The libusb USB adapter, and the two measured quirks that make it work at all.
 *
 * Both are invisible in review and fatal in practice: a transfer shorter than
 * `wMaxPacketSize` is refused outright by libusb, and every read comes back full-length
 * so a reply has to be found by its own length prefix rather than by the transfer size.
 * Anyone "simplifying" either one gets a channel that fails on the first command.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UsbLibusbAdapter } from '../transports/usbLibusbAdapter';

const FRAME = 1024;
const INTERRUPT = 0x03;
const BULK = 0x02;

interface Recorded {
	sent: Buffer[];
	requestedReadLengths: number[];
	closed: number;
	released: number;
	claimed: number;
	openedDevices: string[];
	closedDevices: string[];
}

/** A reply in the brick's framing: length prefix, message counter, then a body. */
function replyPacket(counter: number, body: number[] = [0x02, 0x00]): Buffer {
	const payload = Buffer.from([counter & 0xff, (counter >> 8) & 0xff, 0x03, ...body]);
	const framed = Buffer.alloc(2 + payload.length);
	framed.writeUInt16LE(payload.length, 0);
	payload.copy(framed, 2);
	return framed;
}

/** What the wire actually hands back: the packet, then padding to the full frame. */
function paddedReply(counter: number, body?: number[]): Buffer {
	const frame = Buffer.alloc(FRAME);
	replyPacket(counter, body).copy(frame, 0);
	return frame;
}

interface FakeDeviceSpec {
	serial?: string;
	/** Defaults to an interrupt IN/OUT pair at 1024 bytes, like a real EV3. */
	endpoints?: { direction: 'in' | 'out'; type: number; maxPacketSize: number }[];
	replies?: Buffer[];
	/** Fails the OUT transfer with this message. */
	sendError?: string;
	claimError?: string;
	busNumber?: number;
	deviceAddress?: number;
}

function fakeUsb(specs: FakeDeviceSpec[]): { module: { getDeviceList: () => unknown[] }; log: Recorded } {
	const log: Recorded = {
		sent: [], requestedReadLengths: [], closed: 0, released: 0, claimed: 0,
		openedDevices: [], closedDevices: [],
	};

	const devices = specs.map((spec, index) => {
		const name = spec.serial ?? `device${index}`;
		const replies = [...(spec.replies ?? [])];
		const endpointSpecs = spec.endpoints ?? [
			{ direction: 'in' as const, type: INTERRUPT, maxPacketSize: FRAME },
			{ direction: 'out' as const, type: INTERRUPT, maxPacketSize: FRAME },
		];
		const endpoints = endpointSpecs.map((ep) => ({
			direction: ep.direction,
			descriptor: {
				bEndpointAddress: ep.direction === 'in' ? 0x81 : 0x01,
				bmAttributes: ep.type,
				wMaxPacketSize: ep.maxPacketSize,
			},
			timeout: 0,
			transfer(
				lengthOrData: number | Buffer,
				callback: (error: Error | undefined, data?: Buffer) => void,
			): void {
				if (ep.direction === 'out') {
					log.sent.push(Buffer.from(lengthOrData as Buffer));
					setImmediate(() => callback(
						spec.sendError ? new Error(spec.sendError) : undefined
					));
					return;
				}
				log.requestedReadLengths.push(lengthOrData as number);
				const next = replies.shift();
				setImmediate(() => next
					? callback(undefined, next)
					: callback(new Error('LIBUSB_ERROR_TIMEOUT')));
			},
		}));

		return {
			deviceDescriptor: { idVendor: 0x0694, idProduct: 0x0005, iSerialNumber: 3 },
			busNumber: spec.busNumber ?? 2,
			deviceAddress: spec.deviceAddress ?? 10 + index,
			open(): void { log.openedDevices.push(name); },
			close(): void { log.closed += 1; log.closedDevices.push(name); },
			interface(): unknown {
				return {
					endpoints,
					claim(): void {
						if (spec.claimError) { throw new Error(spec.claimError); }
						log.claimed += 1;
					},
					release(_close: boolean, callback: () => void): void {
						log.released += 1;
						callback();
					},
				};
			},
			getStringDescriptor(
				_index: number,
				callback: (error: Error | undefined, value?: string) => void,
			): void {
				setImmediate(() => callback(undefined, spec.serial));
			},
		};
	});

	return { module: { getDeviceList: () => devices }, log };
}

function adapterFor(specs: FakeDeviceSpec[], serial?: string): {
	adapter: UsbLibusbAdapter; log: Recorded;
} {
	const { module, log } = fakeUsb(specs);
	const adapter = new UsbLibusbAdapter({
		serial,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		moduleLoader: () => module as any,
	});
	return { adapter, log };
}

describe('UsbLibusbAdapter — packet size', () => {
	it('reports the frame the endpoint advertises, not an assumed figure', async () => {
		const { adapter } = adapterFor([{}]);
		assert.equal(adapter.maxPacketBytes, undefined, 'nothing has said anything yet');
		await adapter.open();
		assert.equal(adapter.maxPacketBytes, FRAME);
		await adapter.close();
		assert.equal(adapter.maxPacketBytes, undefined);
	});

	it('takes the smaller of the two directions when they disagree', async () => {
		const { adapter } = adapterFor([{
			endpoints: [
				{ direction: 'in', type: INTERRUPT, maxPacketSize: 512 },
				{ direction: 'out', type: INTERRUPT, maxPacketSize: FRAME },
			],
		}]);
		await adapter.open();
		// A transfer must match its endpoint exactly, so the tighter one governs.
		assert.equal(adapter.maxPacketBytes, 512);
		await adapter.close();
	});

	it('refuses a packet larger than the frame instead of truncating it', async () => {
		const { adapter } = adapterFor([{}]);
		await adapter.open();
		await assert.rejects(
			() => adapter.send(new Uint8Array(FRAME + 1)),
			/exceeds the 1024-byte frame/
		);
		await adapter.close();
	});
});

describe('UsbLibusbAdapter — the transfer quirks', () => {
	it('pads every send to the full frame, whatever the packet size', async () => {
		const { adapter, log } = adapterFor([{ replies: [paddedReply(1)] }]);
		await adapter.open();
		await adapter.send(new Uint8Array([0x05, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));
		await adapter.close();

		// Measured, not stylistic: libusb fails a short interrupt transfer with
		// LIBUSB_ERROR_IO, and the same packet padded to 1024 succeeds.
		assert.equal(log.sent.length, 1);
		assert.equal(log.sent[0].length, FRAME);
		assert.deepEqual([...log.sent[0].subarray(0, 7)], [0x05, 0, 0x01, 0, 0x01, 0, 0]);
		assert.ok(log.sent[0].subarray(7).every((b) => b === 0), 'the tail must be padding');
	});

	it('trims a full-frame reply down to the packet it declares', async () => {
		const { adapter, log } = adapterFor([{ replies: [paddedReply(1, [0x02, 0x00, 0x63])] }]);
		await adapter.open();
		const reply = await adapter.send(new Uint8Array([0x00, 0x00]), {
			expectedMessageCounter: 1,
		});
		await adapter.close();

		// The read is frame-sized whatever the reply is; the padding must not reach the codec.
		assert.equal(log.requestedReadLengths[0], FRAME);
		assert.equal(reply.length, 2 + 6, 'length prefix plus the six declared bytes');
		assert.deepEqual([...reply], [6, 0, 1, 0, 0x03, 0x02, 0x00, 0x63]);
	});

	it('rejects a reply that declares more than the transfer carried', async () => {
		const bogus = Buffer.alloc(FRAME);
		bogus.writeUInt16LE(4000, 0);
		const { adapter } = adapterFor([{ replies: [bogus] }]);
		await adapter.open();
		await assert.rejects(
			() => adapter.send(new Uint8Array([0x00, 0x00])),
			/shorter than the packet it declares/
		);
		await adapter.close();
	});
});

describe('UsbLibusbAdapter — reply matching', () => {
	it('steps over a reply left behind by an abandoned exchange', async () => {
		const { adapter } = adapterFor([{
			replies: [paddedReply(7), paddedReply(8)],
		}]);
		await adapter.open();
		const reply = await adapter.send(new Uint8Array([0x00, 0x00]), {
			expectedMessageCounter: 8,
		});
		await adapter.close();
		assert.equal(reply[2], 8, 'the stale counter-7 reply must not be handed back');
	});

	it('gives up rather than spinning on a channel that stays out of step', async () => {
		const { adapter } = adapterFor([{
			replies: Array.from({ length: 12 }, () => paddedReply(7)),
		}]);
		await adapter.open();
		await assert.rejects(
			() => adapter.send(new Uint8Array([0x00, 0x00]), { expectedMessageCounter: 99 }),
			/stayed out of step/
		);
		await adapter.close();
	});

	it('refuses a second send while one is in flight', async () => {
		const { adapter } = adapterFor([{ replies: [paddedReply(1)] }]);
		await adapter.open();
		const first = adapter.send(new Uint8Array([0x00, 0x00]));
		await assert.rejects(
			() => adapter.send(new Uint8Array([0x00, 0x00])),
			/in-flight send request/
		);
		await first;
		await adapter.close();
	});

	it('honours an abort signal', async () => {
		const { adapter } = adapterFor([{}]);
		await adapter.open();
		const controller = new AbortController();
		const pending = adapter.send(new Uint8Array([0x00, 0x00]), { signal: controller.signal });
		controller.abort();
		await assert.rejects(() => pending, /aborted/);
		await adapter.close();
	});
});

describe('UsbLibusbAdapter — device selection', () => {
	it('claims the brick whose serial was asked for', async () => {
		const { adapter, log } = adapterFor(
			[{ serial: '001653AABBCC' }, { serial: '001653DDEEFF', deviceAddress: 11 }],
			'001653ddeeff'
		);
		await adapter.open();
		assert.deepEqual(adapter.deviceLocation, { busNumber: 2, deviceAddress: 11 });
		await adapter.close();
	});

	it('closes the devices it opened only to read their serial', async () => {
		const { adapter, log } = adapterFor(
			[{ serial: '001653AABBCC' }, { serial: '001653DDEEFF' }],
			'001653ddeeff'
		);
		await adapter.open();
		// Leaving a handle open on a brick we did not want would block a later connect
		// to it — a leak that only shows up on the second connection.
		assert.ok(log.closedDevices.includes('001653AABBCC'));
		await adapter.close();
	});

	it('never opens a device another session is holding', async () => {
		// Resolving a serial means opening the device, and libusb hands out one handle per
		// device: opening and closing a brick another session has claimed drops that handle
		// and every later transfer on it fails with "Device is not open". Verified the hard
		// way — connecting a second brick killed the first.
		const { module, log } = fakeUsb([
			{ serial: '001653AABBCC', deviceAddress: 10 },
			{ serial: '001653DDEEFF', deviceAddress: 11 },
		]);
		const adapter = new UsbLibusbAdapter({
			serial: '001653ddeeff',
			inUse: (location) => location.deviceAddress === 10,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			moduleLoader: () => module as any,
		});
		await adapter.open();

		assert.ok(
			!log.openedDevices.includes('001653AABBCC'),
			'the in-use brick must not be opened even to read its serial'
		);
		assert.deepEqual(adapter.deviceLocation, { busNumber: 2, deviceAddress: 11 });
		await adapter.close();
	});

	it('names the serial it could not find', async () => {
		const { adapter } = adapterFor([{ serial: '001653AABBCC' }], '001653ddeeff');
		await assert.rejects(() => adapter.open(), /001653DDEEFF/);
	});

	it('reports an empty bus rather than throwing something opaque', async () => {
		const { adapter } = adapterFor([]);
		await assert.rejects(() => adapter.open(), /No EV3 found on the USB bus/);
	});
});

describe('UsbLibusbAdapter — open failures release what they took', () => {
	it('closes the device when the interface cannot be claimed', async () => {
		const { adapter, log } = adapterFor([{ claimError: 'LIBUSB_ERROR_ACCESS' }]);
		await assert.rejects(() => adapter.open(), /Could not claim USB interface 0/);
		assert.equal(log.closed, 1, 'an unclaimed device must not keep its handle');
		assert.equal(adapter.isOpen, false);
	});

	it('rejects an interface with no interrupt endpoint pair', async () => {
		const { adapter, log } = adapterFor([{
			endpoints: [
				{ direction: 'in', type: BULK, maxPacketSize: 512 },
				{ direction: 'out', type: BULK, maxPacketSize: 512 },
			],
		}]);
		// Interface 1 on an EV3 is mass storage with bulk endpoints. Picking endpoints by
		// direction alone would claim it and then hang on the first transfer.
		await assert.rejects(() => adapter.open(), /no interrupt endpoint pair/);
		assert.equal(log.released, 1);
		assert.equal(log.closed, 1);
	});
});
