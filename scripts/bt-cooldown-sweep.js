/**
 * Isolates what makes an RFCOMM connect fail (plan 2.8.16).
 *
 * 2.8.14 compared the two BT backends and found no difference worth the name in open rate
 * (Winsock 40%, SPP 47%, at the product's own 15 s/30 s cooldowns) even though Winsock is
 * six times faster on the round trip. That ruled out the backend and ruled out the *default*
 * pacing, but left the pacing itself untested as a variable: every prior measurement used the
 * product's fixed cooldowns, never a longer one.
 *
 * This varies exactly one thing against one brick, Winsock only: the cooldown between
 * attempts, stepped from the product default up through several multiples of it. If a longer
 * wait recovers the open rate, the fix is a bigger cooldown. If it does not, waiting longer is
 * not the answer and whatever is refusing the RFCOMM channel is untouched by time.
 *
 * Reports queue wait and adapter-open time separately (the instrument fix 2.8.16 calls for):
 * comparing cooldowns with a number that already contains the cooldown would confound the
 * experiment with the thing it varies.
 *
 *   node scripts/bt-cooldown-sweep.js                         first paired brick, default steps
 *   node scripts/bt-cooldown-sweep.js --mac 00:16:53:42:D9:F2  a specific brick
 *   node scripts/bt-cooldown-sweep.js --steps 15000,30000,60000,90000,120000
 *   node scripts/bt-cooldown-sweep.js --attempts 10
 *
 * Slow on purpose: each step waits out its own cooldown `attempts` times.
 */

'use strict';

const path = require('path');
const REPO = path.resolve(__dirname, '..');

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'vscode') { return path.join(REPO, 'src/test/vscodeStub.cjs'); }
	return originalResolve.call(this, request, ...rest);
};

const out = (dir) => path.join(REPO, 'out', dir);
const {
	BtTransportProvider, BtWinsockAdapter, BtConnectionQueue, BtSppBackend,
} = require(out('transports'));
const { encodeEv3Packet, decodeEv3Packet } = require(out('protocol/ev3Packet'));
const { buildCommand } = require(out('protocol/ev3Commands'));
const { parseResponse } = require(out('protocol/ev3Responses'));
const { makeBrickKey } = require(out('contracts/brickKey'));
const { Transport } = require(out('contracts/enums'));

const argAfter = (flag, fallback) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const STEPS_MS = argAfter('--steps', '15000,30000,60000,90000')
	.split(',').map((s) => Number.parseInt(s, 10));
const ATTEMPTS_PER_STEP = Number.parseInt(argAfter('--attempts', '8'), 10);
const MAC_FILTER = argAfter('--mac', undefined);

const normaliseMac = (mac) => mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();

/** See bt-backend-comparison.js: separates the queue's wait from the adapter's own open time. */
function trackQueueWait(queue) {
	const originalAcquire = queue.acquire.bind(queue);
	let lastWaitMs = 0;
	queue.acquire = async (id) => {
		const startedAt = Date.now();
		const release = await originalAcquire(id);
		lastWaitMs = Date.now() - startedAt;
		return release;
	};
	return () => lastWaitMs;
}

let counter = 0;

/** Opens, asks the brick who it is, closes. One full connection lifecycle. */
async function attempt(provider, key, readQueueWaitMs) {
	const startedAt = Date.now();
	let openedMs;

	try {
		await provider.connect(key);
		openedMs = Date.now() - startedAt;
		const queueWaitMs = readQueueWaitMs();
		const connectMs = openedMs - queueWaitMs;

		counter = (counter + 1) & 0xffff;
		const { type, payload } = buildCommand({ kind: 'info' });
		const sentAt = Date.now();
		const reply = await provider.sendPacket(key, encodeEv3Packet(counter, type, payload), {
			expectedMessageCounter: counter,
			timeoutMs: 4000,
		});
		const rttMs = Date.now() - sentAt;
		const info = parseResponse({ kind: 'info' }, decodeEv3Packet(reply));

		await provider.disconnect(key);
		return {
			ok: true, openedMs, queueWaitMs, connectMs, rttMs, name: info.displayName,
		};
	} catch (error) {
		await provider.disconnect(key).catch(() => { /* nothing to release */ });
		const total = openedMs ?? Date.now() - startedAt;
		const queueWaitMs = readQueueWaitMs();
		return {
			ok: false,
			openedMs: total,
			queueWaitMs,
			connectMs: total - queueWaitMs,
			error: String((error && error.message) || error),
		};
	}
}

