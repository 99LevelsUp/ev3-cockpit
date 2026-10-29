/**
 * Does one brick survive two live links at once -- USB and Bluetooth -- and answer both?
 *
 * The cockpit and the lab both carry a rule, "one active transport per brick", said to freeze
 * every brick when broken. The incident record it cites does not exist. The owner's model of
 * one brick with several channels (plan D2) depends on the answer: if a brick tolerates USB and
 * Bluetooth open together, Bluetooth can stand by while USB works and the move to the arena
 * costs nothing; if it does not, every failover pays a Bluetooth connect.
 *
 *   node scripts/dual-channel-probe.js [brickName] [--rounds N]
 *
 * Read-only on the brick: every command is `info` (name and firmware version). Goes through the
 * shipped providers -- libusb/HID for USB, Winsock RFCOMM behind the product's BtConnectionQueue
 * for Bluetooth -- not a hand-written socket.
 *
 * Phases:
 *   1. USB alone (baseline)
 *   2. Bluetooth opened while USB stays open
 *   3. alternating -- one USB command, then one Bluetooth command
 *   4. concurrent -- a USB and a Bluetooth command in flight at the brick at the same moment
 *   5. USB closed (a software stand-in for pulling the cable), Bluetooth carries on alone
 *   6. USB reopened beside Bluetooth
 *   7. both closed, then USB alone again -- is the brick still answering at all?
 *
 * Each link counts its own messages in its own range, so a reply delivered to the wrong link
 * shows up as a counter mismatch rather than a quiet success. The run stops as soon as both
 * links fail in the same round: a brick that answers nobody is the freeze the rule warns of,
 * and it should be looked at, not hammered.
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

const argAfter = (flag, fallback) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ROUNDS = Number.parseInt(argAfter('--rounds', '30'), 10);
const target = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '').toLowerCase();
const COMMAND_TIMEOUT_MS = 4000;
const BT_OPEN_ATTEMPTS = 3;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One link to the brick, with its own message counter range. */
function link(name, provider, key, counterBase) {
	let counter = 0;
	return {
		name, provider, key,
		async info() {
			counter = (counter + 1) % 0x1000;
			const id = counterBase + counter;
			const { type, payload } = buildCommand({ kind: 'info' });
			const sentAt = Date.now();
			const reply = await provider.sendPacket(key, encodeEv3Packet(id, type, payload), {
				expectedMessageCounter: id,
				timeoutMs: COMMAND_TIMEOUT_MS,
			});
			const rttMs = Date.now() - sentAt;
			const info = parseResponse({ kind: 'info' }, decodeEv3Packet(reply));
			return { rttMs, name: info.displayName, firmware: info.firmwareVersion };
		},
	};
}

/** Runs one command and records the outcome instead of throwing. */
async function sample(l, expectedName) {
	try {
		const r = await l.info();
		const ok = r.name === expectedName;
		return { link: l.name, ok, rttMs: r.rttMs, error: ok ? undefined : `answered as "${r.name}"` };
	} catch (error) {
		return { link: l.name, ok: false, error: String((error && error.message) || error) };
	}
}

function report(label, samples) {
	const byLink = new Map();
	for (const s of samples) {
		if (!byLink.has(s.link)) { byLink.set(s.link, []); }
		byLink.get(s.link).push(s);
	}
	console.log(`\n${label}`);
	for (const [name, list] of byLink) {
		const ok = list.filter((s) => s.ok);
		const rtts = ok.map((s) => s.rttMs).sort((a, b) => a - b);
		const at = (q) => (rtts.length ? rtts[Math.min(rtts.length - 1, Math.floor(q * rtts.length))] : '-');
		console.log(`  ${name.padEnd(4)} ${ok.length}/${list.length} ok   rtt p50 ${at(0.5)} ms  p95 ${at(0.95)} ms  max ${rtts.length ? rtts[rtts.length - 1] : '-'} ms`);
		const errors = new Map();
		for (const s of list.filter((x) => !x.ok)) { errors.set(s.error, (errors.get(s.error) ?? 0) + 1); }
		for (const [e, n] of errors) { console.log(`       ${n}x ${e}`); }
	}
}

async function openBluetooth(bt, key) {
	for (let attempt = 1; attempt <= BT_OPEN_ATTEMPTS; attempt += 1) {
		const startedAt = Date.now();
		try {
			await bt.connect(key);
			return { ok: true, attempt, openMs: Date.now() - startedAt };
		} catch (error) {
			console.log(`  Bluetooth open attempt ${attempt} failed after ${Date.now() - startedAt} ms: `
				+ `${(error && error.message) || error}`);
			await bt.disconnect(key).catch(() => { /* nothing to release */ });
		}
	}
	return { ok: false };
}

