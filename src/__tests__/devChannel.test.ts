/** The pieces under brick loans: the device gate, the hardware lock, and replacement inside a development channel. */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
	const lockFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-lock-')), 'hardware.lock');
	/** A pid nobody has. */
	const DEAD = 2 ** 22 + 12345;

	it('is not taken while another live daemon claims it, and is taken once that claim is gone', () => {
		const file = lockFile();
		const lock = new HardwareLock(file, 'dev-x');
		// Another daemon's claim: the test runner that started this process is alive.
		const other = `${file}.${process.ppid}`;
		fs.writeFileSync(other, JSON.stringify({ pid: process.ppid, at: 1 }));
		assert.equal(lock.tryTake(), false);
		assert.equal(fs.existsSync(`${file}.${process.pid}`), false, 'a withdrawn claim stayed behind');
		assert.equal(lock.holder()?.pid, process.ppid);
		fs.rmSync(other);
		assert.equal(lock.tryTake(), true);
		assert.deepEqual({ ...JSON.parse(fs.readFileSync(`${file}.${process.pid}`, 'utf8')), at: 0 }, { pid: process.pid, channel: 'dev-x', at: 0 });
		assert.equal(lock.holder()?.channel, 'dev-x');
		lock.release();
		assert.equal(fs.existsSync(`${file}.${process.pid}`), false);
		assert.equal(lock.holder(), undefined);
	});

	it('clears the claim of a daemon that died, even an unreadable one', () => {
		const file = lockFile();
		fs.writeFileSync(`${file}.${DEAD}`, '{"pid":');
		const lock = new HardwareLock(file, undefined);
		assert.equal(lock.tryTake(), true);
		assert.equal(fs.existsSync(`${file}.${DEAD}`), false);
		lock.release();
	});

	it('is never held by two of many daemons claiming it at the same moment', async () => {
		const file = lockFile();
		const module = path.resolve(__dirname, '..', 'daemon', 'hardwareLock.js');
		const start = Date.now() + 1500;
		// Each daemon waits for the same instant, claims, holds for a while if it got the lock, then reports.
		const script = `const { HardwareLock } = require(${JSON.stringify(module)});
			while (Date.now() < ${start}) {}
			const lock = new HardwareLock(${JSON.stringify(file)}, undefined);
			const got = lock.tryTake();
			const until = Date.now() + 700; while (Date.now() < until) {}
			lock.release();
			process.stdout.write(got ? 'held' : 'not');`;
		const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
			execFile(process.execPath, ['-e', script], (error, stdout) => (error ? reject(error) : resolve(stdout)));
		})));
		assert.ok(runs.filter((r) => r === 'held').length <= 1, `held by ${runs.filter((r) => r === 'held').length}: ${runs.join(',')}`);
		assert.deepEqual(fs.readdirSync(path.dirname(file)), [], 'a claim stayed behind');
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