function spread(list, field) {
	const values = list.map((s) => s[field]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
	if (!values.length) { return 'no data'; }
	return `${values[0]}..${values[values.length - 1]} ms, median ${values[Math.floor(values.length / 2)]} ms`;
}

function summarise(stepMs, samples) {
	const ok = samples.filter((s) => s.ok);
	const failed = samples.filter((s) => !s.ok);
	const pct = samples.length ? (ok.length / samples.length) * 100 : 0;

	console.log(`\ncooldown ${stepMs} ms  —  opened ${ok.length}/${samples.length} (${pct.toFixed(0)}%)`);
	if (ok.length) {
		console.log(`  queue wait ${spread(ok, 'queueWaitMs')}`);
		console.log(`  connect    ${spread(ok, 'connectMs')}`);
		console.log(`  exchange   ${spread(ok, 'rttMs')}`);
	}
	if (failed.length) {
		console.log(`  failed     ${spread(failed, 'openedMs')}`
			+ ` (queue wait ${spread(failed, 'queueWaitMs')}, connect ${spread(failed, 'connectMs')})`);
		const reasons = new Map();
		for (const s of failed) { reasons.set(s.error, (reasons.get(s.error) ?? 0) + 1); }
		for (const [reason, n] of reasons) { console.log(`    ${n}x ${reason}`); }
	}
	return pct;
}

async function main() {
	const discovery = new BtSppBackend();
	const peers = await discovery.discover();
	if (!peers.length) {
		console.log('No paired EV3 found. Pair at least one brick first.');
		process.exit(1);
	}

	const target = MAC_FILTER
		? peers.find((p) => normaliseMac(p.mac).endsWith(normaliseMac(MAC_FILTER)))
		: peers[0];
	if (!target) {
		console.log(`No paired brick matches --mac ${MAC_FILTER}. Paired: ${peers.map((p) => p.mac).join(', ')}`);
		process.exit(1);
	}

	console.log(`Target: ${target.mac} (${target.name || 'unnamed'})`);
	console.log(`Steps: ${STEPS_MS.join(', ')} ms · ${ATTEMPTS_PER_STEP} attempts each · Winsock only.`);
	console.log('Each step sets both the clean-close and error-recovery cooldown to the step '
		+ 'value, and lifts the backoff cap to match, so a run of failures cannot be capped '
		+ 'back down to a shorter wait than the step being tested.\n');

	const key = makeBrickKey(Transport.BT, target.mac);
	const startedAt = Date.now();
	const summary = [];

	for (const stepMs of STEPS_MS) {
		const queue = new BtConnectionQueue({
			interConnectionCooldownMs: stepMs,
			errorRecoveryCooldownMs: stepMs,
			backoffMax: stepMs,
			// Must exceed stepMs, or 1.11.12's own ceiling-reached timeout fires as a false
			// "no slot available" failure once a step's cooldown is pushed past that
			// timeout's default (measured 28.08.2026 at the 60 s step, whose real WSA-10060
			// failures were briefly mixed in with three of these artifacts).
			acquireTimeoutMs: stepMs * 2,
		});
		const readQueueWaitMs = trackQueueWait(queue);
		const provider = new BtTransportProvider({
			backends: new Map([['winsock', (mac) => new BtWinsockAdapter({ mac })]]),
			connectionQueue: queue,
		});

		const samples = [];
		for (let i = 1; i <= ATTEMPTS_PER_STEP; i += 1) {
			const result = await attempt(provider, key, readQueueWaitMs);
			samples.push(result);
			process.stderr.write(
				`  [${stepMs}ms] ${String(i).padStart(2)}/${ATTEMPTS_PER_STEP}  `
				+ (result.ok
					? `ok    total ${String(result.openedMs).padStart(6)} ms  `
						+ `(wait ${result.queueWaitMs} / open ${result.connectMs})  rtt ${result.rttMs} ms`
					: `FAIL  total ${String(result.openedMs).padStart(6)} ms  ${result.error}`)
				+ '\n'
			);
		}

		const pct = summarise(stepMs, samples);
		summary.push({ stepMs, pct, n: samples.length });
		queue.dispose();
		provider.dispose();
	}

	console.log(`\n── ${((Date.now() - startedAt) / 60000).toFixed(1)} minutes total ──`);
	console.log('\ncooldown(ms)  open%');
	for (const { stepMs, pct } of summary) {
		console.log(`${String(stepMs).padStart(10)}  ${pct.toFixed(0)}%`);
	}
}

// See bt-backend-comparison.js: the queue unrefs its own timers, so nothing else keeps a
// script alive between a clean close and the next attempt without this.
const keepAlive = setInterval(() => { /* hold the loop open */ }, 1000);

main().then(
	() => { clearInterval(keepAlive); process.exit(0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); }
);
