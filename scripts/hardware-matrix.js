/**
 * Every layer built so far, against every brick, over every transport that can reach it.
 *
 * Written because the layers were verified unevenly. USB has been exercised for weeks, TCP
 * only in passing, and the Bluetooth path had never opened a real port until 27.08.2026 — its
 * provider was constructed with no backends, so nothing below it had ever run. Two defects in
 * the SPP adapter surfaced within minutes of it finally being wired, which is the argument
 * for this file: a layer nobody has run against hardware is not a working layer, however many
 * unit tests it has.
 *
 * Not a replacement for the unit suite. Those pin behaviour that hardware cannot show — error
 * paths, budget arithmetic, scheduler invariants. This pins the half that only a brick knows.
 *
 *   node scripts/hardware-matrix.js            every brick, every transport
 *   node scripts/hardware-matrix.js --quick    skip the slow filesystem and telemetry checks
 *
 * Exits non-zero if any check fails, so it can gate a release.
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
	ProviderRegistry, UsbTransportProvider, TcpTransportProvider, BtTransportProvider,
	BtSppBackend, BtWinsockAdapter, BtConnectionQueue,
} = require(out('transports'));
const {
	encodeEv3Packet, decodeEv3Packet, EV3_COMMAND, EV3_REPLY,
} = require(out('protocol/ev3Packet'));
const { buildCommand, FIRMWARE_BUFFER_BYTES } = require(out('protocol/ev3Commands'));
const { parseResponse } = require(out('protocol/ev3Responses'));
const { maxPacketBytesFor } = require(out('fs/brickFilesystem'));
const { brickKeyTransport } = require(out('contracts/brickKey'));
const { assembleFrame, buildTelemetryFrame, parseFrame } = require(out('telemetry/frameAssembler'));
const { TelemetryScheduler } = require(out('telemetry/telemetryScheduler'));
const { allEv3Rows, batteryLevelRow } = require(out('telemetry/ev3Rows'));

const QUICK = process.argv.includes('--quick');

/**
 * Round-trip times above which a transport is broken rather than slow, in ms.
 *
 * Measured baselines on 27.08.2026 are USB ~6 ms (13 ms with the brick's Wi-Fi up), TCP
 * ~17 ms, Bluetooth ~100 ms. These ceilings sit far above all of those, because the job here
 * is to catch a link that has stopped working, not to police its performance.
 */
const ABSOLUTE_FRAME_CEILING_MS = { USB: 200, TCP: 500, BT: 2000 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: { info: () => {}, warn: () => {} } };

// ── result collection ────────────────────────────────────────────────

const results = [];
let counter = 0;

function record(transport, brick, layer, check, ok, detail) {
	results.push({ transport, brick, layer, check, ok, detail });
	const mark = ok === true ? 'ok  ' : ok === null ? 'skip' : 'FAIL';
	process.stdout.write(`  ${mark}  ${layer} / ${check}${detail ? `  — ${detail}` : ''}\n`);
}

/** Runs one check, turning a throw into a failed row rather than a dead run. */
async function check(transport, brick, layer, name, fn) {
	try {
		const detail = await fn();
		record(transport, brick, layer, name, true, detail);
		return true;
	} catch (error) {
		record(transport, brick, layer, name, false, error?.message || String(error));
		return false;
	}
}

function assert(condition, message) {
	if (!condition) { throw new Error(message); }
}

// ── plumbing ─────────────────────────────────────────────────────────

async function sendCommand(provider, key, command, timeoutMs) {
	counter = (counter + 1) & 0xffff;
	const { type, payload } = buildCommand(command);
	const packet = encodeEv3Packet(counter, type, payload);
	const started = Date.now();
	const reply = await provider.sendPacket(key, packet, {
		expectedMessageCounter: counter, timeoutMs,
	});
	return { response: parseResponse(command, decodeEv3Packet(reply)), elapsedMs: Date.now() - started };
}

async function sendFrame(provider, key, payload, timeoutMs) {
	counter = (counter + 1) & 0xffff;
	const packet = encodeEv3Packet(counter, EV3_COMMAND.DIRECT_COMMAND_REPLY, payload);
	const reply = await provider.sendPacket(key, packet, {
		expectedMessageCounter: counter, timeoutMs,
	});
	const decoded = decodeEv3Packet(reply);
	// A rejected frame comes back as DIRECT_REPLY_ERROR carrying the *previous* command's
	// globals, so a run that does not check this reads stale bytes as fresh values.
	assert(decoded.type === EV3_REPLY.DIRECT_REPLY,
		`brick answered 0x${decoded.type.toString(16)} instead of DIRECT_REPLY`);
	return decoded.payload;
}

