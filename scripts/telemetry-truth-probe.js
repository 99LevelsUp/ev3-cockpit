/**
 * Real bricks against the mock, row by row (step-6 plan U10, the rule written 13.11.2026).
 *
 * One frame — the whole row catalogue — goes to each brick over USB and over Bluetooth and to a
 * mock brick configured only from the owner's description of what is plugged in. Never from what
 * a brick reports: a mock seeded from the brick's own type codes would agree by construction.
 *
 * Everything that moves bytes is shipped code: the real providers, `PacketCommandChannel`, the
 * assembler, the rows' own parsers and `MockTransportProvider`'s channel. The probe only compares.
 *
 *   node scripts/telemetry-truth-probe.js compare --devices "AAA=1:touch,3:color,B:large,D:medium;BBB=..."
 *       [--frames 10] [--only AAA] [--no-bt]
 *
 * Writes the full per-frame record to .review-out/u10-compare-<brick>.json (gitignored) and prints
 * the differences the rule asks to classify.
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
const {
	UsbTransportProvider, BtTransportProvider, BtSppBackend, BtWinsockAdapter, BtConnectionQueue,
} = require(out('transports'));
const { PacketCommandChannel } = require(out('commands/commandChannel'));
const { MockTransportProvider } = require(out('mock/mockTransportProvider'));
const { assembleFrame, buildTelemetryFrame, parseFrame } = require(out('telemetry/frameAssembler'));
const { allEv3Rows } = require(out('telemetry/ev3Rows'));
const { peripheralTypeOf } = require(out('telemetry/peripheralTypes'));
const { brickKeyId, makeBrickKey } = require(out('contracts/brickKey'));
const { Transport } = require(out('contracts/enums'));

const quiet = { log: { info: () => {}, warn: () => {} } };
/** A MAC without separators, lower case: USB keys carry `001653…`, Bluetooth keys `00:16:53:…`. */
const macOf = (key) => brickKeyId(key).replace(/[:-]/g, '').toLowerCase();
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

// ── the owner's description ─────────────────────────────────────────

const DEVICE_NAMES = {
	touch: 'touch-sensor', color: 'color-sensor', colour: 'color-sensor', infrared: 'infrared-sensor',
	ir: 'infrared-sensor', ultrasonic: 'ultrasonic-sensor', us: 'ultrasonic-sensor', gyro: 'gyro-sensor',
	large: 'large-motor', medium: 'medium-motor',
};

/** "AAA=1:touch,B:large;BBB=2:ir" → Map(name → { sensors: Map(port → type), motors: ... }). */
function parseDevices(text) {
	if (!text) { throw new Error('--devices is required: the owner\'s description, not the brick\'s.'); }
	const bricks = new Map();
	for (const part of text.split(';').map((s) => s.trim()).filter(Boolean)) {
		const [name, list = ''] = part.split('=');
		const sensors = new Map(); const motors = new Map();
		for (const item of list.split(',').map((s) => s.trim()).filter(Boolean)) {
			const [port, device] = item.split(':');
			const type = DEVICE_NAMES[(device ?? '').toLowerCase()];
			if (!type) { throw new Error(`Unknown device "${device}" in "${item}".`); }
			const upper = port.toUpperCase();
			(/^[1-4]$/.test(upper) ? sensors : motors).set(upper, type);
			if (!/^[1-4A-D]$/.test(upper)) { throw new Error(`Unknown port "${port}" in "${item}".`); }
		}
		bricks.set(name.trim(), { sensors, motors });
	}
	return bricks;
}

/** A mock brick with exactly the described devices, all reading a constant 0. */
function mockFor(name, described) {
	const port = (p, type) => ({ port: p, peripheralType: type, dynamic: { kind: 'static', value: 0 } });
	return new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'probe', displayName: name, firmwareVersion: 'V1.09H', battery: { level: 80, voltage: 7.5 },
			sensorPorts: [...described.sensors].map(([p, t]) => port(p, t)),
			motorPorts: [...described.motors].map(([p, t]) => port(p, t)),
		}],
	});
}

// ── classification (the rule, items 1–5) ────────────────────────────

