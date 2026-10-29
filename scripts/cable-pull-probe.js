/**
 * The arena scenario with a real cable: USB carries the traffic, Bluetooth stands by, the
 * cable is pulled, traffic moves to Bluetooth, the cable goes back in, traffic returns to USB.
 *
 *   node scripts/cable-pull-probe.js <brickName>
 *
 * Needs a person at the brick. Signals, all from the PC speaker:
 *   three short high beeps -> pull the USB cable out of the brick
 *   one long low beep      -> plug it back in
 *
 * `dual-channel-probe.js` showed a brick tolerates USB and Bluetooth open together, but closed
 * USB in software. A pulled cable is a different event: the device leaves the bus under an
 * open handle. What this measures:
 *   - how long until the USB link reports the loss, and as what error,
 *   - whether the standby Bluetooth link misses anything while that happens,
 *   - how long until the brick is back on the bus after plugging in, and the reopen time.
 *
 * Read-only on the brick (`info` only), through the shipped providers. The traffic model is
 * the one plan D2 proposes: one channel carries the traffic, the other gets a heartbeat.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
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

const target = (process.argv[2] ?? '').toLowerCase();
const TRAFFIC_MS = 250;
const HEARTBEAT_MS = 1000;
const COMMAND_TIMEOUT_MS = 2000;
const BEFORE_PULL_MS = 8000;
const PULL_WAIT_MS = 30000;
const BT_ONLY_MS = 8000;
const REPLUG_WAIT_MS = 40000;
const AFTER_REPLUG_MS = 8000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const now = () => Date.now() - t0;
const log = (line) => console.log(`${String(now()).padStart(6)} ms  ${line}`);

/** Beeps without blocking the event loop, so the traffic keeps its pace. */
function beep(pattern) {
	const script = pattern.map(([hz, ms]) => `[console]::beep(${hz},${ms})`).join(';');
	spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', windowsHide: true });
}

function link(name, provider, key, counterBase) {
	let counter = 0;
	return {
		name,
		async info(expectedName) {
			counter = (counter + 1) % 0x1000;
			const id = counterBase + counter;
			const { type, payload } = buildCommand({ kind: 'info' });
			const sentAt = Date.now();
			try {
				const reply = await provider.sendPacket(key, encodeEv3Packet(id, type, payload), {
					expectedMessageCounter: id,
					timeoutMs: COMMAND_TIMEOUT_MS,
				});
				const info = parseResponse({ kind: 'info' }, decodeEv3Packet(reply));
				const ok = info.displayName === expectedName;
				return { at: now(), link: name, ok, rttMs: Date.now() - sentAt, error: ok ? undefined : `answered as "${info.displayName}"` };
			} catch (error) {
				return { at: now(), link: name, ok: false, rttMs: Date.now() - sentAt, error: String((error && error.message) || error) };
			}
		},
	};
}

function summary(label, samples) {
	const ok = samples.filter((s) => s.ok);
	const rtts = ok.map((s) => s.rttMs).sort((a, b) => a - b);
	const p = (q) => (rtts.length ? rtts[Math.min(rtts.length - 1, Math.floor(q * rtts.length))] : '-');
	const failures = samples.filter((s) => !s.ok);
	console.log(`  ${label.padEnd(34)} ${ok.length}/${samples.length} ok  p50 ${p(0.5)} ms  p95 ${p(0.95)} ms  max ${rtts.length ? rtts[rtts.length - 1] : '-'} ms`
		+ (failures.length ? `   failures: ${[...new Set(failures.map((f) => f.error))].join(' | ')}` : ''));
}

