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
import { DevicePermissionError } from '../errors/CockpitError';

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
	/** IN transfers held back by `holdReads`, to call back when the test decides. */
	heldReads: ((error: Error | undefined, data?: Buffer) => void)[];
	/** What happened, in order: `read-callback`, `release`, `close`. */
	events: string[];
	/** Clear-halts held back by `holdClearHalt`, to call back when the test decides. */
	heldClearHalts: (() => void)[];
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
	/** IN transfers never call back on their own: a read still in flight inside libusb. */
	holdReads?: boolean;
	/**
	 * A kernel driver holds the interface, as Linux's `usbhid` holds an EV3's: the claim fails
	 * with LIBUSB_ERROR_BUSY until the driver is detached (measured on HOSTC, 13.11.2026).
	 */
	kernelDriverActive?: boolean;
	/** The device offers libusb's auto-detach (`setAutoDetachKernelDriver`). Default true. */
	autoDetach?: boolean;
	/** `open()` throws this, as libusb does for a device the user may not open. */
	openError?: string;
	/** `clearHalt` holds its callback until the test calls {@link Recorded.heldClearHalts}. */
	holdClearHalt?: boolean;
	/** `clearHalt` never calls back at all. */
	clearHaltNeverAnswers?: boolean;
	/** `clearHalt` calls back with this error. */
	clearHaltError?: string;
}