function classOf(value) {
	if (value === undefined || value === null || (typeof value === 'number' && Number.isNaN(value))) { return 'none'; }
	if (typeof value === 'number') { return `${Number.isInteger(value) ? 'int' : 'real'}${value < 0 ? '-' : ''}`; }
	if (typeof value === 'string') { return value === '' ? 'empty-string' : 'string'; }
	return typeof value;
}

function describeRow(result) {
	if (result.row.reportsOccupancy) {
		const code = result.value.value;
		return `type ${code} (${typeof code === 'number' ? peripheralTypeOf(code) : '?'}) mode ${result.value.mode}`;
	}
	return classOf(result.value.value);
}

// ── sending ─────────────────────────────────────────────────────────

async function runFrames(label, channel, frame, frames, timeoutMs) {
	const built = buildTelemetryFrame(frame);
	const records = [];
	const send = async () => {
		const started = Date.now();
		const response = await channel.execute({ kind: 'telemetry:frame', payload: built }, { timeoutMs });
		return { payload: response.payload, ms: Date.now() - started };
	};
	await send(); // warm-up, not recorded
	for (let i = 0; i < frames; i += 1) {
		const { payload, ms } = await send();
		const lengthOk = payload.length === frame.globalBytes;
		const values = parseFrame(frame, payload, Date.now());
		records.push({
			ms, lengthOk, payloadLength: payload.length,
			rows: frame.placed.map((placed, j) => ({
				id: placed.row.id, slot: placed.slot, bytes: placed.row.result.bytes,
				text: describeRow({ row: placed.row, value: values[j] }),
				raw: Buffer.from(payload.subarray(placed.slot, placed.slot + placed.row.result.bytes)).toString('hex'),
			})),
		});
	}
	process.stdout.write(`  ${label.padEnd(4)} ${frames} frames, median ${median(records.map((r) => r.ms))} ms\n`);
	return records;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Per row: the set of descriptions seen across the frames. */
function summarise(records) {
	const rows = new Map();
	for (const record of records) {
		for (const row of record.rows) {
			const entry = rows.get(row.id) ?? { texts: new Set(), raws: new Set() };
			entry.texts.add(row.text); entry.raws.add(row.raw);
			rows.set(row.id, entry);
		}
	}
	return rows;
}

// ── main ────────────────────────────────────────────────────────────

async function compare() {
	const described = parseDevices(arg('--devices'));
	const frames = Number(arg('--frames') ?? 10);
	const only = arg('--only');
	const withBt = !process.argv.includes('--no-bt');

	const usb = new UsbTransportProvider(quiet);
	const btBackend = new BtSppBackend();
	const btQueue = new BtConnectionQueue();
	const bt = new BtTransportProvider({
		discoverDevices: btBackend.discover,
		backends: new Map([['winsock', (mac) => new BtWinsockAdapter({ mac })], ['spp', btBackend.adapterFor]]),
		connectionQueue: btQueue,
	});
	const verdictLines = [];
	try {
		const usbScan = await usb.discover();
		const btScan = withBt ? await bt.discover().catch(() => ({ items: [] })) : { items: [] };
		for (const [name, devices] of described) {
			if (only && only !== name) { continue; }
			const usbItem = usbScan.items.find((i) => i.displayName === name);
			if (!usbItem) { verdictLines.push(`${name}: not found on USB, skipped`); continue; }
			const btItem = btScan.items.find((i) => macOf(i.brickKey) === macOf(usbItem.brickKey));
			process.stdout.write(`\n${name}\n`);

			// One frame for every side, so the same rows sit at the same slots.
			await usb.connect(usbItem.brickKey);
			const frame = assembleFrame(allEv3Rows(), { maxPacketBytes: Math.min(usb.maxPacketBytes?.(usbItem.brickKey) ?? 1024, 1024) });
			const sides = {};
			try {
				const channel = new PacketCommandChannel((packet, o) => usb.sendPacket(usbItem.brickKey, packet, o), 'USB');
				sides.USB = await runFrames('USB', channel, frame, frames, 5000);
			} finally { await usb.disconnect(usbItem.brickKey).catch(() => {}); }

			if (btItem) {
				try {
					await bt.connect(btItem.brickKey);
					const channel = new PacketCommandChannel((packet, o) => bt.sendPacket(btItem.brickKey, packet, o), 'BT');
					sides.BT = await runFrames('BT', channel, frame, frames, 12000);
				} catch (error) {
					verdictLines.push(`${name}: BT failed (${error?.message ?? error}), compared without it`);
				} finally { await bt.disconnect(btItem.brickKey).catch(() => {}); }
			} else if (withBt) {
				verdictLines.push(`${name}: not found over BT, compared without it`);
			}

			const mock = mockFor(name, devices);
			const mockKey = makeBrickKey(Transport.Mock, 'probe');
			await mock.connect(mockKey);
			sides.mock = await runFrames('mock', mock.createCommandChannel(mockKey), frame, frames, 1000);
			mock.dispose();

			const file = path.join(REPO, '.review-out', `u10-compare-${name}.json`);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ name, devices: {
				sensors: Object.fromEntries(devices.sensors), motors: Object.fromEntries(devices.motors) },
			frame: { globalBytes: frame.globalBytes, rows: frame.placed.length, deferred: frame.deferred.length }, sides }, null, '\t'));

			// Rule items 1–5: compare each real side with the mock, and USB with BT.
			const summary = Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, summarise(v)]));
			for (const side of Object.keys(sides)) {
				const bad = sides[side].filter((r) => !r.lengthOk);
				if (bad.length) { verdictLines.push(`${name} ${side}: reply length ≠ declared globals in ${bad.length} frame(s) [rule 4]`); }
			}
			const pairs = [['USB', 'mock'], ['BT', 'mock'], ['USB', 'BT']].filter(([a, b]) => summary[a] && summary[b]);
			for (const row of frame.placed) {
				for (const [a, b] of pairs) {
					const ta = [...summary[a].get(row.row.id).texts].sort().join(' | ');
					const tb = [...summary[b].get(row.row.id).texts].sort().join(' | ');
					if (ta === tb) { continue; }
					const item = row.row.reportsOccupancy ? 1 : row.row.port ? 2 : 3;
					const tag = a === 'USB' && b === 'BT' ? 'TRANSPORT (blocker if real)' : `rule ${item}`;
					verdictLines.push(`${name} ${row.row.id}: ${a} [${ta}] vs ${b} [${tb}] — ${tag}`);
				}
			}
		}
	} finally {
		usb.dispose(); bt.dispose(); btQueue.dispose();
	}

	process.stdout.write('\n── differences to classify ──\n');
	process.stdout.write(verdictLines.length ? `${verdictLines.join('\n')}\n` : 'none\n');
}