async function main() {
	const usb = new UsbTransportProvider({ log: { info: () => {}, warn: () => {} } });
	const queue = new BtConnectionQueue();
	const bt = new BtTransportProvider({
		backends: new Map([['winsock', (mac) => new BtWinsockAdapter({ mac })]]),
		connectionQueue: queue,
	});

	const scan = await usb.discover();
	const found = scan.items.find((item) => !target || item.displayName.toLowerCase().includes(target));
	if (!found) {
		console.error(`No USB brick${target ? ` matching "${target}"` : ''}. Seen: `
			+ (scan.items.map((i) => i.displayName).join(', ') || '(nothing)'));
		process.exitCode = 1;
		return;
	}
	// The USB serial and the Bluetooth address are the same twelve hex digits.
	const hex = found.brickKey.split(':').pop();
	const mac = (hex.match(/../g) ?? []).join(':').toUpperCase();
	const usbKey = found.brickKey;
	const btKey = makeBrickKey(Transport.BT, mac);
	console.log(`Brick ${found.displayName}: USB ${usbKey}, Bluetooth ${btKey}. ${ROUNDS} rounds per phase.`);

	const U = link('usb', usb, usbKey, 0x1000);
	const B = link('bt', bt, btKey, 0x2000);
	const startedAt = Date.now();
	let expected;
	let stopped = false;

	const run = async (label, rounds, step) => {
		const samples = [];
		for (let i = 0; i < rounds && !stopped; i += 1) {
			const round = await step();
			samples.push(...round);
			if (round.length > 1 && round.every((s) => !s.ok)) {
				console.log(`\n!! Both links failed in the same round of "${label}" -- stopping. `
					+ 'Check the brick: a frozen display or no answer to its buttons is the freeze NF1 warns of.');
				stopped = true;
			}
		}
		report(label, samples);
		return samples;
	};

	try {
		await usb.connect(usbKey);
		console.log(`USB open, ${usb.maxPacketBytes?.(usbKey) ?? '?'}-byte frames.`);
		expected = (await U.info()).name;

		await run('1. USB alone', ROUNDS, async () => [await sample(U, expected)]);

		console.log('\n2. Opening Bluetooth while USB stays open...');
		const opened = await openBluetooth(bt, btKey);
		if (!opened.ok) {
			console.log(`  Bluetooth did not open in ${BT_OPEN_ATTEMPTS} attempts; this host's adapter `
				+ 'decides that, not the dual link. Nothing to measure beyond phase 1.');
			return;
		}
		console.log(`  opened on attempt ${opened.attempt} in ${opened.openMs} ms (includes queue wait)`);

		await run('3. Alternating USB / Bluetooth', ROUNDS, async () => [
			await sample(U, expected), await sample(B, expected),
		]);
		await run('4. Concurrent -- both in flight at once', ROUNDS, async () =>
			Promise.all([sample(U, expected), sample(B, expected)]));

		if (!stopped) {
			await usb.disconnect(usbKey);
			await run('5. USB closed, Bluetooth alone', Math.min(ROUNDS, 15), async () => [await sample(B, expected)]);
		}
		if (!stopped) {
			const reopenedAt = Date.now();
			await usb.connect(usbKey);
			console.log(`\n6. USB reopened beside Bluetooth in ${Date.now() - reopenedAt} ms`);
			await run('6. USB back, both open', Math.min(ROUNDS, 15), async () =>
				Promise.all([sample(U, expected), sample(B, expected)]));
		}
	} finally {
		await bt.disconnect(btKey).catch(() => { /* may never have opened */ });
		await usb.disconnect(usbKey).catch(() => { /* may already be closed */ });
	}

	// Liveness after everything: a brick that took the dual link badly may still be wedged.
	await wait(2000);
	try {
		await usb.connect(usbKey);
		await run('7. Afterwards, USB alone again', 5, async () => [await sample(U, expected)]);
	} finally {
		await usb.disconnect(usbKey).catch(() => { /* closing anyway */ });
	}

	console.log(`\n-- ${((Date.now() - startedAt) / 1000).toFixed(0)} s --`);
	queue.dispose?.();
	bt.dispose?.();
	usb.dispose?.();
}

// BtConnectionQueue unrefs its drain timer; in a script that lets Node exit mid-cooldown.
const keepAlive = setInterval(() => { /* hold the loop open */ }, 1000);

main().then(
	() => { clearInterval(keepAlive); process.exit(process.exitCode ?? 0); },
	(error) => { clearInterval(keepAlive); console.error(error); process.exit(1); }
);
