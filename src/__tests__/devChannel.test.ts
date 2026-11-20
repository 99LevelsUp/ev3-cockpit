/** The pieces under brick loans: the device gate, the hardware lock, and replacement inside a development channel. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { Transport, makeBrickKey } from '../core/contracts';
import { LoanGate } from '../core/runtime/deviceGate';
import { createReplacement } from '../daemon/handover';
import { HardwareLock } from '../daemon/hardwareLock';

const usbKey = (serial: string) => makeBrickKey(Transport.USB, serial);
const at = { busNumber: 1, deviceAddress: 7 };

describe('the device gate', () => {
	it('lets an owner open everything but what it lent, and nothing once it lent everything', () => {
		const gate = new LoanGate('owner');
		gate.add('001653F00C0C', [at]);
		assert.equal(gate.mayOpen(usbKey('001653F00C0C')), false);
		assert.equal(gate.mayOpen(usbKey('001653F00A0A')), true);
		assert.equal(gate.mayOpenUsb(at), false);
		assert.equal(gate.mayOpenUsb({ busNumber: 1, deviceAddress: 8 }), true);
		assert.equal(gate.mayUseRadio(), true);
		gate.setAll(true);
		assert.equal(gate.mayOpen(usbKey('001653F00A0A')), false);
		assert.equal(gate.mayUseRadio(), false);
	});

	it('lets a borrower open only what it borrowed, and the radio only with everything', () => {
		const gate = new LoanGate('borrower');
		assert.equal(gate.mayOpen(usbKey('001653F00C0C')), false);
		assert.equal(gate.mayOpenUsb(at), false);
		gate.add('001653F00C0C', [at]);
		assert.equal(gate.mayOpen(usbKey('001653F00C0C')), true);
		assert.equal(gate.mayOpenUsb(at), true);
		assert.equal(gate.mayUseRadio(), false);
		gate.setAll(true);
		assert.equal(gate.mayUseRadio(), true);
		gate.own();
		assert.equal(gate.role, 'owner');
		assert.equal(gate.mayOpen(usbKey('001653F00A0A')), true);
	});
});

describe('the hardware lock', () => {
	it('is held by one process, and taken over from one that died', () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-lock-')), 'hardware.lock');
		const first = new HardwareLock(file, undefined);
		assert.equal(first.tryTake(), true);
		const second = new HardwareLock(file, 'dev-x');
		assert.equal(second.tryTake(), false);
		assert.equal(second.holder()?.pid, process.pid);
		first.release();
		assert.equal(second.tryTake(), true);
		second.release();
		// A holder that is gone: a pid nobody has.
		fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
		assert.equal(new HardwareLock(file, undefined).tryTake(), true);
	});

	it('appears with its holder in it, and takes over a damaged lock', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-lock-'));
		const file = path.join(dir, 'hardware.lock');
		const lock = new HardwareLock(file, 'dev-x');
		assert.equal(lock.tryTake(), true);
		assert.deepEqual({ ...JSON.parse(fs.readFileSync(file, 'utf8')), at: 0 }, { pid: process.pid, channel: 'dev-x', at: 0 });
		assert.deepEqual(fs.readdirSync(dir), ['hardware.lock']);
		lock.release();
		// Unreadable and new: perhaps still being written where there are no hard links.
		fs.writeFileSync(file, '{"pid":');
		assert.equal(new HardwareLock(file, undefined).tryTake(), false);
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(file, old, old);
		assert.equal(new HardwareLock(file, undefined).tryTake(), true);
	});

	it('leaves a dead holder\'s lock to the daemon already taking it over, and clears a guard a dead one left', () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-lock-')), 'hardware.lock');
		fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
		const guard = `${file}.takeover`;
		fs.writeFileSync(guard, '');
		assert.equal(new HardwareLock(file, undefined).tryTake(), false);
		assert.ok(fs.existsSync(file), 'the lock was removed under another daemon\'s takeover');
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(guard, old, old);
		const lock = new HardwareLock(file, undefined);
		assert.equal(lock.tryTake(), false);
		assert.equal(fs.existsSync(guard), false);
		assert.equal(lock.tryTake(), true);
	});
});

describe('replacement inside a development channel', () => {
	const launch = (version: string) => ({ runtime: 'node', entry: 'daemon.js', installRoot: '.', version });

	it('takes any other version there, and only a newer one elsewhere', () => {
		const handed: string[] = [];
		const options = { version: '0.2.10', idle: () => false, handOver: (l: { version: string }) => { handed.push(l.version); }, log: () => undefined };
		const user = createReplacement(options);
		assert.equal(user.register(launch('0.2.9')).accepted, false);
		assert.equal(user.register(launch('0.2.10')).accepted, false);
		assert.equal(user.register(launch('0.2.11')).accepted, true);
		user.dispose();
		const dev = createReplacement({ ...options, anyDifference: true });
		assert.equal(dev.register(launch('0.2.9')).accepted, true);
		assert.equal(dev.register(launch('0.2.10')).accepted, false);
		dev.dispose();
		assert.deepEqual(handed, []);
	});
});