function fakeUsb(specs: FakeDeviceSpec[]): { module: { getDeviceList: () => unknown[] }; log: Recorded } {
	const log: Recorded = {
		sent: [], requestedReadLengths: [], closed: 0, released: 0, claimed: 0,
		openedDevices: [], closedDevices: [], heldReads: [], events: [], heldClearHalts: [],
	};

	const devices = specs.map((spec, index) => {
		const name = spec.serial ?? `device${index}`;
		const replies = [...(spec.replies ?? [])];
		const endpointSpecs = spec.endpoints ?? [
			{ direction: 'in' as const, type: INTERRUPT, maxPacketSize: FRAME },
			{ direction: 'out' as const, type: INTERRUPT, maxPacketSize: FRAME },
		];
		let kernelHeld = spec.kernelDriverActive ?? false;
		let autoDetachOn = false;
		/**
		 * After the kernel driver is taken off, the endpoints' data toggle no longer matches the
		 * brick's and the first reply is dropped as a duplicate, until a clear-halt resets both
		 * sides (HOSTC, 13.11.2026: the first exchange after every detach timed out).
		 */
		let toggleOutOfStep = false;
		const kernelSeams = spec.autoDetach === false ? {} : {
			setAutoDetachKernelDriver(enable: boolean): void {
				autoDetachOn = enable;
				log.events.push(`autoDetach:${enable}`);
			},
		};
		const endpoints = endpointSpecs.map((ep) => ({
			direction: ep.direction,
			descriptor: {
				bEndpointAddress: ep.direction === 'in' ? 0x81 : 0x01,
				bmAttributes: ep.type,
				wMaxPacketSize: ep.maxPacketSize,
			},
			timeout: 0,
			clearHalt(callback: (error?: Error) => void): void {
				log.events.push(`clearHalt:${ep.direction}`);
				if (spec.clearHaltNeverAnswers) { return; }
				const answer = (): void => {
					if (!spec.clearHaltError) { toggleOutOfStep = false; }
					callback(spec.clearHaltError ? new Error(spec.clearHaltError) : undefined);
				};
				if (spec.holdClearHalt) { log.heldClearHalts.push(answer); return; }
				setImmediate(answer);
			},
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
				if (toggleOutOfStep) {
					toggleOutOfStep = false;
					replies.shift();
					setImmediate(() => callback(new Error('LIBUSB_TRANSFER_TIMED_OUT')));
					return;
				}
				if (spec.holdReads) {
					log.heldReads.push((error, data) => { log.events.push('read-callback'); callback(error, data); });
					return;
				}
				const next = replies.shift();
				setImmediate(() => next
					? callback(undefined, next)
					: callback(new Error('LIBUSB_ERROR_TIMEOUT')));
			},
		}));

		return {
			...kernelSeams,
			deviceDescriptor: { idVendor: 0x0694, idProduct: 0x0005, iSerialNumber: 3 },
			busNumber: spec.busNumber ?? 2,
			deviceAddress: spec.deviceAddress ?? 10 + index,
			open(): void {
				if (spec.openError) { throw new Error(spec.openError); }
				log.openedDevices.push(name);
			},
			close(): void { log.closed += 1; log.closedDevices.push(name); log.events.push('close'); },
			interface(): unknown {
				return {
					endpoints,
					claim(): void {
						if (spec.claimError) { throw new Error(spec.claimError); }
						if (kernelHeld && !autoDetachOn) { throw new Error('LIBUSB_ERROR_BUSY'); }
						if (kernelHeld) { kernelHeld = false; toggleOutOfStep = true; log.events.push('auto-detached'); }
						log.claimed += 1;
						log.events.push('claim');
					},
					release(_close: boolean, callback: () => void): void {
						log.released += 1;
						log.events.push('release');
						callback();
					},
					isKernelDriverActive(): boolean { return kernelHeld; },
					detachKernelDriver(): void { kernelHeld = false; toggleOutOfStep = true; log.events.push('detach'); },
					attachKernelDriver(): void { kernelHeld = true; log.events.push('attach'); },
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

function adapterFor(specs: FakeDeviceSpec[], serial?: string, readSlackBytes = 0, platform?: NodeJS.Platform): {
	adapter: UsbLibusbAdapter; log: Recorded;
} {
	const { module, log } = fakeUsb(specs);
	const adapter = new UsbLibusbAdapter({
		serial,
		readSlackBytes,
		...(platform ? { platform } : {}),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		moduleLoader: () => module as any,
	});
	return { adapter, log };
}

describe('UsbLibusbAdapter — closing with a transfer still in libusb', () => {
	it('waits for an abandoned read to call back before releasing and closing the device', async () => {
		// A send that timed out on the JS side leaves its libusb transfer pending. Releasing the
		// interface and closing the device under it let the late callback land in freed native
		// memory: the extension host crashed with an access violation in node-usb (30.10.2026),
		// minutes after a name probe had timed out.
		const { adapter, log } = adapterFor([{ serial: '001653AABBCC', holdReads: true }], '001653AABBCC');
		await adapter.open();
		log.events.length = 0;   // finding the device by serial opens and closes it once
		await assert.rejects(adapter.send(replyPacket(1), { timeoutMs: 30 }), /budget/);

		const closing = adapter.close();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(log.events, [], 'nothing may be released while libusb still holds a transfer');

		log.heldReads.shift()!(new Error('LIBUSB_TRANSFER_CANCELLED'));
		await closing;
		assert.deepEqual(log.events, ['read-callback', 'release', 'close']);
	});
});

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

	it('gives libusb\'s Windows HID read the extra byte it writes past the frame', async () => {
		// libusb on Windows copies the report id's byte too: a 1024-byte read writes 1025. That
		// byte past a JS buffer took the extension host down (30.10.2026); a reply of 1025 bytes
		// must still come out as the packet it declares.
		const reply1025 = Buffer.concat([paddedReply(1, [0x02, 0x00, 0x63]), Buffer.from([0x00])]);
		const { adapter, log } = adapterFor([{ replies: [reply1025] }], undefined, 1);
		await adapter.open();
		const reply = await adapter.send(new Uint8Array([0x00, 0x00]), { expectedMessageCounter: 1 });
		await adapter.close();

		assert.equal(log.requestedReadLengths[0], FRAME + 1);
		assert.deepEqual([...reply], [6, 0, 1, 0, 0x03, 0x02, 0x00, 0x63]);
	});

	it('asks for the extra byte on Windows only, where libusb reads through HID', async () => {
		const { module, log } = fakeUsb([{ replies: [paddedReply(1)] }]);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const adapter = new UsbLibusbAdapter({ moduleLoader: () => module as any });
		await adapter.open();
		await adapter.send(new Uint8Array([0x00, 0x00]));
		await adapter.close();

		// Elsewhere a full packet is not a short one, and a longer read would wait for more.
		assert.equal(log.requestedReadLengths[0], process.platform === 'win32' ? FRAME + 1 : FRAME);
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

describe('UsbLibusbAdapter — a kernel driver holding the interface (Linux, HOSTC 13.11.2026)', () => {
	// On Linux the kernel's `usbhid` binds the EV3's interface 0, so a bare claim fails with
	// LIBUSB_ERROR_BUSY and every Linux user silently lands on 64-byte HID. Detaching works as a
	// normal user and gives the 1024-byte endpoints.

	it('turns on auto-detach before the claim, so the interface is claimed', async () => {
		const { adapter, log } = adapterFor([{ kernelDriverActive: true }], undefined, 0, 'linux');
		await adapter.open();
		assert.equal(adapter.isOpen, true);
		assert.equal(adapter.maxPacketBytes, FRAME);
		assert.deepEqual(log.events.slice(0, 3), ['autoDetach:true', 'auto-detached', 'claim']);
	});

	it('without auto-detach, detaches before the claim and reattaches after the release', async () => {
		const { adapter, log } = adapterFor([{ kernelDriverActive: true, autoDetach: false }], undefined, 0, 'linux');
		await adapter.open();
		assert.equal(adapter.isOpen, true);
		await adapter.close();
		assert.deepEqual(log.events, ['detach', 'claim', 'clearHalt:in', 'clearHalt:out', 'release', 'attach', 'close']);
	});

	it('leaves an interface no kernel driver holds alone', async () => {
		const { adapter, log } = adapterFor([{ kernelDriverActive: false, autoDetach: false }], undefined, 0, 'linux');
		await adapter.open();
		await adapter.close();
		assert.deepEqual(log.events, ['claim', 'clearHalt:in', 'clearHalt:out', 'release', 'close']);
	});

	it('gives the driver back and closes when the claim fails after a detach', async () => {
		const { adapter, log } = adapterFor(
			[{ kernelDriverActive: true, autoDetach: false, claimError: 'LIBUSB_ERROR_IO' }], undefined, 0, 'linux');
		await assert.rejects(() => adapter.open(), /Could not claim USB interface 0/);
		assert.deepEqual(log.events, ['detach', 'attach', 'close']);
		assert.equal(adapter.isOpen, false);
	});

	it('clears both endpoints after taking the interface from the kernel, so the first reply arrives', async () => {
		const { adapter, log } = adapterFor([{ kernelDriverActive: true, replies: [paddedReply(1)] }], undefined, 0, 'linux');
		await adapter.open();
		const claimAt = log.events.indexOf('claim');
		assert.ok(log.events.indexOf('clearHalt:in') > claimAt, 'IN cleared after the claim');
		assert.ok(log.events.indexOf('clearHalt:out') > claimAt, 'OUT cleared after the claim');
		const reply = await adapter.send(replyPacket(1), { expectedMessageCounter: 1, timeoutMs: 1000 });
		assert.equal(reply[2], 1);
	});

	it('never touches the kernel driver on Windows', async () => {
		const { adapter, log } = adapterFor([{ kernelDriverActive: false }], undefined, 0, 'win32');
		await adapter.open();
		await adapter.close();
		assert.deepEqual(log.events, ['claim', 'release', 'close'], 'no detach and no clear-halt on Windows');
	});
});

describe('UsbLibusbAdapter — a device this user may not open (Linux, HOSTC 13.11.2026)', () => {
	// Without the udev rule every EV3 node is root-only. The serial lookup swallowed the
	// LIBUSB_ERROR_ACCESS and said "No EV3 on the USB bus reports serial …", which sends a user
	// looking for the wrong brick instead of at the permissions.

	it('says permission, and names the udev rule, when every candidate refuses to open', async () => {
		const { adapter } = adapterFor(
			[{ serial: 'aaa', openError: 'LIBUSB_ERROR_ACCESS' }, { serial: 'bbb', openError: 'LIBUSB_ERROR_ACCESS' }],
			'aaa', 0, 'linux');
		const error = await adapter.open().then(() => undefined, (e: unknown) => e);
		assert.ok(error instanceof DevicePermissionError, `got ${String(error)}`);
		assert.match((error as Error).message, /LIBUSB_ERROR_ACCESS/);
		assert.match((error as Error).message, /native\/linux\/70-lego-ev3\.rules/);
		assert.match((error as Error).message, /\/etc\/udev\/rules\.d/);
	});

	it('says permission when the one brick it would take refuses to open', async () => {
		const { adapter } = adapterFor([{ openError: 'LIBUSB_ERROR_ACCESS' }], undefined, 0, 'linux');
		await assert.rejects(() => adapter.open(), DevicePermissionError);
	});

	it('says permission when a device it could not open might be the brick asked for', async () => {
		const { adapter } = adapterFor(
			[{ serial: 'bbb' }, { serial: 'ccc', openError: 'LIBUSB_ERROR_ACCESS' }], 'aaa', 0, 'linux');
		const error = await adapter.open().then(() => undefined, (e: unknown) => e);
		assert.ok(error instanceof DevicePermissionError,
			'a refusing device may be the brick asked for: its serial could not be read');
	});

	it('keeps the Windows message as it was', async () => {
		const { adapter } = adapterFor([{ serial: 'aaa', openError: 'LIBUSB_ERROR_ACCESS' }], 'aaa', 0, 'win32');
		const error = await adapter.open().then(() => undefined, (e: unknown) => e);
		assert.ok(!(error instanceof DevicePermissionError));
		assert.match((error as Error).message, /No EV3 on the USB bus reports serial AAA/);
	});
});

describe('UsbLibusbAdapter — a stale packet after a fresh plug (Linux, HOSTC 13.11.2026)', () => {
	// Plugged in and claimed, AAA had one packet of garbage waiting on its IN endpoint: read at
	// once, before anything was sent. The first exchange then failed with "shorter than the
	// packet it declares" and the next ones worked, on each of two re-plugs.
	function bogus(): Buffer {
		const frame = Buffer.alloc(FRAME);
		frame.writeUInt16LE(4000, 0);
		frame[600] = 0x7e;
		return frame;
	}

	it('steps over an unreadable reply when it is waiting for a known counter', async () => {
		const { adapter } = adapterFor([{ replies: [bogus(), paddedReply(1)] }], undefined, 0, 'linux');
		await adapter.open();
		const reply = await adapter.send(new Uint8Array([0x00, 0x00]), { expectedMessageCounter: 1 });
		assert.equal(reply[2], 1);
		await adapter.close();
	});

	it('still gives up on a channel that answers nothing readable', async () => {
		const { adapter } = adapterFor([{ replies: Array.from({ length: 12 }, () => bogus()) }], undefined, 0, 'linux');
		await adapter.open();
		await assert.rejects(
			() => adapter.send(new Uint8Array([0x00, 0x00]), { expectedMessageCounter: 1 }),
			/stayed out of step/
		);
		await adapter.close();
	});

	it('keeps rejecting it on Windows', async () => {
		const { adapter } = adapterFor([{ replies: [bogus(), paddedReply(1)] }], undefined, 0, 'win32');
		await adapter.open();
		await assert.rejects(
			() => adapter.send(new Uint8Array([0x00, 0x00]), { expectedMessageCounter: 1 }),
			/shorter than the packet it declares/
		);
		await adapter.close();
	});
});

describe('UsbLibusbAdapter — a close while the open is still clearing (review of 2dacf24)', () => {
	async function settle(): Promise<void> {
		for (let i = 0; i < 20; i += 1) { await new Promise((r) => setImmediate(r)); }
	}
	it('releases everything and does not come up open when closed during the clear-halt', async () => {
		const { adapter, log } = adapterFor([{ kernelDriverActive: true, autoDetach: false, holdClearHalt: true }], undefined, 0, 'linux');
		const opening = adapter.open().then(() => 'opened', (e: unknown) => e);
		await settle();
		assert.equal(log.heldClearHalts.length, 1, 'the open is waiting on the clear-halt');

		await adapter.close();
		assert.deepEqual(log.events.slice(-3), ['release', 'attach', 'close'], 'the interface and the kernel driver are given back at once');

		for (const answer of log.heldClearHalts.splice(0)) { answer(); }
		await settle();
		for (const answer of log.heldClearHalts.splice(0)) { answer(); }
		const outcome = await opening;
		assert.ok(outcome instanceof Error, 'an open overtaken by a close must not resolve as open');
		assert.match((outcome as Error).message, /closed while it was opening/);
		assert.equal(adapter.isOpen, false);
		assert.equal(log.released, 1, 'released once, not again by the abandoned open');
	});

	it('opens anyway when a clear-halt fails: it is best effort', async () => {
		const { adapter } = adapterFor([{ kernelDriverActive: true, clearHaltError: 'LIBUSB_ERROR_PIPE' }], undefined, 0, 'linux');
		await adapter.open();
		assert.equal(adapter.isOpen, true);
		await adapter.close();
	});

	it('does not wait for ever on a clear-halt that never answers', async () => {
		const { adapter } = adapterFor([{ kernelDriverActive: true, clearHaltNeverAnswers: true }], undefined, 0, 'linux');
		const started = Date.now();
		await adapter.open();
		assert.equal(adapter.isOpen, true);
		assert.ok(Date.now() - started < 5000);
		await adapter.close();
	});
});
