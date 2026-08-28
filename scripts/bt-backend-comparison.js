/**
 * Which Bluetooth backend actually holds up: Winsock RFCOMM or SPP over a COM port.
 *
 * This is P7 of the testlab re-survey brief, run here rather than there because the code
 * under test is the code that ships. The lab compared the backends for *connecting at all*
 * and picked Winsock; nothing has ever compared them for staying connected, and the one
 * number this repo produced on the subject — an SPP open rate near 50% — was collected at a
 * 2-second spacing against a channel that documented 10 and 30 second recoveries. That
 * measured the pacing violation, not the backend.
 *
 * So both backends run through the real `BtTransportProvider` and share one real
 * `BtConnectionQueue`. Every cooldown the product enforces is enforced here, which makes the
 * run slow on purpose: roughly a minute and a half per round for three bricks.
 *
 * Round-robin across bricks rather than brick by brick, because a diagnosis drawn from one
 * piece of hardware has already been wrong four times on this transport. Backends alternate
 * per round for the same reason — a drift in the host stack should not land entirely on
 * whichever went second.
 *
 *   node scripts/bt-backend-comparison.js               five rounds
 *   node scripts/bt-backend-comparison.js --rounds 10
 *   node scripts/bt-backend-comparison.js --only winsock
 *
 * Reports per backend: open rate, open latency spread, round-trip, and what failed.
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
	BtTransportProvider, BtSppBackend, BtWinsockAdapter, BtConnectionQueue,
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

const ROUNDS = Number.parseInt(argAfter('--rounds', '5'), 10);
const ONLY = argAfter('--only', undefined);

let counter = 0;

/** Opens, asks the brick who it is, closes. One full connection lifecycle. */
async function attempt(provider, key) {
	const startedAt = Date.now();
	let openedMs;

	try {
		await provider.connect(key);
		openedMs = Date.now() - startedAt;

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
		return { ok: true, openedMs, rttMs, name: info.displayName };
	} catch (error) {
		// disconnect() is safe on a session that never opened, and skipping it would leak
		// the queue slot for the rest of the run.
		await provider.disconnect(key).catch(() => { /* nothing to release */ });
		return {
			ok: false,
			openedMs: openedMs ?? Date.now() - startedAt,
			error: String((error && error.message) || error),
		};
	}
}

function summarise(label, samples) {
	const ok = samples.filter((s) => s.ok);
	const failed = samples.filter((s) => !s.ok);
	const pct = samples.length ? ((ok.length / samples.length) * 100).toFixed(0) : '0';

	console.log(`\n${label}`);
	console.log(`  opened ${ok.length}/${samples.length}  (${pct}%)`);

	const spread = (list, field) => {
		const values = list.map((s) => s[field]).filter((v) => typeof v === 'number')
			.sort((a, b) => a - b);
		if (!values.length) { return 'no data'; }
		return `${values[0]}..${values[values.length - 1]} ms, median `
			+ `${values[Math.floor(values.length / 2)]} ms`;
	};

	if (ok.length) {
		console.log(`  connect  ${spread(ok, 'openedMs')}`);
		console.log(`  exchange ${spread(ok, 'rttMs')}`);
	}
	if (failed.length) {
		console.log(`  failed   ${spread(failed, 'openedMs')}`);
		const reasons = new Map();
		for (const s of failed) {
			// Keep the whole message. Truncating one to 40 characters once turned a
			// 15000 ms timeout into an apparent 1500 ms one.
			reasons.set(s.error, (reasons.get(s.error) ?? 0) + 1);
		}
		for (const [reason, n] of reasons) { console.log(`    ${n}x ${reason}`); }
	}
}

async function main() {
	const discovery = new BtSppBackend();

	// A COM port scan, not a radio operation: it reads what Windows already knows about
	// paired peers, so it costs the channel nothing.
	const peers = await discovery.discover();
	if (!peers.length) {
		console.log('No paired EV3 found. Pair at least one brick first.');
		process.exit(1);
	}

	const queue = new BtConnectionQueue();
	const backends = [
		['winsock', new BtTransportProvider({
			backends: new Map([['winsock', (mac) => new BtWinsockAdapter({ mac })]]),
			connectionQueue: queue,
		})],
		['spp', new BtTransportProvider({
			backends: new Map([['spp', discovery.adapterFor]]),
			connectionQueue: queue,
		})],
	].filter(([name]) => !ONLY || name === ONLY);

	const results = new Map(backends.map(([name]) => [name, []]));

	console.log(`${peers.length} brick(s), ${backends.map(([n]) => n).join(' vs ')}, `
		+ `${ROUNDS} rounds`);
	console.log('Pacing is the product\'s own: 15 s after a clean close, 30 s after a failure.\n');
	const startedAt = Date.now();

	for (let round = 1; round <= ROUNDS; round += 1) {
		// Alternate so neither backend always follows the other's cooldown.
		const order = round % 2 === 0 ? [...backends].reverse() : backends;

		for (const peer of peers) {
			const key = makeBrickKey(Transport.BT, peer.mac);
			for (const [name, provider] of order) {
				const result = await attempt(provider, key);
				results.get(name).push(result);
				process.stderr.write(
					`  r${String(round).padStart(2)} ${peer.mac} ${name.padEnd(7)} `
					+ (result.ok
						? `ok    ${String(result.openedMs).padStart(6)} ms  rtt ${result.rttMs} ms  ${result.name}`
						: `FAIL  ${String(result.openedMs).padStart(6)} ms  ${result.error}`)
					+ '\n'
				);
			}
		}
	}

	console.log(`\n── ${((Date.now() - startedAt) / 60000).toFixed(1)} minutes ──`);
	for (const [name, samples] of results) { summarise(name, samples); }

	// The question the run exists to answer.
	const rate = (name) => {
		const samples = results.get(name) ?? [];
		return samples.length ? samples.filter((s) => s.ok).length / samples.length : 0;
	};
	if (results.size === 2) {
		const [a, b] = [...results.keys()];
		console.log(`\n  ${a} ${(rate(a) * 100).toFixed(0)}% vs ${b} ${(rate(b) * 100).toFixed(0)}%`);
	}

	queue.dispose?.();
	for (const [, provider] of backends) { provider.dispose?.(); }
}

// BtConnectionQueue unrefs its drain timer, which is right inside an extension host and
// fatal in a script: while the queue is serving a 30-second cooldown there is nothing
// referenced left to run, so Node decides the program is finished and exits 0 mid-run.
// The first attempt at this file died exactly there, after one line of output.
const keepAlive = setInterval(() => { /* hold the loop open */ }, 1000);

main().then(
	() => { clearInterval(keepAlive); process.exit(0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); }
);