// ── one brick over one link ─────────────────────────────────────────

/** Opens `name` over USB (`hid` forces the HID fallback) or BT and hands back a channel. */
async function openBrick(name, on = 'usb') {
	const created = [];
	const usb = new UsbTransportProvider({
		...quiet,
		// Forcing HID: the provider falls back to it when libusb cannot open the brick.
		// The provider falls back when libusb's open() fails, not when the adapter cannot be made.
		...(on === 'hid' ? { createLibusbAdapter: () => ({
			open: () => Promise.reject(new Error('libusb withheld by the probe (3.1.13)')),
			close: () => Promise.resolve(),
		}) } : {}),
	});
	created.push(() => usb.dispose());
	const usbItem = (await usb.discover()).items.find((i) => i.displayName === name);
	if (!usbItem) { throw new Error(`${name} is not on USB.`); }
	let provider = usb; let key = usbItem.brickKey;
	if (on === 'bt') {
		const btBackend = new BtSppBackend();
		const queue = new BtConnectionQueue();
		const bt = new BtTransportProvider({
			discoverDevices: btBackend.discover,
			backends: new Map([['winsock', (mac) => new BtWinsockAdapter({ mac })], ['spp', btBackend.adapterFor]]),
			connectionQueue: queue,
		});
		created.push(() => { bt.dispose(); queue.dispose(); });
		const btItem = (await bt.discover()).items.find((i) => macOf(i.brickKey) === macOf(usbItem.brickKey));
		if (!btItem) { throw new Error(`${name} is not seen over BT.`); }
		provider = bt; key = btItem.brickKey;
	}
	await provider.connect(key);
	const channel = new PacketCommandChannel((packet, o) => provider.sendPacket(key, packet, o), on.toUpperCase());
	return {
		channel,
		maxPacketBytes: provider.maxPacketBytes?.(key) ?? 1024,
		close: async () => { await provider.disconnect(key).catch(() => {}); for (const c of created) { c(); } },
	};
}