async function main() {
	const usb = new UsbTransportProvider({ log: { info: () => {}, warn: () => {} } });
	const queue = new BtConnectionQueue();
	const bt = new BtTransportProvider({
		backends: new Map([['winsock', (mac) => new BtWinsockAdapter({ mac })]]),
		connectionQueue: queue,
	});

	const scan = await usb.discover();
	const found = scan.items.find((item) => item.displayName.toLowerCase() === target);
	if (!target || !found) {
		console.error(`Name a brick on USB. Seen: ${scan.items.map((i) => i.displayName).join(', ') || '(nothing)'}`);
		process.exitCode = 1;
		return;
	}
	const hex = found.brickKey.split(':').pop();
	const mac = (hex.match(/../g) ?? []).join(':').toUpperCase();
	const usbKey = found.brickKey;
	const btKey = makeBrickKey(Transport.BT, mac);
	const U = link('usb', usb, usbKey, 0x1000);
	const B = link('bt', bt, btKey, 0x2000);
	const name = found.displayName;

	await usb.connect(usbKey);
	log(`USB open to ${name}`);
	for (let attempt = 1; ; attempt += 1) {
		try {
			await bt.connect(btKey);
			log(`Bluetooth open (attempt ${attempt})`);
			break;
		} catch (error) {
			log(`Bluetooth open attempt ${attempt} failed: ${(error && error.message) || error}`);
			await bt.disconnect(btKey).catch(() => {});
			if (attempt >= 3) { throw new Error('Bluetooth would not open; nothing to measure.'); }
		}
	}

	const samples = { before: [], pull: [], btOnly: [], replug: [], after: [] };
	let phase = 'before';
	let traffic = U;
	let standby = B;
	let lastHeartbeat = 0;
	let running = true;

	// One loop: the traffic channel every TRAFFIC_MS, the standby channel every HEARTBEAT_MS.
	const loop = (async () => {
		while (running) {
			const tickStart = Date.now();
			const jobs = [traffic.info(name)];
			if (standby && Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
				lastHeartbeat = Date.now();
				jobs.push(standby.info(name));
			}
			for (const s of await Promise.all(jobs)) {
				samples[phase].push(s);
				if (!s.ok) { log(`${s.link} FAIL after ${s.rttMs} ms: ${s.error}`); }
			}
			await wait(Math.max(0, TRAFFIC_MS - (Date.now() - tickStart)));
		}
	})();

	await wait(BEFORE_PULL_MS);

	// ── pull ─────────────────────────────────────────────────────
	phase = 'pull';
	log('>>> PULL the USB cable now (three high beeps)');
	beep([[1500, 150], [1500, 150], [1500, 150]]);
	const pullSignalAt = now();
	const deadline = Date.now() + PULL_WAIT_MS;
	let usbLostAt;
	while (Date.now() < deadline) {
		const usbFail = samples.pull.find((s) => s.link === 'usb' && !s.ok);
		if (usbFail) { usbLostAt = usbFail.at; break; }
		await wait(50);
	}
	if (usbLostAt === undefined) {
		log('USB never failed within the window -- the cable was not pulled. Stopping.');
		running = false;
		await loop;
		return;
	}
	const firstFail = samples.pull.find((s) => s.link === 'usb' && !s.ok);
	const lastOk = [...samples.before, ...samples.pull]
		.filter((s) => s.link === 'usb' && s.ok && s.at < firstFail.at).pop();
	// The signal-to-failure time includes the walk to the brick; this gap does not.
	const detectionGapMs = lastOk ? firstFail.at - lastOk.at : undefined;
	log(`USB loss reported ${usbLostAt - pullSignalAt} ms after the signal (${detectionGapMs} ms after `
		+ `the last good USB reply, failing call took ${firstFail.rttMs} ms): ${firstFail.error}`);

	// Fail over: Bluetooth carries the traffic, nothing stands by.
	traffic = B;
	standby = undefined;
	phase = 'btOnly';
	await usb.disconnect(usbKey).catch((e) => log(`USB close after loss: ${(e && e.message) || e}`));
	log('traffic on Bluetooth');
	await wait(BT_ONLY_MS);

	// ── replug ───────────────────────────────────────────────────
	phase = 'replug';
	log('>>> PLUG the USB cable back in (one long low beep)');
	beep([[600, 900]]);
	const plugSignalAt = now();
	let backOnBusAt;
	const replugDeadline = Date.now() + REPLUG_WAIT_MS;
	while (Date.now() < replugDeadline) {
		const again = await usb.discover().catch(() => ({ items: [] }));
		if (again.items.some((i) => i.brickKey === usbKey)) { backOnBusAt = now(); break; }
		await wait(250);
	}
	if (backOnBusAt === undefined) {
		log('The brick did not come back on USB within the window.');
	} else {
		log(`brick back on the USB bus ${backOnBusAt - plugSignalAt} ms after the signal`);
		const openAt = Date.now();
		try {
			await usb.connect(usbKey);
			log(`USB reopened in ${Date.now() - openAt} ms; traffic back on USB, Bluetooth stands by`);
			standby = B;
			traffic = U;
		} catch (error) {
			log(`USB reopen failed: ${(error && error.message) || error}`);
		}
	}
	phase = 'after';
	await wait(AFTER_REPLUG_MS);
	running = false;
	await loop;

	console.log(`\n${name}: summary`);
	const pick = (list, l) => list.filter((s) => s.link === l);
	summary('USB traffic before the pull', pick(samples.before, 'usb'));
	summary('BT standby before the pull', pick(samples.before, 'bt'));
	summary('USB while being pulled', pick(samples.pull, 'usb'));
	summary('BT while USB was being pulled', pick(samples.pull, 'bt'));
	summary('BT carrying traffic, no cable', [...pick(samples.btOnly, 'bt'), ...pick(samples.replug, 'bt')]);
	summary('USB traffic after replug', pick(samples.after, 'usb'));
	summary('BT standby after replug', pick(samples.after, 'bt'));
	console.log(`  USB loss detected:  ${usbLostAt - pullSignalAt} ms after the pull signal`);
	console.log(`  back on USB bus:    ${backOnBusAt === undefined ? 'no' : `${backOnBusAt - plugSignalAt} ms after the plug signal`}`);

	await bt.disconnect(btKey).catch(() => {});
	await usb.disconnect(usbKey).catch(() => {});
	queue.dispose?.();
	bt.dispose?.();
	usb.dispose?.();
}

const keepAlive = setInterval(() => { /* BtConnectionQueue unrefs its timer */ }, 1000);
main().then(
	() => { clearInterval(keepAlive); process.exit(process.exitCode ?? 0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); }
);
