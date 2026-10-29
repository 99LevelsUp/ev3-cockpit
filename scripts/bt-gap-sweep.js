/**
 * How long must the cockpit wait between Bluetooth connects? (step-1 plan, U3.2 / D3)
 *
 *   node scripts/bt-gap-sweep.js [--per-gap N] [brick ...]
 *
 * The queue waits 15 s after a clean close and 30 s (growing) after a failure. Nothing has
 * shown that waiting helps: a longer cooldown never raised the open rate (plan 2.8.16), and on
 * this host a second attempt one second after a failure has opened. This sweeps the gap
 * directly: for each brick, a chain of open -> `info` -> close cycles, each preceded by a gap
 * drawn in shuffled order from {0, 2, 5, 15, 30} s, so no gap always follows another. Every
 * attempt records the gap before it and whether the previous attempt on that brick opened.
 *
 * The queue is built with no cooldown, so the gap is the only wait. Bricks run one after the
 * other, never at once. Only `info` goes to a brick.
 *
 * Decision rule, written before the run (plan U3.2): after a clean close, the inter-connection
 * gap becomes the shortest gap whose open rate is no more than 10 percentage points below the
 * 15 s rate; after a failure, the same against 30 s. Pooled over bricks; reported per brick
 * too. This host's adapter fails about half its connects (2.8.16), so the rates are low in
 * absolute terms; the comparison between gaps is what the run is for.
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
	UsbTransportProvider, BtTransportProvider, BtWinsockAdapter, BtConnectionQueue,
} = require(out('transports'));
const { encodeEv3Packet, decodeEv3Packet } = require(out('protocol/ev3Packet'));
const { buildCommand } = require(out('protocol/ev3Commands'));
const { parseResponse } = require(out('protocol/ev3Responses'));
const { makeBrickKey } = require(out('contracts/brickKey'));
const { Transport } = require(out('contracts/enums'));

const GAPS_S = [0, 2, 5, 15, 30];
const argAfter = (flag, fallback) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PER_GAP = Number.parseInt(argAfter('--per-gap', '8'), 10);
const names = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--per-gap')
	.map((n) => n.toUpperCase());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const log = (line) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(5)} s  ${line}`);

function shuffled(list) {
	const a = [...list];
	for (let i = a.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

async function cycle(provider, key, counter) {
	const at = Date.now();
	try {
		await provider.connect(key);
		const openMs = Date.now() - at;
		const { type, payload } = buildCommand({ kind: 'info' });
		const reply = await provider.sendPacket(key, encodeEv3Packet(counter, type, payload), {
			expectedMessageCounter: counter, timeoutMs: 3000,
		});
		parseResponse({ kind: 'info' }, decodeEv3Packet(reply));
		await provider.disconnect(key);
		return { ok: true, openMs };
	} catch (error) {
		await provider.disconnect(key).catch(() => {});
		return { ok: false, openMs: Date.now() - at, error: String((error && error.message) || error) };
	}
}

function table(label, rows) {
	console.log(`\n${label}`);
	console.log('  gap s | after clean close | after failure');
	for (const g of GAPS_S) {
		const cell = (prevOk) => {
			const list = rows.filter((r) => r.gapS === g && r.prevOk === prevOk);
			const ok = list.filter((r) => r.ok).length;
			return list.length ? `${ok}/${list.length} (${Math.round((ok / list.length) * 100)} %)` : '-';
		};
		console.log(`  ${String(g).padStart(5)} | ${cell(true).padEnd(17)} | ${cell(false)}`);
	}
}

async function main() {
	const usb = new UsbTransportProvider({ log: { info: () => {}, warn: () => {} } });
	const items = (await usb.discover()).items;
	usb.dispose?.();
	const bricks = items
		.filter((i) => !names.length || names.includes(i.displayName.toUpperCase()))
		.map((i) => ({ name: i.displayName, mac: (i.brickKey.split(':').pop().match(/../g) ?? []).join(':').toUpperCase() }));
	console.log(`Bricks: ${bricks.map((b) => b.name).join(', ')}; gaps ${GAPS_S.join('/')} s, ${PER_GAP} each, shuffled.`);

	const queue = new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0 });
	const provider = new BtTransportProvider({
		backends: new Map([['winsock', (m) => new BtWinsockAdapter({ mac: m })]]),
		connectionQueue: queue,
	});
	const rows = [];
	let counter = 0;

	for (const brick of bricks) {
		const key = makeBrickKey(Transport.BT, brick.mac);
		// One unmeasured cycle first, so the first measured attempt has a known predecessor.
		let prev = await cycle(provider, key, (counter = (counter + 1) & 0xffff));
		log(`${brick.name} warm-up ${prev.ok ? 'ok' : `FAIL ${prev.error}`}`);
		for (const gapS of shuffled(GAPS_S.flatMap((g) => Array(PER_GAP).fill(g)))) {
			await wait(gapS * 1000);
			const result = await cycle(provider, key, (counter = (counter + 1) & 0xffff));
			rows.push({ brick: brick.name, gapS, prevOk: prev.ok, ...result });
			log(`${brick.name} gap ${String(gapS).padStart(2)} s after ${prev.ok ? 'ok  ' : 'FAIL'} -> `
				+ (result.ok ? `ok ${result.openMs} ms` : `FAIL ${result.openMs} ms ${result.error}`));
			prev = result;
		}
	}

	for (const brick of bricks) { table(`${brick.name}`, rows.filter((r) => r.brick === brick.name)); }
	table('All bricks pooled', rows);
	console.log(`\n-- ${Math.round((Date.now() - t0) / 60000)} min, ${rows.length} measured attempts --`);
	queue.dispose?.();
	provider.dispose?.();
}

const keepAlive = setInterval(() => {}, 1000);
main().then(
	() => { clearInterval(keepAlive); process.exit(process.exitCode ?? 0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); }
);
