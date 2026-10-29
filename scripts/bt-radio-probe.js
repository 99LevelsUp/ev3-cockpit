/**
 * Two questions about the one Bluetooth radio, both of which decide how the scan and the
 * connection queue may behave:
 *
 *   A. Can this host hold Bluetooth sessions to two bricks at once? The cockpit assumes not
 *      (one RFCOMM connection per host, from the old testlab) and so lets a session hold the
 *      queue's only slot for its whole life -- which today means one Bluetooth brick at a time.
 *   B. Does a live inquiry (the picker's scan) disturb an open session? The lab recommends
 *      never scanning beside a data link; nobody has measured whether it matters.
 *
 *   node scripts/bt-radio-probe.js <brickA> <brickB>
 *
 * Bricks are named as they appear on USB (the serial gives the Bluetooth address). Each
 * session gets its own queue with no cooldown, so the queue cannot hide the host's answer.
 * Only `info` goes to the bricks.
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
const { scanForBricks } = require(out('transports/btPairingHelper'));
const { BT } = require(out('transports/transportConstants'));
const { makeBrickKey } = require(out('contracts/brickKey'));
const { Transport } = require(out('contracts/enums'));

const HELPER = path.join(REPO, 'native', 'bin', 'bt-pairing-helper.exe');
const TICK_MS = 250;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const log = (line) => console.log(`${String(Date.now() - t0).padStart(6)} ms  ${line}`);

function session(name, mac, counterBase) {
	const queue = new BtConnectionQueue({ interConnectionCooldownMs: 0, errorRecoveryCooldownMs: 0 });
	const provider = new BtTransportProvider({
		backends: new Map([['winsock', (m) => new BtWinsockAdapter({ mac: m })]]),
		connectionQueue: queue,
	});
	const key = makeBrickKey(Transport.BT, mac);
	let counter = 0;
	return {
		name,
		async open() {
			for (let attempt = 1; attempt <= 4; attempt += 1) {
				const at = Date.now();
				try {
					await provider.connect(key);
					log(`${name}: Bluetooth open (attempt ${attempt}, ${Date.now() - at} ms)`);
					return true;
				} catch (error) {
					log(`${name}: open attempt ${attempt} failed after ${Date.now() - at} ms: ${(error && error.message) || error}`);
					await provider.disconnect(key).catch(() => {});
					await wait(1000);
				}
			}
			return false;
		},
		async info() {
			counter = (counter + 1) % 0x1000;
			const id = counterBase + counter;
			const { type, payload } = buildCommand({ kind: 'info' });
			const sentAt = Date.now();
			try {
				const reply = await provider.sendPacket(key, encodeEv3Packet(id, type, payload), {
					expectedMessageCounter: id, timeoutMs: 2000,
				});
				const info = parseResponse({ kind: 'info' }, decodeEv3Packet(reply));
				return { ok: info.displayName === name, rttMs: Date.now() - sentAt, error: info.displayName === name ? undefined : `answered as ${info.displayName}` };
			} catch (error) {
				return { ok: false, rttMs: Date.now() - sentAt, error: String((error && error.message) || error) };
			}
		},
		async close() {
			await provider.disconnect(key).catch(() => {});
			queue.dispose?.();
			provider.dispose?.();
		},
	};
}

function summary(label, samples) {
	const ok = samples.filter((s) => s.ok);
	const r = ok.map((s) => s.rttMs).sort((a, b) => a - b);
	const p = (q) => (r.length ? r[Math.min(r.length - 1, Math.floor(q * r.length))] : '-');
	const errors = [...new Set(samples.filter((s) => !s.ok).map((s) => s.error))];
	console.log(`  ${label.padEnd(30)} ${ok.length}/${samples.length} ok  p50 ${p(0.5)} ms  p95 ${p(0.95)} ms  max ${r.length ? r[r.length - 1] : '-'} ms`
		+ (errors.length ? `  failures: ${errors.join(' | ')}` : ''));
}

/** Sends `info` on every session every tick for `ms`, and collects the samples per session. */
async function traffic(sessions, ms) {
	const samples = new Map(sessions.map((s) => [s.name, []]));
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const tick = Date.now();
		const results = await Promise.all(sessions.map((s) => s.info()));
		results.forEach((r, i) => samples.get(sessions[i].name).push(r));
		await wait(Math.max(0, TICK_MS - (Date.now() - tick)));
	}
	return samples;
}

async function main() {
	const [nameA, nameB] = process.argv.slice(2).map((n) => n.toUpperCase());
	const usb = new UsbTransportProvider({ log: { info: () => {}, warn: () => {} } });
	const items = (await usb.discover()).items;
	usb.dispose?.();
	const macOf = (name) => {
		const item = items.find((i) => i.displayName.toUpperCase() === name);
		if (!item) { throw new Error(`${name} is not on USB; seen ${items.map((i) => i.displayName).join(', ')}`); }
		return (item.brickKey.split(':').pop().match(/../g) ?? []).join(':').toUpperCase();
	};
	const A = session(nameA, macOf(nameA), 0x1000);
	const B = session(nameB, macOf(nameB), 0x2000);

	try {
		// ── A. two sessions at once ──────────────────────────────
		console.log('\nA. Two Bluetooth sessions at once');
		if (!(await A.open())) { log('A never opened; stopping.'); return; }
		const bOpened = await B.open();
		if (!bOpened) {
			log(`${nameB} would not open beside ${nameA}. Checking it opens alone...`);
			await A.close();
			const alone = await B.open();
			log(alone ? `${nameB} opens alone: the host refuses a second session.` : `${nameB} does not open alone either: inconclusive.`);
			return;
		}
		const both = await traffic([A, B], 30000);
		summary(`${nameA} beside ${nameB}`, both.get(nameA));
		summary(`${nameB} beside ${nameA}`, both.get(nameB));

		// ── B. inquiry beside open sessions ───────────────────────
		console.log('\nB. Live inquiry beside the open sessions');
		const before = await traffic([A, B], 15000);
		const scanned = new Map();
		const scan = scanForBricks({
			helperPath: HELPER, ouiFilter: BT.LEGO_OUI, inquirySeconds: 30, timeoutSeconds: 60,
			onChange: (bricks) => { for (const b of bricks) { scanned.set(b.mac, b); } },
		});
		log('scan started (30 s inquiry)');
		const during = await traffic([A, B], 30000);
		await scan.done.catch((e) => log(`scan failed: ${(e && e.message) || e}`));
		log(`scan ended; saw ${[...scanned.values()].map((b) => `${b.name}(paired=${b.paired}, signal=${b.signal})`).join(', ') || 'nothing'}`);
		const after = await traffic([A, B], 15000);
		for (const s of [A, B]) {
			summary(`${s.name} before the scan`, before.get(s.name));
			summary(`${s.name} during the scan`, during.get(s.name));
			summary(`${s.name} after the scan`, after.get(s.name));
		}
	} finally {
		await A.close();
		await B.close();
	}
}

const keepAlive = setInterval(() => {}, 1000);
main().then(
	() => { clearInterval(keepAlive); process.exit(process.exitCode ?? 0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); }
);