function packetCeiling(provider, key) {
	return provider.maxPacketBytes?.(key)
		?? maxPacketBytesFor(brickKeyTransport(key))
		?? FIRMWARE_BUFFER_BYTES;
}

// ── the checks ───────────────────────────────────────────────────────

async function checkProtocol(transport, brick, provider, key, timeoutMs) {
	await check(transport, brick, 'protocol', 'battery reads a plausible level', async () => {
		const { response } = await sendCommand(provider, key, { kind: 'battery' }, timeoutMs);
		assert(response.level >= 0 && response.level <= 100,
			`level ${response.level} is not a percentage`);
		assert(response.voltage === undefined || (response.voltage > 3 && response.voltage < 10),
			`voltage ${response.voltage} V is not a plausible EV3 pack`);
		return `${response.level}%${response.voltage ? `, ${response.voltage.toFixed(2)} V` : ''}`;
	});

	await check(transport, brick, 'protocol', 'info returns a name and firmware', async () => {
		const { response } = await sendCommand(provider, key, { kind: 'info' }, timeoutMs);
		assert(response.displayName?.length > 0, 'empty brick name');
		assert(/^V\d/.test(response.firmwareVersion ?? ''),
			`firmware "${response.firmwareVersion}" does not look like a version`);
		return `${response.displayName}, ${response.firmwareVersion}`;
	});

	await check(transport, brick, 'protocol', 'ports never report a value for an empty port',
		async () => {
			const { response } = await sendCommand(provider, key, { kind: 'ports' }, timeoutMs);
			const all = [...response.sensorPorts, ...response.motorPorts];
			assert(all.length === 8, `expected 8 ports, got ${all.length}`);
			const lying = all.filter((p) => !p.peripheralType && p.value !== undefined);
			assert(lying.length === 0,
				`${lying.length} empty port(s) reported a value: ${lying.map((p) => p.port).join(', ')}`);
			const populated = all.filter((p) => p.peripheralType);
			return `${populated.length} populated: `
				+ (populated.map((p) => `${p.port}=${p.peripheralType}`).join(' ') || 'none');
		});

	await check(transport, brick, 'protocol', 'message counter matches the reply', async () => {
		// A provider that answered another command's reply would fail here rather than
		// silently attributing one brick's data to another.
		for (let i = 0; i < 5; i += 1) {
			await sendCommand(provider, key, { kind: 'buttons' }, timeoutMs);
		}
		return '5 exchanges, no counter mismatch';
	});
}

async function checkFilesystem(transport, brick, provider, key, timeoutMs) {
	if (QUICK) {
		record(transport, brick, 'filesystem', 'listing and free space', null, 'skipped (--quick)');
		return;
	}

	await check(transport, brick, 'filesystem', 'root listing is non-empty', async () => {
		const { response } = await sendCommand(provider, key,
			{ kind: 'fs:list', path: '/home/root/lms2012/' }, timeoutMs * 2);
		assert(response.entries.length > 0, 'no entries at all');
		return `${response.entries.length} entr(ies), complete=${response.complete}`;
	});

	await check(transport, brick, 'filesystem', 'free space is plausible', async () => {
		const { response } = await sendCommand(provider, key, { kind: 'fs:freeSpace' }, timeoutMs);
		assert(response.totalKb > 0 && response.freeKb >= 0 && response.freeKb <= response.totalKb,
			`free ${response.freeKb} of ${response.totalKb} kB makes no sense`);
		return `${response.freeKb} kB free of ${response.totalKb} kB`;
	});
}

