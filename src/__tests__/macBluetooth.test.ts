/**
 * Bluetooth on macOS through the IOBluetooth helper (the Mac visit, 18.11.2026): the helper's `list`
 * answer, one `list` at a time, and the adapter over a fake helper process.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import {
	BtMacAdapter, HelperProcess, MAC_BT_DENIED, createMacPairedScan, createMacPairing, createMacPresence, createMacRadioName, createMacUnpair,
	parsePairedList,
} from '../core/transports/macBluetooth';
import { BackendUnavailableError, TransportError } from '../core/errors/CockpitError';
import type { BtPairingEvent } from '../core/transports/btPairingHelper';
import { MAC_LOCAL_NETWORK_HINT, codedForTests } from '../core/transports/tcpSocketAdapter';

/** A helper process whose streams and exit the test drives; its stdin can hold a write's callback. */
class FakeHelper extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly written: Buffer[] = [];
	/** Callbacks of writes held back, for a test that delivers a write's outcome late. */
	readonly heldWrites: Array<(error?: Error | null) => void> = [];
	holdWrites = false;
	stdinEnded = false;
	killed?: string;
	readonly stdin: Writable;
	constructor(readonly args: readonly string[]) {
		super();
		this.stdin = new Writable({
			write: (chunk: Buffer, _encoding, callback) => {
				this.written.push(chunk);
				if (this.holdWrites) { this.heldWrites.push(callback); } else { callback(); }
			},
			final: (callback) => { this.stdinEnded = true; callback(); },
		});
	}
	kill(signal?: NodeJS.Signals): boolean { this.killed = signal ?? 'SIGTERM'; this.emit('close', null, signal ?? 'SIGTERM'); return true; }
	/** The process ended and its pipes are drained (`close`, which is what the adapter listens to). */
	exit(code: number): void { this.emit('close', code, null); }
}

