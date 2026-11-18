/**
 * Bluetooth on macOS through the IOBluetooth helper (the Mac visit, 18.11.2026): the helper's `list`
 * answer, one `list` at a time, and the adapter over a fake helper process.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { BtMacAdapter, HelperProcess, MAC_BT_DENIED, createMacPairedScan, parsePairedList } from '../core/transports/macBluetooth';
import { TransportError } from '../core/errors/CockpitError';
import { MAC_LOCAL_NETWORK_HINT, codedForTests } from '../core/transports/tcpSocketAdapter';

/** A helper process whose streams and exit the test drives. */
class FakeHelper extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly written: Buffer[] = [];
	stdinEnded = false;
	killed?: string;
	constructor(readonly args: readonly string[]) {
		super();
		this.stdin.on('data', (chunk: Buffer) => this.written.push(chunk));
		this.stdin.on('finish', () => { this.stdinEnded = true; });
	}
	kill(signal?: NodeJS.Signals): boolean { this.killed = signal ?? 'SIGTERM'; this.emit('exit', null, signal ?? 'SIGTERM'); return true; }
	exit(code: number): void { this.emit('exit', code, null); }
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