async function checkTelemetry(transport, brick, provider, key, timeoutMs) {
	const maxPacketBytes = packetCeiling(provider, key);

	await check(transport, brick, 'telemetry', 'the composed frame is accepted', async () => {
		const frame = assembleFrame(allEv3Rows(), { maxPacketBytes });
		const payload = await sendFrame(provider, key, buildTelemetryFrame(frame), timeoutMs);
		assert(payload.length === frame.globalBytes,
			`reply carried ${payload.length} B, frame declared ${frame.globalBytes} B`);
		const values = parseFrame(frame, payload, Date.now());
		assert(values.length === frame.placed.length, 'not every placed row parsed');
		return `${frame.placed.length} rows, ${frame.bytecode.length + 7} B out / ${payload.length + 5} B back`;
	});

	await check(transport, brick, 'telemetry', 'width costs little', async () => {
		// The control is the point: a wide frame's cost has to be compared against a narrow
		// one on this link, right now. Brick state taxes the round trip more than width does.
		const narrow = assembleFrame([batteryLevelRow()], { maxPacketBytes });
		const wide = assembleFrame(allEv3Rows(), { maxPacketBytes });
		const time = async (frame) => {
			const built = buildTelemetryFrame(frame);
			const started = Date.now();
			for (let i = 0; i < 8; i += 1) { await sendFrame(provider, key, built, timeoutMs); }
			return (Date.now() - started) / 8;
		};
		const one = await time(narrow);
		const many = await time(wide);

		// A ratio alone is not a check. The first version asserted only `many < one * 3` and
		// passed a Bluetooth link that took **six seconds per frame** — both numbers were
		// equally awful, so their ratio looked perfect. A relative test on a uniformly broken
		// link reports success. So bound the absolute cost as well, generously enough that a
		// slow-but-working transport still passes.
		const ceiling = ABSOLUTE_FRAME_CEILING_MS[transport.trim()] ?? 1000;
		assert(one < ceiling,
			`a single row took ${one.toFixed(0)} ms; anything over ${ceiling} ms means the link `
			+ 'is not working, whatever the ratio says');
		assert(many < one * 3,
			`${wide.placed.length} rows cost ${many.toFixed(0)} ms against ${one.toFixed(0)} ms for one`);
		return `1 row ${one.toFixed(1)} ms, ${wide.placed.length} rows ${many.toFixed(1)} ms`;
	});

	if (QUICK) {
		record(transport, brick, 'telemetry', 'scheduler holds back-pressure', null, 'skipped (--quick)');
		return;
	}

	await check(transport, brick, 'telemetry', 'scheduler holds back-pressure', async () => {
		let concurrent = 0;
		let peak = 0;
		const scheduler = new TelemetryScheduler({
			rows: allEv3Rows(),
			limits: { maxPacketBytes },
			tickPeriodMs: 5,          // far faster than any link can serve
			send: async (payload) => {
				concurrent += 1;
				peak = Math.max(peak, concurrent);
				try { return await sendFrame(provider, key, payload, timeoutMs); }
				finally { concurrent -= 1; }
			},
			onError: () => { /* counted in stats */ },
		});
		scheduler.start();
		await wait(2000);
		scheduler.stop();
		await wait(300);
		const stats = scheduler.stats;
		scheduler.dispose();

		assert(peak === 1, `${peak} frames were in flight at once`);
		assert(stats.ticksSkipped > 0, 'the scheduler never stood down, so nothing was tested');
		return `peak ${peak} in flight, ${stats.framesSent} frames, ${stats.ticksSkipped} ticks declined`;
	});
}

async function checkSession(transport, brick, provider, key, timeoutMs) {
	await check(transport, brick, 'session', 'reconnect after an explicit disconnect', async () => {
		await provider.disconnect(key);
		await wait(500);
		await provider.connect(key);
		const { response } = await sendCommand(provider, key, { kind: 'battery' }, timeoutMs);
		assert(typeof response.level === 'number', 'no answer after reconnect');
		return 'answered again after reconnect';
	});
}

/**
 * The `TransportProvider` contract itself (1.13.1's mock coverage, against a real brick):
 * a held session refuses a second connect, a disconnected one refuses a send, and a second
 * disconnect is a no-op rather than a throw. 1.12.4 — no USB, TCP or BT provider had ever
 * had this checked against real hardware; only the mock was.
 *
 * Ends the brick connected, same as it found it, so the checks after this one are unaffected.
 */
async function checkContract(transport, brick, provider, key, timeoutMs) {
	await check(transport, brick, 'contract', 'a second connect is refused while the session is held',
		async () => {
			await provider.connect(key).then(
				() => { throw new Error('a second connect() resolved instead of being refused'); },
				() => { /* refused, as the session model requires */ }
			);
			return 'refused, as the session model requires';
		});

	await check(transport, brick, 'contract', 'a disconnected brick refuses a send', async () => {
		await provider.disconnect(key);
		try {
			await sendCommand(provider, key, { kind: 'battery' }, timeoutMs).then(
				() => { throw new Error('sendPacket answered a brick with no session'); },
				() => { /* refused, as the session model requires */ }
			);
			return 'refused, as the session model requires';
		} finally {
			await provider.connect(key);
		}
	});

	await check(transport, brick, 'contract', 'a second disconnect does not throw', async () => {
		await provider.disconnect(key);
		await provider.disconnect(key);
		await provider.connect(key);
		return 'idempotent, as the session model requires';
	});
}

// ── driver ───────────────────────────────────────────────────────────

