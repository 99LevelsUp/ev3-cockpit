/**
 * Does a timed-out Bluetooth connect leave a libuv thread blocked for good?
 *
 *   node scripts/bt-threadpool-probe.js <MAC> [--attempts N]
 *   UV_THREADPOOL_SIZE=32 node scripts/bt-threadpool-probe.js <MAC>
 *
 * Both gap sweeps of 29.10.2026 collapsed the same way: after one fast reconnect failed, every
 * later connect to every brick ran into the 15 s deadline until the process exited, and a new
 * process connected at once. The Winsock connect runs through koffi's `.async()`, on Node's
 * worker pool (4 threads by default); the deadline closes the socket and assumes that ends the
 * blocked call. If it does not, each timeout parks one worker for good, and once the pool is
 * gone nothing that needs it runs -- the next connect, and also file system calls.
 *
 * So after every attempt this asks the pool a trivial question (`fs.promises.stat`) with a
 * 3 s limit. Attempts reconnect with no gap after a clean close, the sequence that started both
 * collapses. Only `info` goes to the brick.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'vscode') { return path.join(REPO, 'src/test/vscodeStub.cjs'); }
	return originalResolve.call(this, request, ...rest);
};

const out = (dir) => path.join(REPO, 'out', dir);
const { BtTransportProvider, BtWinsockAdapter, BtConnectionQueue } = require(out('transports'));
const { makeBrickKey } = require(out('contracts/brickKey'));
const { Transport } = require(out('contracts/enums'));

const mac = (process.argv[2] ?? '').toUpperCase();
const i = process.argv.indexOf('--attempts');
const ATTEMPTS = i >= 0 ? Number.parseInt(process.argv[i + 1], 10) : 10;
const t0 = Date.now();
const log = (line) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${line}`);

async function poolCheck() {
	const at = Date.now();
	const answered = await Promise.race([
		fs.promises.stat(__filename).then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
	]);
	return answered ? `fs ok ${Date.now() - at} ms` : 'fs STUCK (no answer in 3 s)';
}

async function main() {
	console.log(`UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '(default 4)'}; ${mac}; ${ATTEMPTS} attempts, no gap`);
	const queue = new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0 });
	// No reconnect gap: this probe provokes the fast-reconnect sequence on purpose.
	const bt = new BtTransportProvider({
		backends: new Map([['winsock', (m) => new BtWinsockAdapter({ mac: m })]]),
		connectionQueue: queue,
		reconnectGapAfterCloseMs: 0,
	});
	const key = makeBrickKey(Transport.BT, mac);
	log(`before any connect: ${await poolCheck()}`);
	for (let n = 1; n <= ATTEMPTS; n += 1) {
		const at = Date.now();
		let outcome;
		try {
			await bt.connect(key);
			outcome = `open in ${Date.now() - at} ms`;
			await bt.disconnect(key);
		} catch (error) {
			await bt.disconnect(key).catch(() => {});
			outcome = `FAIL in ${Date.now() - at} ms: ${(error && error.message) || error}`;
		}
		log(`attempt ${n}: ${outcome} | ${await poolCheck()}`);
	}
	queue.dispose?.();
	bt.dispose?.();
}

const keepAlive = setInterval(() => {}, 1000);
main().then(
	() => { clearInterval(keepAlive); process.exit(0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); }
);
