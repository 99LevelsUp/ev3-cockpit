/**
 * An interrupted transfer must not leave the brick's space taken until a reboot (IMPLEMENTATION_PLAN
 * 4.6.17; owner decision 13.11.2026).
 *
 * The firmware keeps a download's slot, with its open file, in one global table that nothing clears
 * on a disconnect; deleting the file only unlinks it, so its blocks stay taken. `CLOSE_FILEHANDLE`
 * releases the slot from any channel after any reconnect. So a transfer that could not release its
 * slot leaves a debt with the brick, and the next transfer settles it before it starts: the slot is
 * closed and the partial file deleted. A slot whose number was never learned (the reply to the
 * first command lost) is swept, 0..63 and never higher, only when the user agrees.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickId, BrickResponse } from '../contracts';
import { ProtocolError, TransportError } from '../errors/CockpitError';
import { FileTransferService } from '../fs/fileTransferService';
import { TransferLedger, ledgerFor } from '../fs/transferLedger';
import { buildCommand } from '../protocol/ev3Commands';

const HANDLE = 3;
const PATH = '/home/root/lms2012/prjs/x.rbf';

/** A brick whose link can be cut and whose replies can be held back, recording every command. */
function brick() {
	const commands: BrickCommand[] = [];
	let linkDown = false;
	let failNext: BrickCommand['kind'] | undefined;
	let held: (() => void) | undefined;
	let holdKind: BrickCommand['kind'] | undefined;
	const unknownHandles = new Set<number>();
	let declared = 0;
	let written = 0;

	const answer = (command: BrickCommand): BrickResponse => {
		switch (command.kind) {
		case 'fs:beginWrite':
			declared = command.totalBytes;
			written = command.chunk.length;
			return { kind: 'fs:beginWrite', handle: HANDLE, endOfFile: written >= declared };
		case 'fs:continueWrite':
			written += command.chunk.length;
			return { kind: 'fs:continueWrite', handle: HANDLE, endOfFile: written >= declared };
		case 'fs:beginRead':
			return { kind: 'fs:beginRead', handle: HANDLE, totalBytes: 10, endOfFile: false, chunk: new Uint8Array(4) };
		case 'fs:continueRead': return { kind: 'fs:continueRead', handle: HANDLE, endOfFile: true, chunk: new Uint8Array(6) };
		case 'fs:closeHandle':
			if (unknownHandles.has(command.handle)) { throw new ProtocolError('UNKNOWN_HANDLE'); }
			return { kind: 'fs:closeHandle' };
		case 'fs:delete': return { kind: 'fs:delete', deleted: true };
		default: throw new Error(`unexpected ${command.kind}`);
		}
	};
	const send = async (command: BrickCommand): Promise<BrickResponse> => {
		commands.push(command);
		if (linkDown) { throw new TransportError('USB receive failed: LIBUSB_TRANSFER_ERROR'); }
		if (failNext === command.kind) { failNext = undefined; linkDown = true; throw new TransportError('cable out'); }
		if (holdKind === command.kind) {
			holdKind = undefined;
			await new Promise<void>((resolve) => { held = resolve; });
		}
		return answer(command);
	};
	return {
		send, commands,
		/** The link drops on this command, and stays down until `reconnect`. */
		cutOn(kind: BrickCommand['kind']) { failNext = kind; },
		reconnect() { linkDown = false; },
		hold(kind: BrickCommand['kind']) { holdKind = kind; },
		release() { held?.(); },
		forget(handle: number) { unknownHandles.add(handle); },
		kinds() { return commands.map((c) => (c.kind === 'fs:closeHandle' ? `close ${c.handle}` : c.kind)); },
		clear() { commands.length = 0; },
	};
}

function setup(confirm?: () => Promise<boolean>) {
	const b = brick();
	const ledger = new TransferLedger(confirm ? { confirmSweep: confirm } : {});
	const service = new FileTransferService(b.send, { ledger });
	return { b, ledger, service };
}

const content = new Uint8Array(3000);

