/**
 * Which USB backend a connection lands on, and whether anyone is told.
 *
 * The two are not interchangeable: libusb carries the brick's full 1024-byte frame while
 * HID delivers 64, which is too little for `copy` or `move` to be expressed at all. A
 * silent fallback would look like a working connection and behave like a broken one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Transport, makeBrickKey } from '../contracts';
import { UsbTransportProvider } from '../transports/usbTransportProvider';
import { USB } from '../transports/transportConstants';
import { ConnectionError, DevicePermissionError } from '../errors/CockpitError';

const KEY = makeBrickKey(Transport.USB, '001653AABBCC');

interface FakeAdapter {
	open(): Promise<void>;
	close(): Promise<void>;
	send(): Promise<Uint8Array>;
	readonly isOpen: boolean;
	readonly maxPacketBytes?: number;
	readonly deviceLocation?: { busNumber: number; deviceAddress: number };
}

function adapter(options: {
	failWith?: string;
	maxPacketBytes?: number;
	opened?: string[];
	label?: string;
}): FakeAdapter {
	let open = false;
	return {
		open(): Promise<void> {
			if (options.failWith) { return Promise.reject(new Error(options.failWith)); }
			open = true;
			options.opened?.push(options.label ?? 'adapter');
			return Promise.resolve();
		},
		close(): Promise<void> { open = false; return Promise.resolve(); },
		send(): Promise<Uint8Array> { return Promise.resolve(new Uint8Array()); },
		get isOpen(): boolean { return open; },
		get maxPacketBytes(): number | undefined { return open ? options.maxPacketBytes : undefined; },
		deviceLocation: { busNumber: 2, deviceAddress: 10 },
	};
}

function providerWith(config: {
	libusb: { failWith?: string; maxPacketBytes?: number };
	hid?: { failWith?: string };
	opened?: string[];
	log?: { info: string[]; warn: string[] };
}): UsbTransportProvider {
	const log = config.log;
	return new UsbTransportProvider({
		log: log && {
			info: (m: string) => log.info.push(m),
			warn: (m: string) => log.warn.push(m),
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createLibusbAdapter: () => adapter({
			...config.libusb, opened: config.opened, label: 'libusb',
		}) as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createHidAdapter: () => adapter({
			...(config.hid ?? {}), maxPacketBytes: USB.MAX_WRITE_PACKET_BYTES,
			opened: config.opened, label: 'hid',
		}) as any,
	});
}

/** Adapters that share one device: a second open while it is claimed fails, as on Windows. */
function claimingProvider(): UsbTransportProvider {
	let claimed = false;
	const make = (label: string, maxPacketBytes: number) => {
		let open = false;
		return {
			open(): Promise<void> {
				if (claimed) { return Promise.reject(new Error('LIBUSB_ERROR_BUSY')); }
				claimed = true; open = true;
				return Promise.resolve();
			},
			close(): Promise<void> { if (open) { claimed = false; } open = false; return Promise.resolve(); },
			send(): Promise<Uint8Array> { return Promise.resolve(new Uint8Array()); },
			get isOpen(): boolean { return open; },
			get maxPacketBytes(): number | undefined { return open ? maxPacketBytes : undefined; },
			deviceLocation: { busNumber: 2, deviceAddress: 10 },
			label,
		};
	};
	return new UsbTransportProvider({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createLibusbAdapter: () => make('libusb', 1024) as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createHidAdapter: () => ({ ...make('hid', USB.MAX_WRITE_PACKET_BYTES), open: () => Promise.resolve() }) as any,
	});
}

describe('USB name probe', () => {
	it('makes a connect wait for an open probe, so it lands on libusb rather than HID', async () => {
		const provider = claimingProvider();
		const probe = await provider.openProbe(KEY);
		const connecting = provider.connect(KEY);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(provider.backendFor(KEY), undefined, 'the connect must wait for the probe');

		await probe.close();
		await connecting;
		assert.equal(provider.backendFor(KEY), 'libusb');
		provider.dispose();
	});

	it('refuses a probe of a brick that has a session', async () => {
		const provider = claimingProvider();
		await provider.connect(KEY);
		await assert.rejects(provider.openProbe(KEY), /has a session/);
		provider.dispose();
	});
});

