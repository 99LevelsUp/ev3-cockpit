/**
 * How long must the cockpit wait between Bluetooth connects? (step-1 plan, U3.2 / D3)
 *
 *   node scripts/bt-gap-sweep.js [--per-gap N] [brick ...]
 *
 * The queue waits 15 s after a clean close and 30 s (growing) after a failure. Nothing has
 * shown that waiting helps: a longer cooldown never raised the open rate (plan 2.8.16), and on
 * this host a second attempt one second after a failure has opened. This sweeps the gap
 * directly: for each brick, open -> `info` -> close cycles, each measured one preceded by a gap
 * drawn in shuffled order from {0, 2, 5, 15, 30} s **after a clean close**. A measured attempt
 * that fails is followed by recovery retries -- pauses of 1, 5 or 15 s, drawn at random -- until
 * one opens; those are the "after a failure" data. The first version of this script let every
 * attempt follow whatever came before, and on 29.10.2026 one failure turned into 119 more: each
 * attempt followed a failure, so the chain never got back to the question it was asking.
 *
 * The queue is built with no cooldown, so the gap is the only wait. Bricks run one after the
 * other, never at once. Only `info` goes to a brick.
 *
 * Decision rule, written before the run (plan U3.2): after a clean close, the inter-connection
 * gap becomes the shortest gap whose open rate is no more than 10 percentage points below the
 * 15 s rate; after a failure, the shortest recovery pause no more than 10 points below 15 s. Pooled over bricks; reported per brick
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
const RETRY_PAUSES_S = [1, 5, 15];
const MAX_RETRIES = 8;
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

	const next = () => (counter = (counter + 1) & 0xffff);

	/** Retries until an open succeeds, recording each retry; false if the brick never answers. */
	async function recover(brick, key) {
		for (let n = 1; n <= MAX_RETRIES; n += 1) {
			const pauseS = RETRY_PAUSES_S[Math.floor(Math.random() * RETRY_PAUSES_S.length)];
			await wait(pauseS * 1000);
			const result = await cycle(provider, key, next());
			retries.push({ brick: brick.name, pauseS, ...result });
			log(`${brick.name}   retry after ${String(pauseS).padStart(2)} s -> `
				+ (result.ok ? `ok ${result.openMs} ms` : `FAIL ${result.openMs} ms ${result.error}`));
			if (result.ok) { return true; }
		}
		return false;
	}

	const retries = [];
	for (const brick of bricks) {
		const key = makeBrickKey(Transport.BT, brick.mac);
		// An unmeasured open first, so every measured gap starts after a clean close.
		const warm = await cycle(provider, key, next());
		log(`${brick.name} warm-up ${warm.ok ? 'ok' : `FAIL ${warm.error}`}`);
		if (!warm.ok && !(await recover(brick, key))) { log(`${brick.name}: never opened, skipped`); continue; }

		let abandoned = false;
		for (const gapS of shuffled(GAPS_S.flatMap((g) => Array(PER_GAP).fill(g)))) {
			await wait(gapS * 1000);
			const result = await cycle(provider, key, next());
			rows.push({ brick: brick.name, gapS, prevOk: true, ...result });
			log(`${brick.name} gap ${String(gapS).padStart(2)} s after a clean close -> `
				+ (result.ok ? `ok ${result.openMs} ms` : `FAIL ${result.openMs} ms ${result.error}`));
			if (!result.ok && !(await recover(brick, key))) { abandoned = true; break; }
		}
		if (abandoned) { log(`${brick.name}: ${MAX_RETRIES} retries in a row failed, brick abandoned`); }
	}

	for (const brick of bricks) { table(`${brick.name}`, rows.filter((r) => r.brick === brick.name)); }
	table('All bricks pooled', rows);
	console.log('\nrecovery retries after a failure, pooled');
	for (const p of RETRY_PAUSES_S) {
		const list = retries.filter((r) => r.pauseS === p);
		const ok = list.filter((r) => r.ok).length;
		console.log(`  pause ${String(p).padStart(2)} s: ${ok}/${list.length}${list.length ? ` (${Math.round((ok / list.length) * 100)} %)` : ''}`);
	}
	console.log(`\n-- ${Math.round((Date.now() - t0) / 60000)} min, ${rows.length} measured attempts --`);
	queue.dispose?.();
	provider.dispose?.();
}

const keepAlive = setInterval(() => {}, 1000);
main().then(
	() => { clearInterval(keepAlive); process.exit(process.exitCode ?? 0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); }
);