describe('Transfer ledger — space an interrupted transfer took (4.6.17)', () => {
	it('closes the slot and deletes the partial file before the next transfer, after the link was lost', async () => {
		const { b, service } = setup();
		b.cutOn('fs:continueWrite');
		await assert.rejects(service.writeFile(PATH, content), TransportError);

		b.reconnect();
		b.clear();
		await service.writeFile('/home/root/lms2012/prjs/y.rbf', new Uint8Array(10));

		assert.deepEqual(b.kinds().slice(0, 3), [`close ${HANDLE}`, 'fs:delete', 'fs:beginWrite']);
		assert.equal((b.commands[1] as { path: string }).path, PATH);
	});

	it('takes "unknown handle" as settled: the slot was already free', async () => {
		const { b, ledger, service } = setup();
		b.cutOn('fs:continueWrite');
		await assert.rejects(service.writeFile(PATH, content));
		b.reconnect();
		b.forget(HANDLE);

		await service.writeFile('/home/root/lms2012/prjs/y.rbf', new Uint8Array(10));

		assert.equal(ledger.pending(), 0);
	});

	it('keeps the debt while the link is still down, and settles it the next time', async () => {
		const { b, ledger, service } = setup();
		b.cutOn('fs:continueWrite');
		await assert.rejects(service.writeFile(PATH, content));

		await assert.rejects(service.writeFile('/home/root/lms2012/prjs/y.rbf', new Uint8Array(10)));
		assert.equal(ledger.pending(), 1);

		b.reconnect();
		await service.writeFile('/home/root/lms2012/prjs/y.rbf', new Uint8Array(10));
		assert.equal(ledger.pending(), 0);
	});

	it('releases at once and leaves no debt when the link is still there', async () => {
		const { b, ledger, service } = setup();
		const abort = new AbortController();
		b.hold('fs:continueWrite');
		const writing = service.writeFile(PATH, new Uint8Array(5000), { signal: abort.signal });
		await new Promise((resolve) => setImmediate(resolve));
		abort.abort();
		b.release();
		await assert.rejects(writing);

		assert.deepEqual(b.kinds().slice(-2), [`close ${HANDLE}`, 'fs:delete'], 'the slot closed and the partial file gone');
		assert.equal(ledger.pending(), 0);
	});

	it('leaves a read\'s file alone: it closes the slot only', async () => {
		const { b, service } = setup();
		b.cutOn('fs:continueRead');
		await assert.rejects(service.readFile(PATH));
		b.reconnect();
		b.clear();

		await service.readFile(PATH);

		assert.deepEqual(b.kinds().slice(0, 2), [`close ${HANDLE}`, 'fs:beginRead']);
	});

	it('sweeps a slot it never learned, 0..63 and no higher, only when the user agrees', async () => {
		let asked = 0;
		const { b, service } = setup(async () => { asked += 1; return true; });
		b.cutOn('fs:beginWrite');                // the first command's reply lost
		await assert.rejects(service.writeFile(PATH, content));
		b.reconnect();
		b.clear();

		await service.writeFile('/home/root/lms2012/prjs/y.rbf', new Uint8Array(10));

		const closes = b.commands.filter((c): c is Extract<BrickCommand, { kind: 'fs:closeHandle' }> => c.kind === 'fs:closeHandle');
		assert.deepEqual(closes.map((c) => c.handle), Array.from({ length: 64 }, (_, i) => i));
		assert.equal(asked, 1);
		assert.ok(b.kinds().includes('fs:delete'));
	});

	it('does not sweep when the user declines, and does not ask again', async () => {
		let asked = 0;
		const { b, ledger, service } = setup(async () => { asked += 1; return false; });
		b.cutOn('fs:beginWrite');
		await assert.rejects(service.writeFile(PATH, content));
		b.reconnect();
		b.clear();

		await service.writeFile('/home/root/lms2012/prjs/y.rbf', new Uint8Array(10));
		await service.writeFile('/home/root/lms2012/prjs/z.rbf', new Uint8Array(10));

		assert.equal(b.kinds().filter((k) => k.startsWith('close')).length, 0);
		assert.equal(asked, 1);
		assert.equal(ledger.pending(), 0);
	});

	it('never sweeps without someone to ask: the debt waits', async () => {
		const { b, ledger, service } = setup();
		b.cutOn('fs:beginWrite');
		await assert.rejects(service.writeFile(PATH, content));
		b.reconnect();
		b.clear();

		await service.writeFile('/home/root/lms2012/prjs/y.rbf', new Uint8Array(10));

		assert.equal(b.kinds().filter((k) => k.startsWith('close')).length, 0);
		assert.equal(ledger.pending(), 1);
	});

	it('settles nothing while another transfer of its own is running: it could close that one\'s slot', async () => {
		const { b, ledger, service } = setup(async () => true);
		b.cutOn('fs:beginWrite');
		await assert.rejects(service.writeFile(PATH, content));
		b.reconnect();
		b.hold('fs:continueWrite');
		const first = service.writeFile('/home/root/lms2012/prjs/a.rbf', new Uint8Array(3000));
		await new Promise((resolve) => setImmediate(resolve));
		b.clear();

		const second = service.readFile(PATH);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(b.kinds().filter((k) => k.startsWith('close')).length, 0, 'no sweep under a running transfer');
		b.release();
		await Promise.all([first, second]);
		assert.equal(ledger.pending(), 0, 'settled by the first transfer, before it began');
	});

	it('leaves a debt that arose while a transfer of its own runs for after it: no sweep under it', async () => {
		const { b, ledger, service } = setup(async () => true);
		b.hold('fs:continueWrite');
		const running = service.writeFile('/home/root/lms2012/prjs/a.rbf', new Uint8Array(3000));
		await new Promise((resolve) => setImmediate(resolve));
		ledger.owe({ kind: 'unknown' });          // another call's first reply, lost meanwhile
		b.clear();

		const next = service.readFile(PATH);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(b.kinds().filter((k) => k.startsWith('close')).length, 0, 'the running write keeps its slot');
		b.release();
		await Promise.all([running, next]);
		assert.equal(ledger.pending(), 1, 'still owed, for a transfer that starts with nothing running');
	});

	it('keeps one ledger per brick for the same brick layer', () => {
		const layer = {};
		assert.equal(ledgerFor(layer, 'AAA' as BrickId), ledgerFor(layer, 'AAA' as BrickId));
		assert.notEqual(ledgerFor(layer, 'AAA' as BrickId), ledgerFor(layer, 'BBB' as BrickId));
		assert.notEqual(ledgerFor(layer, 'AAA' as BrickId), ledgerFor({}, 'AAA' as BrickId));
	});

	it('never puts a slot number past the firmware\'s table on the wire', () => {
		assert.throws(() => buildCommand({ kind: 'fs:closeHandle', handle: 64 }), /0..63/);
		assert.throws(() => buildCommand({ kind: 'fs:continueWrite', handle: 200, chunk: new Uint8Array(1) }), /0..63/);
		assert.doesNotThrow(() => buildCommand({ kind: 'fs:closeHandle', handle: 63 }));
	});
});