const sensorIndex = (port) => {
	const i = ['1', '2', '3', '4'].indexOf(String(port));
	if (i < 0) { throw new Error('--port must be 1–4.'); }
	return i;
};

/** Sends one frame; `byId` holds each row's value, since the assembler places rows in its own order. */
async function sendTimed(channel, frame, timeoutMs) {
	const started = Date.now();
	const response = await channel.execute({ kind: 'telemetry:frame', payload: buildTelemetryFrame(frame) }, { timeoutMs });
	const values = parseFrame(frame, response.payload, Date.now());
	const byId = new Map(values.map((v) => [v.rowId, v]));
	return { ms: Date.now() - started, values, byId, length: response.payload.length };
}

/**
 * Switch-and-settle for a UART mode: how long until the brick reports the new mode, and what the
 * value row reads meanwhile. The scheduler's settle is timed from the send (U4 round 1, #3); this
 * is the number it should be timed with.
 *
 *   settle --brick CCC --port 2 --from 0 --to 2 [--on usb|bt] [--seconds 3]
 */
async function settle() {
	const name = arg('--brick'); const index = sensorIndex(arg('--port'));
	const occ = `ports.sensor.${arg('--port')}.occupancy`; const val = `ports.sensor.${arg('--port')}.value`;
	const from = Number(arg('--from') ?? 0); const to = Number(arg('--to') ?? 1);
	const seconds = Number(arg('--seconds') ?? 3);
	const { sensorOccupancyRow, sensorValueRow } = require(out('telemetry/ev3Rows'));
	const link = await openBrick(name, arg('--on') ?? 'usb');
	try {
		const frameFor = (mode) => assembleFrame([sensorOccupancyRow(index), sensorValueRow(index, mode)], { maxPacketBytes: link.maxPacketBytes });
		for (let i = 0; i < 10; i += 1) { await sendTimed(link.channel, frameFor(from), 5000); }
		const before = await sendTimed(link.channel, frameFor(from), 5000);
		process.stdout.write(`${name} port ${arg('--port')}: settled in mode ${before.byId.get(occ).mode}, `
			+ `type ${before.byId.get(occ).value}, value ${before.byId.get(val).value}\n`);
		const switched = Date.now();
		const lines = []; let modeAt; let valueAt;
		while (Date.now() - switched < seconds * 1000) {
			const r = await sendTimed(link.channel, frameFor(to), 5000);
			const t = Date.now() - switched;
			lines.push(`  +${String(t).padStart(5)} ms  frame ${String(r.ms).padStart(4)} ms  mode ${r.byId.get(occ).mode}  value ${r.byId.get(val).value}`);
			if (modeAt === undefined && r.byId.get(occ).mode === to) { modeAt = t; }
			if (modeAt !== undefined && valueAt === undefined && classOf(r.byId.get(val).value) !== 'none') { valueAt = t; }
		}
		process.stdout.write(`${lines.join('\n')}\n`);
		process.stdout.write(`mode ${from}→${to}: reported after ${modeAt ?? '—'} ms, first value after ${valueAt ?? '—'} ms; `
			+ `slowest frame ${Math.max(...lines.map((l) => Number(l.match(/frame\s+(\d+)/)[1])))} ms\n`);
	} finally { await link.close(); }
}

/**
 * Does a value read stall? Frames with the value row ungated, back to back, while the owner plugs a
 * sensor in. `c_input.c` says `opINPUT_READSI` never re-executes; a frame of ~1.2 s says otherwise.
 *
 *   stall --brick CCC --port 1 [--seconds 30] [--on usb|bt]
 */