function adapterWith(helpers: FakeHelper[], connectTimeoutMs = 2000): BtMacAdapter {
	return new BtMacAdapter({
		mac: '00:16:53:AA:BB:CC',
		helperPath: '/nowhere',
		connectTimeoutMs,
		spawnHelper: (args) => {
			const helper = new FakeHelper(args);
			helpers.push(helper);
			return helper as unknown as HelperProcess;
		},
	});
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('macOS local network consent for TCP (Mac visit, 18.11.2026)', () => {
	const unreachable = Object.assign(new Error('connect EHOSTUNREACH 192.0.2.10:5555'), { code: 'EHOSTUNREACH' });

	it('tells a Mac user where to allow the local network when a connect is unreachable', () => {
		const error = codedForTests(unreachable, 'darwin') as TransportError;
		assert.ok(error instanceof TransportError);
		assert.ok(error.message.endsWith(MAC_LOCAL_NETWORK_HINT));
	});

	it('says nothing of macOS elsewhere, or for other failures', () => {
		assert.ok(!(codedForTests(unreachable, 'win32') as Error).message.includes('macOS'));
		const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
		assert.ok(!(codedForTests(refused, 'darwin') as Error).message.includes('macOS'));
	});
});

describe('macOS pairing, forgetting and presence through the helper (second day of the Mac visit, 19.11.2026)', () => {
	const pairingWith = (helpers: FakeHelper[]) => createMacPairing({
		helperPath: '/nowhere',
		spawnHelper: (args) => { const helper = new FakeHelper(args); helpers.push(helper); return helper as unknown as HelperProcess; },
	});

	it('pairs, passing on each event, and succeeds on the helper\'s result', async () => {
		const helpers: FakeHelper[] = [];
		const events: BtPairingEvent[] = [];
		const pairing = pairingWith(helpers)('00:16:53:AA:BB:CC', (event) => events.push(event));
		await tick();
		assert.deepEqual(helpers[0].args, ['pair', '001653aabbcc']);
		helpers[0].stdout.write('{"type":"pairingRequested","kind":"confirm","value":123456}\n{"type":"res');
		helpers[0].stdout.write('ult","status":"Paired","ok":true}\n');
		helpers[0].exit(0);
		assert.deepEqual(await pairing, { ok: true, status: 'Paired' });
		assert.deepEqual(events.map((event) => event.type), ['pairingRequested', 'result']);
	});

	it('says what to do when the brick was not confirmed in time, and when Bluetooth is refused', async () => {
		const helpers: FakeHelper[] = [];
		const pair = pairingWith(helpers);
		const late = pair('00:16:53:AA:BB:CC');
		await tick();
		helpers[0].stdout.write('{"type":"result","status":"AuthenticationTimeout","ok":false}\n');
		helpers[0].exit(5);
		const timedOut = await late;
		assert.equal(timedOut.ok, false);
		assert.match(timedOut.reason ?? '', /brick's screen/);

		const refused = pair('00:16:53:AA:BB:CC');
		await tick();
		helpers[1].stdout.write('{"type":"result","status":"Denied","ok":false}\n');
		helpers[1].exit(3);
		assert.equal((await refused).reason, MAC_BT_DENIED);
	});

	it('fails a pairing whose helper ends without a result, with the helper\'s own reason', async () => {
		const helpers: FakeHelper[] = [];
		const pairing = pairingWith(helpers)('00:16:53:AA:BB:CC');
		await tick();
		helpers[0].stderr.write('error no pairing for this device\n');
		helpers[0].exit(4);
		assert.deepEqual(await pairing, { ok: false, reason: 'no pairing for this device' });
	});

	it('stops the helper and reports a cancelled pairing when the caller gives up', async () => {
		const helpers: FakeHelper[] = [];
		const abort = new AbortController();
		const pairing = pairingWith(helpers)('00:16:53:AA:BB:CC', undefined, abort.signal);
		await tick();
		abort.abort();
		assert.equal(helpers[0].killed, 'SIGTERM');
		assert.deepEqual(await pairing, { ok: false, reason: 'Pairing was cancelled.', status: 'Cancelled' });
	});

	it('forgets through the helper, and says why when it could not', async () => {
		const asked: Array<readonly string[]> = [];
		assert.deepEqual(await createMacUnpair({ helperPath: '/nowhere', run: async (args) => { asked.push(args); } })('00:16:53:AA:BB:CC'), { ok: true });
		assert.deepEqual(asked, [['forget', '001653aabbcc']]);
		const failed = await createMacUnpair({ helperPath: '/nowhere', run: () => Promise.reject(new Error('the pairing is still there')) })('00:16:53:AA:BB:CC');
		assert.deepEqual(failed, { ok: false, reason: 'the pairing is still there' });
	});

	it('checks a paired brick by whether it answered', async () => {
		const answers = ['{"answered":true,"name":"CCC"}', '{"answered":false,"name":""}'];
		const asked: Array<readonly string[]> = [];
		const presence = createMacPresence({ helperPath: '/nowhere', run: async (args) => { asked.push(args); return answers.shift()!; } });
		assert.equal(await presence.check('00:16:53:AA:BB:CC'), true);
		assert.equal(await presence.check('00:16:53:AA:BB:CC'), false);
		assert.deepEqual(asked[0], ['check', '001653aabbcc']);
	});

	it('finds the EV3s an inquiry heard, paired or not, with their names and no made-up signal', async () => {
		const presence = createMacPresence({ helperPath: '/nowhere', run: async () => JSON.stringify({ devices: [
			{ mac: '001653aabbcc', name: 'CCC', paired: false, rssi: -40 },
			{ mac: '001653ddeeff', name: 'BBB', paired: true, rssi: 127 },
			{ mac: '88c9e84741fc', name: 'Headphones', paired: true, rssi: -50 },
		] }) });
		const found = await presence.inquire();
		assert.deepEqual(found.map(({ mac, name, paired, signal }) => ({ mac, name, paired, signal })), [
			{ mac: '00:16:53:AA:BB:CC', name: 'CCC', paired: false, signal: -40 },
			{ mac: '00:16:53:DD:EE:FF', name: 'BBB', paired: true, signal: null },
		]);
	});

	it('knows this Mac\'s Bluetooth name once read, and stays unknown when it cannot be', async () => {
		const radio = createMacRadioName({ helperPath: '/nowhere', run: async () => '{"name":"HOSTM"}' });
		assert.equal(radio.name(), undefined, 'unknown until read');
		await radio.read();
		assert.equal(radio.name(), 'HOSTM');
		const refused = createMacRadioName({ helperPath: '/nowhere', run: async () => '{"error":"denied"}' });
		await refused.read();
		assert.equal(refused.name(), undefined);
	});

	it('stops presence with the reason when Bluetooth is refused, rather than failing every round', async () => {
		const presence = createMacPresence({ helperPath: '/nowhere', run: async () => '{"error":"denied"}' });
		await assert.rejects(presence.inquire(), (error: unknown) => error instanceof BackendUnavailableError && error.message === MAC_BT_DENIED);
		await assert.rejects(presence.check('00:16:53:AA:BB:CC'), BackendUnavailableError);
	});
});

describe('macOS Bluetooth through the IOBluetooth helper', () => {
	it('lists only paired EV3s, with the names macOS knows', () => {
		const devices = parsePairedList(JSON.stringify({ devices: [
			{ mac: '001653aabbcc', name: 'CCC', connected: false, classOfDevice: 2052 },
			{ mac: '88c9e84741fc', name: 'Headphones', connected: true, classOfDevice: 2360324 },
			{ mac: '', name: 'broken', connected: false },
		] }));
		assert.deepEqual(devices, [{ mac: '00:16:53:AA:BB:CC', name: 'CCC', connected: false, remembered: true, authenticated: true }]);
	});

	it('says that Bluetooth is not allowed, and where to allow it, instead of listing nothing', () => {
		assert.throws(() => parsePairedList('{"error":"denied"}'), (error: unknown) =>
			error instanceof TransportError && error.message === MAC_BT_DENIED);
	});

	it('runs one list at a time: a scan during a list waiting for consent shares it', async () => {
		let calls = 0;
		let answer!: (text: string) => void;
		const scan = createMacPairedScan({ helperPath: '/nowhere', run: () => { calls++; return new Promise((resolve) => { answer = resolve; }); } });
		const first = scan();
		const second = scan();
		answer('{"devices":[{"mac":"001653aabbcc","name":"CCC","connected":false}]}');
		assert.deepEqual(await first, await second);
		assert.equal(calls, 1);
		const third = scan();
		answer('{"devices":[]}');
		assert.deepEqual(await third, []);
		assert.equal(calls, 2, 'a scan after the answer asks again');
	});

	it('opens when the helper reports the channel open, and frames replies from its stdout', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const opening = adapter.open();
		await tick();
		assert.deepEqual(helpers[0].args, ['connect', '001653aabbcc']);
		helpers[0].stderr.write('open 667\n');
		await opening;
		assert.equal(adapter.isOpen, true);

		const reply = adapter.send(Uint8Array.from([0x03, 0x00, 0x01, 0x00, 0x00]));
		await tick();
		assert.deepEqual(Buffer.concat(helpers[0].written), Buffer.from([0x03, 0x00, 0x01, 0x00, 0x00]));
		// The reply arrives in two pieces, as RFCOMM may deliver it.
		helpers[0].stdout.write(Buffer.from([0x04, 0x00, 0x01]));
		helpers[0].stdout.write(Buffer.from([0x00, 0x02, 0x07]));
		assert.deepEqual(Buffer.from(await reply), Buffer.from([0x04, 0x00, 0x01, 0x00, 0x02, 0x07]));
	});

	it('fails the open with the helper\'s own reason when it ends first', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const opening = adapter.open();
		await tick();
		helpers[0].stderr.write('error RFCOMM open failed (-536870212)\n');
		await tick();
		helpers[0].exit(4);
		await assert.rejects(opening, (error: unknown) => error instanceof TransportError && /RFCOMM open failed/.test(error.message));
		assert.equal(adapter.isOpen, false);
	});

	it('names the missing consent when the helper is refused Bluetooth', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const opening = adapter.open();
		await tick();
		helpers[0].exit(3);
		await assert.rejects(opening, (error: unknown) => error instanceof TransportError && error.message.includes('System Settings'));
	});

	it('gives up after the connect deadline and stops the helper', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers, 30);
		await assert.rejects(adapter.open(), /timed out/);
		await tick();
		assert.equal(helpers[0].stdinEnded, true, 'the helper is told to leave');
	});

	it('closes by ending the helper\'s stdin, and fails a reply still waiting', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const opening = adapter.open();
		await tick();
		helpers[0].stderr.write('open 667\n');
		await opening;
		const replyFailed = assert.rejects(adapter.send(Uint8Array.from([0x03, 0x00, 0x01, 0x00, 0x00])), TransportError);
		const closing = adapter.close();
		await tick();
		assert.equal(helpers[0].stdinEnded, true);
		helpers[0].exit(0);
		await closing;
		await replyFailed;
		assert.equal(adapter.isOpen, false);
	});

	it('survives an EPIPE on the helper\'s stdin: the link fails, the process does not (review of the Mac visit)', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const opening = adapter.open();
		await tick();
		helpers[0].stderr.write('open 667\n');
		await opening;
		const replyFailed = assert.rejects(adapter.send(Uint8Array.from([0x03, 0x00, 0x01, 0x00, 0x00])), TransportError);
		helpers[0].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
		await replyFailed;
		assert.equal(adapter.isOpen, false);
	});

	it('stops a helper whose stdin broke, rather than leaving it running unreferenced (second review round)', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const opening = adapter.open();
		await tick();
		helpers[0].stderr.write('open 667\n');
		await opening;
		helpers[0].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
		await tick();
		assert.equal(adapter.isOpen, false);
		assert.ok(helpers[0].stdinEnded || helpers[0].killed, 'the helper is told to leave');
	});

	it('does not let a late write error of a closed link fail a request on the link that replaced it (second review round)', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const opening = adapter.open();
		await tick();
		helpers[0].stderr.write('open 667\n');
		await opening;
		helpers[0].holdWrites = true;
		const oldReply = assert.rejects(adapter.send(Uint8Array.from([0x03, 0x00, 0x01, 0x00, 0x00])), TransportError);
		await tick();
		const closing = adapter.close();
		await tick();
		helpers[0].exit(0);
		await closing;
		await oldReply;

		const reopening = adapter.open();
		await tick();
		helpers[1].stderr.write('open 667\n');
		await reopening;
		const reply = adapter.send(Uint8Array.from([0x03, 0x00, 0x02, 0x00, 0x00]));
		await tick();
		helpers[0].heldWrites[0](new Error('write EPIPE'));   // the old helper's write fails only now
		helpers[1].stdout.write(Buffer.from([0x03, 0x00, 0x02, 0x00, 0x02]));
		assert.deepEqual(Buffer.from(await reply), Buffer.from([0x03, 0x00, 0x02, 0x00, 0x02]));
	});

	it('does not publish a link whose helper ended right after saying "open" (second review round)', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const openFailed = assert.rejects(adapter.open(), TransportError);
		await tick();
		// Ends in the same turn as the status line, before the open's continuation runs. Registered
		// first: a PassThrough delivers the write synchronously, after the adapter's own listener.
		helpers[0].stderr.once('data', () => helpers[0].exit(0));
		helpers[0].stderr.write('open 667\n');
		await openFailed;
		assert.equal(adapter.isOpen, false);
	});

	it('does not publish a link whose pipe broke while it was opening, even when "open" comes after (third review round)', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const openFailed = assert.rejects(adapter.open(), /EPIPE/);
		await tick();
		helpers[0].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
		helpers[0].stderr.write('open 667\n');   // buffered status arrives after the pipe failed
		await openFailed;
		assert.equal(adapter.isOpen, false);
		await tick();
		assert.ok(helpers[0].stdinEnded || helpers[0].killed, 'the helper is told to leave');
	});

	it('does not let an earlier helper, still ending, close the link that replaced it (review of the Mac visit)', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers, 30);
		await assert.rejects(adapter.open(), /timed out/);
		const reopening = adapter.open();
		await tick();
		helpers[1].stderr.write('open 667\n');
		await reopening;
		helpers[0].exit(0);   // the helper the first open gave up on ends only now
		await tick();
		assert.equal(adapter.isOpen, true, 'the new link stays open');
		const reply = adapter.send(Uint8Array.from([0x03, 0x00, 0x01, 0x00, 0x00]));
		await tick();
		helpers[1].stdout.write(Buffer.from([0x03, 0x00, 0x01, 0x00, 0x02]));
		assert.deepEqual(Buffer.from(await reply), Buffer.from([0x03, 0x00, 0x01, 0x00, 0x02]));
	});

	it('lets a close win over an open still in progress, even when the channel opens during the close (review of the Mac visit)', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const openFailed = assert.rejects(adapter.open(), TransportError);
		await tick();
		const closing = adapter.close();
		helpers[0].stderr.write('open 667\n');   // the channel comes up after the close began
		await tick();
		helpers[0].exit(0);
		await closing;
		await openFailed;
		assert.equal(adapter.isOpen, false);
	});

	it('shares one open between two callers rather than starting two helpers', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const first = adapter.open();
		const second = adapter.open();
		await tick();
		assert.equal(helpers.length, 1);
		helpers[0].stderr.write('open 667\n');
		await Promise.all([first, second]);
		assert.equal(adapter.isOpen, true);
	});

	it('takes the helper\'s last status line even when it comes with the end of the process', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const opening = adapter.open();
		await tick();
		helpers[0].stderr.write('error no device 00-16-53-aa-bb-cc\n');
		helpers[0].exit(4);
		await assert.rejects(opening, /no device/);
	});

	it('fails a waiting reply when the brick or the radio ends the link', async () => {
		const helpers: FakeHelper[] = [];
		const adapter = adapterWith(helpers);
		const opening = adapter.open();
		await tick();
		helpers[0].stderr.write('open 667\n');
		await opening;
		const replyFailed = assert.rejects(adapter.send(Uint8Array.from([0x03, 0x00, 0x01, 0x00, 0x00])),
			(error: unknown) => error instanceof TransportError && /closed/.test(error.message));
		helpers[0].stderr.write('closed\n');
		await tick();
		helpers[0].exit(0);
		await replyFailed;
		assert.equal(adapter.isOpen, false);
	});
});