async function runBrick(transport, provider, item, timeoutMs) {
	const key = item.brickKey;
	const brick = item.displayName;
	process.stdout.write(`\n${transport} / ${brick}\n`);

	try {
		await provider.connect(key);
	} catch (error) {
		record(transport, brick, 'transport', 'connect', false, error?.message || String(error));
		return;
	}
	record(transport, brick, 'transport', 'connect', true,
		`${packetCeiling(provider, key)} B packets`);

	try {
		await checkProtocol(transport, brick, provider, key, timeoutMs);
		await checkFilesystem(transport, brick, provider, key, timeoutMs);
		await checkTelemetry(transport, brick, provider, key, timeoutMs);
		await checkSession(transport, brick, provider, key, timeoutMs);
		await checkContract(transport, brick, provider, key, timeoutMs);
	} finally {
		await provider.disconnect(key).catch(() => { /* already reported */ });
	}
}

async function discoverAll(usb, tcp, bt) {
	process.stdout.write('discovery\n');

	const usbScan = await usb.discover().catch(() => ({ items: [] }));
	record('USB', '-', 'transport', 'discovery', usbScan.items.length > 0,
		usbScan.items.map((i) => i.displayName).join(', ') || 'nothing found');

	// Beacon discovery is cache-based and each call re-primes the path, so one call after a
	// long wait comes back empty even with a brick present.
	let tcpScan = { items: [] };
	for (let i = 0; i < 5 && !tcpScan.items.length; i += 1) {
		tcpScan = await tcp.discover().catch(() => ({ items: [] }));
		if (!tcpScan.items.length) { await wait(2500); }
	}
	record('TCP', '-', 'transport', 'discovery', tcpScan.items.length > 0,
		tcpScan.items.map((i) => i.displayName).join(', ') || 'nothing announced');

	const btScan = await bt.discover().catch((error) => {
		record('BT', '-', 'transport', 'discovery', false, error?.message || String(error));
		return { items: [] };
	});
	if (btScan.items.length) {
		record('BT', '-', 'transport', 'discovery', true,
			btScan.items.map((i) => i.displayName).join(', '));
	}

	return { usbScan, tcpScan, btScan };
}

function summarise() {
	const failed = results.filter((r) => r.ok === false);
	const passed = results.filter((r) => r.ok === true);
	const skipped = results.filter((r) => r.ok === null);

	process.stdout.write('\n── summary ──\n');
	const byCell = new Map();
	for (const r of results) {
		const cell = `${r.transport} / ${r.layer}`;
		if (!byCell.has(cell)) { byCell.set(cell, { ok: 0, fail: 0, skip: 0 }); }
		const bucket = byCell.get(cell);
		if (r.ok === true) { bucket.ok += 1; } else if (r.ok === false) { bucket.fail += 1; }
		else { bucket.skip += 1; }
	}
	for (const [cell, bucket] of byCell) {
		process.stdout.write(`  ${cell.padEnd(24)} ${bucket.ok} ok`
			+ (bucket.fail ? `, ${bucket.fail} FAILED` : '')
			+ (bucket.skip ? `, ${bucket.skip} skipped` : '') + '\n');
	}

	if (failed.length) {
		process.stdout.write('\nfailures:\n');
		for (const r of failed) {
			process.stdout.write(`  ${r.transport} / ${r.brick} / ${r.layer} / ${r.check}\n`
				+ `      ${r.detail}\n`);
		}
	}

	process.stdout.write(`\n${passed.length} passed, ${failed.length} failed, `
		+ `${skipped.length} skipped\n`);
	return failed.length;
}

async function main() {
	const registry = new ProviderRegistry();
	const usb = new UsbTransportProvider(quiet);
	const tcp = new TcpTransportProvider(quiet);
	// Mirrors extension.ts: Winsock preferred, SPP fallback, paced through the same
	// BtConnectionQueue the product shares across every BT session. Without the queue,
	// every check here hammers the one RFCOMM channel back-to-back with no cooldown at
	// all -- a harness bug that reads exactly like the channel refusing every reconnect.
	const btBackend = new BtSppBackend();
	const btQueue = new BtConnectionQueue();
	const bt = new BtTransportProvider({
		discoverDevices: btBackend.discover,
		backends: new Map([
			['winsock', (mac) => new BtWinsockAdapter({ mac })],
			['spp', btBackend.adapterFor],
		]),
		connectionQueue: btQueue,
	});
	registry.register(usb); registry.register(tcp); registry.register(bt);

	try {
		const { usbScan, tcpScan, btScan } = await discoverAll(usb, tcp, bt);

		for (const item of usbScan.items) { await runBrick('USB', usb, item, 5000); }
		for (const item of tcpScan.items) { await runBrick('TCP', tcp, item, 8000); }
		for (const item of btScan.items) { await runBrick('BT ', bt, item, 12000); }
	} finally {
		usb.dispose(); tcp.dispose(); bt.dispose(); btQueue.dispose(); registry.dispose();
	}

	return summarise();
}

main().then(
	(failures) => process.exit(failures ? 1 : 0),
	(error) => { console.error(error); process.exit(1); },
);