describe('USB bus sharing', () => {
	const SERIALS = ['001653000001', '001653000002'];
	const at = (i: number) => ({ busNumber: 2, deviceAddress: 10 + i });
	const tick = () => new Promise((resolve) => setImmediate(resolve));
	const ticks = async (n: number) => { for (let i = 0; i < n; i += 1) { await tick(); } };

	/**
	 * Adapters that open the way `findDevice` does: every EV3 not in use, in turn, then claim
	 * their own. Opening a device another adapter holds claimed is what dropped a transfer in
	 * flight into freed memory on hardware; here it is recorded as a violation.
	 */
	function busProvider(hooks: { afterClaim?: () => Promise<void>; onClose?: () => Promise<void> }) {
		const claimedBy = new Map<number, string>();
		const violations: string[] = [];
		const provider = new UsbTransportProvider({
			createLibusbAdapter: (options) => {
				const mine = SERIALS.indexOf(options.serial!.toUpperCase());
				let location: { busNumber: number; deviceAddress: number } | undefined;
				return {
					async open(): Promise<void> {
						for (let i = 0; i < SERIALS.length; i += 1) {
							if (options.inUse?.(at(i))) { continue; }
							const holder = claimedBy.get(at(i).deviceAddress);
							if (holder) { violations.push(`${options.serial} opened ${holder}'s claimed device`); }
							await tick();
						}
						claimedBy.set(at(mine).deviceAddress, options.serial!);
						location = at(mine);
						await hooks.afterClaim?.();
					},
					async close(): Promise<void> {
						// Like the real adapter: the location is gone at once, the claim only once
						// libusb has handed back what was in flight.
						const held = location;
						location = undefined;
						await hooks.onClose?.();
						if (held) { claimedBy.delete(held.deviceAddress); }
					},
					send: () => Promise.resolve(new Uint8Array()),
					get isOpen(): boolean { return location !== undefined; },
					maxPacketBytes: 1024,
					get deviceLocation() { return location; },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any;
			},
		});
		return { provider, violations };
	}

	it('lets no probe open a device another probe has claimed but not yet returned from', async () => {
		let claimedFirst!: () => void;
		const firstHolds = new Promise<void>((resolve) => { claimedFirst = resolve; });
		let calls = 0;
		const { provider, violations } = busProvider({
			afterClaim: () => (calls++ === 0 ? firstHolds : Promise.resolve()),
		});

		const first = provider.openProbe(makeBrickKey(Transport.USB, SERIALS[0]));
		await ticks(10);
		const second = provider.openProbe(makeBrickKey(Transport.USB, SERIALS[1]));
		await ticks(10);
		claimedFirst();
		const probes = await Promise.all([first, second]);

		assert.deepEqual(violations, []);
		for (const probe of probes) { await probe.close(); }
		provider.dispose();
	});

	it('keeps a closing probe\'s device in use until libusb has let go of it', async () => {
		let letGo!: () => void;
		const draining = new Promise<void>((resolve) => { letGo = resolve; });
		let closes = 0;
		const { provider, violations } = busProvider({
			onClose: () => (closes++ === 0 ? draining : Promise.resolve()),
		});

		const first = await provider.openProbe(makeBrickKey(Transport.USB, SERIALS[0]));
		const closing = first.close();
		await ticks(5);
		const second = await provider.openProbe(makeBrickKey(Transport.USB, SERIALS[1]));
		letGo();
		await closing;

		assert.deepEqual(violations, []);
		await second.close();
		provider.dispose();
	});
});

describe('USB backend selection', () => {
	it('prefers libusb, and never opens the HID path when it succeeds', async () => {
		const opened: string[] = [];
		const provider = providerWith({ libusb: { maxPacketBytes: 1024 }, opened });
		await provider.connect(KEY);

		assert.deepEqual(opened, ['libusb']);
		assert.equal(provider.backendFor(KEY), 'libusb');
		assert.equal(provider.maxPacketBytes(KEY), 1024);
		provider.dispose();
	});

	it('falls back to HID and says what that costs', async () => {
		const log = { info: [] as string[], warn: [] as string[] };
		const provider = providerWith({
			libusb: { failWith: 'LIBUSB_ERROR_ACCESS' },
			log,
		});
		await provider.connect(KEY);

		assert.equal(provider.backendFor(KEY), 'hid');
		assert.equal(provider.maxPacketBytes(KEY), USB.MAX_WRITE_PACKET_BYTES);
		assert.equal(log.warn.length, 1, 'a degraded link must not be silent');
		assert.match(log.warn[0], /LIBUSB_ERROR_ACCESS/, 'the reason belongs in the message');
		assert.match(log.warn[0], /copy\/move cannot be sent at all/);
		provider.dispose();
	});

	it('names both failures when neither backend opens, and warns of no fallback that never happened', async () => {
		const log = { info: [] as string[], warn: [] as string[] };
		const provider = providerWith({
			libusb: { failWith: 'LIBUSB_ERROR_ACCESS' },
			hid: { failWith: 'no HID device' },
			log,
		});
		// "USB connect failed" against a brick that is plainly attached is a dead end
		// unless the message says the libusb claim was refused first.
		await assert.rejects(
			() => provider.connect(KEY),
			/libusb: LIBUSB_ERROR_ACCESS\. HID: no HID device/
		);
		// While a cable is out every reconnect fails both ways; measured 30.10.2026, a warning
		// per attempt about falling back to HID filled the log during a cable pull.
		assert.deepEqual(log.warn, []);
		provider.dispose();
	});

	it('reports no packet size for a brick that is not connected', async () => {
		const provider = providerWith({ libusb: { maxPacketBytes: 1024 } });
		assert.equal(provider.maxPacketBytes(KEY), undefined);
		assert.equal(provider.backendFor(KEY), undefined);
		provider.dispose();
	});

	it('forgets the backend on disconnect', async () => {
		const provider = providerWith({ libusb: { maxPacketBytes: 1024 } });
		await provider.connect(KEY);
		await provider.disconnect(KEY);
		assert.equal(provider.maxPacketBytes(KEY), undefined);
		provider.dispose();
	});
});

describe('USB connect — a device this user may not open', () => {
	it('fails with the permission error, not "connect failed", when neither backend may open it', async () => {
		const provider = new UsbTransportProvider({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createLibusbAdapter: () => ({
				...adapter({}),
				open: () => Promise.reject(new DevicePermissionError('may not open (LIBUSB_ERROR_ACCESS); install the udev rule')),
			}) as any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createHidAdapter: () => adapter({ failWith: 'cannot open device with path /dev/hidraw3' }) as any,
		});
		const error = await provider.connect(KEY).then(() => undefined, (e: unknown) => e);
		assert.ok(error instanceof DevicePermissionError, `got ${String(error)}`);
		assert.ok(error instanceof ConnectionError, 'still a connection failure to everything that counts them');
		assert.match((error as Error).message, /udev rule/);
		assert.match((error as Error).message, /hidraw3/, 'the HID half stays in the message for the log');
		provider.dispose();
	});

	it('still falls back to HID when HID may open it', async () => {
		const log = { info: [] as string[], warn: [] as string[] };
		const provider = new UsbTransportProvider({
			log: { info: (m: string) => log.info.push(m), warn: (m: string) => log.warn.push(m) },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createLibusbAdapter: () => ({
				...adapter({}),
				open: () => Promise.reject(new DevicePermissionError('may not open (LIBUSB_ERROR_ACCESS)')),
			}) as any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createHidAdapter: () => adapter({ maxPacketBytes: USB.MAX_WRITE_PACKET_BYTES }) as any,
		});
		await provider.connect(KEY);
		assert.equal(provider.backendFor(KEY), 'hid');
		assert.equal(log.warn.length, 1);
		provider.dispose();
	});
});

describe('USB provider — dispose gives every device back (review of 2dacf24)', () => {
	// On Linux an open libusb link holds the brick with `usbhid` detached; one left open when the
	// extension stops leaves the brick with no driver. `npm run test:host` showed it: the name
	// probe was still open when VS Code closed, and dispose closed sessions only.
	function trackedProvider(openGate?: Promise<void>) {
		const closed: string[] = [];
		let made = 0;
		const provider = new UsbTransportProvider({
			createLibusbAdapter: () => {
				const id = `libusb${(made += 1)}`;
				let open = false;
				return {
					async open(): Promise<void> { await openGate; open = true; },
					async close(): Promise<void> { if (open) { closed.push(id); } open = false; },
					send: () => Promise.resolve(new Uint8Array()),
					get isOpen(): boolean { return open; },
					maxPacketBytes: 1024,
					deviceLocation: { busNumber: 2, deviceAddress: 10 },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any;
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createHidAdapter: () => adapter({ failWith: 'no HID here' }) as any,
		});
		return { provider, closed };
	}

	it('closes an open name probe', async () => {
		const { provider, closed } = trackedProvider();
		await provider.openProbe(KEY);
		provider.dispose();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(closed, ['libusb1']);
	});

	it('closes a probe whose open lands after the dispose, and refuses it', async () => {
		let land!: () => void;
		const { provider, closed } = trackedProvider(new Promise<void>((resolve) => { land = resolve; }));
		const probing = provider.openProbe(KEY).then(() => 'opened', (e: unknown) => e);
		await new Promise((resolve) => setImmediate(resolve));
		provider.dispose();
		land();
		const outcome = await probing;
		assert.ok(outcome instanceof Error, 'a probe opened after dispose must not be handed out');
		assert.deepEqual(closed, ['libusb1']);
	});

	it('closes a connect whose libusb open lands after the dispose, and keeps no session', async () => {
		let land!: () => void;
		const { provider, closed } = trackedProvider(new Promise<void>((resolve) => { land = resolve; }));
		const connecting = provider.connect(KEY).then(() => 'connected', (e: unknown) => e);
		await new Promise((resolve) => setImmediate(resolve));
		provider.dispose();
		land();
		const outcome = await connecting;
		assert.ok(outcome instanceof Error, 'a connect that lands after dispose must fail');
		assert.deepEqual(closed, ['libusb1']);
		assert.equal(provider.backendFor(KEY), undefined);
	});
});

describe('USB connect — permission from either backend, by its code (review of 2dacf24)', () => {
	const HID_PATH = '/dev/hidraw3';
	function permissionProvider(config: {
		libusbError: Error;
		hidAccess: 'denied' | 'ok' | 'unknown';
		platform?: NodeJS.Platform;
	}): UsbTransportProvider {
		return new UsbTransportProvider({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createLibusbAdapter: () => ({ ...adapter({}), open: () => Promise.reject(config.libusbError) }) as any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createHidAdapter: () => adapter({ failWith: `cannot open device with path ${HID_PATH}` }) as any,
			listHidDevices: () => [{ path: HID_PATH, serialNumber: '001653AABBCC', product: 'AAA' }],
			listUsbDevices: (() => Promise.resolve([])) as never,
			hidAccess: () => config.hidAccess,
			platform: config.platform ?? 'linux',
		});
	}

	it('says permission when libusb is refused and the hidraw node is refused too', async () => {
		const provider = permissionProvider({ libusbError: new DevicePermissionError('may not open (LIBUSB_ERROR_ACCESS); udev rule'), hidAccess: 'denied' });
		await assert.rejects(() => provider.connect(KEY), DevicePermissionError);
		provider.dispose();
	});

	it('says permission when only the hidraw node is refused, whatever libusb said', async () => {
		const provider = permissionProvider({ libusbError: new Error('Could not claim USB interface 0 (LIBUSB_ERROR_IO)'), hidAccess: 'denied' });
		const error = await provider.connect(KEY).then(() => undefined, (e: unknown) => e);
		assert.ok(error instanceof DevicePermissionError, `got ${String(error)}`);
		assert.match((error as Error).message, /native\/linux\/70-lego-ev3\.rules/);
	});

	it('does not send a user to the udev rule when the hidraw node is open to them and HID failed otherwise', async () => {
		const provider = permissionProvider({ libusbError: new DevicePermissionError('may not open (LIBUSB_ERROR_ACCESS)'), hidAccess: 'ok' });
		const error = await provider.connect(KEY).then(() => undefined, (e: unknown) => e);
		assert.ok(error instanceof ConnectionError);
		assert.ok(!(error instanceof DevicePermissionError), 'the rule is in place for hidraw; something else failed');
		provider.dispose();
	});

	it('never checks the hidraw node on Windows', async () => {
		let asked = false;
		const provider = new UsbTransportProvider({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createLibusbAdapter: () => ({ ...adapter({}), open: () => Promise.reject(new Error('LIBUSB_ERROR_ACCESS')) }) as any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createHidAdapter: () => adapter({ failWith: 'cannot open device' }) as any,
			listHidDevices: () => [{ path: HID_PATH, serialNumber: '001653AABBCC', product: 'AAA' }],
			listUsbDevices: (() => Promise.resolve([])) as never,
			hidAccess: () => { asked = true; return 'denied'; },
			platform: 'win32',
		});
		const error = await provider.connect(KEY).then(() => undefined, (e: unknown) => e);
		assert.ok(!(error instanceof DevicePermissionError));
		assert.equal(asked, false);
		provider.dispose();
	});
});

describe('USB provider — disposeAsync waits until every device is given back', () => {
	// Disposal through context.subscriptions is synchronous, and the extension host exits right
	// after: a close still waiting on libusb's release never gives `usbhid` back. On HOSTC one brick
	// was left without a driver after every `npm run test:host`, even with probes closed on dispose.
	it('resolves only once the sessions and probes have closed', async () => {
		const closedAt: string[] = [];
		let made = 0;
		const provider = new UsbTransportProvider({
			createLibusbAdapter: () => {
				const id = `libusb${(made += 1)}`;
				return {
					open: () => Promise.resolve(),
					close: () => new Promise<void>((resolve) => setTimeout(() => { closedAt.push(id); resolve(); }, 30)),
					send: () => Promise.resolve(new Uint8Array()),
					isOpen: true,
					maxPacketBytes: 1024,
					deviceLocation: { busNumber: 2, deviceAddress: 10 + made },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any;
			},
		});
		await provider.connect(KEY);
		await provider.openProbe(makeBrickKey(Transport.USB, '001653000099'));
		await provider.disposeAsync();
		assert.deepEqual(closedAt.sort(), ['libusb1', 'libusb2']);
	});
});

describe('USB provider — disposeAsync waits for links still opening (review of 98bd795)', () => {
	it('closes a libusb link in the middle of its open, and resolves only once it has', async () => {
		const events: string[] = [];
		let land!: () => void;
		const gate = new Promise<void>((resolve) => { land = resolve; });
		const provider = new UsbTransportProvider({
			createLibusbAdapter: () => {
				let closed = false;
				return {
					async open(): Promise<void> {
						events.push('open-start');
						await gate;
						if (closed) { events.push('open-overtaken'); throw new Error('closed while it was opening'); }
						events.push('open-landed');
					},
					close: () => new Promise<void>((resolve) => setTimeout(() => {
						closed = true; events.push('closed'); resolve();
					}, 20)),
					send: () => Promise.resolve(new Uint8Array()),
					isOpen: false,
					maxPacketBytes: 1024,
					deviceLocation: { busNumber: 2, deviceAddress: 10 },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any;
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createHidAdapter: () => adapter({ failWith: 'no HID here' }) as any,
		});
		const connecting = provider.connect(KEY).catch(() => undefined);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(events, ['open-start']);
		await provider.disposeAsync();
		assert.ok(events.includes('closed'), 'the link still opening was closed before disposeAsync resolved');
		land();
		await connecting;
		assert.ok(!events.includes('open-landed'), 'and its open did not land afterwards');
	});
});
