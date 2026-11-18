/**
 * Bluetooth on macOS through the IOBluetooth helper (the Mac visit, 18.11.2026): the helper's `list`
 * answer, one `list` at a time, and the adapter over a fake helper process.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { BtMacAdapter, HelperProcess, MAC_BT_DENIED, createMacPairedScan, parsePairedList } from '../core/transports/macBluetooth';
import { TransportError } from '../core/errors/CockpitError';
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