async function stall() {
	const name = arg('--brick'); const index = sensorIndex(arg('--port'));
	const occ = `ports.sensor.${arg('--port')}.occupancy`; const val = `ports.sensor.${arg('--port')}.value`;
	const seconds = Number(arg('--seconds') ?? 30);
	const { sensorOccupancyRow, sensorValueRow } = require(out('telemetry/ev3Rows'));
	const link = await openBrick(name, arg('--on') ?? 'usb');
	try {
		// Ungated: the value row goes out every frame whatever the occupancy says.
		const frame = assembleFrame([sensorOccupancyRow(index), sensorValueRow(index)], { maxPacketBytes: link.maxPacketBytes });
		process.stdout.write(`${name} port ${arg('--port')}: ${seconds} s of frames — plug the sensor in now\n`);
		const started = Date.now(); let last; const times = []; const slow = [];
		while (Date.now() - started < seconds * 1000) {
			const r = await sendTimed(link.channel, frame, 5000);
			const t = Date.now() - started; times.push(r.ms);
			const state = `type ${r.byId.get(occ).value} mode ${r.byId.get(occ).mode}`;
			if (state !== last) { process.stdout.write(`  +${String(t).padStart(6)} ms  ${state}  value ${r.byId.get(val).value}  (frame ${r.ms} ms)\n`); last = state; }
			if (r.ms > 100) { slow.push(`+${t} ms: ${r.ms} ms (${state})`); }
		}
		process.stdout.write(`${times.length} frames, median ${median(times)} ms, slowest ${Math.max(...times)} ms\n`);
		process.stdout.write(slow.length ? `frames over 100 ms:\n  ${slow.join('\n  ')}\n` : 'no frame over 100 ms\n');
	} finally { await link.close(); }
}

/**
 * 3.1.13: what HID does with a reply longer than one 64-byte report. One small instruction (the
 * battery level at slot 0) under growing declared globals; the reply is always globals + 5 bytes.
 * The shipped HID adapter reassembles by the length in the header, so a fragmented reply arrives
 * whole, a truncated one times out, and anything else is a length mismatch.
 *
 *   hid --brick AAA
 */
async function hid() {
	const name = arg('--brick');
	const { batteryLevelRow } = require(out('telemetry/ev3Rows'));
	const row = batteryLevelRow();
	const sizes = [8, 54, 59, 60, 64, 100, 200, 500];
	for (const on of ['usb', 'hid']) {
		const link = await openBrick(name, on);
		try {
			process.stdout.write(`${name} over ${on === 'hid' ? 'HID (libusb withheld)' : 'libusb'}: ${link.maxPacketBytes} B packets\n`);
			for (const globals of sizes) {
				const frame = { bytecode: row.emit(0), globalBytes: globals, placed: [{ row, slot: 0 }], deferred: [] };
				try {
					const r = await sendTimed(link.channel, frame, 3000);
					process.stdout.write(`  globals ${String(globals).padStart(3)} (reply ${globals + 5} B): ${r.length === globals ? 'whole' : `MISMATCH ${r.length} B`}, `
						+ `battery ${r.values[0].value}, ${r.ms} ms\n`);
				} catch (error) {
					process.stdout.write(`  globals ${String(globals).padStart(3)} (reply ${globals + 5} B): FAILED ${error?.message ?? error}\n`);
				}
			}
		} finally { await link.close(); }
	}
}

const command = process.argv[2];
const commands = { compare, settle, stall, hid };
if (!commands[command]) {
	console.error(`Usage: node scripts/telemetry-truth-probe.js <${Object.keys(commands).join('|')}> …`);
	process.exit(2);
}
// The transports unref their timers so they never hold the extension host open; a probe awaiting
// only such a timer (a Bluetooth connect) would see Node exit 0 halfway (13.11.2026). Held until done.
const keepAlive = setInterval(() => {}, 1 << 30);
commands[command]().then(
	() => { clearInterval(keepAlive); process.exitCode = 0; },
	(error) => { clearInterval(keepAlive); console.error(error); process.exitCode = 1; },
).finally(() => { setTimeout(() => process.exit(), 500).unref(); });
